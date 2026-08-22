#!/usr/bin/env node
/**
 * Type-check every ```ts block in README.md against the real SDK types.
 *
 *   npm run check:readme
 *
 * Written after three separate bugs shipped in a single README rewrite:
 * `downloadDocument(euId, { file_type })` where the option is `fileType`, a
 * `subscription_type: 'financials'` that is not one of the eight valid values,
 * and `financials.statements` on a response whose shape is `history.metrics`.
 * Every one of them would have been copy-pasted by the first reader, and none
 * is the kind of thing review catches.
 *
 * Each block is compiled in **its own function scope**, because README blocks
 * are independent snippets rather than one program — several legitimately open
 * with `const fd = new FirmenData(...)`. A preamble declares the names the
 * prose establishes once and later blocks reuse (`fd`, `euId`), so a snippet
 * can be written the way it should be read.
 *
 * `strictNullChecks` is off on purpose: examples write `results.data` rather
 * than `results.data?.` for brevity, and contorting the docs to satisfy a
 * type-checker would make them worse. The rest of `strict` stays on, which is
 * where the real mistakes live — wrong property names, wrong enum members,
 * wrong response shapes.
 */

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

// ```ts blocks only — ```bash and ```jsonc are not TypeScript.
const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]);
if (blocks.length === 0) {
  console.error('check-readme: no ```ts blocks found — did the README move?');
  process.exit(1);
}

// Imports hoist to module scope and dedupe; everything else stays in its block.
const imports = new Set();
const bodies = [];
for (const block of blocks) {
  const body = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('import ')) {
      imports.add(line.replace(/'firmendata'/, "'../src/index.js'"));
    } else {
      body.push(line);
    }
  }
  bodies.push(body.join('\n'));
}

const source = [
  ...imports,
  "import { FirmenData as _FirmenData } from '../src/index.js';",
  '',
  '// Established by the prose, reused across snippets.',
  'declare const fd: _FirmenData;',
  'declare const euId: string;',
  'declare const customFetch: typeof globalThis.fetch;',
  'void customFetch;',
  '',
  ...bodies.map((body, i) => `export async function readmeBlock${i}() {\n${body}\n}`),
].join('\n');

const file = join(ROOT, 'test', '.readme-check.ts');
writeFileSync(file, source);

try {
  execFileSync(
    'npx',
    [
      'tsc',
      '--noEmit',
      '--strict',
      '--strictNullChecks',
      'false',
      '--target',
      'es2022',
      '--module',
      'esnext',
      '--moduleResolution',
      'bundler',
      '--skipLibCheck',
      file,
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  console.log(`check-readme: ${blocks.length} TypeScript blocks type-check clean`);
} catch {
  console.error('\ncheck-readme: a README example does not compile against the SDK types.');
  process.exitCode = 1;
} finally {
  rmSync(file, { force: true });
}
