/**
 * Accounting-period closure + opening.
 *
 * A closed period seals every record whose envelope `_ts` is at or
 * before the period's `endDate`: further writes (`put` / `delete`)
 * against such records throw {@link PeriodClosedError}. The period
 * itself is stored as a record in the reserved `_periods` collection
 * and written through the normal ledger-instrumented path, so every
 * closure appends a tamper-evident entry to the vault's hash chain.
 *
 * ## Closure model
 *
 * ```
 * vault.closePeriod({ name: 'FY2026-Q1', endDate: '2026-03-31' })
 *   └─► PeriodRecord written to _periods/<name>
 *         ├─ priorPeriodName / priorPeriodHash — chain to last close
 *         ├─ closedAt / closedBy — provenance
 *         └─ normal ledger append fires (LedgerStore.append)
 * ```
 *
 * Enforcement (`assertTsWritable`) is vault-local: the Vault caches
 * the list of closed periods on first read and consults that cache in
 * the `Collection.put` / `.delete` path via the `periodGuard` hook.
 *
 * ## Opening model
 *
 * ```
 * vault.openPeriod({
 *   name: 'FY2026-Q2',
 *   startDate: '2026-04-01',
 *   fromPeriod: 'FY2026-Q1',
 *   carryForward: async (priorView) => Record<string, Record<string, unknown>>,
 * })
 * ```
 *
 * `carryForward` receives a read-only `VaultInstant` anchored at the
 * prior period's `endDate` (built via `vault.at(endDate)`) so the
 * callback can compute closing aggregates from the sealed state. The
 * returned `{ [collectionName]: { [id]: record } }` map is written
 * before the new `PeriodRecord` lands — opening balances materialise
 * as normal records with fresh timestamps that fall outside every
 * closed period.
 *
 * ## Freeze
 *
 * ```
 * vault.freezePeriod('FY2026-Q1')
 *   └─► physically purges delete markers whose write-time falls inside
 *       the closed period's window (via the #589 `_purgeDeleteMarkers`
 *       seam), then records the fact:
 *         ├─ PeriodFreezeRecord written to _period_freezes/<name>
 *         └─ normal ledger append fires (LedgerStore.append)
 * ```
 *
 * The chained `_periods/<name>` record is never mutated — `frozenAt` /
 * `frozenBy` / `purgedMarkerCount` are merged onto the returned
 * `PeriodRecord` at read time from the companion, so a tamper with the
 * freeze can never break the inter-period hash chain. Freezing is
 * terminal (a closed period, once frozen, stays frozen) and idempotent
 * (a second call is a no-op that returns the same merged record without
 * re-purging or re-appending a ledger entry). Freeze does NOT purge
 * forget-tombstones (GDPR crypto-shred erasure evidence), `_history`
 * versions, or live records — the delete-markers-only seam leaves all
 * three untouched by construction.
 *
 * Freeze purges the LOCAL adapter only. On a synced vault, markers already
 * pushed to sync targets survive there, and a later pull re-imports them
 * (benign — they still read deleted, but the space isn't reclaimed). A
 * re-imported marker keeps its original `_ts` (inside the already-frozen
 * period's window), so — like any late-booked delete — it is reclaimed by
 * the NEXT period's freeze, whose window covers it; freeze stays terminal
 * and does NOT re-purge an already-frozen period (#611). Sweeping the sync
 * targets themselves is a cross-target-purge concern deferred to the
 * cold-archival spec. Purging re-opens the #589 resurrection window for a
 * peer offline since before the cutoff, which is why the closed period is
 * the operator-asserted safe-point that gates the call.
 *
 * A period whose purge window has not fully elapsed cannot be frozen —
 * `freezePeriod` throws rather than purge markers for deletes that may not
 * have converged yet (#610).
 *
 * ## Archive
 *
 * ```
 * vault.archivePeriod('FY2026-Q1')
 *   └─► relocates the closed period's in-window records (those with
 *       `_ts < periodExclusiveUpperBound(endDate)`) from the hot store to
 *       the configured cold tier (routeStore's `cold` route), then records:
 *         ├─ PeriodArchiveRecord written to _period_archives/<name>
 *         └─ a ledger entry attributed to _period_archives
 * ```
 *
 * Archival is NON-DESTRUCTIVE: routeStore reads fall through to the cold
 * tier on a hot miss, so an archived record still reads normally. It is
 * therefore gated only on `closed` (not `frozen`) — it does not re-open the
 * #589 resurrection window and needs no convergence safe-point. Freeze
 * (purge markers) and archive (relocate records) are independent and compose
 * in either order. Like freeze, archival keeps the chained `_periods/<name>`
 * record byte-immutable (state lives in the companion) and is idempotent.
 *
 * Bounds by write-time `_ts`, NOT business date: the store tier sees only
 * encrypted envelopes. A record with an in-period business date but a later
 * `_ts` (late-booked) archives at the NEXT period's archive — the same rule
 * freeze uses for late-booked delete markers. Requires a `routeStore` with a
 * cold route (`age: { cold }`); throws otherwise.
 *
 * Read cost: with `withLazy()` (per-id reads) archived records are truly
 * cold — fetched from cold only on access. In the default hydrated mode,
 * `loadAll` merges the cold store, so archived records still load into RAM
 * on vault open (hot-tier STORAGE is reclaimed; RAM is not). Summaries
 * (`_`-prefixed) always stay hot.
 *
 * ## Not covered
 *
 * - Partial re-opening of a closed period. If an auditor needs to
 *   make a correction inside a sealed period, the sanctioned path is
 *   a compensating entry in the NEW period, not an unlock of the
 *   old one.
 * - Automatic period rollover. `closePeriod` / `openPeriod` are
 *   deliberately explicit operator calls so the caller decides when
 *   the boundary lands.
 *
 * @module
 */

