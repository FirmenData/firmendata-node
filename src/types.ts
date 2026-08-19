/**
 * Public type aliases, derived from the generated schema.
 *
 * Nothing here is hand-written: every alias is projected out of
 * `src/schema.ts`, which `npm run generate` regenerates from the vendored
 * `contracts/openapi.v1.json`. Add an endpoint to the API and the alias
 * follows; rename a filter and the compiler points at every call site.
 */

import type { paths } from './schema.js';

/** The 200 JSON body of an operation. */
export type ResponseOf<T> = T extends {
  responses: { 200: { content: { 'application/json': infer R } } };
}
  ? R
  : never;

/** The query parameters of an operation, with optionality preserved. */
export type QueryOf<T> = T extends { parameters: { query?: infer Q } }
  ? NonNullable<Q>
  : Record<string, never>;

type Get<P extends keyof paths> = paths[P] extends { get: infer O } ? O : never;

// -- companies --------------------------------------------------------------

export type AutocompleteResponse = ResponseOf<Get<'/v1/companies/autocomplete'>>;
export type AutocompleteQuery = QueryOf<Get<'/v1/companies/autocomplete'>>;

export type SearchResponse = ResponseOf<Get<'/v1/companies/search'>>;
/** Every `/companies/search` filter. All optional; they combine with AND. */
export type SearchFilters = QueryOf<Get<'/v1/companies/search'>>;

export type CompanyDetail = ResponseOf<Get<'/v1/companies/{eu_id}'>>;
export type CompanyFinancials = ResponseOf<Get<'/v1/companies/{eu_id}/financials'>>;
export type ShareholdersReport = ResponseOf<Get<'/v1/companies/{eu_id}/shareholders'>>;
export type UboReport = ResponseOf<Get<'/v1/companies/{eu_id}/ubo'>>;
export type CompanyHistory = ResponseOf<Get<'/v1/companies/{eu_id}/history'>>;
export type CompanyDocumentDownload = ResponseOf<
  Get<'/v1/companies/{eu_id}/documents/download'>
>;
export type DocumentQuery = QueryOf<Get<'/v1/companies/{eu_id}/documents/download'>>;

// -- subscriptions ----------------------------------------------------------

export type SubscriptionList = ResponseOf<Get<'/v1/subscriptions'>>;
export type SubscriptionFilters = QueryOf<Get<'/v1/subscriptions'>>;
export type Subscription = ResponseOf<Get<'/v1/subscriptions/{subscription_id}'>>;
export type SubscriptionEventList = ResponseOf<
  Get<'/v1/subscriptions/{subscription_id}/events'>
>;
export type SubscriptionEvent = ResponseOf<Get<'/v1/subscriptions/events/{event_id}'>>;

export type SubscriptionCreated = paths['/v1/subscriptions']['post'] extends {
  responses: { 201: { content: { 'application/json': infer R } } };
}
  ? R
  : ResponseOf<paths['/v1/subscriptions']['post']>;

export type SubscriptionCreateRequest = paths['/v1/subscriptions']['post'] extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : never;

export type { paths };
