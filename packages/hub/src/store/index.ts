/**
 * `@noy-db/hub/store` — subpath export for document-storage plumbing.
 *
 * The main `@noy-db/hub` entry still re-exports every symbol from
 * this subpath for backward compatibility through.x. Consumers
 * that opt into the subpath import get ~6-8 KB of bundle savings by
 * excluding routing + middleware + bundle-store machinery they
 * don't use.
 *
 * Named re-exports (not `export *`) so tsup keeps the barrel populated
 * even with `sideEffects: false`. See `tsup.config.ts` entries.
 */

// ─── Store routing (#162, #163) ─────────────────────────────────────
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

// ─── Bundle store ────────────────────────────────────────────
export { wrapBundleStore, createBundleStore } from './bundle-store.js'
export type { WrappedBundleNoydbStore, WrapBundleStoreOptions } from './bundle-store.js'

// ─── Sync policy ─────────────────────────────────────────────
export { SyncScheduler, INDEXED_STORE_POLICY, BUNDLE_STORE_POLICY } from './sync-policy.js'
export type {
  SyncPolicy,
  PushPolicy,
  PullPolicy,
  PushMode,
  PullMode,
  SyncSchedulerStatus,
} from './sync-policy.js'

// ─── Blob primitives relocated to packages/hub/src/blobs/ ──────────
//
// refactor: blob-set, mime-magic, attachments, compaction, and
// export-blobs moved to `../blobs/` so hub's optional "blob document"
// subsystem lives in one folder behind the `@noy-db/hub/blobs` subpath
// export. The root barrel (`../index.ts`) still re-exports `BlobSet`
// + the MIME helpers for backward compatibility with `@noy-db/as-blob`,
// `@noy-db/as-zip`, and any consumer reaching into the root namespace.
