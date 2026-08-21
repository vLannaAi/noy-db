/**
 * **@noy-db/hub/cargo** — the orchestration seam klum binds. Canonical
 * successor to `/kernel` (the published `/kernel` subpath alias has been
 * retired — coordinated removal, consumers migrated).
 *
 * `cargo` is the layer of services + interfaces required to **manage pods** —
 * the multi-vault management plane klum-db binds: custody, deed, diff,
 * distributed query, addressing, and change-observation. It consolidates the
 * runtime floor formerly published as `/kernel` plus the orchestration delta.
 *
 * See docs/foundations/architecture-lexicon.md.
 *
 * @packageDocumentation
 */

// The runtime floor — unpublished now that `/kernel` the subpath is retired;
// `floor.ts` is that re-export source (was `src/legacy/kernel.ts` until
// the /bundle retirement deleted the legacy folder, #812).
export * from './floor.js'

// Custody & ownership.
export { CustodyApi } from '../with-party/custody/index.js'
export type { GrantCustodianOptions } from '../with-party/custody/index.js'
export { liberateVault } from '../with-party/custody/liberate.js'
export type { LiberateOptions, LiberateResult } from '../with-party/custody/liberate.js'
export { createDeedOwner, loadDeedMarker, isDeedVault } from '../with-party/team/deed.js'
export type { DeedMarker } from '../with-party/team/deed.js'
export type { NoydbSealer } from '../with-party/team/managed-secret.js'

// Interchange & addressing.
export { diffVault } from './vault-diff.js'
export { STATE_VAULT_NAME } from '../kernel/constants.js'

// Capability opt-in seam (S4): the source-side `extractPartition` free function
// routes through the cargoStrategy, so it throws CargoNotEnabledError unless
// opted in. adopt/decrypt — and `diffVault` (shared import/merge infra) — stay
// ungated host-side.
export { withCargo } from './active.js'
export { NO_CARGO } from './strategy.js'
export type { CargoStrategy } from './strategy.js'
export { CargoNotEnabledError } from '../kernel/errors.js'

// Partition transfer (#812): the interchange helpers klum-db's lobby binds,
// promoted from the transitional /bundle subpath so the orchestrator's last
// /bundle imports can move here and src/legacy/ can retire. extractPartition
// is capability-gated (withCargo(), see the opt-in seam above); walkClosure /
// describeExtraction / decryptExtractedPartition are ungated host-side.
export { extractPartition } from './extract-partition.js'
export { walkClosure } from './walk-closure.js'
export { describeExtraction } from './describe-extraction.js'
export { decryptExtractedPartition } from './decrypt-partition.js'
export type { ExtractionPreview } from './describe-extraction.js'
export type { DecryptedRecord } from './decrypt-partition.js'
// Each promoted op's own option/result types — a caller can name what it
// passes and what it gets back without reaching for the retiring /bundle.
export type { WalkClosureOptions, ClosureResult, DanglingRefNotice } from './walk-closure.js'
export type { ExtractPartitionResult } from './extract-partition.js'
// The adopt half. Extraction without adoption is half the transfer story
// (see docs/services/transferable-partitions.md) — both ends of the
// ceremony belong on the same seam.
export { adoptPartition, unsealDeks, createOwnerOnAdoptedPartition } from './adopt-partition.js'
export type {
  AdoptPartitionOptions,
  AdoptPartitionResult,
  CreateOwnerResult,
  CreateOwnerOptions,
  CreateOwnerStandardOptions,
  CreateOwnerManagedOptions,
} from './adopt-partition.js'
// Errors thrown by the transfer ops above, so consumers can `instanceof`
// them without falling back to the root barrel.
export { TransferSealError, AdoptionStateError, PartitionExtractionError } from '../kernel/errors.js'

// Change observation.
export type { WriteHook, WriteEvent } from '../port/with/write-hooks.js'
export type { WriteQueue } from '../kernel/write-queue.js'
export type { WriteConflict } from '../kernel/types.js'
export type { AccessibleVault } from '../kernel/types.js'
export type { Unsubscribe } from '../kernel/types.js'

// #837 — option/payload types named by this seam's own signatures.
export type { ExtractPartitionOptions } from './extract-partition.js'
export type { TransferSealPayload } from '../with-pod/pod.js'
