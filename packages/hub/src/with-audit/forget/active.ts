/**
 * `withForgetCascade` — the active factory for GDPR right-to-erasure via
 * per-record CEK crypto-shred. Mirrors the canonical
 * `strategy.ts` (type + `NO_FORGET` sentinel) / `active.ts` (factory) split
 * used by the other services.
 *
 * @module
 */
import type { SubjectDeclaration, ForgetStrategy } from './strategy.js'

/**
 * Declare GDPR crypto-shred for one or more collections.
 *
 * Each declared collection is forced to `perRecordKeys: true` (a shred can
 * only guarantee erasure of a record whose body is keyed off a per-record
 * CEK). On write, Noydb extracts `record[subjectField]` and maintains an
 * encrypted `_subject_index` mapping `subject → [{collection, id}]`, so
 * `vault.forget(subjectId)` can find every record for a subject and rewrite
 * each to a tombstone (body + history permanently undecryptable) while the
 * collection DEK and every other record stay intact.
 *
 * @example
 * ```ts
 * createNoydb({
 *   secret, user,
 *   forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }),
 * })
 * const result = await vault.forget('buyer-123')
 * // → { subject, recordsShredded, historyVersionsShredded, collections, … }
 * ```
 */
export function withForgetCascade(opts: SubjectDeclaration): ForgetStrategy {
  return { subjects: { ...opts.subjects } }
}
