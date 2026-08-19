/**
 * Typed errors mapped from the API's RFC 7807 problem responses.
 *
 * Every non-2xx body looks like:
 *
 * ```json
 * {
 *   "type":   "https://api.firmendata.com/problems/insufficient-credits",
 *   "title":  "Insufficient credits.",
 *   "status": 402,
 *   "detail": "Your credit balance is too low for this request.",
 *   "request_id": "8e510d86-..."
 * }
 * ```
 *
 * The subclass is chosen by the `type` slug rather than the status code: the
 * slug is the stable part of the contract, and one status can cover several
 * distinct failures. `requestId` survives on every error — quote it to
 * support and it identifies the exact call in our logs.
 *
 * Kept deliberately in step with the Python SDK's hierarchy so the two
 * libraries fail the same way.
 */

export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  request_id?: string;
  errors?: Array<Record<string, unknown>>;
}

export class FirmenDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Required for `instanceof` to work when the package is compiled to ES5
    // by a consumer's bundler.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The request never produced a response (DNS, TLS, socket reset). */
export class APIConnectionError extends FirmenDataError {}

/** The request exceeded the configured timeout. */
export class APITimeoutError extends APIConnectionError {}

/** A structured error response from the API. */
export class APIError extends FirmenDataError {
  readonly statusCode: number;
  readonly problemType?: string;
  readonly title?: string;
  readonly detail?: string;
  readonly instance?: string;
  readonly requestId?: string;
  /** Per-field validation failures. Only populated on 422. */
  readonly errors: Array<Record<string, unknown>>;
  readonly headers: Record<string, string>;

  constructor(
    message: string,
    init: {
      statusCode: number;
      problem?: Problem;
      headers?: Record<string, string>;
    },
  ) {
    super(message);
    const p = init.problem ?? {};
    this.statusCode = init.statusCode;
    this.problemType = p.type;
    this.title = p.title;
    this.detail = p.detail;
    this.instance = p.instance;
    this.requestId = p.request_id ?? init.headers?.['x-request-id'];
    this.errors = p.errors ?? [];
    this.headers = init.headers ?? {};
  }
}

/** No valid API key — also raised when a keyless call uses a paid feature. */
export class AuthenticationError extends APIError {}
/** The key was valid but has expired. */
export class TokenExpiredError extends AuthenticationError {}
/** Not enough credits for this call. */
export class InsufficientCreditsError extends APIError {}
/** No such company, subscription or event. */
export class NotFoundError extends APIError {}
/** Conflicts with existing state. */
export class ConflictError extends APIError {}
/** Bad parameters — see `.errors`. */
export class ValidationError extends APIError {}
/** 5xx. Retried automatically for idempotent requests. */
export class ServerError extends APIError {}

/** Rate limit exceeded; the retry budget was exhausted. */
export class RateLimitError extends APIError {
  /** The server's `Retry-After`, in seconds, when it sent one. */
  readonly retryAfter?: number;

  constructor(
    message: string,
    init: {
      statusCode: number;
      problem?: Problem;
      headers?: Record<string, string>;
      retryAfter?: number;
    },
  ) {
    super(message, init);
    this.retryAfter = init.retryAfter;
  }
}

const BY_SLUG: Record<string, new (m: string, i: never) => APIError> = {
  unauthenticated: AuthenticationError as never,
  'token-expired': TokenExpiredError as never,
  'insufficient-credits': InsufficientCreditsError as never,
  'not-found': NotFoundError as never,
  conflict: ConflictError as never,
  'validation-error': ValidationError as never,
  'rate-limit-exceeded': RateLimitError as never,
};

const BY_STATUS: Record<number, new (m: string, i: never) => APIError> = {
  401: AuthenticationError as never,
  402: InsufficientCreditsError as never,
  404: NotFoundError as never,
  409: ConflictError as never,
  422: ValidationError as never,
  429: RateLimitError as never,
};

function retryAfterSeconds(headers: Record<string, string>): number | undefined {
  const raw = headers['retry-after'];
  if (!raw) return undefined;
  const n = Number(raw);
  // The HTTP-date form is legal but this API always sends seconds. Rather
  // than guess at a date parse, fall through to the caller's own backoff.
  return Number.isFinite(n) ? n : undefined;
}

export function buildError(
  statusCode: number,
  body: unknown,
  headers: Record<string, string>,
): APIError {
  const problem: Problem = body !== null && typeof body === 'object' ? (body as Problem) : {};

  const slug =
    typeof problem.type === 'string'
      ? problem.type.replace(/\/$/, '').split('/').pop()
      : undefined;

  const Cls =
    (slug ? BY_SLUG[slug] : undefined) ??
    BY_STATUS[statusCode] ??
    (statusCode >= 500 ? ServerError : APIError);

  const message = problem.detail ?? problem.title ?? `HTTP ${statusCode}`;
  const init = {
    statusCode,
    problem,
    headers,
    ...(Cls === (RateLimitError as never) ? { retryAfter: retryAfterSeconds(headers) } : {}),
  };
  return new Cls(message, init as never);
}
