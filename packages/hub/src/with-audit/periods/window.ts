/**
 * Pure period-window primitives — the reserved collection names and the
 * exclusive-upper-bound computation shared by freeze (#604), archive (#613),
 * target-purge (#615) and the period-scoped sync pull (#807).
 *
 * Deliberately dependency-light (kernel errors only): the sync engine
 * (`with-sync/period-scope.ts`) imports THIS module, not
 * `periods.ts`, so a period-scoped pull never drags the ledger hash-chain
 * machinery (`sha256Hex`/`canonicalJson`) into a bundle that opted out of
 * the periods service.
 */
import { ValidationError } from '../../kernel/errors.js'

/** The reserved collection name holding closed-period metadata. */
export const PERIODS_COLLECTION = '_periods'

/** Sibling of {@link PERIODS_COLLECTION} holding freeze companions (#604). */
export const PERIOD_FREEZES_COLLECTION = '_period_freezes'

/** Sibling of {@link PERIODS_COLLECTION} holding archive companions (#613). */
export const PERIOD_ARCHIVES_COLLECTION = '_period_archives'

/** Sibling of {@link PERIODS_COLLECTION} holding target-purge companions (#615). */
export const PERIOD_TARGET_PURGES_COLLECTION = '_period_target_purges'

/**
 * Exclusive upper bound for a period's delete-marker purge window (#604).
 * Markers carry no business date (empty body), only write-time `_ts`, so freeze
 * purges markers with `_ts < bound`, `bound` being the instant just after the
 * period's inclusive `endDate`: a date-only `endDate` seals through end-of-day
 * → next midnight; a full-timestamp `endDate` seals through that instant → +1ms.
 */
export function periodExclusiveUpperBound(endDate: string): string {
  const ms = Date.parse(endDate)
  if (Number.isNaN(ms)) throw new ValidationError(`freezePeriod: unparseable period endDate "${endDate}".`)
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(endDate)
  return new Date(ms + (dateOnly ? 86_400_000 : 1)).toISOString()
}