import type { NoydbStore, EncryptedEnvelope } from '../../kernel/types.js'
import type { LedgerStore } from '../../with-commit/history/ledger/index.js'
import { sha256Hex, canonicalJson } from '../../with-commit/history/ledger/index.js'
import { PeriodClosedError, ValidationError } from '../../kernel/errors.js'

/** The reserved collection name holding closed-period metadata. */
export const PERIODS_COLLECTION = '_periods'

/** Sibling of {@link PERIODS_COLLECTION} holding freeze companions (#604). */
export const PERIOD_FREEZES_COLLECTION = '_period_freezes'

/** Sibling of {@link PERIODS_COLLECTION} holding archive companions (#613). */
export const PERIOD_ARCHIVES_COLLECTION = '_period_archives'

/**
 * Companion record recording that a closed period was frozen (its delete
 * markers physically purged). Stored in {@link PERIOD_FREEZES_COLLECTION},
 * keyed by period name — kept OFF the hash-chained `_periods/<name>` record so
 * freeze never alters the inter-period chain.
 */
export interface PeriodFreezeRecord {
  readonly period: string
  readonly frozenAt: string
  readonly frozenBy: string
  readonly purgedMarkerCount: number
}

/**
 * Companion record noting that a closed period was cold-archived (its
 * in-window records physically relocated hot → cold). Stored in
 * {@link PERIOD_ARCHIVES_COLLECTION}, keyed by period name — kept OFF the
 * hash-chained `_periods/<name>` record so archive never alters the chain.
 */
export interface PeriodArchiveRecord {
  readonly period: string
  readonly archivedAt: string
  readonly archivedBy: string
  readonly archivedRecordCount: number
}

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

/**
 * Stored record for one closed or opened accounting period. One entry
 * per period, keyed by `name` in the reserved `_periods` collection.
 *
 * The hash chain between periods is computed at read time by
 * `loadPeriods()` — each record carries the name + hash of its
 * predecessor so a tamper with any period's record breaks the chain
 * into the next one, the same way the ledger's `prevHash` works.
 */
