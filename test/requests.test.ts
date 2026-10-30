/**
 * Request identification, live-call safety, rate-limit waits, response
 * metadata and the pagination helpers. Mirrors the Python SDK's
 * `tests/test_requests.py`. No network, no credentials.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APIConnectionError,
  APITimeoutError,
  FirmenData,
  RateLimitError,
  ServerError,
  VERSION,
} from '../src/index.js';
import type { ResponseInfo, SearchHit, SubscriptionTestRequest } from '../src/index.js';
import { shouldRetry } from '../src/retry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function clientWith(
  impl: (url: string, init: RequestInit) => Response | Promise<Response>,
  options: Partial<ConstructorParameters<typeof FirmenData>[0]> = {},
) {
  const fetchSpy = vi.fn(async (input: unknown, init?: unknown) =>
    impl(String(input), (init ?? {}) as RequestInit),
  );
  const client = new FirmenData({
    maxRetries: 0,
    ...options,
    fetch: fetchSpy as unknown as typeof globalThis.fetch,
  });
  return { client, fetchSpy };
}

function headersOf(fetchSpy: ReturnType<typeof clientWith>['fetchSpy'], call = 0) {
  return (fetchSpy.mock.calls[call]![1] as RequestInit).headers as Record<string, string>;
}

function urlOf(fetchSpy: ReturnType<typeof clientWith>['fetchSpy'], call = 0) {
  return new URL(String(fetchSpy.mock.calls[call]![0]));
}

/** A fetch that only ever settles by being aborted — i.e. it times out. */
function hangUntilAborted(_url: string, init: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted.', 'AbortError')),
    );
  });
}

function connectionFailure(code: string): never {
  throw new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

function problem(slug: string, status: number) {
  return {
    type: `https://api.firmendata.com/problems/${slug}`,
    title: slug,
    status,
    detail: 'boom',
    request_id: 'req-body',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('client identification', () => {
  it('generated VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });

  it('sends X-FirmenData-Client and a Node User-Agent', async () => {
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, { data: [] }));
    await client.autocomplete('sap');
    const headers = headersOf(fetchSpy);
    expect(headers['X-FirmenData-Client']).toBe(`node-sdk/${VERSION}`);
    expect(headers['User-Agent']).toBe(
      `firmendata-node/${VERSION} node/${process.versions.node}`,
    );
  });

  it('appends appInfo to the User-Agent', async () => {
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, { data: [] }), {
      appInfo: { name: 'acme-crm', version: '2.1.0', url: 'https://acme.example' },
    });
    await client.autocomplete('sap');
    expect(headersOf(fetchSpy)['User-Agent']).toBe(
      `firmendata-node/${VERSION} node/${process.versions.node} acme-crm/2.1.0 (https://acme.example)`,
    );
  });

  it('accepts appInfo with only a name, and truncates long values', async () => {
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, { data: [] }), {
      appInfo: { name: 'x'.repeat(200) },
    });
    await client.autocomplete('sap');
    expect(headersOf(fetchSpy)['User-Agent']!.endsWith(` ${'x'.repeat(64)}`)).toBe(true);
  });

  it.each([
    { name: 'evil\r\nX-Injected: 1' },
    { name: 'ok', version: '1\n2' },
    { name: 'ok', url: 'https://a.example\r' },
    { name: '  ' },
  ])('rejects unusable appInfo %j', (appInfo) => {
    expect(() => new FirmenData({ appInfo })).toThrow(TypeError);
  });

  it('never sets a User-Agent in a browser-like runtime', async () => {
    vi.stubGlobal('window', {});
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, { data: [] }), {
      appInfo: { name: 'acme-crm' },
    });
    await client.autocomplete('sap');
    const headers = headersOf(fetchSpy);
    expect(headers['User-Agent']).toBeUndefined();
    expect(headers['X-FirmenData-Client']).toBe(`node-sdk/${VERSION}`);
  });
});

