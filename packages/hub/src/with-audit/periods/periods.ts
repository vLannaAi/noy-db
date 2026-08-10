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
 * ## Target-purge
 *
 * ```
 * vault.purgePeriodTargets('FY2026-Q1')
 *   └─► sweeps delete markers (`_ts < periodExclusiveUpperBound(endDate)`) off
 *       the vault's PUSH-ONLY sync targets (backup/archive roles), then records:
 *         ├─ PeriodTargetPurgeRecord written to _period_target_purges/<name>
 *         └─ a ledger entry attributed to _period_target_purges
 * ```
 *
 * Extends freeze's local marker purge to the vault's own remote sinks.
 * `sync-peer` (bidirectional) targets are SKIPPED: purging a marker there
 * re-opens the #589 resurrection window for a client offline before the
 * cutoff, an assertion no single vault can verify. Backup/archive targets are
 * push-only — never pulled from into convergence — so sweeping their markers
 * is safe. Requires the period be frozen first (closed → frozen →
 * target-purged) so the local safe-point is already established. Idempotent
 * once run; a vault with no push-only targets writes no companion and is
 * re-runnable (so a target added later is still swept). Single-vault only —
 * fleet-wide purge across sovereign vaults is klum's concern over
 * `@noy-db/hub/cargo`.
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
import { isDeleteMarker } from '../../kernel/enclave/index.js'
import { PeriodClosedError, ValidationError } from '../../kernel/errors.js'

// The reserved collection names + `periodExclusiveUpperBound` moved to the
// dependency-light `window.ts` so the sync engine's period-scoped pull (#807)
// can import them without this module's ledger imports; re-exported here so
// every existing import path keeps working.
export {
  PERIODS_COLLECTION,
  PERIOD_FREEZES_COLLECTION,
  PERIOD_ARCHIVES_COLLECTION,
  PERIOD_TARGET_PURGES_COLLECTION,
  PERIOD_REOPENS_COLLECTION,
  periodExclusiveUpperBound,
} from './window.js'
import { PERIODS_COLLECTION } from './window.js'

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

/** Per-target count of delete markers purged off one push-only sync target (#615). */
export interface TargetPurgeCount {
  readonly label?: string
  readonly role: 'backup' | 'archive'
  readonly purgedCount: number
}

/**
 * One entry in a period's append-only reopen/reclose log (#1022).
 *
 * Real accounting close is a three-state lifecycle — open / closed / reopened
 * — not a one-way door. A month gets closed, a missing invoice arrives or a
 * filing is rejected, the month is reopened, corrected, and reclosed. The audit
 * value is not the ability to write again; it is the chain being able to say
 * *closed at T1, reopened at T2 by U, reclosed at T3*.
 */
export interface PeriodReopenEvent {
  readonly op: 'reopen' | 'reclose'
  /** ISO timestamp the event was recorded. */
  readonly at: string
  /** userId of the keyring that performed it. */
  readonly by: string
  /**
   * `reopen` only — ISO instant after which the period re-seals on its own,
   * with nobody acting. Absent means the window stays open until an explicit
   * `reclosePeriod`.
   */
  readonly until?: string
  /** Free-text justification, carried verbatim into the audit trail. */
  readonly reason?: string
}

/**
 * Companion holding a period's reopen/reclose history (#1022). Stored in
 * {@link PERIOD_REOPENS_COLLECTION}, keyed by the period's storage key — kept
 * OFF the hash-chained `_periods/<name>` record for the same reason freeze and
 * archive are: reopening must never rewrite the close, or the chain that proves
 * the close happened is the very thing the reopen destroys.
 *
 * `events` is APPEND-ONLY. Where the other companions are single-shot and
 * idempotent, this one accumulates, because the cycle repeats.
 */
export interface PeriodReopenRecord {
  readonly period: string
  readonly partition?: PeriodPartition
  readonly events: readonly PeriodReopenEvent[]
}

