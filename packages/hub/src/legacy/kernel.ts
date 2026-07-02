/**
 * **@noy-db/hub/kernel** — the stable internal surface that outward
 * orchestration frameworks bind to *instead of* reaching into hub
 * internals via relative paths.
 *
 * This is the kernel surface: the minimal set
 * of runtime helpers, error classes, and types the federation /
 * orchestration layer needs from the vault core. Treat it as a
 * contract — additive changes only; removals are breaking.
 *
 * @deprecated Prefer `@noy-db/hub/cargo`, which carries this whole surface
 * plus the orchestration delta. Kept for existing pins.
 *
 * @packageDocumentation
 */

// ─── runtime helpers ──────────────────────────────────────────────
export { readPath } from '../kernel/query/predicate.js'
export { reduceRecords } from '../with-lookup/aggregate/aggregation.js'
export { groupAndReduce } from '../with-lookup/aggregate/groupby.js'
export { generateULID } from '../with-pod/ulid.js'
export { sha256Hex } from '../kernel/enclave/index.js'
// Coordination port — the stable drain-barrier seam an outward
// orchestrator (@klum-db/lobby) or a `by-*` transport binds to. The pure
// helpers are runtime; the port + presence/fence shapes are types only
// (see the `types` group below). `StoreCoordinationProvider` is hub-internal
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
// against these will not work from `@noy-db/hub/kernel`. Consumers needing a
// runtime class value must import it from `@noy-db/hub` directly.
// ─── types ────────────────────────────────────────────────────────
export type { CollectionMeta, VaultMeta } from '../with-shape/introspection/meta.js'
export type { ChangeEvent } from '../kernel/types.js'
export type { Vault } from '../kernel/vault.js'
export type { Collection } from '../kernel/collection.js'
export type { Noydb } from '../kernel/noydb.js'
export type { Operator } from '../kernel/query/predicate.js'
export type { Query } from '../kernel/query/builder.js'
export type { JoinStrategy } from '../kernel/query/join.js'
export type { LiveQuery } from '../kernel/query/live.js'
export type {
  AggregateResult,
  AggregateSpec,
  LiveAggregation,
} from '../with-lookup/aggregate/aggregation.js'
export type { IndexDef } from '../with-lookup/indexing/eager-indexes.js'
// Rank-fusion types
export type { FuseOptions } from '../with-lookup/search/fuse.js'
export type { RetrieveHit, RetrieveOptions } from '../with-lookup/search/retrieve-types.js'
// Coordination port types — the implementable contract surface for an
// injected drain-barrier transport (runtime helpers are in the group above).
export type {
  CoordinationProvider,
  WriterPresence,
  FenceState,
  DrainBarrierOptions,
} from '../port/by/index.js'
