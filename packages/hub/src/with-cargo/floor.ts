/**
 * The `@noy-db/hub/kernel` published subpath has been retired (coordinated
 * removal; consumers migrated to `@noy-db/hub/cargo`). This file survives
 * unpublished as `/cargo`'s internal re-export floor — `with-cargo/index.ts`
 * does `export * from './floor.js'` to consolidate this runtime-helper
 * / error-class / type surface into the cargo seam, and
 * `cargo-surface-golden.test.ts` reads this file directly as part of that
 * union. Do not reintroduce it as a tsup entry or package.json export.
 *
 * @packageDocumentation
 */

// ─── runtime helpers ──────────────────────────────────────────────
export { readPath } from '../kernel/query/predicate.js'
export { reduceRecords } from '../with-lookup/reduce/reduction.js'
export { groupAndReduce } from '../with-lookup/reduce/groupby.js'
export { generateULID } from '../with-pod/ulid.js'
export { sha256Hex } from '../kernel/enclave/index.js'
// Coordination port — the stable drain-barrier seam an outward
// orchestrator (@klum-db/lobby) or a `by-*` transport binds to. The pure
// helpers are runtime; the port + presence/fence shapes are types only
// (see the `types` group below). `StoreMesh` is hub-internal
// and intentionally NOT exported here — consumers inject their own.
export { isQuorum, runDrainBarrier } from '../port/by/index.js'
// Rank-fusion reducer: an outward orchestrator (@klum-db/lobby)
// fuses per-vault retrieve() result-sets with the SAME primitive hybrid uses.
export { fuseRetrieval } from '../with-lookup/search/fuse.js'

// ─── error classes ────────────────────────────────────────────────
export {
  CrossShardJoinError,
  DataResidencyError,
  NoAccessError,
  ReservedVaultNameError,
  ShardProvisioningError,
  UnknownShardError,
  ValidationError,
  VaultTemplateNotFoundError,
} from '../kernel/errors.js'

// Types only (erased at emit). NOTE: Vault / Collection / Noydb / Query are
// runtime classes in hub, but are re-exported here as TYPES — `instanceof`
// against these will not work from `@noy-db/hub/cargo`. Consumers needing a
// runtime class value must import it from `@noy-db/hub` directly.
// ─── types ────────────────────────────────────────────────────────
export type { CollectionMeta, VaultMeta } from '../with-shape/introspection/meta.js'
export type { ChangeEvent } from '../kernel/types.js'
export type { Vault } from '../kernel/vault.js'
export type { Collection } from '../kernel/collection.js'
export type { Noydb } from '../kernel/noydb.js'
export type { Operator } from '../kernel/query/predicate.js'
export type { Query } from '../kernel/query/builder.js'
export type { JoinStrategy } from '../kernel/query/relate/join.js'
export type { LiveQuery } from '../kernel/query/live/live.js'
export type {
  ReduceResult,
  ReduceSpec,
  LiveReduction,
} from '../with-lookup/reduce/reduction.js'
export type { IndexDef } from '../with-lookup/indexing/eager-indexes.js'
// Rank-fusion types
export type { FuseOptions } from '../with-lookup/search/fuse.js'
export type { RetrieveHit, RetrieveOptions } from '../with-lookup/search/retrieve-types.js'
// Coordination port types — the implementable contract surface for an
// injected drain-barrier transport (runtime helpers are in the group above).
//
// `FenceState` was REMOVED here in 0.7 and replaced by `FenceDoc` (#1188).
// It was never the string union of the same name on the root barrel — it was
// `/by`'s duplicate object type, re-exported. A removal from this frozen
// surface, taken deliberately rather than aliased: the no-legacy-aliases
// policy that retired `/kernel` and `/adapter` applies, and the name is what
// caused the collision, so keeping it as an alias would preserve the defect
// it was removed for. Measured first — zero code imports of the type outside
// this repo (klum-db's hits are all `schemaFenceState()` method calls).
export type {
  NoydbMesh,
  WriterPresence,
  FenceDoc,
  DrainBarrierOptions,
} from '../port/by/index.js'
