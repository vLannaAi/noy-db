export { withMaterializedView } from './with-materialized-view.js'
export { MaterializedViewRegistry } from './registry.js'
export { MaterializedViewExecutor } from './executor.js'
export { analyzeDependencies, summarizeQueryPlan } from './dependency-analyzer.js'
export { computeQueryHash, canonicalizeQueryPlan } from './query-hash.js'
export { markMVStale, resolveStaleMVOnRead, isMVStale, clearMVStale } from './stale.js'
export type { MVStaleAccessor } from './stale.js'
export type {
  MaterializedViewStrategy,
  MaterializedViewStrategyHandle,
  MaterializedViewOutput,
  MaterializedFromMeta,
} from './types.js'
export type { RegisteredMV } from './registry.js'
export type { MVExecutorAccessor, RefreshResult } from './executor.js'

// Re-export errors so `@noy-db/hub/materialized-views` is self-contained
// (matches the v1 derivations subpath pattern).
export {
  MaterializedViewCycleError,
  MaterializedViewSourceUnknownError,
} from '../errors.js'
