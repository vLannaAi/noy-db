/**
 * `@noy-db/hub/store` — subpath export for document-storage plumbing.
 *
 * The main `@noy-db/hub` entry still re-exports every symbol from
 * this subpath for backward compatibility through v0.15.x. Consumers
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

// ─── Store middleware (#164) ────────────────────────────────────────
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

// ─── Bundle store (#103) ────────────────────────────────────────────
export { wrapBundleStore, createBundleStore } from './bundle-store.js'
export type { WrappedBundleNoydbStore, WrapBundleStoreOptions } from './bundle-store.js'

// ─── Sync policy (#101) ─────────────────────────────────────────────
export { SyncScheduler, INDEXED_STORE_POLICY, BUNDLE_STORE_POLICY } from './sync-policy.js'
export type {
  SyncPolicy,
  PushPolicy,
  PullPolicy,
  PushMode,
  PullMode,
  SyncSchedulerStatus,
} from './sync-policy.js'

// ─── Blob primitives (#105) ─────────────────────────────────────────
export { BlobSet } from './blob-set.js'
export {
  BLOB_COLLECTION,
  BLOB_INDEX_COLLECTION,
  BLOB_CHUNKS_COLLECTION,
  BLOB_SLOTS_PREFIX,
  BLOB_VERSIONS_PREFIX,
  DEFAULT_CHUNK_SIZE,
} from './blob-set.js'
// These blob-related types live in the hub-root types module — re-export
// from there so the types surface of the subpath matches the main entry.
export type {
  BlobObject,
  SlotRecord,
  SlotInfo,
  VersionRecord,
  BlobPutOptions,
  BlobResponseOptions,
} from '../types.js'

// ─── MIME magic detection (#105) ────────────────────────────────────
export { detectMimeType, detectMagic, isPreCompressed } from './mime-magic.js'

// Legacy attachments (v0.11 name-surface, superseded by blob-set in v0.12)
// — not re-exported here to discourage new usage. Consumers that need
// the old names can import './attachments.js' directly.
