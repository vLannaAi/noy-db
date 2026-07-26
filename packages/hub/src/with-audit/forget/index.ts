/**
 * `@noy-db/hub/forget` — GDPR right-to-erasure via per-record CEK crypto-shred.
 * Import `withForgetCascade` and pass it to `createNoydb`:
 *
 * ```ts
 * import { createNoydb } from '@noy-db/hub'
 * import { withForgetCascade } from '@noy-db/hub/forget'
 *
 * const db = createNoydb({
 *   secret, user,
 *   historyStrategy: withHistory(),               // ledger for the erasure proof
 *   forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }),
 * })
 * const vault = await db.openVault('main')
 * const result = await vault.forget('buyer-123')
 * ```
 *
 * The erasure flow (`vault.forget`), the subject-index maintenance hooks, and
 * the tombstone rewrite live in core (`vault.ts` / `collection.ts`) because
 * they touch the write path directly; this subpath only exposes the
 * declaration factory + result types.
 *
 * @module
 */
export { withForgetCascade } from './active.js'
export { NO_FORGET } from './strategy.js'
export type {
  SubjectDeclaration,
  ForgetStrategy,
  ForgetResult,
  ScopedPurgeResidueNotice,
} from './strategy.js'
export type { SubjectRef } from './subject-index.js'
export { SUBJECT_INDEX_COLLECTION } from './subject-index.js'
