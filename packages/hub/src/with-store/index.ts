/**
 * `@noy-db/hub` store routing + middleware — opt-in service.
 *
 * Store routing (multiplex by collection/size/age) and composable store
 * middleware (retry, logging, metrics, circuit-breaker, cache, health-check).
 * Published as `@noy-db/hub/store` (#843 C3a). Also re-exported from the root
 * barrel, matching how the Via features are dual-homed — the subpath exists so
 * the surface is navigable and tree-shakeable, not to force a migration.
 *
 * Named re-exports (not `export *`) so tsup keeps the barrel populated
 * even with `sideEffects: false`.
 */

// ─── Store routing ─────────────────────────────────────
export { routeStore } from './route-store.js'
export type {
  RouteStoreOptions,
  RoutedNoydbStore,
  BlobStoreRoute,
  AgeRoute,
  BlobLifecyclePolicy,
  OverrideTarget,
  OverrideOptions,
  SuspendOptions,
  RouteStatus,
} from './route-store.js'

// ─── Store middleware ────────────────────────────────────────
export {
  wrapStore,
  withRetry,
  withLogging,
  withMetrics,
  withCircuitBreaker,
  withCache,
  withHealthCheck,
} from './store-middleware.js'
export type {
  StoreMiddleware,
  RetryOptions,
  LoggingOptions,
  LogLevel,
  MetricsOptions,
  StoreOperation,
  CircuitBreakerOptions,
  StoreCacheOptions,
  HealthCheckOptions,
} from './store-middleware.js'
