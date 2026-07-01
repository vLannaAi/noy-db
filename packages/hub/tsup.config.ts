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
  'i18n/index': 'src/with-shape/i18n/index.ts',
  'store/index': 'src/kernel/store/index.ts',
  'team/index': 'src/with-party/team/index.ts',
  'session/index': 'src/with-party/session/index.ts',
  'history/index': 'src/with-commit/history/index.ts',
  'forget/index': 'src/with-audit/forget/index.ts',
  'sealed-record/index': 'src/with-audit/sealed-record/index.ts',
  'query/index': 'src/kernel/query/index.ts',
  'blobs/index': 'src/with-shape/blobs/index.ts',
  'indexing/index': 'src/with-lookup/indexing/index.ts',
  'aggregate/index': 'src/with-lookup/aggregate/index.ts',
  'crdt/index': 'src/with-commit/crdt/index.ts',
  'bundle/index': 'src/bundle/index.ts',
  'pod/index': 'src/with-pod/index.ts',
  'consent/index': 'src/with-audit/consent/index.ts',
  'periods/index': 'src/with-audit/periods/index.ts',
  'guards/index': 'src/with-audit/guards/index.ts',
  'shadow/index': 'src/with-fork/shadow/index.ts',
  'snapshots/index': 'src/with-fork/snapshots/index.ts',
  'tx/index': 'src/with-commit/tx/index.ts',
  'derivations/index': 'src/with-formula/derivations/index.ts',
  'materialized-views/index': 'src/with-formula/materialized-views/index.ts',
  'overlay-views/index': 'src/with-formula/overlay-views/index.ts',
  'sync/index': 'src/with-party/sync/index.ts',
  'util/index': 'src/kernel/util/index.ts',
  'attestation/index': 'src/with-audit/attestation/index.ts',
  'kernel/index': 'src/kernel/index.ts',
  'cargo/index': 'src/with-cargo/index.ts',
  'adapter/index': 'src/kernel/adapter/index.ts',
  describe: 'src/describe.ts',
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
