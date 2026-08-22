/**
 * The public type aliases must keep matching the contract they are derived
 * from. Everything in `src/schema.ts` is generated, but the aliases in
 * `src/types.ts` that *correct* the generator are hand-written, and a
 * hand-written correction is exactly the thing that rots.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(join(ROOT, 'contracts', 'openapi.v1.json'), 'utf8')) as {
  components: {
    schemas: Record<
      string,
      { required?: string[]; properties?: Record<string, { default?: unknown }> }
    >;
  };
};

describe('SubscriptionCreateRequest', () => {
  const schema = spec.components.schemas.SubscriptionCreateRequest;

  it('exists in the vendored contract', () => {
    expect(schema).toBeDefined();
  });

  /**
   * `openapi-typescript` treats a property with a `default` as required, which
   * is right for a response body and wrong for a request one: the API accepts
   * the create call without `cadence`, `language` or `mode` and fills them in.
   * `src/types.ts` re-optionalises exactly that set; this pins the set.
   */
  it('re-optionalises every property the API defaults', () => {
    const required = new Set(schema?.required ?? []);

    const defaultedButOptional = Object.entries(schema?.properties ?? {})
      .filter(([name, prop]) => 'default' in prop && !required.has(name))
      .map(([name]) => name)
      .sort();

    // Keep in sync with SubscriptionCreateRequestDefaults in src/types.ts.
    expect(defaultedButOptional).toEqual(['cadence', 'language', 'mode']);
  });

  it('still requires the two properties the API requires', () => {
    expect([...(schema?.required ?? [])].sort()).toEqual(['eu_id', 'subscription_type']);
  });
});
