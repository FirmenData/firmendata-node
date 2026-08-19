/**
 * Client behaviour against an injected fetch. No network, no credentials.
 *
 * These mirror the Python SDK's suite deliberately — the two libraries are
 * supposed to behave identically, and the cheapest way to keep that true is
 * to assert the same things about both.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  APIConnectionError,
  AuthenticationError,
  FirmenData,
  InsufficientCreditsError,
  NotFoundError,
  RateLimitError,
  ServerError,
  ValidationError,
} from '../src/index.js';
import { backoffMs, shouldRetry } from '../src/retry.js';

function problem(slug: string, status: number, extra: Record<string, unknown> = {}) {
  return {
    type: `https://api.firmendata.com/problems/${slug}`,
    title: slug,
    status,
    detail: 'boom',
    instance: '/v1/companies/autocomplete',
    request_id: 'req-abc123',
    ...extra,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A client whose fetch is a spy returning canned responses. */
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

describe('request shaping', () => {
  it('sends no Authorization header without a key', async () => {
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, { data: [] }));
    await client.autocomplete('sap');
    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBeUndefined();
  });

  it('sends a bearer token when a key is set', async () => {
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, { data: [] }), {
      apiKey: 'firmendata_live_xyz',
    });
    await client.autocomplete('sap');
    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe('Bearer firmendata_live_xyz');
  });

  it('repeats the key for array filters', async () => {
    // `?city=Berlin&city=Hamburg` is what the API parses — not a joined value.
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, { data: [] }), {
      apiKey: 'k',
    });
    await client.search({ city: ['Berlin', 'Hamburg'] });
    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.searchParams.getAll('city')).toEqual(['Berlin', 'Hamburg']);
  });

  it('omits undefined parameters', async () => {
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, {}), { apiKey: 'k' });
    await client.downloadDocument('DE1', { fileType: 'Bilanz' });
    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.searchParams.has('file_id')).toBe(false);
    expect(url.searchParams.get('file_type')).toBe('Bilanz');
  });

  it('serialises booleans as true/false', async () => {
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, {}), { apiKey: 'k' });
    await client.getCompany('DE1', { fetchRealtime: true });
    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.searchParams.get('fetch_realtime')).toBe('true');
  });

  it('percent-encodes path parameters', async () => {
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, {}), { apiKey: 'k' });
    await client.getCompany('DE B/1103');
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('DE%20B%2F1103');
  });
});