/**
 * Collapse an append-only reopen log into the return-only fields merged onto a
 * {@link PeriodRecord} on read.
 *
 * Expiry is deliberately NOT resolved here: `reopenedUntil` is carried through
 * verbatim and compared against the clock at write-guard time, so a bounded
 * window re-seals on its own without anything having to run.
 *
 * @internal
 */
export function resolveReopenState(events: readonly PeriodReopenEvent[]): {
  reopenedAt?: string
  reopenedBy?: string
  reopenedUntil?: string
  reopenReason?: string
  reclosedAt?: string
  reopenCount: number
} {
  let lastReopen: PeriodReopenEvent | undefined
  let reclosedAfter: string | undefined
  let reopenCount = 0
  for (const e of events) {
    if (e.op === 'reopen') {
      lastReopen = e
      reclosedAfter = undefined
      reopenCount++
    } else if (lastReopen !== undefined) {
      reclosedAfter = e.at
    }
  }
  if (!lastReopen) return { reopenCount }
  return {
    reopenedAt: lastReopen.at,
    reopenedBy: lastReopen.by,
    ...(lastReopen.until !== undefined && { reopenedUntil: lastReopen.until }),
    ...(lastReopen.reason !== undefined && { reopenReason: lastReopen.reason }),
    ...(reclosedAfter !== undefined && { reclosedAt: reclosedAfter }),
    reopenCount,
  }
}

/**
 * Is this period writable right now on account of a reopen? (#1022)
 *
 * Three ways to be sealed again: never reopened, explicitly reclosed after the
 * last reopen, or a bounded window that has elapsed. The clock is read by the
 * caller and passed in, so the guard and any diagnostic agree on one instant.
 *
 * @internal
 */
export function isEffectivelyReopened(period: PeriodRecord, nowIso: string): boolean {
  if (period.reopenedAt === undefined) return false
  if (period.reclosedAt !== undefined && period.reclosedAt >= period.reopenedAt) return false
  if (period.reopenedUntil !== undefined && nowIso > period.reopenedUntil) return false
  return true
}

/**
 * Companion record noting that a closed+frozen period's delete markers were
 * swept off the vault's push-only sync targets (#615). Stored in
 * {@link PERIOD_TARGET_PURGES_COLLECTION}, keyed by period name — kept OFF the
 * hash-chained `_periods/<name>` record so target-purge never alters the chain.
 */
export interface PeriodTargetPurgeRecord {
  readonly period: string
  readonly purgedAt: string
  readonly purgedBy: string
  readonly targets: readonly TargetPurgeCount[]
}

/**
 * Scope tuple for a period timeline (#1005).
 *
 * Identical in shape and semantics to `SequenceOptions.partition`: a
 * partitioned timeline is always disjoint from any unpartitioned one, and from
 * every other tuple. `['acme', 'vat']` and `['acme', 'wht']` are two
 * independent close calendars for the same subject — which is the whole point,
 * since sub-ledgers for one legal entity and one month routinely close on
 * different statutory deadlines.
 */
export type PeriodPartition = readonly (string | number)[]

/**
 * Resolve the `_periods` storage key for a (name, partition) pair.
 *
 * Deliberately the same encoding as `resolveSequenceKey`: `name` verbatim when
 * unpartitioned, else `${name}\x00${parts}` with each component
 * `encodeURIComponent`d and `'/'`-joined. The null-byte separator cannot occur
 * in a period name, so a partitioned key never collides with an unpartitioned
 * one; URI-encoding keeps `['a/b']` distinct from `['a','b']`.
 *
 * @throws {ValidationError} on an empty component or a non-finite number.
 * @internal
 */
export function resolvePeriodKey(name: string, partition?: PeriodPartition): string {
  if (!partition || partition.length === 0) return name
  const parts = partition.map((p) => {
    if (typeof p === 'number' && !Number.isFinite(p)) {
      throw new ValidationError(`period partition component must be a finite number, got ${p}`)
    }
    const s = String(p)
    if (s === '') {
      throw new ValidationError('period partition component must not be empty')
    }
    return encodeURIComponent(s)
  })
  return `${name}\x00${parts.join('/')}`
}

