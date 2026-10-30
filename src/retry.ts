/**
 * Retry policy. Mirrors the Python SDK exactly, so the two libraries behave
 * identically under failure.
 *
 * Three rules do the work:
 *
 * - **429 is always safe to retry, on any method.** The server rejects
 *   rate-limited calls before the handler runs — nothing happened, nothing
 *   was billed. Its `Retry-After` is authoritative: the client waits that
 *   long, and when it asks for longer than {@link MAX_RETRY_DELAY_SECONDS}
 *   the `RateLimitError` is raised at once instead of hanging the call.
 *
 * - **5xx and connection failures are retried only for idempotent methods.**
 *   A `POST /v1/subscriptions` that fails with a 502 may already have created
 *   the subscription; replaying it would create a second one.
 *
 * - **Live calls are never replayed once they may have reached the server.**
 *   `fetch_realtime=true` requests and document downloads are billed when the
 *   server finishes them, whether or not the client is still waiting. A
 *   timeout, a gateway timeout, or a connection that broke after the request
 *   went out is therefore not retried — the retry could be billed a second
 *   time.
 *
 * Backoff is exponential with **full jitter**. Without the jitter, every
 * client that trips the same limit together comes back at the same instant.
 */

export const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

export const DEFAULT_MAX_RETRIES = 2;
/** The longest the client waits between two attempts, in seconds. */
export const MAX_RETRY_DELAY_SECONDS = 20;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = MAX_RETRY_DELAY_SECONDS * 1000;

export function shouldRetry(opts: {
  method: string;
  /** `undefined` for a transport failure — no response arrived. */
  statusCode?: number;
  attempt: number;
  maxRetries: number;
  /** The server's `Retry-After` on a 429, in seconds. */
  retryAfterSeconds?: number;
  /**
   * The request is billed when the server finishes it (`fetch_realtime=true`,
   * document downloads). Such a request is only replayed when it provably
   * never reached the server.
   */
  live?: boolean;
  /**
   * For a transport failure: `false` when the request provably never left
   * the client (DNS failure, connection refused). Defaults to `true`.
   */
  requestSent?: boolean;
}): boolean {
  const { method, statusCode, attempt, maxRetries, retryAfterSeconds } = opts;
  if (attempt >= maxRetries) return false;

  const idempotent = IDEMPOTENT_METHODS.has(method.toUpperCase());
  const live = opts.live === true;

  if (statusCode === undefined) {
    // Reset, timeout, DNS. A live call that may have arrived is not replayed.
    return idempotent && !(live && opts.requestSent !== false);
  }
  if (statusCode === 429) {
    // Never executed, so always replayable — unless the server asks for a
    // wait longer than we are prepared to block for.
    return retryAfterSeconds === undefined || retryAfterSeconds <= MAX_RETRY_DELAY_SECONDS;
  }
  if (statusCode === 408 || statusCode === 504) return idempotent && !live;
  if (statusCode >= 500) return idempotent;
  return false;
}

/** Delay in milliseconds before the next attempt. `attempt` is 0-based. */
export function backoffMs(
  attempt: number,
  opts: { retryAfterSeconds?: number; random?: () => number } = {},
): number {
  const { retryAfterSeconds, random = Math.random } = opts;
  if (retryAfterSeconds !== undefined && retryAfterSeconds >= 0) {
    // The server knows when the window actually resets; guessing shorter
    // just burns another rejection.
    return Math.min(retryAfterSeconds * 1000, MAX_DELAY_MS);
  }
  const ceiling = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return random() * ceiling;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
