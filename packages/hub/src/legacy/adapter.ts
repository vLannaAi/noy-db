/**
 * @deprecated `@noy-db/hub/adapter` is the legacy name of the `to-*` family
 * port. Import from `@noy-db/hub/to` instead. Kept for published pins;
 * removal only with a coordinated version bump.
 *
 * Named re-exports of exactly its historical 12 symbols (not `export *`):
 * `/to` additionally carries `NoydbPodStore` / `PodVersionConflictError`,
 * and this alias's surface is frozen byte-identical by
 * `adapter-surface-golden.test.ts` — an `export *` would let those two
 * names leak through and break the freeze.
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
} from '../port/to/index.js'

export { ConflictError, NetworkError, StoreCapabilityError, BundleVersionConflictError } from '../port/to/index.js'
