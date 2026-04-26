import { defineConfig } from 'tsup'

/**
 * Build config — see #288.
 *
 * The hub ships 17 subpath entries plus the main barrel. Every entry
 * is its own bundle; tsup compiles them independently. With
 * `splitting: false`, shared modules (e.g. `errors.ts`) get inlined
 * into every entry, producing one class definition per entry. That
 * breaks `instanceof` across subpath boundaries — a `PeriodClosedError`
 * thrown from `dist/periods/index.js` is a different class object than
 * the one re-exported from `dist/index.js`, even though the source
 * is the same file.
 *
 * `splitting: true` for ESM extracts shared modules into separate
 * chunk files (e.g. `dist/chunk-ABC123.js`) that every entry imports.
 * One class definition; `instanceof` works again across subpaths.
 *
 * CJS doesn't support code splitting natively. We keep CJS as the
 * single-bundle "self-contained per entry" mode. Modern consumers
 * almost universally use ESM, where instanceof works correctly.
 * CJS consumers who mix subpaths can use string-discriminator checks
 * (`err.code === '...'`) — documented in `docs/reference/api-stability.md`.
 */
const ENTRIES = {
  index: 'src/index.ts',
  'i18n/index': 'src/i18n/index.ts',
  'store/index': 'src/store/index.ts',
  'team/index': 'src/team/index.ts',
  'session/index': 'src/session/index.ts',
  'history/index': 'src/history/index.ts',
  'query/index': 'src/query/index.ts',
  'blobs/index': 'src/blobs/index.ts',
  'indexing/index': 'src/indexing/index.ts',
  'aggregate/index': 'src/aggregate/index.ts',
  'crdt/index': 'src/crdt/index.ts',
  'bundle/index': 'src/bundle/index.ts',
  'consent/index': 'src/consent/index.ts',
  'periods/index': 'src/periods/index.ts',
  'shadow/index': 'src/shadow/index.ts',
  'tx/index': 'src/tx/index.ts',
  'sync/index': 'src/sync/index.ts',
  'util/index': 'src/util/index.ts',
}

export default defineConfig([
  // ESM build with code splitting — shared chunks deduplicated so
  // class identity holds across subpath boundaries.
  {
    entry: ENTRIES,
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: true,
    sourcemap: true,
    target: 'es2022',
  },
  // CJS build without splitting — preserves the v0.24 single-bundle
  // shape for legacy consumers. `clean: false` so it doesn't wipe the
  // ESM artefacts emitted by the first config.
  {
    entry: ENTRIES,
    format: ['cjs'],
    dts: false, // dts already emitted by the ESM build
    clean: false,
    splitting: false,
    sourcemap: true,
    target: 'es2022',
  },
])
