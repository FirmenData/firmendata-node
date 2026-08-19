/**
 * Official TypeScript/JavaScript client for the firmendata
 * German company-data API.
 *
 * Autocomplete is free and needs no API key:
 *
 * ```ts
 * import { FirmenData } from '@firmendata/sdk';
 *
 * const fd = new FirmenData();
 * const { data } = await fd.autocomplete('siemens');
 * ```
 */

export { FirmenData, DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from './client.js';
export type { FirmenDataOptions } from './client.js';

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
export type { Problem } from './errors.js';

export type * from './types.js';
