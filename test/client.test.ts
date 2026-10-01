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
import type { CompanyDocumentList } from '../src/index.js';

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

  it('serialises country, canton and Swiss legal-form filters', async () => {
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, { data: [] }));
    await client.search({
      country: 'CH',
      canton: ['ZH', 'BE'],
      bundesland: ['Bayern'],
      rechtsform: ['AG (CH)', 'GmbH (CH)'],
      sort: 'name',
    });
    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.searchParams.getAll('country')).toEqual(['CH']);
    expect(url.searchParams.getAll('canton')).toEqual(['ZH', 'BE']);
    expect(url.searchParams.getAll('bundesland')).toEqual(['Bayern']);
    expect(url.searchParams.getAll('rechtsform')).toEqual(['AG (CH)', 'GmbH (CH)']);
    expect(url.searchParams.get('sort')).toBe('name');
  });

  it('serialises micro companies alongside the existing size filters', async () => {
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, { data: [] }));
    await client.search({ company_size: ['kleinst', 'klein', 'mittelgross'] });
    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.pathname).toBe('/v1/companies/search');
    expect(url.searchParams.getAll('company_size')).toEqual([
      'kleinst',
      'klein',
      'mittelgross',
    ]);
  });

  it('omits undefined parameters', async () => {
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, {}), { apiKey: 'k' });
    await client.downloadDocument('DE1', { fileType: 'Bilanz' });
    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.searchParams.has('file_id')).toBe(false);
    expect(url.searchParams.has('document_id')).toBe(false);
    expect(url.searchParams.has('fetch_realtime')).toBe(false);
    expect(url.searchParams.get('file_type')).toBe('Bilanz');
  });

  it('downloads a specific document version with its matching file type', async () => {
    const body = {
      document_id: 'doc_123',
      label: 'Liste der Gesellschafter vom 2024-01-15',
      download_url: 'https://example.com/document.pdf',
    };
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, body));
    const result = await client.downloadDocument('DE B/1103', {
      fileType: 'shareholder_list',
      documentId: 'doc_123',
    });
    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.pathname).toBe('/v1/companies/DE%20B%2F1103/documents/download');
    expect(url.searchParams.get('file_type')).toBe('shareholder_list');
    expect(url.searchParams.get('document_id')).toBe('doc_123');
    expect(url.searchParams.has('file_id')).toBe(false);
    expect(url.searchParams.has('fetch_realtime')).toBe(false);
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe('GET');
    expect(result).toEqual(body);
    expect(result.document_id).toBe('doc_123');
    expect(result.label).toBe(body.label);
  });

  it('still accepts file IDs and realtime document downloads', async () => {
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, {}));
    await client.downloadDocument('DE1', {
      fileType: 'register_extract_current',
      fileId: 'file_123',
      fetchRealtime: true,
    });
    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.searchParams.get('file_type')).toBe('register_extract_current');
    expect(url.searchParams.get('file_id')).toBe('file_123');
    expect(url.searchParams.get('fetch_realtime')).toBe('true');
    expect(url.searchParams.has('document_id')).toBe(false);
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

describe('document lists', () => {
  it('lists live documents and older versions with their metadata', async () => {
    const body: CompanyDocumentList = {
      object: 'company_document_list',
      eu_id: 'DE B/1103',
      country_code: 'DE',
      coverage: { object: 'documents_coverage', status: 'available' },
      freshness: {
        object: 'freshness',
        last_checked_at: '2026-10-01T12:00:00Z',
        realtime_fetching_status: 'success',
      },
      data: [
        {
          object: 'company_document_listing',
          document_id: null,
          type: 'register_extract_current',
          type_label_de: 'Aktueller Abdruck',
          type_label_en: 'Current Register Extract',
          label: null,
          document_date: null,
          published_at: null,
          is_latest: true,
          stored: true,
          file_id: 'file_456',
          fetched_at: '2026-09-30T12:00:00Z',
          is_outdated: true,
        },
        {
          object: 'company_document_listing',
          document_id: 'doc_123',
          type: 'shareholder_list',
          type_label_de: 'Liste der Gesellschafter',
          type_label_en: 'Shareholder List',
          label: 'Liste der Gesellschafter vom 2024-01-15',
          document_date: '2024-01-15',
          published_at: '2024-01-16',
          is_latest: false,
          stored: false,
          file_id: null,
          fetched_at: null,
          is_outdated: false,
        },
      ],
    };
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, body), { apiKey: 'k' });
    const result: CompanyDocumentList = await client.listDocuments(body.eu_id);
    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.pathname).toBe('/v1/companies/DE%20B%2F1103/documents');
    expect(url.search).toBe('');
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer k' });
    expect(result).toEqual(body);
  });

  it('returns an empty Swiss catalog with coverage and freshness', async () => {
    const body: CompanyDocumentList = {
      object: 'company_document_list',
      eu_id: 'CHE123456789',
      country_code: 'CH',
      coverage: { object: 'documents_coverage', status: 'not_applicable' },
      freshness: { object: 'freshness', realtime_fetching_status: 'file_unavailable' },
      data: [],
    };
    const { client } = clientWith(() => jsonResponse(200, body));
    expect(await client.listDocuments(body.eu_id)).toEqual(body);
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
          errors: [{ param: 'q', message: 'String should have at least 3 characters' }],
        }),
      ),
    );
    await expect(client.autocomplete('ab')).rejects.toMatchObject({
      errors: [{ param: 'q', message: 'String should have at least 3 characters' }],
    });
  });

  it('asks for financial line items only when told to', async () => {
    const { client, fetchSpy } = clientWith(() => jsonResponse(200, {}));
    await client.getFinancials('DE1');
    await client.getFinancials('DE1', { includeLineItems: true, years: 3 });
    const [lean, full] = fetchSpy.mock.calls.map(([url]) => new URL(String(url)));
    expect(lean?.search).toBe('');
    expect(full?.searchParams.getAll('include')).toEqual(['line_items']);
    expect(full?.searchParams.get('years')).toBe('3');
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
          : jsonResponse(200, { data: [{ display_name: 'SAP SE' }] });
      },
      { maxRetries: 2 },
    );
    const result = await client.autocomplete('sap');
    expect(calls).toBe(2);
    // `data` is optional in the contract (the response schemas declare no
    // required fields), so the generated type makes callers check it.
    expect(result.data?.[0]?.display_name).toBe('SAP SE');
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
