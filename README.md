# @firmendata/sdk

Official TypeScript/JavaScript client for the [firmendata](https://firmendata.com)
API — data on **2.4 million German companies** from the Unternehmensregister and
Handelsregister: register profiles, parsed annual financial statements,
shareholder cap tables, UBO chains, insolvency notices and public-tender links.

[![npm](https://img.shields.io/npm/v/@firmendata/sdk)](https://www.npmjs.com/package/@firmendata/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

```bash
npm install @firmendata/sdk
```

**Zero runtime dependencies.** Built on the platform `fetch`, so it runs
unchanged on Node 18+, Bun, Deno, Cloudflare Workers and in the browser, and
adds nothing to your dependency tree.

## Try it without signing up

Company-name autocomplete is free and needs **no API key**:

```ts
import { FirmenData } from '@firmendata/sdk';

const fd = new FirmenData();
const { data } = await fd.autocomplete('siemens');

for (const hit of data) {
  console.log(hit.eu_id, hit.display_name);
}
```

Keyless calls are rate limited, modestly and by address — enough to try the
API, back a search box, or run low-volume queries. Add a key for substantially
higher limits plus every other endpoint. On a `429`, honour `Retry-After`; the
client already does this for you.

## With an API key

Create one at [firmendata.com](https://firmendata.com/de/account/api-keys) — the
free plan includes 100 credits.

```ts
const fd = new FirmenData({ apiKey: process.env.FIRMENDATA_API_KEY });

// Filters combine with AND; arrays combine with OR
const results = await fd.search({
  city: ['Berlin', 'Hamburg'],
  revenue_min: 1_000_000,
  legal_status: ['insolvent'],
  limit: 25,
});

// Paginate
if (results.pagination.has_more) {
  const next = await fd.search({ cursor: results.pagination.next_cursor });
}
```

```ts
const euId = 'DEB1103R_HRB123456';

await fd.getCompany(euId); // full profile
await fd.getFinancials(euId); // multi-year statements, parsed into figures
await fd.getShareholders(euId); // cap table from the Gesellschafterliste
await fd.getUbo(euId); // beneficial owners through ownership chains
await fd.getHistory(euId); // chronological register history
```

## Errors

Every failure is a typed error carrying the API's RFC 7807 problem detail,
including a `requestId` you can quote to support.

```ts
import { InsufficientCreditsError, RateLimitError } from '@firmendata/sdk';

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

| Error                                    | Status | Meaning                                                    |
| ---------------------------------------- | ------ | ---------------------------------------------------------- |
| `AuthenticationError`                    | 401    | Missing/invalid key, or a keyless call used a paid feature |
| `TokenExpiredError`                      | 401    | Key expired                                                |
| `InsufficientCreditsError`               | 402    | Balance too low for this call                              |
| `NotFoundError`                          | 404    | No such company, subscription or event                     |
| `ConflictError`                          | 409    | Conflicts with existing state                              |
| `ValidationError`                        | 422    | Bad parameters — see `.errors`                             |
| `RateLimitError`                         | 429    | Retry budget exhausted — see `.retryAfter`                 |
| `ServerError`                            | 5xx    | Retried automatically for idempotent calls                 |
| `APIConnectionError` / `APITimeoutError` | —      | No response at all                                         |

### Retries

Automatic and deliberately conservative:

- **429 is always retried**, on any method — the server rejects rate-limited
  calls before the handler runs, so nothing happened and nothing was billed.
  The server's `Retry-After` is used verbatim.
- **5xx and connection failures are retried only for idempotent methods.** A
  `createSubscription` that times out may already have been applied; replaying
  it would create a second one.
- Backoff is exponential with full jitter, so clients that trip the same limit
  together don't all return at the same instant.

Tune with `new FirmenData({ maxRetries })`; `0` disables it.

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
  timeoutMs: 30_000,
  maxRetries: 2,
  fetch: customFetch, // injection point for tests or a custom transport
});
```

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

## License

MIT — see [LICENSE](LICENSE).
