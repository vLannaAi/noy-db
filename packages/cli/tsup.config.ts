import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

// Derive the CLI version from package.json at build time so `noydb --version`
// never drifts from the published version (see #705).
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string }

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'bin/noydb': 'src/bin/noydb.ts',
  },
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2022',
  define: { __CLI_VERSION__: JSON.stringify(version) },
})

