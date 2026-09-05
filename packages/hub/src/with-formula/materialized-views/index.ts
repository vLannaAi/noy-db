export { withMaterializedView } from './with-materialized-view.js'
export { MaterializedViewRegistry } from './registry.js'
export { MaterializedViewExecutor } from './executor.js'
export { analyzeDependencies, summarizeQueryPlan } from './dependency-analyzer.js'
export { computeQueryHash, canonicalizeQueryPlan } from './query-hash.js'
export { markMVStale, resolveStaleMVOnRead, isMVStale, clearMVStale } from './stale.js'
export type { MVStaleAccessor } from './stale.js'
export type {
  MaterializedViewSpec,
  MaterializedViewStrategy,
  MaterializedViewOutput,
  MaterializedFromMeta,
  UnionSource,
  UnionArmJoin,
  ProjectionSpec,
  ProjectionJoinLeg,
} from './types.js'
export type { RegisteredMV } from './registry.js'
export type { MVExecutorAccessor, RefreshResult } from './executor.js'
// #1418 — the emit-diff counters carried on every RefreshResult.
export type { MvMaintenanceStats } from './emit-cache.js'

// Re-export errors so `@noy-db/hub/materialized-views` is self-contained
// (matches the v1 derivations subpath pattern).
export {
  MaterializedViewCycleError,
  MaterializedViewConfigError,
  MaterializedViewSourceUnknownError,
  MaterializedViewTooLargeError,
} from '../../kernel/errors.js'

// #837 — dispatch context named by this entry's signatures.
export type { PutDerivedOutputCtx } from '../../kernel/via/dispatch.js'
