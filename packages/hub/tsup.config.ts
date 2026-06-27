import { defineConfig } from 'tsup'

/**
 * Build config — spec.
 *
 * The hub ships 25 subpath entries plus the main barrel. Every entry
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
 * One class definition; `instanceof` works again across subpaths. The
 * package is ESM-only, so this single build is the whole story — there
 * is no CJS single-bundle mode to reconcile against.
 */
const ENTRIES = {
  index: 'src/index.ts',
  'i18n/index': 'src/i18n/index.ts',
  'store/index': 'src/store/index.ts',
  'team/index': 'src/team/index.ts',
  'session/index': 'src/session/index.ts',
  'history/index': 'src/history/index.ts',
  'forget/index': 'src/forget/index.ts',
  'sealed-record/index': 'src/sealed-record/index.ts',
  'query/index': 'src/query/index.ts',
  'blobs/index': 'src/blobs/index.ts',
  'indexing/index': 'src/indexing/index.ts',
  'aggregate/index': 'src/aggregate/index.ts',
  'crdt/index': 'src/crdt/index.ts',
  'bundle/index': 'src/bundle/index.ts',
  'consent/index': 'src/consent/index.ts',
  'periods/index': 'src/periods/index.ts',
  'guards/index': 'src/guards/index.ts',
  'shadow/index': 'src/shadow/index.ts',
  'snapshots/index': 'src/snapshots/index.ts',
  'tx/index': 'src/tx/index.ts',
  'derivations/index': 'src/derivations/index.ts',
  'materialized-views/index': 'src/materialized-views/index.ts',
  'overlay-views/index': 'src/overlay-views/index.ts',
  'sync/index': 'src/sync/index.ts',
  'util/index': 'src/util/index.ts',
  'attestation/index': 'src/attestation/index.ts',
  'kernel/index': 'src/kernel/index.ts',
  'adapter/index': 'src/adapter/index.ts',
}

// ESM build with code splitting — shared chunks deduplicated so
// class identity holds across subpath boundaries.
export default defineConfig({
  entry: ENTRIES,
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: true,
  sourcemap: true,
  target: 'es2022',
})
