/**
 * `@noy-db/hub/kernel/store` — always-on store primitives.
 *
 * Store routing, middleware, and bundle-store wrapping are opt-in services
 * that live outside the kernel (`@noy-db/hub/src/with-store/`,
 * `@noy-db/hub/src/with-pod/pod-store.ts`) — they have zero kernel call
 * sites. This barrel keeps only what the kernel itself depends on:
 * the in-memory store used by `createNoydb()` defaults, the sync-policy
 * types consumed by `kernel/types.ts` and `kernel/noydb.ts`, and the
 * store-capability error re-export.
 */

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

// ─── Memory store ────────────────────────────────────────────
export { memoryStore } from './memory-store.js'

// ─── Store errors ────────────────────────────────────────────
// Re-exported from the central errors module so subpath consumers can
// `instanceof StoreCapabilityError` without falling back to the root barrel.
export { StoreCapabilityError } from '../errors.js'