describe('error mapping', () => {
  const cases = [
    ['unauthenticated', 401, AuthenticationError],
    ['insufficient-credits', 402, InsufficientCreditsError],
    ['not-found', 404, NotFoundError],
    ['validation-error', 422, ValidationError],
    ['rate-limit-exceeded', 429, RateLimitError],
  ] as const;

  for (const [slug, status, Expected] of cases) {
    it(`maps ${slug} to ${Expected.name}`, async () => {
      const { client } = clientWith(() => jsonResponse(status, problem(slug, status)));
      await expect(client.autocomplete('sap')).rejects.toBeInstanceOf(Expected);
    });
  }

  it('preserves the request id', async () => {
    const { client } = clientWith(() => jsonResponse(404, problem('not-found', 404)));
    await expect(client.autocomplete('sap')).rejects.toMatchObject({
      requestId: 'req-abc123',
      statusCode: 404,
    });
  });

  it('falls back to the status when the body is not a problem', async () => {
    const { client } = clientWith(() => new Response('<html>nope</html>', { status: 404 }));
    await expect(client.autocomplete('sap')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('exposes per-field validation errors', async () => {
    const { client } = clientWith(() =>
      jsonResponse(
        422,
        problem('validation-error', 422, {
          errors: [{ path: 'q', code: 'too_short' }],
        }),
      ),
    );
    await expect(client.autocomplete('ab')).rejects.toMatchObject({
      errors: [{ path: 'q', code: 'too_short' }],
    });
  });

  it('carries Retry-After on a rate limit', async () => {
    const { client } = clientWith(() =>
      jsonResponse(429, problem('rate-limit-exceeded', 429), { 'retry-after': '7' }),
    );
    await expect(client.autocomplete('sap')).rejects.toMatchObject({ retryAfter: 7 });
  });

  it('surfaces keyless fetch_realtime as an auth error', async () => {
    const { client } = clientWith(() =>
      jsonResponse(
        401,
        problem('unauthenticated', 401, {
          detail: '`fetch_realtime=true` requires an API key.',
        }),
      ),
    );
    await expect(client.autocomplete('sap', { fetchRealtime: true })).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it('reports a transport failure as APIConnectionError', async () => {
    const { client } = clientWith(() => {
      throw new TypeError('fetch failed');
    });
    await expect(client.autocomplete('sap')).rejects.toBeInstanceOf(APIConnectionError);
  });
});

describe('retry policy', () => {
  it('retries 429 on any method — the call never executed', () => {
    expect(shouldRetry({ method: 'POST', statusCode: 429, attempt: 0, maxRetries: 2 })).toBe(
      true,
    );
  });

  it('does not retry 5xx on POST — the create may have landed', () => {
    expect(shouldRetry({ method: 'POST', statusCode: 503, attempt: 0, maxRetries: 2 })).toBe(
      false,
    );
  });

  it('retries 5xx on GET', () => {
    expect(shouldRetry({ method: 'GET', statusCode: 503, attempt: 0, maxRetries: 2 })).toBe(
      true,
    );
  });

  it('does not retry a transport failure on POST', () => {
    expect(shouldRetry({ method: 'POST', attempt: 0, maxRetries: 2 })).toBe(false);
  });

  it('never retries 4xx', () => {
    expect(shouldRetry({ method: 'GET', statusCode: 404, attempt: 0, maxRetries: 5 })).toBe(
      false,
    );
  });

  it('respects the budget', () => {
    expect(shouldRetry({ method: 'GET', statusCode: 500, attempt: 2, maxRetries: 2 })).toBe(
      false,
    );
  });

  it('prefers the server Retry-After', () => {
    expect(backoffMs(0, { retryAfterSeconds: 3 })).toBe(3000);
  });

  it('jitters within the ceiling', () => {
    // Full jitter: without it, clients that trip the same limit together all
    // come back at the same instant.
    const values = new Set(Array.from({ length: 50 }, () => backoffMs(3)));
    expect(values.size).toBeGreaterThan(1);
    for (const v of values) expect(v).toBeLessThanOrEqual(4000);
  });

  it('recovers after a retryable 500', async () => {
    let calls = 0;
    const { client } = clientWith(
      () => {
        calls += 1;
        return calls === 1
          ? jsonResponse(500, problem('server-error', 500))
          : jsonResponse(200, { data: [{ name: 'SAP SE' }] });
      },
      { maxRetries: 2 },
    );
    const result = await client.autocomplete('sap');
    expect(calls).toBe(2);
    expect((result as { data: Array<{ name: string }> }).data[0]!.name).toBe('SAP SE');
  });

  it('gives up and throws the last error', async () => {
    const { client } = clientWith(() => jsonResponse(500, problem('server-error', 500)), {
      maxRetries: 1,
    });
    await expect(client.autocomplete('sap')).rejects.toBeInstanceOf(ServerError);
  });
});

describe('packaging', () => {
  it('errors survive instanceof across the class hierarchy', async () => {
    const { client } = clientWith(() =>
      jsonResponse(402, problem('insufficient-credits', 402)),
    );
    const err = await client.getUbo('DE1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientCreditsError);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('InsufficientCreditsError');
  });

  it('works with no options at all — the free tier', async () => {
    const fd = new FirmenData();
    expect(fd.apiKey).toBeUndefined();
    expect(fd.baseUrl).toBe('https://api.firmendata.com');
  });
});
