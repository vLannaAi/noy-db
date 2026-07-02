/**
 * @noy-db/hub/as — the as-* exporter family door.
 *
 * An export-format package (`as-csv`, `as-xlsx`, `as-json`, `as-noydb`
 * bundle, `as-sql`, …) binds ONLY to this subpath: the shared import/merge
 * diff primitive (`diffVault`/`VaultDiff`, ungated shared infra — see
 * `with-cargo/vault-diff.ts`) plus the `.noydb` pod read/write primitives
 * (`writePod`/`readPod`/`readPodHeader`, always-on infra — see
 * `with-pod/index.ts`) and the `Vault` handle type those primitives close
 * over.
 *
 * LAYER DOOR (not a kernel door): this file lives at `src/as/`, a sibling
 * of `with-cargo/` and `with-pod/`, not under `src/kernel/`. It may import
 * `with-*` services directly — same tier as `with-cargo`/`with-pod`
 * themselves — because `scripts/check-architecture.mjs`'s door-layering
 * check only restricts `src/kernel/**` (spine + kernel doors); it does not
 * examine top-level `src/*` directories.
 *
 * Named re-exports only (no `export *`) so the published surface is explicit and
 * tsup's per-entry bundling keeps class identity stable across subpaths.
 */
export { diffVault } from '../with-cargo/vault-diff.js'
export type { VaultDiff } from '../with-cargo/vault-diff.js'
export { writePod, readPod, readPodHeader } from '../with-pod/index.js'
export type { WritePodOptions, NoydbPodHeader } from '../with-pod/index.js'
export type { Vault } from '../kernel/vault.js'
