/**
 * @noy-db/hub/to — the stable store-adapter contract (the `to-*` family port).
 *
 * A storage backend (a `to-*` package) binds ONLY to this subpath: the
 * ciphertext-facing slice of the hub. It carries the 6-method `NoydbStore`
 * contract (plus its optional extension methods), the envelope / snapshot / op
 * types a store passes through, the store-facing error classes, and the
 * `NoydbPodStore` contract (plus `PodVersionConflictError`) for pod stores
 * such as `to-drive` and `to-icloud`. Mirrors the `@noy-db/hub/cargo` seam
 * used by klum-db and the `by-*` transports.
 *
 * Supersedes `@noy-db/hub/adapter`, which has been retired (coordinated
 * removal; consumers migrated to this subpath).
 *
 * Named re-exports only (no `export *`) so the published surface is explicit and
 * tsup's per-entry bundling keeps class identity stable across subpaths.
 */
export type {
  NoydbStore,
  NoydbPodStore,
  EncryptedEnvelope,
  VaultSnapshot,
  TxOp,
  StoreCapabilities,
  StoreCredentials,
  StoreCredentialSource,
  StoreTime,
  ListPageResult,
} from '../../kernel/types.js'

export {
  ConflictError,
  NetworkError,
  StoreCapabilityError,
  PodVersionConflictError,
  UnknownStoreKindError,
  DuplicateStoreKindError,
} from '../../kernel/errors.js'

export type {
  StoreClass, StoreDescriptor, StoreBinding, StoreFactory, StoreLocator, AnyNoydbStore,
} from './locator.js'
export { createStoreLocator, isPodStore } from './locator.js'

// Envelope-format generation (#1207): lets a store host (e.g. @doi-db/daemon)
// report "these envelopes were sealed under generation N; the client's hub
// reads generation M" instead of surfacing a bare TamperedError from code
// that is correct. Diagnostic only — a store never interprets what it holds,
// and a reader never branches on a generation read from an untrusted source.
export { NOYDB_ENVELOPE_GENERATION } from '../../kernel/types.js'
