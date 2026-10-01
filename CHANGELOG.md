# Changelog

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
