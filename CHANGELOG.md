# Changelog

## 1.3.0

Regenerated from the updated API contract. Additive, except where noted for
`getFinancials()`.

**Coverage and fields**

- Austria: `country: 'AT'`, the Austrian register type (`AT-FB`), Firmenbuch
  courts in `register_court`, the Austrian states in `bundesland`, and
  Austrian legal forms.
- `autocomplete()` accepts an optional `country` (`DE`, `CH` or `AT`);
  autocomplete hits include `registered_seat`.
- Company contact details include `phones` (phone and fax numbers) and
  `primary_email`.
- Financial summaries include `latest_equity`; each year in `history.metrics`
  carries its top-level `balance_sheet` and `income_statement` positions.
- Error messages fall back to the problem's new `message` field, which
  `Problem` now declares.

**New methods**

- Beta event feeds: `feedNewCompanies()` and `feedInsolvencies()`, with
  schema-derived query, response and event types. Both accept
  `register_court` (German Registergericht or Austrian Firmenbuch court names,
  repeated values combined with OR); on the insolvency feed it filters by the
  company's register court, not the insolvency court.
- `iterateFeedNewCompanies()` and `iterateFeedInsolvencies()` return a
  `FeedIterator`: use it with `for await`, events are deduplicated on `id`
  within the run, and `nextCursor` holds the cursor of the last fully consumed
  page (including empty pages) to persist and resume from.
- `getLists()` and `getList(listId, { limit, cursor, sort, sort_direction })`
  read your company lists. Both are free.
- `searchAll(filters, { maxResults })` yields every search hit, following
  `next_cursor` with only the cursor and `limit` after the first page, and
  stops at `has_more: false`, `maxResults` or 10,000 results. Each page of up
  to 50 results costs 1 credit.
- `testDelivery()` and `resendEvent()` are typed from the contract
  (`SubscriptionTestRequest` / `SubscriptionTestResponse`,
  `SubscriptionEventResendResponse`) instead of `unknown`.

**Financials**

- `getFinancials()` takes `details`. The API now returns the full line items
  by default; pass `details: false` for the lean response. `includeLineItems`
  is deprecated and sent as `details` (it no longer sends `include=line_items`).
  Calls that passed nothing now receive the full line items, as the API does.

**Client behaviour**

- Every request sends `X-FirmenData-Client: node-sdk/<version>`. On Node the
  `User-Agent` is `firmendata-node/<version> node/<node version>`; it is never
  set in a browser-like runtime. The new `appInfo: { name, version?, url? }`
  option appends your integration to it. `VERSION` is exported.
- New `onResponse` option: called for every HTTP response with `status`,
  `headers`, `requestId` and `creditsCharged`.
- Realtime calls (`fetchRealtime: true`), document listings and downloads are
  no longer retried after a timeout, a gateway timeout or a connection that
  broke after the request was sent — the server bills them when it finishes,
  so a retry could be billed twice. Their timeout is at least 150 seconds
  (`REALTIME_TIMEOUT_MS`) unless the call passes its own `timeoutMs`, which the
  live-capable methods now accept.
- A `429` whose `Retry-After` exceeds 20 seconds throws `RateLimitError` at
  once, with `retryAfter` in seconds, instead of waiting 20 seconds per retry
  and failing anyway.
- The README documents the SDK as server-side only: browser calls from
  third-party sites are blocked by CORS.

## 1.2.1

Regenerated from the updated API contract. Additive, non-breaking:

- The `company_size` search filter now accepts `kleinst`
  (Kleinstkapitalgesellschaft, § 267a HGB), alongside `klein` and `mittelgross`.
  Its description now refers to § 267 / § 267a HGB.

## 1.2.0

Regenerated from API contract 1.2.0. Additive, non-breaking:

- Company profiles, search/list rows and autocomplete hits now require
  `country_code` (`DE` or `CH`). Search hits also include `registered_seat`.
- Search accepts a single `country` and multiple Swiss `canton` codes,
  OR-merged with `bundesland`; `rechtsform` includes Swiss legal forms such
  as `AG (CH)` and `GmbH (CH)`. `sort=name` defaults to ascending.
- `listDocuments(euId)` returns `CompanyDocumentList` from a live registry
  check, including older DK versions, document IDs, labels, dates, latest
  and stored flags, file IDs, fetch timestamps and outdated flags, plus
  `coverage`, `freshness` and `country_code`. Costs 5 credits; Swiss, empty
  and registry-unreachable responses are unbilled.
- `downloadDocument()` accepts `documentId` for a specific DK version with
  a matching `fileType`. It cannot be combined with `fileId` or
  `fetchRealtime: true`. Responses include `document_id` and `label`.

## 1.0.0

Regenerated from API contract 1.1.0. **Breaking:**

- `CompanyDetail.status` is now `legal_status`.
- `CompanyFinancials.id` is now `eu_id`.
- `SubscriptionList` and `SubscriptionEventList` return `data` (was `items`)
  plus the standard `pagination` object; `listEvents()` takes a `cursor`.
- `getFinancials()` is lean by default: pass `{ includeLineItems: true }` for
  the P&L / balance-sheet rows; `years` limits the history. Subsidiaries are
  capped at 25 (`subsidiaries_total` has the count).
- `CompanyHistory` uses English keys and ISO dates (see the API reference).
- `APIError.errors` is `{ param, message }[]` (was free-form).
- Cursors are signed: pass `next_cursor` back unchanged.
- The API now rejects unknown parameters, unknown values and inverted ranges
  with `ValidationError`.
- `execution_time_ms` is an integer; `Wz2025Score.score` is 0–1.

New fields include `is_branch`, `register_canton`, `uid` (Swiss companies),
`is_outdated` on documents, and the latest revenue, profit and headcount with
their years in `financial_summary`. Responses carry `X-Credits-Charged`;
answers without data (e.g. no cap table on file) cost no credits.
