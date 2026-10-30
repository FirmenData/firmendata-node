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
type Post<P extends keyof paths> = paths[P] extends { post: infer O } ? O : never;

/** The JSON request body of an operation. */
type BodyOf<T> = T extends { requestBody: { content: { 'application/json': infer B } } }
  ? B
  : never;

// -- companies --------------------------------------------------------------

export type AutocompleteResponse = ResponseOf<Get<'/v1/companies/autocomplete'>>;
export type AutocompleteQuery = QueryOf<Get<'/v1/companies/autocomplete'>>;

export type SearchResponse = ResponseOf<Get<'/v1/companies/search'>>;
/** Every `/companies/search` filter. All optional; they combine with AND. */
export type SearchFilters = QueryOf<Get<'/v1/companies/search'>>;
/** One search result. List rows (`getList`) have the same shape. */
export type SearchHit = NonNullable<SearchResponse['data']>[number];

export type CompanyDetail = ResponseOf<Get<'/v1/companies/{eu_id}'>>;
export type CompanyFinancials = ResponseOf<Get<'/v1/companies/{eu_id}/financials'>>;
export type FinancialsQuery = QueryOf<Get<'/v1/companies/{eu_id}/financials'>>;
export type ShareholdersReport = ResponseOf<Get<'/v1/companies/{eu_id}/shareholders'>>;
export type UboReport = ResponseOf<Get<'/v1/companies/{eu_id}/ubo'>>;
export type CompanyHistory = ResponseOf<Get<'/v1/companies/{eu_id}/history'>>;
export type CompanyDocumentList = ResponseOf<Get<'/v1/companies/{eu_id}/documents'>>;
export type CompanyDocumentDownload = ResponseOf<
  Get<'/v1/companies/{eu_id}/documents/download'>
>;
export type DocumentQuery = QueryOf<Get<'/v1/companies/{eu_id}/documents/download'>>;

// -- event feeds (Beta) ------------------------------------------------------

export type FeedNewCompaniesQuery = QueryOf<Get<'/v1/feeds/new-companies'>>;
export type FeedNewCompaniesResponse = ResponseOf<Get<'/v1/feeds/new-companies'>>;
export type FeedInsolvenciesQuery = QueryOf<Get<'/v1/feeds/insolvencies'>>;
export type FeedInsolvenciesResponse = ResponseOf<Get<'/v1/feeds/insolvencies'>>;
export type FeedEvent = NonNullable<FeedNewCompaniesResponse['data']>[number];

// -- lists --------------------------------------------------------------------

/** Every list the caller owns, newest first. */
export type CompanyListsResponse = ResponseOf<Get<'/v1/lists'>>;
export type CompanyListSummary = NonNullable<CompanyListsResponse['data']>[number];
/** One page of a list's companies; rows match {@link SearchHit}. */
export type CompanyListDetail = ResponseOf<Get<'/v1/lists/{list_id}'>>;
/** Paging and sort options of `getList`. */
export type CompanyListQuery = QueryOf<Get<'/v1/lists/{list_id}'>>;

// -- subscriptions ----------------------------------------------------------

export type SubscriptionList = ResponseOf<Get<'/v1/subscriptions'>>;
export type SubscriptionFilters = QueryOf<Get<'/v1/subscriptions'>>;
export type Subscription = ResponseOf<Get<'/v1/subscriptions/{subscription_id}'>>;
export type SubscriptionEventList = ResponseOf<
  Get<'/v1/subscriptions/{subscription_id}/events'>
>;
export type SubscriptionEvent = ResponseOf<Get<'/v1/subscriptions/events/{event_id}'>>;

export type SubscriptionEventResendResponse = ResponseOf<
  Post<'/v1/subscriptions/events/{event_id}/resend'>
>;
export type SubscriptionTestResponse = ResponseOf<Post<'/v1/subscriptions/test'>>;

export type SubscriptionCreated = paths['/v1/subscriptions']['post'] extends {
  responses: { 201: { content: { 'application/json': infer R } } };
}
  ? R
  : ResponseOf<paths['/v1/subscriptions']['post']>;

/**
 * Properties the API fills in when you omit them.
 *
 * `openapi-typescript` marks a schema property carrying a `default` as
 * **required**, even when the spec's `required` list leaves it out — reasonable
 * for a response (the server always sends it), wrong for a request body. Left
 * alone it forces every caller to spell out `cadence`, `language` and `mode` on
 * a create call the API accepts without them.
 *
 * Asserted against the vendored contract in `test/types.test.ts`, so a newly
 * defaulted property fails CI instead of silently staying mandatory here.
 */
export type SubscriptionCreateRequestDefaults = 'cadence' | 'language' | 'mode';

/** The same correction for `testDelivery`'s body. Pinned in `test/types.test.ts` too. */
export type SubscriptionTestRequestDefaults = 'delivery_scenario' | 'language' | 'scenario';

type WithOptionalDefaults<B, K extends string> = Omit<B, K> &
  Partial<Pick<B, Extract<K, keyof B>>>;

export type SubscriptionCreateRequest = WithOptionalDefaults<
  BodyOf<Post<'/v1/subscriptions'>>,
  SubscriptionCreateRequestDefaults
>;

export type SubscriptionTestRequest = WithOptionalDefaults<
  BodyOf<Post<'/v1/subscriptions/test'>>,
  SubscriptionTestRequestDefaults
>;

export type { paths };
