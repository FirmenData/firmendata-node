/**
 * Retry policy. Mirrors the Python SDK exactly, so the two libraries behave
 * identically under failure.
 *
 * Two rules do the work:
 *
 * - **429 is always safe to retry, on any method.** The server rejects
 *   rate-limited calls before the handler runs — nothing happened, nothing
 *   was billed. Its `Retry-After` is authoritative and used verbatim.
 *
 * - **5xx and connection failures are retried only for idempotent methods.**
 *   A `POST /v1/subscriptions` that fails with a 502 may already have created
 *   the subscription; replaying it would create a second one.
 *
 * Backoff is exponential with **full jitter**. Without the jitter, every
 * client that trips the same limit together comes back at the same instant.
 */

export const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

export const DEFAULT_MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 20_000;

export function shouldRetry(opts: {
  method: string;
  /** `undefined` for a transport failure — no response arrived. */
  statusCode?: number;
  attempt: number;
  maxRetries: number;
}): boolean {
  const { method, statusCode, attempt, maxRetries } = opts;
  if (attempt >= maxRetries) return false;

  const idempotent = IDEMPOTENT_METHODS.has(method.toUpperCase());

  if (statusCode === undefined) return idempotent; // reset, timeout, DNS
  if (statusCode === 429) return true; // never executed
  if (statusCode === 408) return idempotent;
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