/**
 * Do two partitions denote the same timeline? Absent and empty both mean "the
 * unpartitioned timeline", so they compare equal.
 *
 * @internal
 */
export function samePartition(a?: PeriodPartition, b?: PeriodPartition): boolean {
  const x = a ?? []
  const y = b ?? []
  if (x.length !== y.length) return false
  return x.every((v, i) => String(v) === String(y[i]))
}

/**
 * Resolves a record to the timeline that governs it. Supplied by
 * `withPeriods({ subjects })`; returns `undefined` for any collection with no
 * mapping, which is what keeps an unconfigured vault on the single vault-wide
 * timeline it has always had.
 *
 * @internal
 */
export type PartitionResolver = (
  collection: string,
  record: Record<string, unknown>,
) => PeriodPartition | undefined

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
  /**
   * Human-readable name (e.g., `'FY2026-Q1'`). Unique per PARTITION — two
   * timelines may each carry a `'2026-06'`, which is the normal case when one
   * vault serves several subjects (#1005). Unique per vault when unpartitioned.
   */
  readonly name: string
  /**
   * The timeline this period belongs to. Absent = the vault-wide timeline.
   * Two periods with the same `name` and different `partition` are unrelated:
   * separate hash chains, separate close state, and the write guard applies
   * each only to records that resolve to its own tuple.
   */
  readonly partition?: PeriodPartition
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
  /** #615 return-only — merged from the `_period_target_purges/<name>` companion
   *  on read; NEVER written into the stored `_periods/<name>` record. Absent =
   *  target-purge not yet run (or the vault has no push-only targets). */
  readonly targetsPurgedAt?: string
  readonly targetsPurgedBy?: string
  readonly targetsPurged?: readonly TargetPurgeCount[]
  /** #1022 return-only — collapsed from the `_period_reopens/<key>` append-only
   *  log on read; NEVER written into the stored `_periods/<name>` record, so a
   *  reopen cannot disturb the inter-period hash chain. Absent = never reopened.
   *  `reclosedAt` present (and >= `reopenedAt`) means the window was closed
   *  again explicitly; `reopenedUntil` in the past means it lapsed on its own.
   *  Use {@link isEffectivelyReopened} rather than reading these directly. */
  readonly reopenedAt?: string
  readonly reopenedBy?: string
  readonly reopenedUntil?: string
  readonly reopenReason?: string
  readonly reclosedAt?: string
  /** How many times this period has been reopened, ever. */
  readonly reopenCount?: number
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
  /**
   * Close only this timeline (#1005). Omit for the vault-wide timeline.
   *
   * ```ts
   * vault.closePeriod({
   *   name: '2026-06', endDate: '2026-06-30', dateField: 'issuedAt',
   *   partition: [clientId, 'vat'],
   * })
   * ```
   *
   * Which records the resulting seal applies to is decided by the
   * `subjects` map passed to `withPeriods()` — without one, no record ever
   * resolves to a partition and a partitioned close seals nothing.
   */
  readonly partition?: PeriodPartition
}

