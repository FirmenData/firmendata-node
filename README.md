# firmendata

Official TypeScript/JavaScript client for the [firmendata](https://firmendata.com)
API — German, Swiss and Austrian company data from the Unternehmensregister,
Handelsregister, the Swiss commercial register and the Austrian Firmenbuch:
register search, parsed annual financial statements, company profiles,
register documents, and ownership chains for KYC.

[![npm](https://img.shields.io/npm/v/firmendata)](https://www.npmjs.com/package/firmendata)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

```bash
npm install firmendata
```

**Zero runtime dependencies.** Built on the platform `fetch`, so it runs
unchanged on Node 18+, Bun, Deno and Cloudflare Workers, and adds nothing to
your dependency tree.

**For server-side use.** The API does not accept browser calls from
third-party sites (CORS blocks them), and an API key shipped to a browser
would be public anyway. Call it from your backend, a serverless function or a
worker, and pass the results on to your frontend.

## Try it without signing up

Company-name autocomplete is free and needs **no API key**:

```ts
import { FirmenData } from 'firmendata';

const fd = new FirmenData();
const { data } = await fd.autocomplete('siemens');

for (const hit of data) {
  console.log(hit.eu_id, hit.display_name);
}
```

Keyless calls are rate limited, modestly and by address — enough to try the
API or run low-volume queries. Add a key for substantially higher limits plus
every other endpoint. On a `429`, honour `Retry-After`; the client already
does this for you (see [Retries](#retries)).

Limit suggestions to a country with `fd.autocomplete('siemens', { country: 'DE' })`.
`country` also accepts `CH` and `AT`; omit it to search across countries.

Create a key at [firmendata.com](https://firmendata.com/de/developer/api-keys) —
the free plan includes 100 credits.

```ts
const fd = new FirmenData({ apiKey: process.env.FIRMENDATA_API_KEY });
```

## Search the register

The main entry point for German, Swiss and Austrian companies. Different
filters combine with AND, repeated values with OR.

```ts
const results = await fd.search({
  bundesland: ['Bayern', 'Baden-Württemberg'],
  industry_slug: ['manufacturing'],
  total_assets_min: 1_000_000,
  legal_status: ['active'],
  sort: 'total_assets',
  limit: 25,
});

for (const hit of results.data) {
  console.log(hit.display_name, hit.address.city, hit.total_assets);
}

if (results.pagination.has_more) {
  const next = await fd.search({ cursor: results.pagination.next_cursor });
}
```

Pass `next_cursor` back unchanged — cursors are opaque and signed, and an
edited one is rejected. A cursor remembers the filters it was issued for, so
it can be sent alone. Unknown filter names, unknown values and inverted
ranges (`revenue_min` above `revenue_max`) raise `ValidationError` instead of
being ignored.

`searchAll()` does the paging for you: it yields every hit, sends only the
cursor (and `limit`) after the first page, and stops when `has_more` is false,
after `maxResults` hits, or at the 10,000 results a query can return. **Each
page of up to 50 results costs 1 credit**, like a `search()` call — set
`maxResults`, or `break` out of the loop, to stop paying for pages you do not
need.

```ts
for await (const hit of fd.searchAll({ bundesland: ['Bayern'] }, { maxResults: 500 })) {
  console.log(hit.eu_id, hit.display_name);
}
```

Values are case-insensitive and tolerate German spelling both ways — `gmbh`,
`muenchen`, `NRW` and `Bavaria` all resolve. Filter by legal form, legal
status, register court, federal state, city, industry, founding date, size,
web presence, connected person or EU public-procurement role; see the
[filter reference](https://api.firmendata.com/v1/docs#tag/Search).

Use `country: 'DE'`, `'CH'` or `'AT'` for a single country and
`canton: ['ZH', 'BE']` for Swiss cantons. `canton` and `bundesland` combine
with OR, and `bundesland` also takes the Austrian states (`'Wien'`, `'Tirol'`,
…). `rechtsform` also accepts Swiss and Austrian forms such as `'AG (CH)'`,
`'GmbH (CH)'` and `'GmbH (AT)'`, and `register_court` the Austrian Firmenbuch
courts (`'Handelsgericht Wien'`, …).

```ts
const swiss = await fd.search({ country: 'CH', canton: ['ZH', 'BE'], sort: 'name' });
```

`sort: 'name'` defaults to ascending. Company profiles, search/list rows and
autocomplete hits include `country_code` (`'DE'`, `'CH'` or `'AT'`); search
and autocomplete hits also include `registered_seat`.

`company_size` accepts `['kleinst', 'klein', 'mittelgross']` under § 267 / § 267a
HGB. Use `company_size: ['kleinst']` for micro companies
(Kleinstkapitalgesellschaften, § 267a HGB).

> **Filtering on size? Use `total_assets`, not `revenue`.** Small and
> medium-sized German companies file abridged accounts — a balance sheet, but
> no profit-and-loss statement and no headcount. A revenue or employee bound
> therefore narrows your results to the minority that publish a full P&L,
> while the balance-sheet total is available for every filing company.

## Company profile

```ts
const euId = 'DEF1103R.HRB12300B'; // from search or autocomplete

const company = await fd.getCompany(euId);
const history = await fd.getHistory(euId); // chronological register entries
```

Identity and seat, register reference, legal status from the commercial
register and insolvency notices, industry classification, contact details
(including `phones` and `primary_email`) and web presence.

## Financial statements

Filed annual accounts, parsed into figures rather than handed to you as PDFs.
The deepest part of the dataset: companies in Germany and Austria must publish
their accounts, and we parse what they file into structured multi-year
figures.

```ts
const { summary, history } = await fd.getFinancials(euId);

console.log(summary?.latest_fiscal_year, summary?.latest_total_assets, summary?.latest_equity);

for (const year of history.metrics) {
  console.log(year.year, year.balance_sheet_total, year.revenue, year.profit);
}
```

By default the response carries every filed `profit_and_loss`, `assets` and
`liabilities_and_equity` row at every depth — often 100 KB or more for
groups. Pass `details: false` for the lean response: those arrays stay empty,
and each year in `history.metrics` keeps its top-level `balance_sheet` and
`income_statement` positions. Both cost the same. `years` trims every
per-year array to the most recent fiscal years:

```ts
const lean = await fd.getFinancials(euId, { details: false, years: 5 });
```

`includeLineItems` from earlier versions still works but is deprecated: it is
sent as `details`.

`employee_history` and the underlying `financial_publications` are always
included; `relationships.subsidiaries` lists the first 25, with
`subsidiaries_total` for the count.

`summary` is `null` when nothing is on file. Within it, figures resolve to the
most recent filing that actually carries each one, so revenue and profit can
come from _different_ fiscal years — don't assume two share a year when
computing a ratio.

## Documents

```ts
const documents = await fd.listDocuments(euId);
const version = documents.data.find((item) => item.document_id);

if (version?.document_id) {
  const selected = await fd.downloadDocument(euId, {
    fileType: version.type,
    documentId: version.document_id,
  });
  console.log(selected.document_id, selected.label);
}

const doc = await fd.downloadDocument(euId, { fileType: 'register_extract_current' });
```

Aktueller and Chronologischer Abdruck, Gesellschafterliste, Satzung,
Anmeldung and Musterprotokoll, as presigned download URLs.

`listDocuments(euId)` returns a `CompanyDocumentList` after a live registry
check, including older versions, labels, dates, `is_latest`, `stored`,
`file_id`, `fetched_at` and `is_outdated`, plus `coverage`, `freshness` and
`country_code`. It costs 5 credits; Swiss companies, empty lists and
unreachable registries are unbilled. Swiss companies return an empty list
with `coverage.status: 'not_applicable'`.

Pass an item's `document_id` as `documentId` with its matching `fileType` to
download that version. Omit `documentId` for the latest version; it cannot
be combined with `fileId` or `fetchRealtime: true`. Register extracts have
no `document_id` and are downloaded by `fileType`.

Document listings and downloads are live calls — see
[Realtime calls](#realtime-calls).

## Ownership: shareholders and UBO

Cap tables and beneficial-owner chains, for **KYC and AML workflows**.

**Pass `fetchRealtime: true` on both of these.** Unlike the endpoints above,
which answer from data we keep continuously up to date, cap tables are parsed
from the filed Gesellschafterliste on demand — the flag fetches and parses the
current filing for the company (and, for `getUbo`, every German company in its
ownership chain). Without it you are limited to whatever has already been
parsed, and will often get `not_filed` for a company that has in fact filed.
It costs more credits and takes a few seconds per company in the chain, which
is the right trade for a KYC check.

```ts
const cap = await fd.getShareholders(euId, { fetchRealtime: true });

if (cap.coverage.status === 'available') {
  for (const s of cap.as_of_snapshot.shareholders) {
    console.log(s.display_name, s.share_percent);
  }
}

const ubo = await fd.getUbo(euId, { fetchRealtime: true });
console.log(ubo.coverage.status, ubo.beneficial_owners);
```

**What limits these:**

- **Only GmbH, UG and gGmbH file a Gesellschafterliste.** For an AG, KG, e.K.
  or any other form there is no cap table to read and `coverage.status` is
  `not_applicable` — not an error, and not something a retry will fix.
- **Without `fetchRealtime`, `not_filed` does not mean "never filed."** It
  means no parsed cap table is on hand for that company yet. Re-request with
  the flag before concluding anything about a company's ownership.
- **Always branch on `coverage.status`**, never on an empty array. The two
  endpoints have different vocabularies:
  `getShareholders` → `available` | `not_filed` | `not_applicable` |
  `token_limit_reached` (the filing was too large to parse);
  `getUbo` → `available` | `partial` | `not_filed` | `not_applicable`.
  **`partial` is the one to handle**: an unresolved branch could still hide a
  beneficial owner, so read `potential_beneficial_owners` and
  `coverage.reason` rather than treating the result as complete.
- **An empty `beneficial_owners` is a real answer**, not a failure: it means
  nobody crosses the 25% threshold. Fictional UBO under §3 Abs. 2 S. 5 GwG is
  not surfaced.
- **Attribution is all-or-nothing, not multiplicative.** A holds 60% of H and
  H holds 30% of the root → A is a UBO at **30%**, not 18%. Each link is
  independently tested against the 25% threshold, so a sub-threshold link
  breaks the chain entirely.

## Realtime calls

Calls with `fetchRealtime: true` (`autocomplete`, `getCompany`,
`getShareholders`, `getUbo`, `getHistory`, `downloadDocument`), searches with
`fetch_realtime: true`, `listDocuments` and every `downloadDocument` reach the
registers live. Realtime calls cost more credits (see
[pricing](https://firmendata.com/en/plans)) and can take up to about two
minutes. They are **billed when the server finishes them, even if your client
has already given up**, so the client treats them differently:

- It waits at least 150 seconds (`REALTIME_TIMEOUT_MS`) for them, or your
  client `timeoutMs` if that is longer. A `timeoutMs` passed to the call
  itself always wins: `fd.getUbo(euId, { fetchRealtime: true, timeoutMs: 60_000 })`.
- It **never retries one after a timeout**, or after a connection that broke
  once the request was sent — the retry could be billed a second time. It
  throws `APITimeoutError` (or `APIConnectionError`) instead; the call may
  still have completed and been billed.

## Event feeds (Beta)

`feedNewCompanies(query)` and `feedInsolvencies(query)` return one page with
`data`, `next_cursor` and `has_more`. An API key is required. Pass `next_cursor`
back unchanged and persist it even after an empty page. When `has_more` is true,
page again immediately; otherwise poll later. A page with events costs 1 credit;
empty pages are free. Deduplicate events on `id`: the same event can appear
more than once.

On the first call, optionally set `since` to an ISO datetime within the last
7 days (default: the last day). Use `cursor` on subsequent calls. `limit` accepts
1–100 and defaults to 50. Both feeds accept `country`, `bundesland`, `canton`,
`register_court`, `industry_slug` and `rechtsform`; array filters use repeated
query keys. `register_court` takes German Registergericht or Austrian Firmenbuch
court names (the same values as `search()`), combined with OR; select Swiss
companies with `canton`. On the insolvency feed it is the company's register
court, not the insolvency court.
Insolvencies also accepts `category`, `revenue_min` and `revenue_max`, and defaults
to country `DE`. Request `Schuldenruf` explicitly with `category` to include it.
Cursors survive restarts, but positions expire after 7 days; restart
with a recent `since` if expired. Keep filters unchanged when resuming.

The iterators `iterateFeedNewCompanies(query)` and `iterateFeedInsolvencies(query)`
yield events while `has_more` is true, deduplicating event IDs within the run.
Afterwards, persist their `nextCursor` and pass it back as `cursor`. It only
advances past fully consumed pages, including empty ones: stop partway
through a page and it stays at that page's start, so the next run replays it.
For example, poll new companies once a minute:

```ts
const fd = new FirmenData({ apiKey: process.env.FIRMENDATA_API_KEY });
let cursor: string | undefined; // Load your saved cursor on restart.
const seen = new Set<string>(); // Use durable event IDs in production.

for (;;) {
  const events = fd.iterateFeedNewCompanies({ cursor, country: 'DE' });
  for await (const event of events) {
    if (!seen.has(event.id)) {
      console.log(event.id, event.company.name);
      seen.add(event.id);
    }
  }
  cursor = events.nextCursor; // Persist after processing, even if no events arrived.
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}
```

To poll insolvencies, use `iterateFeedInsolvencies` with its own saved cursor.

## Lists

Company lists you build in the web app are readable through the API, for
free:

```ts
const lists = await fd.getLists(); // newest first

for (const list of lists.data) {
  console.log(list.list_id, list.name, list.company_count);
}

const page = await fd.getList(lists.data[0].list_id, { limit: 100, sort: 'revenue' });
for (const row of page.data) {
  console.log(row.eu_id, row.display_name); // same shape as search hits
}
```

`getList` pages like search: pass `page.pagination.next_cursor` back as
`cursor`. `sort` orders the whole list before the page is cut. A list id that
does not exist or is not yours raises `NotFoundError`.

## Subscriptions

Get notified when a company's data changes, instead of polling:

```ts
const sub = await fd.createSubscription({
  eu_id: euId,
  subscription_type: 'shareholders', // or details, history, ubo, doc_*
  cadence: 'weekly', // immediately | daily | weekly | monthly
  notification_type: 'webhook',
  webhook_url: 'https://example.com/hooks/firmendata',
});
```

Webhook bodies are HMAC-SHA256 signed — verify `X-Firmendata-Signature`
against the secret returned at creation. Omit `notification_type` to poll
`listEvents()` on your own schedule instead.

Check your receiver before subscribing with
`fd.testDelivery({ eu_id: euId, subscription_type: 'details', notification_type: 'webhook', webhook_url })`,
and deliver a past event again with `fd.resendEvent(eventId)`.

## Errors

Every failure is a typed error carrying the API's RFC 7807 problem detail,
including a `requestId` you can quote to support.

```ts
import { InsufficientCreditsError, RateLimitError } from 'firmendata';

try {
  await fd.getUbo(euId);
} catch (err) {
  if (err instanceof InsufficientCreditsError) {
    // top up or upgrade
  } else if (err instanceof RateLimitError) {
    console.log('retry after', err.retryAfter, 'seconds');
  }
}
```

| Error                                    | Status | Meaning                                                        |
| ---------------------------------------- | ------ | -------------------------------------------------------------- |
| `AuthenticationError`                    | 401    | Missing/invalid key, or a keyless call used a paid feature     |
| `TokenExpiredError`                      | 401    | Key expired                                                    |
| `InsufficientCreditsError`               | 402    | Balance too low for this call                                  |
| `NotFoundError`                          | 404    | No such company, list, subscription or event                   |
| `ConflictError`                          | 409    | Conflicts with existing state                                  |
| `ValidationError`                        | 422    | Bad parameters — see `.errors` (`{ param, message }[]`)        |
| `RateLimitError`                         | 429    | Retries exhausted, or a long `Retry-After` — see `.retryAfter` |
| `ServerError`                            | 5xx    | Retried automatically for idempotent calls                     |
| `APIConnectionError` / `APITimeoutError` | —      | No response at all                                             |

### Retries

Automatic and deliberately conservative:

- **429 is retried on any method** — the server rejects rate-limited calls
  before the handler runs, so nothing happened and nothing was billed. The
  client waits for the server's `Retry-After`, up to 20 seconds. When the
  server asks for longer — the keyless daily limit can ask for hours — the
  `RateLimitError` is thrown at once, with `retryAfter` in seconds, instead of
  holding your call open.
- **5xx and connection failures are retried only for idempotent methods.** A
  `createSubscription` that times out may already have been applied; replaying
  it would create a second one.
- **Realtime calls are never retried once they may have reached the server**
  — see [Realtime calls](#realtime-calls).
- Backoff is exponential with full jitter, so clients that trip the same limit
  together don't all return at the same instant.

Tune with `new FirmenData({ maxRetries })`; `0` disables it.

## Credits and response metadata

Successful responses carry `X-Credits-Charged`, `X-Request-Id` and the
`RateLimit-*` headers. Pass `onResponse` to see them: it is called for every
HTTP response — successes, errors, and responses the client then retries —
with `status`, `headers` (lower-cased names), `requestId` and
`creditsCharged`.

```ts
let creditsUsed = 0;

const fd = new FirmenData({
  apiKey: process.env.FIRMENDATA_API_KEY,
  onResponse: ({ status, requestId, creditsCharged, headers }) => {
    creditsUsed += creditsCharged ?? 0;
    console.log(status, requestId, creditsCharged, headers['ratelimit-remaining']);
  },
});

await fd.search({ q: 'siemens' });
console.log('credits used so far:', creditsUsed);
```

The callback may be `async`; the call waits for it. An error it throws
reaches the caller of the method.

## Types

Every request and response type is **derived from the OpenAPI contract**, not
hand-written. `src/schema.ts` is generated from
[`contracts/openapi.v1.json`](contracts/openapi.v1.json) — a vendored copy of
the published spec — and `src/types.ts` projects the public aliases out of it:

```bash
npm run generate
```

CI regenerates and fails if the result differs from what is committed, so the
SDK cannot silently drift from the API it targets.

## Configuration

```ts
new FirmenData({
  apiKey: '...', // optional — omit for the free autocomplete tier
  baseUrl: '...', // default https://api.firmendata.com
  timeoutMs: 30_000, // realtime calls wait at least 150_000
  maxRetries: 2,
  appInfo: { name: 'acme-crm', version: '2.1.0', url: 'https://acme.example' },
  onResponse: (info) => console.log(info.requestId, info.creditsCharged),
  fetch: customFetch, // injection point for tests or a custom transport
});
```

Every request sends `X-FirmenData-Client: node-sdk/<version>`; on Node the
`User-Agent` is `firmendata-node/<version> node/<node version>`. `appInfo`
identifies your integration by appending ` name/version (url)` to it.

## Development

```bash
npm install
npm test          # no network, no credentials
npm run typecheck
npm run build
```

## Links

- API reference — <https://api.firmendata.com/v1/docs>
- Python SDK — <https://github.com/FirmenData/firmendata-python>
- n8n node — <https://github.com/FirmenData/n8n-nodes-firmendata>
- MCP server (for AI agents) — `https://mcp.firmendata.com/mcp`
- Website — <https://firmendata.com>

## License

MIT — see [LICENSE](LICENSE).
