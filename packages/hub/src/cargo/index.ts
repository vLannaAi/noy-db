/**
 * **@noy-db/hub/cargo** — the orchestration seam klum binds. Canonical
 * successor to `/kernel` (which remains as a deprecated alias).
 *
 * `cargo` is the layer of services + interfaces required to **manage pods** —
 * the multi-vault management plane klum-db binds: custody, deed, diff,
 * distributed query, addressing, and change-observation. It consolidates the
 * whole current `/kernel` runtime floor plus the orchestration delta klum
 * previously pulled from the bare `@noy-db/hub` root barrel.
 *
 * See docs/superpowers/specs/2026-07-01-noydb-architecture-lexicon.md.
 *
 * @packageDocumentation
 */

// The runtime floor — the whole current /kernel surface.
export * from '../kernel/index.js'

// Custody & ownership.
export { CustodyApi } from '../with-party/custody/index.js'
export type { GrantCustodianOptions } from '../with-party/custody/index.js'
export { liberateVault } from '../with-party/custody/liberate.js'
export type { LiberateOptions, LiberateResult } from '../with-party/custody/liberate.js'
export { createDeedOwner, loadDeedMarker, isDeedVault } from '../with-party/team/deed.js'
export type { DeedMarker } from '../with-party/team/deed.js'
export type { SealingKeyProvider } from '../with-party/team/managed-passphrase.js'

// Interchange & addressing.
export { diffVault } from '../vault-diff.js'
export { STATE_VAULT_NAME } from '../constants.js'

// Change observation.
export type { WriteHook } from '../write-hooks.js'
export type { WriteQueue } from '../write-queue.js'
export type { WriteConflict } from '../types.js'
export type { AccessibleVault } from '../types.js'
export type { Unsubscribe } from '../meta/user-envelope/api.js'

// Partition / interchange — extract, adopt & transfer re-keyed slices
// between vaults (managing pods & slices is cargo's job; the artifact
// format itself lives on the `/pod` seam). See the architecture lexicon.
export { walkClosure } from '../with-share/bundle/walk-closure.js'
export type { WalkClosureOptions, ClosureResult } from '../with-share/bundle/walk-closure.js'
export { describeExtraction } from '../with-share/bundle/describe-extraction.js'
export type { ExtractionPreview } from '../with-share/bundle/describe-extraction.js'
export { extractPartition } from '../with-share/bundle/extract-partition.js'
export type { ExtractPartitionResult } from '../with-share/bundle/extract-partition.js'
export {
  adoptPartition,
  unsealDeks,
  createOwnerOnAdoptedPartition,
} from '../with-share/bundle/adopt-partition.js'
export type {
  AdoptPartitionOptions,
  AdoptPartitionResult,
  CreateOwnerResult,
  CreateOwnerOptions,
  CreateOwnerStandardOptions,
  CreateOwnerManagedOptions,
} from '../with-share/bundle/adopt-partition.js'
export { decryptExtractedPartition } from '../with-share/bundle/decrypt-partition.js'
export type { DecryptedRecord } from '../with-share/bundle/decrypt-partition.js'
export {
  TransferSealError,
  AdoptionStateError,
  PartitionExtractionError,
} from '../errors.js'
