/**
 * `@noy-db/hub` store routing + middleware — opt-in service.
 *
 * Store routing (multiplex by collection/size/age) and composable store
 * middleware (retry, logging, metrics, circuit-breaker, cache, health-check).
 * Root-barrel-only: no dedicated `@noy-db/hub/with-store` subpath export —
 * consumers reach these through the main `@noy-db/hub` entry.
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
