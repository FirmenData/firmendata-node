/**
 * The firmendata API client.
 *
 * Built on the platform `fetch`, with **no runtime dependencies** — so it runs
 * unchanged on Node 18+, Bun, Deno and Cloudflare Workers, and adds nothing
 * to a consumer's dependency tree. It is meant for server-side use: the API
 * does not accept browser calls from third-party sites (CORS), and an API key
 * shipped to a browser would be public anyway.
 */

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  RateLimitError,
  buildError,
} from './errors.js';
import { FeedIterator } from './feeds.js';
import { DEFAULT_MAX_RETRIES, backoffMs, shouldRetry, sleep } from './retry.js';
import type {
  AutocompleteQuery,
  AutocompleteResponse,
  CompanyDetail,
  CompanyDocumentDownload,
  CompanyDocumentList,
  CompanyFinancials,
  CompanyHistory,
  CompanyListDetail,
  CompanyListQuery,
  CompanyListsResponse,
  FeedInsolvenciesQuery,
  FeedInsolvenciesResponse,
  FeedNewCompaniesQuery,
  FeedNewCompaniesResponse,
  SearchFilters,
  SearchHit,
  SearchResponse,
  ShareholdersReport,
  Subscription,
  SubscriptionCreated,
  SubscriptionCreateRequest,
  SubscriptionEvent,
  SubscriptionEventList,
  SubscriptionEventResendResponse,
  SubscriptionFilters,
  SubscriptionList,
  SubscriptionTestRequest,
  SubscriptionTestResponse,
  UboReport,
} from './types.js';
import { VERSION } from './version.js';

export const DEFAULT_BASE_URL = 'https://api.firmendata.com';
export const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * The minimum timeout for live calls — `fetchRealtime: true` and document
 * downloads — which can take up to about two minutes. Applies unless the call
 * sets its own `timeoutMs`.
 */
export const REALTIME_TIMEOUT_MS = 150_000;
/** `/companies/search` serves at most this many results for one query. */
export const SEARCH_RESULT_CAP = 10_000;

const SEARCH_PAGE_MAX = 50;

/** Identifies your integration in the `User-Agent`, like Stripe's `appInfo`. */
export interface AppInfo {
  /** Your application or plugin name, e.g. `'acme-crm'`. */
  name: string;
  version?: string;
  url?: string;
}

/** Metadata of one HTTP response, passed to `onResponse`. */
export interface ResponseInfo {
  status: number;
  /** Response headers, with lower-cased names. */
  headers: Record<string, string>;
  /** `X-Request-Id` — quote it to support. */
  requestId?: string;
  /** `X-Credits-Charged`: credits this call deducted. `undefined` when absent. */
  creditsCharged?: number;
}

export interface FirmenDataOptions {
  /**
   * Optional. Without a key `autocomplete()` still works — it is the free
   * tier. Every other method will throw `AuthenticationError`.
   */
  apiKey?: string;
  baseUrl?: string;
  /**
   * Per-attempt timeout. Live calls (`fetchRealtime: true`, document
   * downloads) use at least {@link REALTIME_TIMEOUT_MS} unless the call
   * passes its own `timeoutMs`.
   */
  timeoutMs?: number;
  /** Retries per request. `0` disables. See {@link shouldRetry}. */
  maxRetries?: number;
  /** Injection point for tests and for custom transports. */
  fetch?: typeof globalThis.fetch;
  /** Appended to the `User-Agent` as ` name/version (url)`. */
  appInfo?: AppInfo;
  /**
   * Called for every HTTP response — successes, errors, and responses the
   * client then retries — before the call resolves or throws. Use it to
   * track `creditsCharged` or log `requestId`. An error thrown here
   * propagates to the caller.
   */
  onResponse?: (info: ResponseInfo) => void | Promise<void>;
}

/** Per-call options of every method that can make a live, billed call. */
export interface LiveCallOptions {
  /** Fetch from the register live instead of answering from stored data. Costs more credits. */
  fetchRealtime?: boolean;
  /** Timeout for this call, overriding the client's (and the live minimum). */
  timeoutMs?: number;
}

