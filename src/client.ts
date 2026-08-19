/**
 * The firmendata API client.
 *
 * Built on the platform `fetch`, with **no runtime dependencies** — so it runs
 * unchanged on Node 18+, Bun, Deno, Cloudflare Workers and the browser, and
 * adds nothing to a consumer's dependency tree.
 */

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  RateLimitError,
  buildError,
} from './errors.js';
import { DEFAULT_MAX_RETRIES, backoffMs, shouldRetry, sleep } from './retry.js';
import type {
  AutocompleteResponse,
  CompanyDetail,
  CompanyDocumentDownload,
  CompanyFinancials,
  CompanyHistory,
  SearchFilters,
  SearchResponse,
  ShareholdersReport,
  Subscription,
  SubscriptionCreated,
  SubscriptionCreateRequest,
  SubscriptionEvent,
  SubscriptionEventList,
  SubscriptionFilters,
  SubscriptionList,
  UboReport,
} from './types.js';

export const DEFAULT_BASE_URL = 'https://api.firmendata.com';
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface FirmenDataOptions {
  /**
   * Optional. Without a key `autocomplete()` still works — it is the free
   * tier. Every other method will throw `AuthenticationError`.
   */
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Retries per request. `0` disables. See {@link shouldRetry}. */
  maxRetries?: number;
  /** Injection point for tests and for custom transports. */
  fetch?: typeof globalThis.fetch;
}

type QueryValue = string | number | boolean | Array<string | number> | undefined | null;

export class FirmenData {
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: FirmenDataOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    // Bind so a bare `fetch` reference doesn't lose its `this` in browsers.
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // -- internals ------------------------------------------------------------

