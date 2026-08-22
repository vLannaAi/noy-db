/**
 * `@noy-db/hub/as` — the format port (the `as-*` family port).
 *
 * A serialization format — `as-csv`, `as-json`, a third party's — binds ONLY
 * this subpath: the {@link NoydbFormat} contract plus the import types hub
 * owns. Mirrors `@noy-db/hub/to` for stores and `/at` for sealers.
 *
 * ## Why this seam exists NOW and did not before
 *
 * `/as` shipped in 0.3.0 and was removed in 0.4.0 — "family port removed, it
 * had zero importers" — alongside `/at`, `/in`, `/on` and `/ui`. It was a
 * second place to find types already on the root barrel.
 *
 * What is different is not the subpath, it is what stands behind it. `/as` now
 * carries types that exist NOWHERE ELSE: `ImportPolicy` was declared six times
 * across satellites and not at all in hub, and `ImportPlan` was declared per
 * package around a hub-owned `VaultDiff`. Consolidating them is the seam's
 * substance — this is not a re-export of the root barrel, it is the first
 * hub-side home the import contract has ever had.
 *
 * See `docs/adr/0004-as-format-port.md` for the measurements, and for why the
 * port reaches five of ten `as-*` packages rather than all of them.
 *
 * ⚠️ Re-introducing a retired subpath is declared, not incidental: the
 * `unretired` list in `codemods/0.7.0-pre.json` records it, and
 * `codemod-map.test.ts` refuses the claim unless the subpath really resolves.
 *
 * Named re-exports only (no `export *`) so the published surface is explicit.
 */
export type {
  NoydbFormat,
  DecodedChunk,
  ImportPolicy,
  ImportPlan,
  ExportChunk,
  ExportFormat,
  VaultDiff,
} from './types.js'
