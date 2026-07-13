import { defineConfig } from 'tsup'
import { ENTRIES } from './tsup.entries.mjs'

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
 *
 * `dts` generation does NOT happen through this config (#660): tsup's
 * `dts: true` ran a single rollup-plugin-dts worker that BUNDLES each
 * entry's declaration graph, duplicating any type reachable from more
 * than one entry into an independent copy per entry/chunk. Two problems:
 * peak RSS grew past 8GB processing all ~39 entries' graphs in one
 * process, AND — the correctness-critical one — a class with private
 * fields (e.g. `LedgerStore`, reachable from `history`/`periods`/`with`/
 * `pod`/the root barrel) got re-declared independently per duplicate,
 * which TypeScript then treats as nominally distinct types across those
 * subpaths (`tsconfig.tests.json`'s dist-import test caught this on a
 * batched-tsup-invocations trial). `scripts/build.mjs` instead runs this
 * JS build with `dts: false` (below) and separately invokes plain
 * `tsc --emitDeclarationOnly` (see tsconfig.dts.json): one program, one
 * declaration per source module, cross-referenced by relative import —
 * no bundling, no duplication, no nominal-type risk, and (measured)
 * far cheaper than rollup-plugin-dts. package.json's exports map `types`
 * conditions point at the mirrored src/-shaped output tsc produces;
 * `default` still points at this file's flat subpath JS bundle — the two
 * conditions don't need to (and don't) share a directory layout.
 */
// ESM build with code splitting — shared chunks deduplicated so
// class identity holds across subpath boundaries.
export default defineConfig({
  entry: ENTRIES,
  format: ['esm'],
  dts: false,
  clean: true,
  splitting: true,
  sourcemap: true,
  target: 'es2022',
})
