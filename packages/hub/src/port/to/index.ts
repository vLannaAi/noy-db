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
import type { NoydbStore as NoydbStoreType } from '../../kernel/types.js'

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

// #1224 — the PREDICATE has to live here, not only on the root barrel.
// `isConflictError` exists because a store may bind a different copy of this
// very subpath than its caller, which makes `instanceof` against the class
// above silently miss (#935). A store binds `/to` and nothing else, so
// exporting the predicate only from the root told store authors to use
// something they could not import — and the obvious fallback, `instanceof
// ConflictError`, is exactly the bug the predicate exists to prevent.
export { isConflictError } from '../../kernel/errors.js'

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

/**
 * A store a RELAY may serve — the 6-method contract minus the two members a
 * relay profile omits **by construction** (#1237).
 *
 * ## Why a type rather than a runtime allowlist
 *
 * `in-rest` types its `store` option as a full {@link NoydbStore} and gates
 * dispatch with an `allow` set. That works, and for `in-rest` it is right — its
 * job is to serve a whole store. But it means a relay profile's exclusions are
 * enforced by *handing the handler an object that carries `saveAll`* and
 * trusting a `Set` not to call it. **That converts structural absence into a
 * runtime allowlist**, which is a downgrade of exactly the property a relay
 * exists to have: a handler typed against this cannot compile a call to
 * `saveAll`, so no mis-set `allow` can talk it into one.
 *
 * ## The two exclusions, and why each
 *
 * - **`saveAll`** — whole-vault replace. A relay that can be asked to overwrite
 *   a vault wholesale is a rollback superweapon pointed at its own hosts.
 * - **`listVaults`** — enumeration is an existence leak. Already optional on
 *   `NoydbStore`, so omitting it here is a statement of profile rather than a
 *   new restriction.
 *
 * ## Scope — deliberately narrow
 *
 * This is a TYPE. It changes nothing about the `NoydbStore` runtime contract,
 * which stays the 6-method interface every backend implements; a full store
 * satisfies this type structurally and needs no changes to be relayed. That
 * boundary is load-bearing: the format-conformance kit's store-observation
 * design (#1211) names a change to the `NoydbStore` contract as the single
 * thing that would invalidate it, so a narrowing that stayed purely in the type
 * layer was a precondition of this work rather than a convenience.
 *
 * It lives here, on the published `/to` seam, rather than inside the relay
 * package because there is already a second consumer: `@doi-db/daemon`
 * implements this profile natively and needs to name the same shape without
 * depending on a relay server it does not run.
 */
export type NoydbRelayStore = Omit<NoydbStoreType, 'saveAll' | 'listVaults'>