/** Options for `vault.openPeriod()`. */
export interface OpenPeriodOptions<TCollections = Record<string, Record<string, unknown>>> {
  /** Human-readable name for the new period. Must be unique. */
  readonly name: string
  /**
   * The timeline to open in. Must match the partition of `fromPeriod` — a
   * period cannot chain across timelines, since each carries its own hash
   * chain (#1005).
   */
  readonly partition?: PeriodPartition
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
  partition?: PeriodPartition,
): Promise<{ priorPeriodName?: string; priorPeriodHash: string }> {
  // #1005 — each timeline carries its OWN chain. Anchoring a partitioned close
  // to whatever happened to be written last vault-wide would interleave
  // unrelated subjects into one chain, so verifying client A's June would
  // depend on client B never having closed in between.
  const inTimeline = records.filter((p) => samePartition(p.partition, partition))
  const last = inTimeline[inTimeline.length - 1]
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
  scope?: { collection: string; resolve?: PartitionResolver },
): void {
  // #1005 — a period only governs records that resolve to ITS timeline. With no
  // resolver (the default `withPeriods()`), nothing resolves to a partition, so
  // every record sits on the vault-wide timeline exactly as before and a
  // partitioned period governs nothing.
  const partitionOf = (r: Record<string, unknown> | null): PeriodPartition | undefined => {
    if (!r || !scope?.resolve) return undefined
    return scope.resolve(scope.collection, r)
  }
  const existingRecord = existing?.record ?? null
  const existingPartition = partitionOf(existingRecord)
  const incomingPartition = partitionOf(incomingRecord)
  // One instant for the whole check, so a bounded reopen window cannot expire
  // between two periods in the same loop and seal a write half-way.
  const now = new Date().toISOString()

  for (const p of closedPeriods) {
    if (p.kind !== 'closed') continue
    // #1022 — a reopened period is writable again. This is the ONLY thing a
    // reopen does: it withdraws the period's veto. It cannot grant a write that
    // some other gate forbids, because the guard bus ANDs every handler and
    // record-level guards are registered ahead of this one.
    if (isEffectivelyReopened(p, now)) continue
    if (p.dateField) {
      const checkRecord = (
        label: string,
        r: Record<string, unknown> | null,
        recordPartition: PeriodPartition | undefined,
      ): void => {
        if (!r) return
        // Both sides are checked under their OWN partition, which is what stops
        // a write from sliding a record either INTO or OUT OF a sealed
        // timeline by rewriting the fields the subject mapping reads.
        if (!samePartition(recordPartition, p.partition)) return
        const v = r[p.dateField!]
        if (typeof v === 'string' && v <= p.endDate) {
          throw new PeriodClosedError(p.name, p.endDate, `${label}[${p.dateField}]=${v}`)
        }
      }
      checkRecord('existing', existingRecord, existingPartition)
      checkRecord('incoming', incomingRecord, incomingPartition)
      continue
    }
    // Fallback: write-time seal via envelope _ts. Scoped by the EXISTING
    // record's partition — `_ts` belongs to the stored envelope, so the
    // incoming side has no write-time of its own to compare.
    if (!samePartition(existingPartition, p.partition)) continue
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
  partition?: PeriodPartition,
): void {
  if (name.length === 0) {
    throw new ValidationError('Period name cannot be empty.')
  }
  // Validates the components as a side effect — an empty or non-finite
  // component must be rejected at the call, not encoded into a storage key.
  resolvePeriodKey(name, partition)
  // #1005 — uniqueness is per TIMELINE. `'2026-06'` in `['A','vat']` does not
  // collide with `'2026-06'` in `['B','vat']`.
  if (existing.some((p) => p.name === name && samePartition(p.partition, partition))) {
    const where = partition && partition.length > 0
      ? ` in partition [${partition.join(', ')}]`
      : ''
    throw new ValidationError(`Period "${name}" already exists${where}.`)
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

/**
 * @internal #615. Sweep delete markers with `_ts < before` off ANY store
 * (the vault's local adapter, or a push-only sync target). Returns the count
 * removed. Shared by `vault._purgeDeleteMarkers` (local) and
 * `vault._purgePeriodTargets` (push-only targets).
 */
export async function purgeMarkersOn(
  store: NoydbStore,
  vault: string,
  before: string,
  collections?: string[],
): Promise<number> {
  const snapshot = await store.loadAll(vault)
  let removed = 0
  for (const [coll, records] of Object.entries(snapshot)) {
    if (collections && !collections.includes(coll)) continue
    for (const [id, env] of Object.entries(records)) {
      if (isDeleteMarker(env) && env._ts < before) {
        await store.delete(vault, coll, id)
        removed++
      }
    }
  }
  return removed
}
