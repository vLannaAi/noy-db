/**
 * @noy-db/hub/as — the as-* exporter family port.
 *
 * An export-format package (`as-csv`, `as-xlsx`, `as-json`, `as-noydb`
 * bundle, `as-sql`, …) binds ONLY to this subpath: the shared import/merge
 * diff primitive (`diffVault`/`VaultDiff`, ungated shared infra — see
 * `with-cargo/vault-diff.ts`) plus the `.noydb` pod read/write primitives
 * (`writePod`/`readPod`/`readPodHeader`, always-on infra — see
 * `with-pod/index.ts`) and the `Vault` handle type those primitives close
 * over.
 *
 * LAYER PORT (not a kernel spine port): this file lives at `src/port/as/`, a
 * sibling of the other family ports, not the kernel spine. It may import
 * `with-*` services directly — same tier as `with-cargo`/`with-pod`
 * themselves — because `scripts/check-architecture.mjs`'s port-layering
 * check only restricts port→port imports; it never restricted a port's
 * with-* service imports in the first place.
 *
 * Named re-exports only (no `export *`) so the published surface is explicit and
 * tsup's per-entry bundling keeps class identity stable across subpaths.
 */
export { diffVault } from '../../with-cargo/vault-diff.js'
export type { VaultDiff } from '../../with-cargo/vault-diff.js'
export { writePod, readPod, readPodHeader } from '../../with-pod/index.js'
export type { WritePodOptions, NoydbPodHeader } from '../../with-pod/index.js'
export type { Vault } from '../../kernel/vault.js'