  #url(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        // Repeat the key — `?city=Berlin&city=Hamburg` is what the API
        // parses, not a comma-joined single value.
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.append(key, String(value));
      }
    }
    return url.toString();
  }

  #headers(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (hasBody) headers['Content-Type'] = 'application/json';
    return headers;
  }

  async #request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, QueryValue>; body?: unknown } = {},
  ): Promise<T> {
    const url = this.#url(path, options.query);
    const hasBody = options.body !== undefined;

    for (let attempt = 0; ; attempt++) {
      let statusCode: number | undefined;
      let retryAfterSeconds: number | undefined;
      let error: Error;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.#fetch(url, {
          method,
          headers: this.#headers(hasBody),
          body: hasBody ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });
        statusCode = response.status;

        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });

        const text = await response.text();
        let parsed: unknown = undefined;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = undefined;
          }
        }

        if (response.ok) return parsed as T;

        const apiError = buildError(response.status, parsed, headers);
        if (apiError instanceof RateLimitError) retryAfterSeconds = apiError.retryAfter;
        error = apiError;
      } catch (caught) {
        if (caught instanceof APIError) {
          error = caught;
        } else if (caught instanceof Error && caught.name === 'AbortError') {
          error = new APITimeoutError(`Request timed out after ${this.timeoutMs}ms`);
        } else {
          error = new APIConnectionError(
            caught instanceof Error ? caught.message : String(caught),
          );
        }
      } finally {
        clearTimeout(timer);
      }

      if (!shouldRetry({ method, statusCode, attempt, maxRetries: this.maxRetries })) {
        throw error;
      }
      await sleep(backoffMs(attempt, { retryAfterSeconds }));
    }
  }

  // -- companies ------------------------------------------------------------

  /**
   * Company-name suggestions for a search box.
   *
   * Free and callable **without an API key** — the one endpoint that is.
   * Keyless calls are rate limited by address; supplying a key raises that
   * substantially. The exact keyless limits are not published and may be
   * tightened without notice — honour `Retry-After` on a 429 (this client
   * does).
   *
   * `fetchRealtime` searches the German registers live so a company founded
   * days ago is findable immediately. It **requires an API key** and costs
   * credits; keyless calls that set it throw `AuthenticationError`.
   */
  autocomplete(
    q: string,
    options: { limit?: number; fetchRealtime?: boolean } = {},
  ): Promise<AutocompleteResponse> {
    return this.#request('GET', '/v1/companies/autocomplete', {
      query: {
        q,
        limit: options.limit,
        fetch_realtime: options.fetchRealtime,
      },
    });
  }

  /**
   * Advanced search over the German commercial register.
   *
   * Filters combine with AND; array filters combine with OR internally.
   * Paginate by passing `pagination.next_cursor` back as `cursor`.
   */
  search(filters: SearchFilters = {}): Promise<SearchResponse> {
    return this.#request('GET', '/v1/companies/search', {
      query: filters as Record<string, QueryValue>,
    });
  }

  getCompany(euId: string, options: { fetchRealtime?: boolean } = {}): Promise<CompanyDetail> {
    return this.#request('GET', `/v1/companies/${encodeURIComponent(euId)}`, {
      query: { fetch_realtime: options.fetchRealtime },
    });
  }

  getFinancials(euId: string): Promise<CompanyFinancials> {
    return this.#request('GET', `/v1/companies/${encodeURIComponent(euId)}/financials`);
  }

  getShareholders(
    euId: string,
    options: { fetchRealtime?: boolean } = {},
  ): Promise<ShareholdersReport> {
    return this.#request('GET', `/v1/companies/${encodeURIComponent(euId)}/shareholders`, {
      query: { fetch_realtime: options.fetchRealtime },
    });
  }

  getUbo(euId: string, options: { fetchRealtime?: boolean } = {}): Promise<UboReport> {
    return this.#request('GET', `/v1/companies/${encodeURIComponent(euId)}/ubo`, {
      query: { fetch_realtime: options.fetchRealtime },
    });
  }

  getHistory(euId: string, options: { fetchRealtime?: boolean } = {}): Promise<CompanyHistory> {
    return this.#request('GET', `/v1/companies/${encodeURIComponent(euId)}/history`, {
      query: { fetch_realtime: options.fetchRealtime },
    });
  }

  downloadDocument(
    euId: string,
    options: { fileType: string; fileId?: string; fetchRealtime?: boolean },
  ): Promise<CompanyDocumentDownload> {
    return this.#request(
      'GET',
      `/v1/companies/${encodeURIComponent(euId)}/documents/download`,
      {
        query: {
          file_type: options.fileType,
          file_id: options.fileId,
          fetch_realtime: options.fetchRealtime,
        },
      },
    );
  }

  // -- subscriptions --------------------------------------------------------

  listSubscriptions(filters: SubscriptionFilters = {}): Promise<SubscriptionList> {
    return this.#request('GET', '/v1/subscriptions', {
      query: filters as Record<string, QueryValue>,
    });
  }

  /**
   * Create a change subscription.
   *
   * Not retried on 5xx: a create that times out may already have been
   * applied, and a blind replay would produce a duplicate.
   */
  createSubscription(body: SubscriptionCreateRequest): Promise<SubscriptionCreated> {
    return this.#request('POST', '/v1/subscriptions', { body });
  }

  getSubscription(subscriptionId: string): Promise<Subscription> {
    return this.#request('GET', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
  }

  deleteSubscription(subscriptionId: string): Promise<void> {
    return this.#request('DELETE', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
  }

  listEvents(
    subscriptionId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<SubscriptionEventList> {
    return this.#request(
      'GET',
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/events`,
      { query: { limit: options.limit, offset: options.offset } },
    );
  }

  getEvent(eventId: string): Promise<SubscriptionEvent> {
    return this.#request('GET', `/v1/subscriptions/events/${encodeURIComponent(eventId)}`);
  }

  resendEvent(eventId: string): Promise<unknown> {
    return this.#request(
      'POST',
      `/v1/subscriptions/events/${encodeURIComponent(eventId)}/resend`,
    );
  }

  testDelivery(body: unknown): Promise<unknown> {
    return this.#request('POST', '/v1/subscriptions/test', { body });
  }
}
