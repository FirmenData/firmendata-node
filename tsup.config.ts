import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // No runtime dependencies to bundle — the package ships none on purpose,
  // so it stays usable in edge runtimes and adds nothing to a consumer's tree.
  treeshake: true,
  target: 'es2022',
});
