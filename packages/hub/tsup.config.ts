import { defineConfig } from 'tsup'

/**
 * Build config — spec.
 *
 * The hub ships 26 subpath entries plus the main barrel. Every entry
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
  'i18n/index': 'src/via/i18n/index.ts',
  'team/index': 'src/with-party/team/index.ts',
  'broker/index': 'src/with-party/broker/index.ts',
  'session/index': 'src/with-party/session/index.ts',
  'history/index': 'src/with-commit/history/index.ts',
  'forget/index': 'src/with-audit/forget/index.ts',
  'sealed-record/index': 'src/with-audit/sealed-record/index.ts',
  'query/index': 'src/kernel/query/index.ts',
  'blobs/index': 'src/via/blob/index.ts',
  'indexing/index': 'src/with-lookup/indexing/index.ts',
  'lazy/index': 'src/with-store/lazy/index.ts',
  'aggregate/index': 'src/with-lookup/aggregate/index.ts',
  'crdt/index': 'src/with-commit/crdt/index.ts',
  'bundle/index': 'src/legacy/bundle.ts',
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
  'classified/index': 'src/via/classified/index.ts',
  'satellites/index': 'src/with-shape/satellites/index.ts',
  'tiers/index': 'src/with-audit/tiers/index.ts',
  'portability/index': 'src/with-audit/portability/index.ts',
  'cargo/index': 'src/with-cargo/index.ts',
  'to/index': 'src/port/to/index.ts',
  'with/index': 'src/port/with/index.ts',
  'ui/index': 'src/port/ui/index.ts',
  'by/index': 'src/port/by/index.ts',
  'on/index': 'src/port/on/index.ts',
  'at/index': 'src/port/at/index.ts',
  'in/index': 'src/port/in/index.ts',
  'as/index': 'src/port/as/index.ts',
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