describe('lists', () => {
  it('lists your company lists', async () => {
    const body = {
      object: 'list',
      data: [
        {
          object: 'company_list',
          list_id: 42,
          name: 'Targets',
          company_count: 3,
          alerts_enabled: true,
          created_at: '2026-10-01T12:00:00Z',
          updated_at: '2026-10-02T12:00:00Z',
        },
      ],
    };
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, body), { apiKey: 'k' });
    const lists = await client.getLists();
    expect(lists.data?.[0]?.list_id).toBe(42);
    expect(urlOf(fetchSpy).pathname).toBe('/v1/lists');
    expect(urlOf(fetchSpy).search).toBe('');
    expect(headersOf(fetchSpy).Authorization).toBe('Bearer k');
  });

  it('fetches one page of a list', async () => {
    const body = { object: 'list', list_id: 42, name: 'Targets', data: [] };
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, body), { apiKey: 'k' });
    const page = await client.getList(42, {
      limit: 200,
      cursor: 'c+/=',
      sort: 'revenue',
      sort_direction: 'asc',
    });
    expect(page.name).toBe('Targets');
    const url = urlOf(fetchSpy);
    expect(url.pathname).toBe('/v1/lists/42');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '200',
      cursor: 'c+/=',
      sort: 'revenue',
      sort_direction: 'asc',
    });
  });
});

describe('financials detail level', () => {
  it('leaves the default (full line items) to the server', async () => {
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, {}));
    await client.getFinancials('DE1');
    expect(urlOf(fetchSpy).search).toBe('');
  });

  it('sends details=false for the lean response', async () => {
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, {}));
    await client.getFinancials('DE1', { details: false, years: 3 });
    expect(Object.fromEntries(urlOf(fetchSpy).searchParams)).toEqual({
      details: 'false',
      years: '3',
    });
  });

  it('maps the deprecated includeLineItems onto details, never include', async () => {
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, {}));
    await client.getFinancials('DE1', { includeLineItems: true });
    await client.getFinancials('DE1', { includeLineItems: true, details: false });
    expect(Object.fromEntries(urlOf(fetchSpy, 0).searchParams)).toEqual({ details: 'true' });
    expect(Object.fromEntries(urlOf(fetchSpy, 1).searchParams)).toEqual({ details: 'false' });
  });
});

