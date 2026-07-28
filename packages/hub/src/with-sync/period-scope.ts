/**
 * #807 — period-scoped pull support for the `SyncEngine` (thin-client
 * bootstrap: first sync pulls the current period + the period summaries;
 * historical periods backfill on demand via `pull({ periods: ['<name>'] })`).
 *
 * ## Membership law
 *
 * The engine only ever sees ciphertext envelopes, so period membership at
 * the sync tier is by write-time `_ts` against the closed periods' windows
 * (`periodExclusiveUpperBound`) — the SAME store-tier law freeze (#604) and
 * archive (#613) use, NOT the business-date (`dateField`) seal the write
 * guard applies inside the trust boundary. A late-booked record (in-period
 * business date, current write-time) therefore syncs with the current
 * period — mirroring how it archives at the NEXT period's archive.
 *
 * Closed periods partition the timeline by their exclusive upper bounds:
 * the earliest closed period's window is unbounded below (a close seals
 * everything at-or-before its `endDate`), each later one starts at its
 * predecessor's bound, and the CURRENT window is everything at-or-after
 * the latest closed bound (everything, when no period was ever closed).
 *
 * ## What a period filter can never drop
 *
 * - **Period summaries** (`_periods` + freeze/archive/target-purge
 *   companions) — the navigation index; always pulled in full, exempt from
 *   every filter (`collections`, `periods`, `modifiedSince`).
 * - **Delete markers and tombstones** — an erasure or delete must never be
 *   skipped by partial sync (the #589/#590 law, mirroring the
 *   `modifiedSince` exemption). This is what makes a device that never
 *   pulled period P converge instead of resurrecting P's deleted records
 *   when it later backfills.
 * - **Reserved lookups** (`_dict_*`/`_lookup_*`) — vocabulary/config rows
 *   are not period-partitioned data; their explicit pull loop is exempt.
 *
 * Push is NEVER period-filtered — `PushOptions` has no `periods` member at
 * all; a thin client's writes always flow up in full.
 */
import type { EncryptedEnvelope } from '../kernel/types.js'
import { ValidationError } from '../kernel/errors.js'
import { isTombstoneShape, isDeleteMarker } from '../kernel/enclave/index.js'
import {
  PERIODS_COLLECTION,
  PERIOD_FREEZES_COLLECTION,
  PERIOD_ARCHIVES_COLLECTION,
  PERIOD_TARGET_PURGES_COLLECTION,
  periodExclusiveUpperBound,
} from '../with-audit/periods/window.js'

export { PERIODS_COLLECTION }

/**
 * The reserved period-metadata collections a period-scoped pull always
 * fetches first (phase 1, "summaries"): the hash-chained `_periods` index
 * plus its freeze/archive/target-purge companions.
 */
export const PERIOD_SUMMARY_COLLECTIONS: readonly string[] = [
  PERIODS_COLLECTION,
  PERIOD_FREEZES_COLLECTION,
  PERIOD_ARCHIVES_COLLECTION,
  PERIOD_TARGET_PURGES_COLLECTION,
]

/** The subset of a decrypted `PeriodRecord` the window computation needs. */
export interface PeriodSyncRecord {
  readonly name: string
  readonly kind: 'closed' | 'opened'
  readonly endDate: string
}

/**
 * Vault-injected source of decrypted period records, wired via
 * `SyncEngine.setPeriodPullSource` (same injection pattern as
 * `setReservedLookupSource`). MUST re-read from the local store on every
 * call — the engine invokes it right after the summaries phase applied
 * freshly pulled `_periods` envelopes.
 */
export interface PeriodPullSource {
  periods(): Promise<readonly PeriodSyncRecord[]>
}

const SHAPE_MSG =
  'pull: `periods` must be an array of closed-period names, or `{ current: true }`.'

/** Validate the raw `PullOptions.periods` value (runtime shape only). */
export function validatePeriodsOption(
  periods: unknown,
): asserts periods is readonly string[] | { readonly current: true } {
  if (Array.isArray(periods)) {
    for (const p of periods) {
      if (typeof p !== 'string' || p.length === 0) throw new ValidationError(SHAPE_MSG)
    }
    return
  }
  if (
    typeof periods === 'object' && periods !== null &&
    (periods as { current?: unknown }).current === true &&
    Object.keys(periods).length === 1
  ) {
    return
  }
  throw new ValidationError(SHAPE_MSG)
}

/**
 * Resolve the selected `_ts` windows and return the pull-scope predicate:
 * `true` = the envelope is in scope for this pull. Tombstones and delete
 * markers are unconditionally in scope (see module doc).
 *
 * Throws `ValidationError` for a name that is not a closed period in the
 * (freshly synced) `_periods` index — a typo'd backfill must fail loudly,
 * never silently pull nothing.
 */
export function buildPeriodScope(
  option: readonly string[] | { readonly current: true },
  records: readonly PeriodSyncRecord[],
): (envelope: EncryptedEnvelope) => boolean {
  const closed = records
    .filter((r) => r.kind === 'closed')
    .map((r) => ({ name: r.name, bound: periodExclusiveUpperBound(r.endDate) }))
    .sort((a, b) => a.bound.localeCompare(b.bound))

  let windows: ReadonlyArray<{ lower: string | null; upper: string | null }>
  if (Array.isArray(option)) {
    windows = (option as readonly string[]).map((name) => {
      const idx = closed.findIndex((c) => c.name === name)
      if (idx < 0) {
        const other = records.find((r) => r.name === name)
        throw new ValidationError(
          other
            ? `pull: period "${name}" is "${other.kind}" — only closed periods have a backfill window; use \`{ current: true }\` for the open period.`
            : `pull: no closed period named "${name}" in this vault's _periods index.`,
        )
      }
      return { lower: idx > 0 ? closed[idx - 1]!.bound : null, upper: closed[idx]!.bound }
    })
  } else {
    // { current: true } — everything at-or-after the latest closed bound
    // (everything, when no period was ever closed: with no closed periods
    // there is nothing historical to exclude, so nothing is silently dropped).
    windows = [{ lower: closed.length > 0 ? closed[closed.length - 1]!.bound : null, upper: null }]
  }

  return (envelope: EncryptedEnvelope): boolean => {
    if (isTombstoneShape(envelope) || isDeleteMarker(envelope)) return true
    return windows.some(
      (w) =>
        (w.lower === null || envelope._ts >= w.lower) &&
        (w.upper === null || envelope._ts < w.upper),
    )
  }
}
