/**
 * @noy-db/hub/adapter — the stable store-adapter contract.
 *
 * A storage backend (a `to-*` package) binds ONLY to this subpath: the
 * ciphertext-facing slice of the hub. It carries the 6-method `NoydbStore`
 * contract (plus its optional extension methods), the envelope / snapshot / op
 * types a store passes through, the store-facing error classes, and the
 * `NoydbBundleStore` contract (plus `BundleVersionConflictError`) for bundle
 * stores such as `to-drive` and `to-icloud`. Mirrors the
 * `@noy-db/hub/kernel` seam used by klum-db and the `by-*` transports.
 *
 * Named re-exports only (no `export *`) so the published surface is explicit and
 * tsup's per-entry bundling keeps class identity stable across subpaths.
 */
export type {
  NoydbStore,
  NoydbBundleStore,
  EncryptedEnvelope,
  VaultSnapshot,
  TxOp,
  StoreCapabilities,
  StoreTime,
  ListPageResult,
} from '../kernel/types.js'

export { ConflictError, NetworkError, StoreCapabilityError, BundleVersionConflictError } from '../errors.js'