describe('live calls are never billed twice', () => {
  function timeouts() {
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return real(fn, ms);
    }) as typeof setTimeout);
    return delays;
  }

  it('raises the timeout of live calls to at least 150 s', async () => {
    const delays = timeouts();
    const { client } = clientWith(() => jsonResponse(200, {}));
    await client.getCompany('DE1');
    await client.getCompany('DE1', { fetchRealtime: true });
    await client.getShareholders('DE1', { fetchRealtime: true });
    await client.search({ q: 'acme', fetch_realtime: true });
    await client.listDocuments('DE1');
    await client.downloadDocument('DE1', { fileType: 'shareholder_list' });
    expect(delays).toEqual([30_000, 150_000, 150_000, 150_000, 150_000, 150_000]);
  });

  it('keeps a longer client timeout and an explicit per-call timeout', async () => {
    const delays = timeouts();
    const { client } = clientWith(() => jsonResponse(200, {}), { timeoutMs: 200_000 });
    await client.getUbo('DE1', { fetchRealtime: true });
    await client.getUbo('DE1', { fetchRealtime: true, timeoutMs: 5_000 });
    await client.downloadDocument('DE1', { fileType: 'shareholder_list', timeoutMs: 7_000 });
    expect(delays).toEqual([200_000, 5_000, 7_000]);
  });

  it('does not retry a timed-out realtime call and says it may be billed', async () => {
    const { client, fetchSpy } = clientWith(hangUntilAborted, { maxRetries: 2 });
    const error = await client
      .getUbo('DE1', { fetchRealtime: true, timeoutMs: 10 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(APITimeoutError);
    expect((error as Error).message).toMatch(/billed/);
    expect((error as Error).message).toMatch(/timeoutMs/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry a timed-out document download', async () => {
    const { client, fetchSpy } = clientWith(hangUntilAborted, { maxRetries: 2 });
    await expect(
      client.downloadDocument('DE1', { fileType: 'shareholder_list', timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(APITimeoutError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('still retries a timed-out ordinary GET', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { client, fetchSpy } = clientWith(hangUntilAborted, { maxRetries: 2, timeoutMs: 10 });
    const error = await client.getCompany('DE1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(APITimeoutError);
    expect((error as Error).message).not.toMatch(/billed/);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('does not retry a live call whose connection broke after sending', async () => {
    const { client, fetchSpy } = clientWith(() => connectionFailure('ECONNRESET'), {
      maxRetries: 2,
    });
    const error = await client
      .getHistory('DE1', { fetchRealtime: true })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(APIConnectionError);
    expect(error).not.toBeInstanceOf(APITimeoutError);
    expect((error as Error).message).toMatch(/billed/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries a live call that provably never left the client', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let calls = 0;
    const { client, fetchSpy } = clientWith(
      () => (++calls === 1 ? connectionFailure('ECONNREFUSED') : jsonResponse(200, {})),
      { maxRetries: 2 },
    );
    await client.getCompany('DE1', { fetchRealtime: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not retry a gateway timeout on a live call, but does otherwise', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const gateway = () => jsonResponse(504, problem('server-error', 504));
    const live = clientWith(gateway, { maxRetries: 2 });
    await expect(live.client.getCompany('DE1', { fetchRealtime: true })).rejects.toBeInstanceOf(
      ServerError,
    );
    expect(live.fetchSpy).toHaveBeenCalledTimes(1);

    const ordinary = clientWith(gateway, { maxRetries: 2 });
    await expect(ordinary.client.getCompany('DE1')).rejects.toBeInstanceOf(ServerError);
    expect(ordinary.fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('shouldRetry encodes the same rules', () => {
    const base = { method: 'GET', attempt: 0, maxRetries: 2 };
    expect(shouldRetry({ ...base, live: true })).toBe(false);
    expect(shouldRetry({ ...base, live: true, requestSent: false })).toBe(true);
    expect(shouldRetry({ ...base, live: true, statusCode: 504 })).toBe(false);
    expect(shouldRetry({ ...base, live: true, statusCode: 408 })).toBe(false);
    expect(shouldRetry({ ...base, live: true, statusCode: 503 })).toBe(true);
    expect(shouldRetry({ ...base, live: true, statusCode: 429 })).toBe(true);
    expect(shouldRetry({ ...base })).toBe(true);
    expect(shouldRetry({ ...base, statusCode: 504 })).toBe(true);
  });
});

describe('Retry-After', () => {
  it('raises at once when the server asks for a longer wait than the cap', async () => {
    const { client, fetchSpy } = clientWith(
      () => jsonResponse(429, problem('rate-limit-exceeded', 429), { 'retry-after': '86400' }),
      { maxRetries: 2 },
    );
    const started = Date.now();
    const error = await client.autocomplete('sap').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(86_400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('waits and retries within the cap', async () => {
    let calls = 0;
    const { client, fetchSpy } = clientWith(
      () =>
        ++calls === 1
          ? jsonResponse(429, problem('rate-limit-exceeded', 429), { 'retry-after': '0' })
          : jsonResponse(200, { data: [] }),
      { maxRetries: 2 },
    );
    await client.autocomplete('sap');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('shouldRetry gives up on a Retry-After above 20 s', () => {
    const base = { method: 'GET', statusCode: 429, attempt: 0, maxRetries: 2 };
    expect(shouldRetry({ ...base, retryAfterSeconds: 20 })).toBe(true);
    expect(shouldRetry({ ...base, retryAfterSeconds: 21 })).toBe(false);
    expect(shouldRetry({ ...base })).toBe(true);
  });
});

describe('onResponse', () => {
  it('reports status, request id and credits for successes and errors', async () => {
    const seen: ResponseInfo[] = [];
    let calls = 0;
    const { client } = clientWith(
      () =>
        ++calls === 1
          ? jsonResponse(429, problem('rate-limit-exceeded', 429), {
              'retry-after': '0',
              'x-credits-charged': '0',
            })
          : jsonResponse(
              200,
              { data: [] },
              { 'x-request-id': 'req-1', 'x-credits-charged': '3' },
            ),
      { maxRetries: 1, onResponse: (info) => void seen.push(info) },
    );
    await client.search({ q: 'acme' });
    expect(
      seen.map(({ status, requestId, creditsCharged }) => [status, requestId, creditsCharged]),
    ).toEqual([
      [429, 'req-body', 0],
      [200, 'req-1', 3],
    ]);
    expect(seen[1]!.headers['x-credits-charged']).toBe('3');
  });

  it('leaves creditsCharged undefined without the header and is awaited', async () => {
    const seen: ResponseInfo[] = [];
    const { client } = clientWith(() => jsonResponse(404, problem('not-found', 404)), {
      onResponse: async (info) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        seen.push(info);
      },
    });
    await expect(client.getCompany('DE1')).rejects.toMatchObject({ statusCode: 404 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.creditsCharged).toBeUndefined();
  });

  it('propagates an error thrown by the callback unchanged', async () => {
    const boom = new Error('callback failed');
    const { client } = clientWith(() => jsonResponse(200, {}), {
      onResponse: () => {
        throw boom;
      },
    });
    await expect(client.getCompany('DE1')).rejects.toBe(boom);
  });
});

describe('searchAll', () => {
  const hit = (n: number) => ({ eu_id: `DE${n}`, display_name: `Company ${n}` }) as SearchHit;

  it('follows cursors with only cursor and limit, until has_more is false', async () => {
    const pages = [
      { data: [hit(1), hit(2)], pagination: { next_cursor: 'c1', has_more: true } },
      { data: [hit(3)], pagination: { next_cursor: 'c2', has_more: true } },
      { data: [hit(4)], pagination: { next_cursor: null, has_more: false } },
    ];
    let index = 0;
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, pages[index++]));
    const ids: string[] = [];
    for await (const item of client.searchAll({
      bundesland: ['Bayern'],
      fetch_realtime: true,
      q: 'acme',
      limit: 2,
    })) {
      ids.push(item.eu_id);
    }
    expect(ids).toEqual(['DE1', 'DE2', 'DE3', 'DE4']);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(Object.fromEntries(urlOf(fetchSpy, 0).searchParams)).toEqual({
      bundesland: 'Bayern',
      fetch_realtime: 'true',
      q: 'acme',
      limit: '2',
    });
    expect(Object.fromEntries(urlOf(fetchSpy, 1).searchParams)).toEqual({
      cursor: 'c1',
      limit: '2',
    });
    expect(Object.fromEntries(urlOf(fetchSpy, 2).searchParams)).toEqual({
      cursor: 'c2',
      limit: '2',
    });
  });

  it('stops at maxResults without fetching another page', async () => {
    const { client, fetchSpy } = clientWith(() =>
      jsonResponse(200, {
        data: [hit(1), hit(2), hit(3)],
        pagination: { next_cursor: 'more', has_more: true },
      }),
    );
    const ids: string[] = [];
    for await (const item of client.searchAll({ q: 'acme' }, { maxResults: 2 })) {
      ids.push(item.eu_id);
    }
    expect(ids).toEqual(['DE1', 'DE2']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(urlOf(fetchSpy).searchParams.get('limit')).toBe('2');
  });

  it('never goes past the 10,000-result cap', async () => {
    let n = 0;
    const { client, fetchSpy } = clientWith(() =>
      jsonResponse(200, {
        data: Array.from({ length: 50 }, () => hit(++n)),
        pagination: { next_cursor: `c${n}`, has_more: true },
      }),
    );
    let count = 0;
    for await (const item of client.searchAll({}, { maxResults: 20_000 })) {
      void item;
      count += 1;
    }
    expect(count).toBe(10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(200);
  });
});

describe('subscription test and resend', () => {
  it('posts a typed test-delivery body', async () => {
    const body: SubscriptionTestRequest = {
      eu_id: 'DEF1103R.HRB12300B',
      subscription_type: 'details',
      notification_type: 'webhook',
      webhook_url: 'https://example.com/hook',
    };
    const response = {
      object: 'subscription_test_result',
      notification_type: 'webhook',
      duration_ms: 12,
      receiver_succeeded: true,
    };
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, response), { apiKey: 'k' });
    const result = await client.testDelivery(body);
    expect(result.receiver_succeeded).toBe(true);
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(body);
    expect(urlOf(fetchSpy).pathname).toBe('/v1/subscriptions/test');
  });

  it('types the resend result', async () => {
    const { client, fetchSpy } = clientWith(() =>
      jsonResponse(200, { succeeded: true, duration_ms: 5, event: { id: 'evt_2' } }),
    );
    const result = await client.resendEvent('evt_1');
    expect(result.succeeded).toBe(true);
    expect(urlOf(fetchSpy).pathname).toBe('/v1/subscriptions/events/evt_1/resend');
  });
});