type QueryValue = string | number | boolean | Array<string | number> | undefined | null;

interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /**
   * Billed when the server finishes, whether or not we are still waiting.
   * `fetch_realtime=true` in the query implies it.
   */
  live?: boolean;
  /** Explicit per-call timeout from the caller. */
  timeoutMs?: number;
}

/** Transport failures that provably happened before the request left the client. */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function errorCode(error: unknown): string | undefined {
  for (let e: unknown = error, depth = 0; e && depth < 3; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

const MAX_APP_INFO_LENGTH = { name: 64, version: 32, url: 256 } as const;

function appInfoPart(field: keyof AppInfo, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new TypeError(`appInfo.${field} must be a string`);
  // Control characters (CR/LF above all) would let the value break out of the header.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new TypeError(`appInfo.${field} must not contain line breaks or control characters`);
  }
  const trimmed = value.trim().slice(0, MAX_APP_INFO_LENGTH[field]);
  return trimmed || undefined;
}

function appInfoSuffix(appInfo: AppInfo | undefined): string {
  if (appInfo === undefined) return '';
  const name = appInfoPart('name', appInfo.name);
  if (!name) throw new TypeError('appInfo.name must be a non-empty string');
  const version = appInfoPart('version', appInfo.version);
  const url = appInfoPart('url', appInfo.url);
  return ` ${name}${version ? `/${version}` : ''}${url ? ` (${url})` : ''}`;
}

/**
 * `firmendata-node/<version> node/<node version> <appInfo>`, or `undefined`
 * in a browser-like runtime, where the browser owns the `User-Agent`.
 */
function userAgent(appInfo: AppInfo | undefined): string | undefined {
  const suffix = appInfoSuffix(appInfo); // validate even where it is not sent
  const g = globalThis as {
    window?: unknown;
    document?: unknown;
    importScripts?: unknown;
    process?: { versions?: { node?: unknown } };
  };
  if (
    g.window !== undefined ||
    g.document !== undefined ||
    typeof g.importScripts === 'function'
  ) {
    return undefined;
  }
  const node = g.process?.versions?.node;
  const runtime = typeof node === 'string' ? ` node/${node}` : '';
  return `firmendata-node/${VERSION}${runtime}${suffix}`;
}

function responseInfo(
  status: number,
  headers: Record<string, string>,
  body: unknown,
): ResponseInfo {
  const fromBody =
    body !== null && typeof body === 'object'
      ? (body as { request_id?: unknown }).request_id
      : undefined;
  const credits = Number.parseInt(headers['x-credits-charged'] ?? '', 10);
  return {
    status,
    headers,
    requestId: headers['x-request-id'] ?? (typeof fromBody === 'string' ? fromBody : undefined),
    creditsCharged: Number.isFinite(credits) ? credits : undefined,
  };
}

const LIVE_NOTE =
  'Live calls (fetchRealtime: true, document listings and downloads) are not retried once ' +
  'they may have reached the server: the server can still finish this one, and it is ' +
  'billed when it does.';

export class FirmenData {
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #userAgent?: string;
  readonly #onResponse?: (info: ResponseInfo) => void | Promise<void>;

  constructor(options: FirmenDataOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    // Bind so a bare `fetch` reference doesn't lose its `this`.
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#userAgent = userAgent(options.appInfo);
    this.#onResponse = options.onResponse;
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

  /** The one place request headers are built. */
  #headers(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-FirmenData-Client': `node-sdk/${VERSION}`,
    };
    if (this.#userAgent) headers['User-Agent'] = this.#userAgent;
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (hasBody) headers['Content-Type'] = 'application/json';
    return headers;
  }

  async #request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.#url(path, options.query);
    const hasBody = options.body !== undefined;
    const live = options.live === true || options.query?.fetch_realtime === true;
    const timeoutMs =
      options.timeoutMs ??
      (live ? Math.max(this.timeoutMs, REALTIME_TIMEOUT_MS) : this.timeoutMs);

    for (let attempt = 0; ; attempt++) {
      let statusCode: number | undefined;
      let retryAfterSeconds: number | undefined;
      let requestSent = true;
      let info: ResponseInfo | undefined;
      let parsed: unknown = undefined;
      let error: Error | undefined;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await this.#fetch(url, {
          method,
          headers: this.#headers(hasBody),
          body: hasBody ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });

        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });

        const text = await response.text();
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = undefined;
          }
        }
        statusCode = response.status;
        info = responseInfo(response.status, headers, parsed);

        if (!response.ok) {
          const apiError = buildError(response.status, parsed, headers);
          if (apiError instanceof RateLimitError) retryAfterSeconds = apiError.retryAfter;
          error = apiError;
        }
      } catch (caught) {
        if (caught instanceof APIError) {
          error = caught;
        } else if ((caught as { name?: unknown } | null)?.name === 'AbortError') {
          const seconds = timeoutMs / 1000;
          error = new APITimeoutError(
            live
              ? `Request timed out after ${seconds}s. ${LIVE_NOTE} Pass a higher timeoutMs ` +
                  'for this call (or on the client) if it needs longer.'
              : `Request timed out after ${seconds}s.`,
          );
        } else {
          requestSent = !NOT_SENT_CODES.has(errorCode(caught) ?? '');
          const message = caught instanceof Error ? caught.message : String(caught);
          error = new APIConnectionError(
            live && requestSent ? `${message}. ${LIVE_NOTE}` : message,
          );
        }
      } finally {
        clearTimeout(timer);
      }

      // Outside the try, so an error thrown by the callback reaches the caller as-is.
      if (info && this.#onResponse) await this.#onResponse(info);
      if (error === undefined) return parsed as T;

      if (
        !shouldRetry({
          method,
          statusCode,
          attempt,
          maxRetries: this.maxRetries,
          retryAfterSeconds,
          live,
          requestSent,
        })
      ) {
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
   * does, up to 20 seconds; a longer wait throws `RateLimitError` at once).
   *
   * `fetchRealtime` searches the German registers live so a company founded
   * days ago is findable immediately. It **requires an API key** and costs
   * credits; keyless calls that set it throw `AuthenticationError`.
   */
  autocomplete(
    q: string,
    options: LiveCallOptions & {
      limit?: number;
      country?: AutocompleteQuery['country'];
    } = {},
  ): Promise<AutocompleteResponse> {
    return this.#request('GET', '/v1/companies/autocomplete', {
      query: {
        q,
        limit: options.limit,
        fetch_realtime: options.fetchRealtime,
        country: options.country,
      },
      timeoutMs: options.timeoutMs,
    });
  }

  /**
   * Advanced search over the German, Swiss and Austrian commercial registers.
   *
   * Filters combine with AND; array filters combine with OR internally.
   * Paginate by passing `pagination.next_cursor` back as `cursor`, unchanged —
   * cursors are signed, and one that was edited is rejected with a 422.
   * Unknown filter names and inverted ranges are 422s too, never ignored.
   * {@link searchAll} pages for you.
   */
  search(
    filters: SearchFilters = {},
    options: Pick<LiveCallOptions, 'timeoutMs'> = {},
  ): Promise<SearchResponse> {
    return this.#request('GET', '/v1/companies/search', {
      query: filters as Record<string, QueryValue>,
      timeoutMs: options.timeoutMs,
    });
  }

  /**
   * Every hit of a search, page by page, following `pagination.next_cursor`.
   *
   * After the first page only the cursor (and `limit`) is sent — the cursor
   * carries the filters. Stops when `has_more` is false, after `maxResults`
   * hits, or at the API's {@link SEARCH_RESULT_CAP}. Each page (up to 50
   * hits) is one call, billed like `search()`; break out of the loop to stop
   * paying for pages you do not need.
   */
  async *searchAll(
    filters: SearchFilters = {},
    options: { maxResults?: number } = {},
  ): AsyncGenerator<SearchHit, void, undefined> {
    const cap = Math.min(options.maxResults ?? SEARCH_RESULT_CAP, SEARCH_RESULT_CAP);
    if (!(cap > 0)) return;
    const limit =
      filters.limit ??
      (options.maxResults !== undefined ? Math.min(SEARCH_PAGE_MAX, cap) : undefined);
    let query: SearchFilters = limit === undefined ? filters : { ...filters, limit };
    let yielded = 0;
    for (;;) {
      const page = await this.search(query);
      for (const hit of page.data ?? []) {
        yield hit;
        if (++yielded >= cap) return;
      }
      const cursor = page.pagination?.next_cursor;
      if (!page.pagination?.has_more || !cursor || cursor === query.cursor) return;
      query = limit === undefined ? { cursor } : { cursor, limit };
    }
  }

  getCompany(euId: string, options: LiveCallOptions = {}): Promise<CompanyDetail> {
    return this.#request('GET', `/v1/companies/${encodeURIComponent(euId)}`, {
      query: { fetch_realtime: options.fetchRealtime },
      timeoutMs: options.timeoutMs,
    });
  }

  /**
   * Multi-year financials. By default the response carries every filed P&L,
   * assets and liabilities-and-equity row (`history.profit_and_loss`,
   * `history.assets`, `history.liabilities_and_equity`) — often 100 KB+ for
   * groups. Pass `details: false` for the lean response: those arrays stay
   * empty, and each year keeps its top-level `balance_sheet` and
   * `income_statement` positions in `history.metrics`. Both cost the same.
   * `years` keeps just the N most recent fiscal years in every per-year array.
   */
  getFinancials(
    euId: string,
    options: {
      /** `false` for the lean response. Omit for the full line items (the default). */
      details?: boolean;
      /**
       * @deprecated Line items are included by default; use `details`.
       * `includeLineItems: x` is sent as `details: x` (ignored when `details` is set).
       */
      includeLineItems?: boolean;
      years?: number;
    } = {},
  ): Promise<CompanyFinancials> {
    return this.#request('GET', `/v1/companies/${encodeURIComponent(euId)}/financials`, {
      query: {
        details: options.details ?? options.includeLineItems,
        years: options.years,
      },
    });
  }

  getShareholders(euId: string, options: LiveCallOptions = {}): Promise<ShareholdersReport> {
    return this.#request('GET', `/v1/companies/${encodeURIComponent(euId)}/shareholders`, {
      query: { fetch_realtime: options.fetchRealtime },
      timeoutMs: options.timeoutMs,
    });
  }

  getUbo(euId: string, options: LiveCallOptions = {}): Promise<UboReport> {
    return this.#request('GET', `/v1/companies/${encodeURIComponent(euId)}/ubo`, {
      query: { fetch_realtime: options.fetchRealtime },
      timeoutMs: options.timeoutMs,
    });
  }

  getHistory(euId: string, options: LiveCallOptions = {}): Promise<CompanyHistory> {
    return this.#request('GET', `/v1/companies/${encodeURIComponent(euId)}/history`, {
      query: { fetch_realtime: options.fetchRealtime },
      timeoutMs: options.timeoutMs,
    });
  }

  /**
   * Check the registry live and list documents, including older versions.
   * A live, billed call: see {@link REALTIME_TIMEOUT_MS}.
   */
  listDocuments(
    euId: string,
    options: Pick<LiveCallOptions, 'timeoutMs'> = {},
  ): Promise<CompanyDocumentList> {
    return this.#request('GET', `/v1/companies/${encodeURIComponent(euId)}/documents`, {
      live: true,
      timeoutMs: options.timeoutMs,
    });
  }

  /**
   * Presigned download URL for a register document. A live, billed call:
   * never retried once it may have reached the server, with a timeout of at
   * least {@link REALTIME_TIMEOUT_MS} unless `timeoutMs` is set.
   */
  downloadDocument(
    euId: string,
    options: LiveCallOptions & {
      fileType: string;
      fileId?: string;
      /** From `listDocuments`; `fileType` must match. Cannot combine with `fileId` or `fetchRealtime: true`. */
      documentId?: string;
    },
  ): Promise<CompanyDocumentDownload> {
    return this.#request(
      'GET',
      `/v1/companies/${encodeURIComponent(euId)}/documents/download`,
      {
        query: {
          file_type: options.fileType,
          file_id: options.fileId,
          document_id: options.documentId,
          fetch_realtime: options.fetchRealtime,
        },
        live: true,
        timeoutMs: options.timeoutMs,
      },
    );
  }

  // -- event feeds (Beta) ----------------------------------------------------

  /**
   * Beta: one page of newly registered companies. Persist `next_cursor`, even
   * after empty pages. Page immediately while `has_more`; otherwise poll later.
   * `since` is an initial ISO datetime, at most seven days back (default: last
   * day). `limit` is 1–100 (default: 50). Deduplicate events on `id`.
   * Requires an API key; one credit per page with events, empty pages are free.
   */
  feedNewCompanies(query: FeedNewCompaniesQuery = {}): Promise<FeedNewCompaniesResponse> {
    return this.#request('GET', '/v1/feeds/new-companies', {
      query: query as Record<string, QueryValue>,
    });
  }

  /**
   * Beta: one page of insolvency notices. Uses the same cursor, polling and
   * billing rules as {@link feedNewCompanies}. Country defaults to DE;
   * Schuldenruf notices must be selected by name with `category`.
   */
  feedInsolvencies(query: FeedInsolvenciesQuery = {}): Promise<FeedInsolvenciesResponse> {
    return this.#request('GET', '/v1/feeds/insolvencies', {
      query: query as Record<string, QueryValue>,
    });
  }

  /**
   * Yield new-company events until `has_more` is false, deduplicated on `id`
   * within this run. Afterwards persist the iterator's `nextCursor` and resume
   * later with `{ cursor: nextCursor }` and the same filters. The cursor only
   * advances past fully consumed pages. Keep processed IDs across polls too:
   * the same event can appear again in a later run.
   */
  iterateFeedNewCompanies(
    query: FeedNewCompaniesQuery = {},
  ): FeedIterator<FeedNewCompaniesQuery> {
    return new FeedIterator((page) => this.feedNewCompanies(page), query);
  }

  /** Yield insolvency events until caught up. See {@link iterateFeedNewCompanies}. */
  iterateFeedInsolvencies(
    query: FeedInsolvenciesQuery = {},
  ): FeedIterator<FeedInsolvenciesQuery> {
    return new FeedIterator((page) => this.feedInsolvencies(page), query);
  }

  // -- lists ----------------------------------------------------------------

  /**
   * Your company lists, newest first, with each list's id, name, company
   * count and alert setting. Free. Lists are created and edited in the web app.
   */
  getLists(): Promise<CompanyListsResponse> {
    return this.#request('GET', '/v1/lists');
  }

  /**
   * One page of companies from one of your lists. Free. Rows have the same
   * shape as search hits; `sort` orders the whole list before the page is cut.
   * Paginate with `pagination.next_cursor` as `cursor`. An unknown list id,
   * or one that belongs to someone else, is a `NotFoundError`.
   */
  getList(listId: number, query: CompanyListQuery = {}): Promise<CompanyListDetail> {
    return this.#request('GET', `/v1/lists/${encodeURIComponent(String(listId))}`, {
      query: query as Record<string, QueryValue>,
    });
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

  /** One page of delivery events; pass `pagination.next_cursor` back as `cursor`. */
  listEvents(
    subscriptionId: string,
    options: { limit?: number; cursor?: string | null; offset?: number } = {},
  ): Promise<SubscriptionEventList> {
    return this.#request(
      'GET',
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/events`,
      { query: { limit: options.limit, cursor: options.cursor, offset: options.offset } },
    );
  }

  getEvent(eventId: string): Promise<SubscriptionEvent> {
    return this.#request('GET', `/v1/subscriptions/events/${encodeURIComponent(eventId)}`);
  }

  /** Deliver a past event again; the result records the new delivery attempt. */
  resendEvent(eventId: string): Promise<SubscriptionEventResendResponse> {
    return this.#request(
      'POST',
      `/v1/subscriptions/events/${encodeURIComponent(eventId)}/resend`,
    );
  }

  /** Send a synthetic event to a webhook URL or email address to verify delivery. */
  testDelivery(body: SubscriptionTestRequest): Promise<SubscriptionTestResponse> {
    return this.#request('POST', '/v1/subscriptions/test', { body });
  }
}
