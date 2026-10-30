/**
 * Official TypeScript/JavaScript client for the firmendata
 * German, Swiss and Austrian company-data API. For server-side use.
 *
 * Autocomplete is free and needs no API key:
 *
 * ```ts
 * import { FirmenData } from 'firmendata';
 *
 * const fd = new FirmenData();
 * const { data } = await fd.autocomplete('siemens');
 * ```
 */

export {
  FirmenData,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  REALTIME_TIMEOUT_MS,
  SEARCH_RESULT_CAP,
} from './client.js';
export type { AppInfo, FirmenDataOptions, LiveCallOptions, ResponseInfo } from './client.js';
export { FeedIterator } from './feeds.js';
export type { FeedCursorQuery, FeedPage } from './feeds.js';
export { VERSION } from './version.js';

export {
  FirmenDataError,
  APIError,
  APIConnectionError,
  APITimeoutError,
  AuthenticationError,
  TokenExpiredError,
  InsufficientCreditsError,
  NotFoundError,
  ConflictError,
  ValidationError,
  RateLimitError,
  ServerError,
} from './errors.js';
export type { Problem, ValidationIssue } from './errors.js';

export type * from './types.js';
