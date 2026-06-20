/**
 * **@noy-db/hub/kernel** — the stable internal surface that outward
 * orchestration frameworks bind to *instead of* reaching into hub
 * internals via relative paths.
 *
 * This is the "kernel-surface extraction" (spec §10): the minimal set
 * of runtime helpers, error classes, and types the federation /
 * orchestration layer needs from the vault core. Treat it as a
 * contract — additive changes only; removals are breaking.
 *
 * @packageDocumentation
 */

// ─── runtime helpers ──────────────────────────────────────────────
export { readPath } from '../query/predicate.js'
export { reduceRecords } from '../aggregate/aggregation.js'
export { groupAndReduce } from '../aggregate/groupby.js'
export { generateULID } from '../bundle/ulid.js'
export { sha256Hex } from '../crypto.js'
// #469 coordination port — the stable drain-barrier seam an outward
// orchestrator (@klum-db/lobby) or a `by-*` transport binds to. The pure
// helpers are runtime; the port + presence/fence shapes are types only
// (see the `types` group below). `StoreCoordinationProvider` is hub-internal
// and intentionally NOT exported here — consumers inject their own.
export { isQuorum, runDrainBarrier } from '../coordination/index.js'

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
} from '../errors.js'

// Types only (erased at emit). NOTE: Vault / Collection / Noydb / Query are
// runtime classes in hub, but are re-exported here as TYPES — `instanceof`
// against these will not work from `@noy-db/hub/kernel`. Consumers needing a
// runtime class value must import it from `@noy-db/hub` directly.
// ─── types ────────────────────────────────────────────────────────
export type { ChangeEvent } from '../types.js'
export type { Vault } from '../vault.js'
export type { Collection } from '../collection.js'
export type { Noydb } from '../noydb.js'
export type { Operator } from '../query/predicate.js'
export type { Query } from '../query/builder.js'
export type { JoinStrategy } from '../query/join.js'
export type { LiveQuery } from '../query/live.js'
export type {
  AggregateResult,
  AggregateSpec,
  LiveAggregation,
} from '../aggregate/aggregation.js'
export type { IndexDef } from '../indexing/eager-indexes.js'
// #469 coordination port types — the implementable contract surface for an
// injected drain-barrier transport (runtime helpers are in the group above).
export type {
  CoordinationProvider,
  WriterPresence,
  FenceState,
  DrainBarrierOptions,
} from '../coordination/index.js'
