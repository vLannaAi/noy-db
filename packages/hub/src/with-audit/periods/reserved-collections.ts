/**
 * #1454 — the periods family, refused by `vault.collection()`.
 *
 * Sibling of `with-party/team/reserved-secret-collections.ts` and
 * `with-shape/manifest/reserved-collections.ts`, for a different reason:
 * these are INTEGRITY-bearing, not secret-bearing. Their contents are not
 * sensitive, but a `put()` through the generic handle rewrites a close or
 * erases an append-only reopen log with no error and no trace — measured on a
 * real pod, undetected on the next cold open. The period engine is the only
 * legitimate writer and has its own path.
 *
 * Kept dependency-light (constants only) so the kernel's collection() door
 * can import it without dragging the period engine into every bundle.
 */
import {
  PERIODS_COLLECTION,
  PERIOD_FREEZES_COLLECTION,
  PERIOD_ARCHIVES_COLLECTION,
  PERIOD_TARGET_PURGES_COLLECTION,
  PERIOD_REOPENS_COLLECTION,
} from './window.js'

export const PERIODS_RESERVED_COLLECTIONS: ReadonlySet<string> = new Set([
  PERIODS_COLLECTION,
  PERIOD_FREEZES_COLLECTION,
  PERIOD_ARCHIVES_COLLECTION,
  PERIOD_TARGET_PURGES_COLLECTION,
  PERIOD_REOPENS_COLLECTION,
])

/** True when `name` belongs to the periods family (#1454). */
export function isPeriodsReservedCollection(name: string): boolean {
  return PERIODS_RESERVED_COLLECTIONS.has(name)
}
