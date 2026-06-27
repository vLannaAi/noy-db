/**
 * @noy-db/hub/adapter — the stable store-adapter contract.
 *
 * A storage backend (a `to-*` package) binds ONLY to this subpath: the
 * ciphertext-facing slice of the hub. It carries the 6-method `NoydbStore`
 * contract (plus its optional extension methods), the envelope / snapshot / op
 * types a store passes through, and the store-facing error classes. Mirrors the
 * `@noy-db/hub/kernel` seam used by klum-db and the `by-*` transports.
 *
 * Named re-exports only (no `export *`) so the published surface is explicit and
 * tsup's per-entry bundling keeps class identity stable across subpaths.
 */
export type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  TxOp,
  StoreCapabilities,
  StoreTime,
  ListPageResult,
} from '../types.js'

export { ConflictError, NetworkError, StoreCapabilityError } from '../errors.js'