export interface PeriodRecord {
  /** Human-readable name (e.g., `'FY2026-Q1'`). Unique per vault. */
  readonly name: string
  /**
   * Role discriminator. A period is `'closed'` from the moment its
   * `closedAt` is recorded; `'opened'` marks a period whose opening
   * entries have been carried forward via {@link openPeriod}. Many
   * workflows will produce one opened period per closed period (the
   * opened one is the SUCCESSOR — its `startDate` equals the prior
   * `endDate + 1 day`).
   */
  readonly kind: 'closed' | 'opened'
  /** ISO date — inclusive upper bound for records belonging to this period. */
  readonly endDate: string
  /** ISO date — lower bound (present on opened periods only). */
  readonly startDate?: string
  /**
   * Record field carrying the business date (e.g. `'date'` on an
   * invoice, `'paidAt'` on a payment). The guard compares
   * `record[dateField]` against `endDate` — NOT the envelope `_ts`.
   * Accounting entries booked late (business date `2026-01-15`,
   * write-time `2026-04-22`) still get sealed when Q1 closes at
   * `2026-03-31` because the comparison uses the business date.
   *
   * Optional for backwards compat. When absent, the guard falls back
   * to envelope `_ts` — that's a write-time seal, appropriate for
   * content that doesn't carry a logical business date (e.g. system
   * settings) but almost never right for accounting ledgers.
   */
  readonly dateField?: string
  /** ISO timestamp recorded at `closePeriod()` / `openPeriod()` call time. */
  readonly closedAt: string
  /** userId of the keyring that invoked the close/open. */
  readonly closedBy: string
  /** Name of the prior period this one chains to, if any. */
  readonly priorPeriodName?: string
  /** sha256(canonicalJson(priorPeriod)) — empty for the first period. */
  readonly priorPeriodHash: string
  /**
   * Opened periods only — the names of the collections whose
   * carry-forward aggregates were written by {@link openPeriod}.
   * Recorded for auditability so a future `verifyPeriodChain()` can
   * cross-check the opening balances against the closing snapshot.
   */
  readonly openingCollections?: readonly string[]
  /** #604 return-only — merged from the `_period_freezes/<name>` companion on
   *  read; NEVER written into the stored `_periods/<name>` record (would break
   *  the hash chain). Absent = not yet frozen. */
  readonly frozenAt?: string
  readonly frozenBy?: string
  readonly purgedMarkerCount?: number
  /** #613 return-only — merged from the `_period_archives/<name>` companion on
   *  read; NEVER written into the stored `_periods/<name>` record. Absent = not
   *  yet archived. */
  readonly archivedAt?: string
  readonly archivedBy?: string
  readonly archivedRecordCount?: number
}

/** Options for `vault.closePeriod()`. */
export interface ClosePeriodOptions {
  /** Human-readable name. Must not collide with an existing period. */
  readonly name: string
  /**
   * Inclusive upper cutoff. A record is sealed when its
   * `record[dateField]` (or, if absent, the envelope `_ts`) is at or
   * before this ISO timestamp.
   */
  readonly endDate: string
  /**
   * Record field carrying the business date used for period
   * membership. Recommended for accounting workflows — e.g. an
   * invoice booked late (write-time after close) is still sealed
   * when its `invoice.date` falls inside the closed period.
   *
   * Omit to use envelope `_ts` (write-time seal). This fallback
   * rarely matches real-world accounting semantics; prefer passing
   * an explicit `dateField`.
   */
  readonly dateField?: string
}

/** Options for `vault.openPeriod()`. */
export interface OpenPeriodOptions<TCollections = Record<string, Record<string, unknown>>> {
  /** Human-readable name for the new period. Must be unique. */
  readonly name: string
  /** ISO lower bound of the new period (usually prior `endDate + 1 day`). */
  readonly startDate: string
  /**
   * Name of the prior CLOSED period this one chains from. The prior
   * period's record is verified to exist and to be `kind: 'closed'`;
   * its `endDate` is made available to the `carryForward` callback.
   */
  readonly fromPeriod: string
  /**
   * Receives a read-only facade over the vault's CURRENT state,
   * plus the prior period's `endDate`. Accounting semantics: after
   * a period closes, records with `record[dateField] <= endDate`
   * are frozen — current state equals closing state, so a caller
   * can compute closing balances by querying the live collection
   * with a `where('date', '<=', priorEndDate)` filter.
   *
   * Returns opening-balance records keyed by collection name.
   * Example:
   *
   * ```ts
   * carryForward: async (ctx) => {
   *   const closing = await ctx.collection<Journal>('journal')
   *     .query().where('date', '<=', ctx.priorEndDate).toArray()
   *   const opening: Record<string, Journal> = {}
   *   for (const entry of closing) {
   *     opening[`OB-${entry.id}`] = { ...entry, date: '2026-04-01' }
   *   }
   *   return { journal: opening }
   * }
   * ```
   */
  readonly carryForward: (
    ctx: CarryForwardContext,
  ) => Promise<TCollections> | TCollections
}

/**
 * Context passed to `OpenPeriodOptions.carryForward`. Exposes a
 * read-only subset of the live vault (`collection(name).get/list`)
 * plus the prior period's `endDate` so business-date filters can
 * be built by the caller.
 *
 * Writes go via the return value, not via the facade — the
 * `collection()` here is deliberately restricted to reads.
 */
export interface CarryForwardContext {
  /** The prior period's `endDate` — the boundary of the closing snapshot. */
  readonly priorEndDate: string
  /** Read-only collection facade over current vault state. */
  collection<T = unknown>(name: string): ReadOnlyCollection<T>
}

/** Minimum read surface exposed to `carryForward`. */
export interface ReadOnlyCollection<T> {
  get(id: string): Promise<T | null>
  list(): Promise<T[]>
}

