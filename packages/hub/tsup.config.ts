import { defineConfig } from 'tsup'

export default defineConfig({
  // Main entry + opt-in subpath entries for tree-shaking-friendly consumers.
  // The main entry re-exports every subpath symbol (backward compat).
  entry: {
    index: 'src/index.ts',
    'i18n/index': 'src/i18n/index.ts',
    'store/index': 'src/store/index.ts',
    'team/index': 'src/team/index.ts',
    'session/index': 'src/session/index.ts',
    'history/index': 'src/history/index.ts',
    'query/index': 'src/query/index.ts',
    'blobs/index': 'src/blobs/index.ts',
    'indexing/index': 'src/indexing/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2022',
})