/**
 * Load every period record currently stored on the adapter.
 * Decrypting is the caller's responsibility (we return plain records
 * so the vault can use its own `_periods` DEK).
 *
 * @internal — called by Vault methods that need the closed-period
 * cache. Not part of the public API surface.
 */
export async function loadPeriods(
  adapter: NoydbStore,
  vault: string,
  decrypt: (envelope: EncryptedEnvelope) => Promise<PeriodRecord>,
): Promise<PeriodRecord[]> {
  const ids = await adapter.list(vault, PERIODS_COLLECTION)
  const records: PeriodRecord[] = []
  for (const id of ids) {
    const env = await adapter.get(vault, PERIODS_COLLECTION, id)
    if (env) records.push(await decrypt(env))
  }
  // Stable order by closedAt so chain verification is reproducible.
  records.sort((a, b) => a.closedAt.localeCompare(b.closedAt))
  return records
}

/**
 * Given the current ordered period list, pick the last entry that
 * belongs to the hash chain — used as the `priorPeriodHash` anchor
 * for the next closure/opening.
 *
 * @internal
 */
export async function chainAnchor(
  records: readonly PeriodRecord[],
): Promise<{ priorPeriodName?: string; priorPeriodHash: string }> {
  const last = records[records.length - 1]
  if (!last) return { priorPeriodHash: '' }
  const hash = await sha256Hex(canonicalJson(last as unknown as Record<string, unknown>))
  return { priorPeriodName: last.name, priorPeriodHash: hash }
}

/**
 * Throw `PeriodClosedError` if the record being touched falls within
 * any closed period.
 *
 * Three signals, evaluated per period:
 *
 *  1. If the period declares a `dateField`, the guard reads
 *     `record[dateField]` on BOTH the existing (prior) record AND the
 *     incoming (new) record. Either comparing `<= endDate` triggers
 *     the error — callers cannot slide a record into a closed period
 *     by editing its date field.
 *  2. If the period has no `dateField`, the guard falls back to the
 *     envelope `_ts` of the existing record. Fresh inserts (no
 *     existing envelope) pass.
 *  3. For a delete, only the existing side is checked.
 *
 * @internal
 */
export function assertTsWritable(
  existing: { ts: string | null; record: Record<string, unknown> | null } | null,
  incomingRecord: Record<string, unknown> | null,
  closedPeriods: readonly PeriodRecord[],
): void {
  for (const p of closedPeriods) {
    if (p.kind !== 'closed') continue
    if (p.dateField) {
      const checkRecord = (label: string, r: Record<string, unknown> | null): void => {
        if (!r) return
        const v = r[p.dateField!]
        if (typeof v === 'string' && v <= p.endDate) {
          throw new PeriodClosedError(p.name, p.endDate, `${label}[${p.dateField}]=${v}`)
        }
      }
      checkRecord('existing', existing?.record ?? null)
      checkRecord('incoming', incomingRecord)
      continue
    }
    // Fallback: write-time seal via envelope _ts.
    const existingTs = existing?.ts ?? null
    if (existingTs !== null && existingTs <= p.endDate) {
      throw new PeriodClosedError(p.name, p.endDate, existingTs)
    }
  }
}

/**
 * Sanity-check a proposed period name + endDate against existing
 * records. Shared by closePeriod / openPeriod so the two pathways
 * produce identical diagnostics.
 *
 * @internal
 */
export function validatePeriodName(
  name: string,
  existing: readonly PeriodRecord[],
): void {
  if (name.length === 0) {
    throw new ValidationError('Period name cannot be empty.')
  }
  if (existing.some((p) => p.name === name)) {
    throw new ValidationError(`Period "${name}" already exists.`)
  }
}

/**
 * Wire a reserved-collection ledger append for a period record. The
 * period itself is stored via the adapter as an encrypted envelope;
 * the ledger entry is a normal `put` with the period's payloadHash,
 * so period closures inherit the chain's tamper-evidence.
 *
 * @internal
 */
export async function appendPeriodLedgerEntry(
  ledger: LedgerStore | null,
  actor: string,
  envelope: EncryptedEnvelope,
  name: string,
  collection: string = PERIODS_COLLECTION,
): Promise<void> {
  if (!ledger) return
  const { envelopePayloadHash } = await import('../../with-commit/history/ledger/index.js')
  await ledger.append({
    op: 'put',
    collection,
    id: name,
    version: envelope._v,
    actor,
    payloadHash: await envelopePayloadHash(envelope),
  })
}
