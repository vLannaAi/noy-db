/**
 * Vault-side accounting-periods facade.
 *
 * Holds the period close/open/list/get entry points, the write-time guard
 * (`assertTsWritable`, called by the service gate bus before put/delete via
 * the thin `vault._assertTsWritable` delegator), and the period-record cache
 * (`periodCache`). Every `Vault` dependency arrives via
 * {@link VaultPeriodsDeps}.
 *
 * Internal service — reached through `vault.closePeriod(...)` etc.
 */
import { ValidationError } from '../../kernel/errors.js'
import { buildRecordAad, buildRecordEnvelope, encrypt, openEnvelopeJson, type EnclaveKey } from '../../kernel/enclave/index.js'
import type { EncryptedEnvelope, NoydbStore } from '../../kernel/types.js'
import type { LedgerStore } from '../../with-commit/history/ledger/store.js'
import type { Collection } from '../../kernel/collection.js'
import type { PeriodsStrategy } from './strategy.js'
import {
  PERIODS_COLLECTION,
  PERIOD_FREEZES_COLLECTION,
  PERIOD_ARCHIVES_COLLECTION,
  PERIOD_TARGET_PURGES_COLLECTION,
  PERIOD_REOPENS_COLLECTION,
  periodExclusiveUpperBound,
  resolvePeriodKey,
  samePartition,
  resolveReopenState,
  isEffectivelyReopened,
  type PeriodRecord,
  type PeriodFreezeRecord,
  type PeriodArchiveRecord,
  type PeriodTargetPurgeRecord,
  type TargetPurgeCount,
  type ClosePeriodOptions,
  type OpenPeriodOptions,
  type PeriodPartition,
  type PeriodReopenEvent,
  type PeriodReopenRecord,
} from './periods.js'

/** Selects one period timeline. Omit — or pass an empty tuple — for the vault-wide one (#1005). */
export interface PeriodScope {
  readonly partition?: PeriodPartition
}

/** A scoped operation that also records a free-text justification in the audit trail. */
export interface PeriodScopeWithReason extends PeriodScope {
  readonly reason?: string
}

/** Options for `vault.reopenPeriod()` (#1022). */
export interface ReopenPeriodOptions extends PeriodScopeWithReason {
  /**
   * ISO instant after which the period re-seals BY ITSELF, with nobody acting.
   * Omit for a window that stays open until an explicit `reclosePeriod()`.
   *
   * Expiry is evaluated against the clock on every write check, so a lapsed
   * window needs no sweep, no timer and no cache invalidation to take effect.
   */
  readonly until?: string
}

/** The persisted side of a write, as the period write-guard sees it. */
export interface PeriodGuardPrior {
  readonly ts: string | null
  readonly record: Record<string, unknown> | null
}

function hasPartition(partition?: PeriodPartition): boolean {
  return partition !== undefined && partition.length > 0
}

function scopeSuffix(options?: PeriodScope): string {
  return hasPartition(options?.partition) ? ` in partition [${options!.partition!.join(', ')}]` : ''
}

/**
 * Guard the three PHYSICAL period operations against a partitioned period.
 *
 * Freeze, archive and target-purge all act on a write-time (`_ts`) window
 * across the entire store: they purge delete markers, relocate envelopes to a
 * cold tier, or sweep remote targets. None of that can be narrowed to one
 * timeline, because deciding which partition a stored envelope belongs to
 * requires READING it, and a storage tier only ever sees ciphertext — the same
 * constraint that keeps the query DSL inside the hub.
 *
 * Refusing is the honest answer: silently applying a vault-wide purge on behalf
 * of one subject's close would destroy other subjects' data. Partition-scoped
 * physical operations need a design of their own.
 */
function assertVaultWide(op: string, period: PeriodRecord, why: string): void {
  if (!hasPartition(period.partition)) return
  throw new ValidationError(
    `${op}: period "${period.name}" is partitioned ([${period.partition!.join(', ')}]), and ${op} ${why} — ` +
      'it cannot be scoped to one timeline, because the store sees only ciphertext and cannot tell which ' +
      'partition a stored record belongs to. Close partitioned periods for their sealing semantics; run ' +
      `${op} against an unpartitioned period covering the same window.`,
  )
}

/** Everything the moving period methods touched on the vault's `this.*`. */
export interface VaultPeriodsDeps {
  /** Resolved periods strategy (NO_PERIODS when not configured). */
  readonly strategy: PeriodsStrategy
  /** The ciphertext store. */
  readonly adapter: NoydbStore
  /** Vault namespace name. */
  readonly vault: string
  /** Whether records are encrypted (vs debug-plaintext). */
  readonly encrypted: boolean
  /** The invoking keyring's user id (read fresh per call). */
  userId(): string
  /** Per-collection DEK resolver (bound `vault.getDEK`). */
  getDEK(collection: string): Promise<EnclaveKey>
  /** The vault's ledger store, or null when history is off. */
  getLedgerOrNull(): LedgerStore | null
  /** Collection accessor (used by `openPeriod`'s carry-forward writes). */
  collection<T = unknown>(name: string): Collection<T>
  /** #604: physically purge delete markers with `_ts < before`. Bound to `vault._purgeDeleteMarkers`. */
  purgeDeleteMarkers(before: string): Promise<number>
  /** #613: relocate a closed period's in-window records hot → cold. Bound to `vault._archiveClosedPeriod`. */
  archiveRecords(before: string): Promise<number>
  /** #615: sweep delete markers off the vault's push-only sync targets. Bound to `vault._purgePeriodTargets`. */
  purgeTargets(before: string): Promise<readonly TargetPurgeCount[]>
  /**
   * #822: mark a reserved-collection write dirty so the sync engine pushes
   * it. Bound to the vault's `onDirty` when sync is configured, `undefined`
   * otherwise. Only `_periods` uses it — see `writeReserved`.
   */
  onDirty?: ((collection: string, id: string, action: 'put', version: number) => Promise<void>) | undefined
}

export class VaultPeriods {
  /**
   * Loaded period records, lazily populated on first close/open/list/get/guard
   * and kept in sync by the write paths. `null` until first touched — the
   * write-guard fast-path avoids a full adapter scan for vaults that never use
   * periods.
   */
  private periodCache: PeriodRecord[] | null = null

  constructor(private readonly deps: VaultPeriodsDeps) {}

  async closePeriod(options: ClosePeriodOptions): Promise<PeriodRecord> {
    const existing = await this.loadPeriodsCache()
    this.deps.strategy.validatePeriodName(options.name, existing, options.partition)
    if (typeof options.endDate !== 'string' || options.endDate.length === 0) {
      throw new ValidationError('closePeriod: endDate must be a non-empty ISO string.')
    }
    const anchor = await this.deps.strategy.chainAnchor(existing, options.partition)
    const record: PeriodRecord = {
      name: options.name,
      kind: 'closed',
      endDate: options.endDate,
      closedAt: new Date().toISOString(),
      closedBy: this.deps.userId(),
      priorPeriodHash: anchor.priorPeriodHash,
      ...(anchor.priorPeriodName !== undefined && { priorPeriodName: anchor.priorPeriodName }),
      ...(options.dateField !== undefined && { dateField: options.dateField }),
      ...(hasPartition(options.partition) && { partition: options.partition }),
    }
    const storageKey = resolvePeriodKey(record.name, record.partition)
    const envelope = await this.writeReserved(PERIODS_COLLECTION, storageKey, record)
    await this.deps.strategy.appendPeriodLedgerEntry(this.deps.getLedgerOrNull(), this.deps.userId(), envelope, storageKey)
    existing.push(record)
    this.periodCache = existing
    return record
  }

  async openPeriod<TCollections extends Record<string, Record<string, unknown>>>(
    options: OpenPeriodOptions<TCollections>,
  ): Promise<PeriodRecord> {
    const existing = await this.loadPeriodsCache()
    this.deps.strategy.validatePeriodName(options.name, existing, options.partition)
    // #1005 — `fromPeriod` is resolved WITHIN the target timeline. A chain
    // cannot span partitions: each has its own `priorPeriodHash` lineage, so
    // carrying forward from another subject's close would silently splice two
    // independent audit trails together.
    const prior = existing.find(
      (p) => p.name === options.fromPeriod && samePartition(p.partition, options.partition),
    )
    if (!prior) {
      const where = hasPartition(options.partition)
        ? ` in partition [${options.partition!.join(', ')}]`
        : ''
      throw new ValidationError(
        `openPeriod: fromPeriod "${options.fromPeriod}" does not exist in this vault${where}.`,
      )
    }
    if (prior.kind !== 'closed') {
      throw new ValidationError(
        `openPeriod: fromPeriod "${options.fromPeriod}" is of kind "${prior.kind}" — only closed periods can be carried forward.`,
      )
    }

    // Build a read-only facade over CURRENT state + the prior
    // period's endDate; after close, records dated <= endDate are
    // frozen so current state equals closing state. The caller
    // filters by business date via their own query against this
    // facade.
    const ctx = {
      priorEndDate: prior.endDate,
      collection: <T = unknown>(name: string) => {
        const c = this.deps.collection<T>(name)
        return {
          get: (id: string) => c.get(id),
          list: () => c.list(),
        }
      },
    }
    const openings = await options.carryForward(ctx)

    // Write opening entries via the normal Collection path so they
    // get encryption, ledger entries, and change events. Each record
    // is timestamped NOW (outside every closed period) — that's why
    // the guard permits them.
    const openingCollections: string[] = []
    for (const [collName, records] of Object.entries(openings)) {
      if (!records || typeof records !== 'object') continue
      const recordEntries = Object.entries(records)
      if (recordEntries.length === 0) continue
      const coll = this.deps.collection(collName)
      for (const [id, record] of recordEntries) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await coll.put(id, record as any)
      }
      openingCollections.push(collName)
    }

    const anchor = await this.deps.strategy.chainAnchor(existing, options.partition)
    const record: PeriodRecord = {
      name: options.name,
      kind: 'opened',
      startDate: options.startDate,
      endDate: prior.endDate, // sealing boundary inherited from prior close
      closedAt: new Date().toISOString(),
      closedBy: this.deps.userId(),
      priorPeriodHash: anchor.priorPeriodHash,
      priorPeriodName: anchor.priorPeriodName ?? prior.name,
      ...(openingCollections.length > 0 && { openingCollections }),
      ...(hasPartition(options.partition) && { partition: options.partition }),
    }
    const storageKey = resolvePeriodKey(record.name, record.partition)
    const envelope = await this.writeReserved(PERIODS_COLLECTION, storageKey, record)
    await this.deps.strategy.appendPeriodLedgerEntry(this.deps.getLedgerOrNull(), this.deps.userId(), envelope, storageKey)
    existing.push(record)
    this.periodCache = existing
    return record
  }

  /**
   * Freeze a closed period: physically purges delete markers whose `_ts`
   * falls inside the period's window (#604) and records the fact in a
   * companion `_period_freezes/<name>` record. NEVER mutates the
   * hash-chained `_periods/<name>` record's stored bytes — `frozenAt` /
   * `frozenBy` / `purgedMarkerCount` are merged into `PeriodRecord`s on
   * read only. Idempotent: a second call is a no-op that returns the
   * same merged record without re-purging or re-appending a ledger entry.
   */
  async freezePeriod(name: string, options?: PeriodScope): Promise<PeriodRecord> {
    const existing = await this.loadPeriodsCache()
    const period = this.findPeriod(existing, name, options)
    if (!period) throw new ValidationError(`freezePeriod: no period named "${name}"${scopeSuffix(options)}.`)
    assertVaultWide('freezePeriod', period, 'purges delete markers by write-time across the whole store')
    if (period.kind !== 'closed') {
      throw new ValidationError(
        `freezePeriod: period "${name}" is "${period.kind}"; only a closed period can be frozen.`,
      )
    }
    // #610: refuse a period whose purge window reaches into the future. Markers
    // are bounded by write-time `_ts`, so a not-yet-elapsed window would purge
    // deletes written seconds ago that cannot have converged to any peer.
    const before = periodExclusiveUpperBound(period.endDate)
    if (Date.parse(before) > Date.now()) {
      throw new ValidationError(
        `freezePeriod: period "${name}" purge window ends at ${before}, in the future; ` +
          `only a period whose window is fully in the past can be frozen (recent delete markers may not have converged).`,
      )
    }
    const prior = await this.readReserved<PeriodFreezeRecord>(PERIOD_FREEZES_COLLECTION, name)
    if (prior) return this.mergeFreeze(period, prior) // idempotent no-op

    const purgedMarkerCount = await this.deps.purgeDeleteMarkers(before)
    const freeze: PeriodFreezeRecord = {
      period: name,
      frozenAt: new Date().toISOString(),
      frozenBy: this.deps.userId(),
      purgedMarkerCount,
    }
    const envelope = await this.writeReserved(PERIOD_FREEZES_COLLECTION, name, freeze)
    await this.deps.strategy.appendPeriodLedgerEntry(
      this.deps.getLedgerOrNull(),
      this.deps.userId(),
      envelope,
      name,
      PERIOD_FREEZES_COLLECTION,
    )
    return this.mergeFreeze(period, freeze)
  }

  /**
   * Archive a closed period (#613): physically relocates its in-window
   * records (those with `_ts < periodExclusiveUpperBound(endDate)`) from the
   * hot store to the configured cold tier via `archiveRecords`, and records
   * the fact in a companion `_period_archives/<name>` record. NEVER mutates
   * the hash-chained `_periods/<name>` record. Non-destructive (reads fall
   * through to cold) and idempotent: a second call is a no-op returning the
   * same merged record.
   */
  async archivePeriod(name: string, options?: PeriodScope): Promise<PeriodRecord> {
    const existing = await this.loadPeriodsCache()
    const period = this.findPeriod(existing, name, options)
    if (!period) throw new ValidationError(`archivePeriod: no period named "${name}"${scopeSuffix(options)}.`)
    assertVaultWide('archivePeriod', period, 'relocates records by write-time across the whole store')
    if (period.kind !== 'closed') {
      throw new ValidationError(
        `archivePeriod: period "${name}" is "${period.kind}"; only a closed period can be archived.`,
      )
    }
    const prior = await this.readReserved<PeriodArchiveRecord>(PERIOD_ARCHIVES_COLLECTION, name)
    if (prior) return this.mergeArchive(period, prior) // idempotent no-op

    const before = periodExclusiveUpperBound(period.endDate)
    const archivedRecordCount = await this.deps.archiveRecords(before)
    const archive: PeriodArchiveRecord = {
      period: name,
      archivedAt: new Date().toISOString(),
      archivedBy: this.deps.userId(),
      archivedRecordCount,
    }
    const envelope = await this.writeReserved(PERIOD_ARCHIVES_COLLECTION, name, archive)
    await this.deps.strategy.appendPeriodLedgerEntry(
      this.deps.getLedgerOrNull(),
      this.deps.userId(),
      envelope,
      name,
      PERIOD_ARCHIVES_COLLECTION,
    )
    return this.mergeArchive(period, archive)
  }

  /**
   * Target-purge a closed period (#615): sweeps delete markers off the vault's
   * PUSH-ONLY sync targets (`backup`/`archive`) via `purgeTargets`, recording a
   * companion `_period_target_purges/<name>` record. `sync-peer` targets are
   * skipped (resurrection risk). NEVER mutates the chained `_periods/<name>`
   * record. Requires the period be frozen first (closed → frozen → target-purged).
   * Idempotent once run; with no push-only targets it writes no companion and
   * is re-runnable.
   */
  async purgePeriodTargets(name: string, options?: PeriodScope): Promise<PeriodRecord> {
    const existing = await this.loadPeriodsCache()
    const period = this.findPeriod(existing, name, options)
    if (!period) throw new ValidationError(`purgePeriodTargets: no period named "${name}"${scopeSuffix(options)}.`)
    assertVaultWide('purgePeriodTargets', period, 'sweeps delete markers by write-time off whole sync targets')
    if (period.kind !== 'closed') {
      throw new ValidationError(
        `purgePeriodTargets: period "${name}" is "${period.kind}"; only a closed period can be target-purged.`,
      )
    }
    const frozen = await this.readReserved<PeriodFreezeRecord>(PERIOD_FREEZES_COLLECTION, name)
    if (!frozen) {
      throw new ValidationError(
        `purgePeriodTargets: period "${name}" must be frozen first (closed → frozen → target-purged).`,
      )
    }
    const prior = await this.readReserved<PeriodTargetPurgeRecord>(PERIOD_TARGET_PURGES_COLLECTION, name)
    if (prior) return this.mergeTargetPurge(period, prior) // idempotent no-op

    const before = periodExclusiveUpperBound(period.endDate)
    const targets = await this.deps.purgeTargets(before)
    if (targets.length === 0) return period // no push-only targets → no companion, re-runnable

    const record: PeriodTargetPurgeRecord = {
      period: name,
      purgedAt: new Date().toISOString(),
      purgedBy: this.deps.userId(),
      targets,
    }
    const envelope = await this.writeReserved(PERIOD_TARGET_PURGES_COLLECTION, name, record)
    await this.deps.strategy.appendPeriodLedgerEntry(
      this.deps.getLedgerOrNull(),
      this.deps.userId(),
      envelope,
      name,
      PERIOD_TARGET_PURGES_COLLECTION,
    )
    return this.mergeTargetPurge(period, record)
  }

  /** Merge target-purge companion fields into a fresh `PeriodRecord` copy — never mutates `periodCache`. */
  private mergeTargetPurge(period: PeriodRecord, record: PeriodTargetPurgeRecord): PeriodRecord {
    return {
      ...period,
      targetsPurgedAt: record.purgedAt,
      targetsPurgedBy: record.purgedBy,
      targetsPurged: record.targets,
    }
  }

  /** Merge archive companion fields into a fresh `PeriodRecord` copy — never mutates `periodCache`. */
  private mergeArchive(period: PeriodRecord, archive: PeriodArchiveRecord): PeriodRecord {
    return {
      ...period,
      archivedAt: archive.archivedAt,
      archivedBy: archive.archivedBy,
      archivedRecordCount: archive.archivedRecordCount,
    }
  }

  /** Merge freeze companion fields into a fresh `PeriodRecord` copy — never mutates `periodCache`. */
  private mergeFreeze(period: PeriodRecord, freeze: PeriodFreezeRecord): PeriodRecord {
    return {
      ...period,
      frozenAt: freeze.frozenAt,
      frozenBy: freeze.frozenBy,
      purgedMarkerCount: freeze.purgedMarkerCount,
    }
  }

  /**
   * Return every closed / opened period in `closedAt` order, merged with any
   * freeze + archive companions.
   *
   * With no argument this spans EVERY timeline — the pre-#1005 behaviour, and
   * the right default for an audit sweep. Pass `{ partition }` to scope to one
   * timeline; `{ partition: [] }` (or omitting it) means the vault-wide one.
   */
  async listPeriods(options?: PeriodScope): Promise<readonly PeriodRecord[]> {
    // #807: always re-read `_periods` from the adapter — a period-scoped pull
    // applies freshly synced period envelopes UNDERNEATH this cache, then
    // resolves its windows through this very method (the engine's
    // PeriodPullSource). Repopulating the shared cache here also refreshes the
    // write guard's view, so a pulled closure seals writes without a reopen.
    // (The companions below were already re-read fresh on every call.)
    this.periodCache = null
    const all = await this.loadPeriodsCache()
    const freezeIds = await this.deps.adapter.list(this.deps.vault, PERIOD_FREEZES_COLLECTION)
    const freezes = new Map<string, PeriodFreezeRecord>()
    for (const id of freezeIds) {
      const f = await this.readReserved<PeriodFreezeRecord>(PERIOD_FREEZES_COLLECTION, id)
      if (f) freezes.set(f.period, f)
    }
    const archiveIds = await this.deps.adapter.list(this.deps.vault, PERIOD_ARCHIVES_COLLECTION)
    const archives = new Map<string, PeriodArchiveRecord>()
    for (const id of archiveIds) {
      const a = await this.readReserved<PeriodArchiveRecord>(PERIOD_ARCHIVES_COLLECTION, id)
      if (a) archives.set(a.period, a)
    }
    const targetPurgeIds = await this.deps.adapter.list(this.deps.vault, PERIOD_TARGET_PURGES_COLLECTION)
    const targetPurges = new Map<string, PeriodTargetPurgeRecord>()
    for (const id of targetPurgeIds) {
      const tp = await this.readReserved<PeriodTargetPurgeRecord>(PERIOD_TARGET_PURGES_COLLECTION, id)
      if (tp) targetPurges.set(tp.period, tp)
    }
    const scoped = options === undefined
      ? all
      : all.filter((p) => samePartition(p.partition, options.partition))
    // #1022 — one listing for the whole set, not one read per period.
    const withReopen = await this.mergeReopenState(scoped)
    return withReopen.map((p) => {
      const f = freezes.get(p.name)
      let merged = f ? this.mergeFreeze(p, f) : p
      const a = archives.get(p.name)
      if (a) merged = this.mergeArchive(merged, a)
      const tp = targetPurges.get(p.name)
      if (tp) merged = this.mergeTargetPurge(merged, tp)
      return merged
    })
  }

  /**
   * Look up a single period by name within one timeline, merged with its
   * freeze + archive + target-purge companions if any. Returns `null` if not
   * found.
   *
   * Names are only unique per partition (#1005), so this resolves against the
   * VAULT-WIDE timeline unless `{ partition }` says otherwise — matching how
   * every pre-partition period is stored.
   */
  async getPeriod(name: string, options?: PeriodScope): Promise<PeriodRecord | null> {
    const all = await this.loadPeriodsCache()
    const period = this.findPeriod(all, name, options)
    if (!period) return null
    const key = resolvePeriodKey(name, options?.partition)
    const freeze = await this.readReserved<PeriodFreezeRecord>(PERIOD_FREEZES_COLLECTION, key)
    const archive = await this.readReserved<PeriodArchiveRecord>(PERIOD_ARCHIVES_COLLECTION, key)
    let merged = freeze ? this.mergeFreeze(period, freeze) : period
    if (archive) merged = this.mergeArchive(merged, archive)
    const targetPurge = await this.readReserved<PeriodTargetPurgeRecord>(PERIOD_TARGET_PURGES_COLLECTION, key)
    if (targetPurge) merged = this.mergeTargetPurge(merged, targetPurge)
    const reopenLog = await this.readReserved<PeriodReopenRecord>(PERIOD_REOPENS_COLLECTION, key)
    if (reopenLog) merged = { ...merged, ...resolveReopenState(reopenLog.events) }
    return merged
  }

  /**
   * The full append-only reopen/reclose log for one period (#1022) — the record
   * an audit actually asks for, in order. `[]` when never reopened.
   */
  async listPeriodReopens(name: string, options?: PeriodScope): Promise<readonly PeriodReopenEvent[]> {
    const key = resolvePeriodKey(name, options?.partition)
    const log = await this.readReserved<PeriodReopenRecord>(PERIOD_REOPENS_COLLECTION, key)
    return log?.events ?? []
  }

  /**
   * Return a closed period to a writable state (#1022).
   *
   * Close is a three-state lifecycle in practice — open / closed / reopened —
   * because a month gets closed and then a missing invoice arrives, or a filing
   * is rejected and must be amended. That is routine, and it is supposed to
   * leave a trail.
   *
   * The `_periods/<key>` record is NOT touched: the reopen is appended to a
   * companion log, so the inter-period hash chain that proves the close
   * happened survives the reopen intact. The chain reads *closed at T1,
   * reopened at T2 by U, reclosed at T3*.
   *
   * A reopen withdraws the PERIOD's veto and nothing else. Record-level rules —
   * an `immutableGuard` on a sent receipt, a frozen field — are separate gate
   * handlers registered ahead of the period gate, so a reopened month cannot
   * resurrect a document that is independently locked. Period state can only
   * ever widen what the record-level rule already permits.
   *
   * Reopening an already-open window is allowed and appends another event: that
   * is how a window gets extended, and the log keeps both.
   */
  async reopenPeriod(name: string, options?: ReopenPeriodOptions): Promise<PeriodRecord> {
    const existing = await this.loadPeriodsCache()
    const period = this.findPeriod(existing, name, options)
    if (!period) throw new ValidationError(`reopenPeriod: no period named "${name}"${scopeSuffix(options)}.`)
    if (period.kind !== 'closed') {
      throw new ValidationError(
        `reopenPeriod: period "${name}" is "${period.kind}"; only a closed period can be reopened.`,
      )
    }
    if (options?.until !== undefined && Number.isNaN(Date.parse(options.until))) {
      throw new ValidationError(`reopenPeriod: unparseable \`until\` "${options.until}".`)
    }
    return this.appendReopenEvent(period, options, {
      op: 'reopen',
      at: new Date().toISOString(),
      by: this.deps.userId(),
      ...(options?.until !== undefined && { until: options.until }),
      ...(options?.reason !== undefined && { reason: options.reason }),
    })
  }

  /**
   * Seal a reopened period again (#1022), ending the window explicitly rather
   * than waiting for an `until` to lapse. Appends to the same log, so the
   * close → reopen → reclose sequence is recoverable in order.
   */
  async reclosePeriod(name: string, options?: PeriodScopeWithReason): Promise<PeriodRecord> {
    const existing = await this.loadPeriodsCache()
    const period = this.findPeriod(existing, name, options)
    if (!period) throw new ValidationError(`reclosePeriod: no period named "${name}"${scopeSuffix(options)}.`)
    const merged = await this.mergeReopenState([period])
    if (!isEffectivelyReopened(merged[0]!, new Date().toISOString())) {
      throw new ValidationError(
        `reclosePeriod: period "${name}"${scopeSuffix(options)} is not currently reopened — ` +
          'nothing to reclose. A period whose `until` has already lapsed re-sealed on its own.',
      )
    }
    return this.appendReopenEvent(period, options, {
      op: 'reclose',
      at: new Date().toISOString(),
      by: this.deps.userId(),
      ...(options?.reason !== undefined && { reason: options.reason }),
    })
  }

  /** Append one entry to a period's reopen log, ledger it, and invalidate the guard's view. */
  private async appendReopenEvent(
    period: PeriodRecord,
    scope: PeriodScope | undefined,
    event: PeriodReopenEvent,
  ): Promise<PeriodRecord> {
    const key = resolvePeriodKey(period.name, period.partition)
    const prior = await this.readReserved<PeriodReopenRecord>(PERIOD_REOPENS_COLLECTION, key)
    const record: PeriodReopenRecord = {
      period: period.name,
      ...(hasPartition(period.partition) && { partition: period.partition }),
      events: [...(prior?.events ?? []), event],
    }
    const envelope = await this.writeReserved(PERIOD_REOPENS_COLLECTION, key, record)
    await this.deps.strategy.appendPeriodLedgerEntry(
      this.deps.getLedgerOrNull(),
      this.deps.userId(),
      envelope,
      key,
      PERIOD_REOPENS_COLLECTION,
    )
    // The write guard caches merged period records; drop it so the next write
    // sees the new state rather than the pre-reopen seal.
    this.periodCache = null
    void scope
    return { ...period, ...resolveReopenState(record.events) }
  }

  /** Merge each period's reopen log onto it. One adapter listing, not one per period. */
  private async mergeReopenState(periods: readonly PeriodRecord[]): Promise<PeriodRecord[]> {
    if (periods.length === 0) return []
    const ids = await this.deps.adapter.list(this.deps.vault, PERIOD_REOPENS_COLLECTION)
    if (ids.length === 0) return [...periods]
    const byKey = new Map<string, PeriodReopenRecord>()
    for (const id of ids) {
      const r = await this.readReserved<PeriodReopenRecord>(PERIOD_REOPENS_COLLECTION, id)
      if (r) byKey.set(id, r)
    }
    return periods.map((p) => {
      const log = byKey.get(resolvePeriodKey(p.name, p.partition))
      return log ? { ...p, ...resolveReopenState(log.events) } : p
    })
  }

  /** Resolve one period within the timeline named by `options` (vault-wide when absent). */
  private findPeriod(
    all: readonly PeriodRecord[],
    name: string,
    options?: PeriodScope,
  ): PeriodRecord | undefined {
    return all.find((p) => p.name === name && samePartition(p.partition, options?.partition))
  }

  /**
   * #1439 — could a closed period govern this record? Synchronous, and
   * deliberately a SUPERSET of what {@link assertTsWritable} would refuse.
   *
   * Exists so a caller can tell "the period gate is registered" from "the
   * period gate can fire for this row". Those were conflated, and the cost was
   * that installing `withPeriods()` disabled an unrelated optimisation for
   * every collection in the vault — with no period closed and no collection
   * registered as a subject (#1439, measured: 0 → 250 redundant MV writes per
   * source write).
   *
   * ⛔ Answers `true` whenever it cannot rule the gate out: the cache is not
   * loaded yet, a closed period has no `dateField` to test against, or no row
   * was supplied. A predicate that exists to permit an optimisation must fail
   * towards "the gate applies", never away from it.
   */
  couldGovern(record?: Record<string, unknown>): boolean {
    if (this.periodCache === null) return true
    const now = new Date().toISOString()
    for (const p of this.periodCache) {
      if (p.kind !== 'closed' || isEffectivelyReopened(p, now)) continue
      if (!p.dateField || record === undefined) return true
      // #1455 — any present value can now fire the gate (a Date is compared,
      // anything else non-string is refused); only absent / null is outside
      // every period.
      if (record[p.dateField] !== undefined && record[p.dateField] !== null) return true
    }
    return false
  }

  /** Called by the gate bus before put/delete. `collection` selects the subject mapping (#1005). */
  async assertTsWritable(
    existing: { ts: string | null; record: Record<string, unknown> | null } | null,
    incoming: Record<string, unknown> | null,
    collection?: string,
  ): Promise<void> {
    // Fast path: nothing to check, and no periods ever touched this
    // vault — avoid a full adapter scan for every put.
    if (existing === null && incoming === null) return
    if (this.periodCache === null) {
      const loaded = await this.deps.strategy.loadPeriods(
        this.deps.adapter,
        this.deps.vault,
        (id, env) => this.decryptPeriodRecord(id, env),
      )
      // #1022 — the guard reads raw `_periods` records, which carry no reopen
      // state (it lives in a companion, so the chained record stays immutable).
      // Merge it in HERE or a reopened period would show as reopened through
      // `listPeriods()` while the write guard kept refusing writes — an audit
      // trail saying "open" over a vault that behaves closed.
      //
      // Only the window BOUND is cached; whether it has elapsed is decided
      // against the clock on every check, so a bounded reopen re-seals itself
      // with no cache invalidation and nothing scheduled.
      this.periodCache = await this.mergeReopenState(loaded)
    }
    if (this.periodCache.length === 0) return
    this.deps.strategy.assertTsWritable(
      existing,
      incoming,
      this.periodCache,
      collection !== undefined
        ? { collection, ...(this.deps.strategy.partitionOf !== undefined && { resolve: this.deps.strategy.partitionOf }) }
        : undefined,
    )
  }

  private async loadPeriodsCache(): Promise<PeriodRecord[]> {
    if (this.periodCache !== null) return this.periodCache
    const loaded = await this.deps.strategy.loadPeriods(
      this.deps.adapter,
      this.deps.vault,
      (id: string, env: EncryptedEnvelope) => this.decryptPeriodRecord(id, env),
    )
    this.periodCache = loaded
    return loaded
  }

  /** Generic reserved-collection writer — serves `_periods` and `_period_freezes` alike. */
  private async writeReserved(collection: string, key: string, value: object): Promise<EncryptedEnvelope> {
    const json = JSON.stringify(value)
    const actor = this.deps.userId()
    const identity = { collection, id: key, by: actor, version: 1 }
    let envelope: EncryptedEnvelope
    if (this.deps.encrypted) {
      const dek = await this.deps.getDEK(collection)
      const { iv, data } = await encrypt(json, dek, buildRecordAad(identity))
      envelope = buildRecordEnvelope(identity, { iv, data})
    } else {
      envelope = buildRecordEnvelope(identity, { iv: '', data: json})
    }
    await this.deps.adapter.put(this.deps.vault, collection, key, envelope)
    // #822: the period summaries are vault-wide state — period-scoped pull
    // (#807) treats `_periods` as always-sync precisely because it is the
    // navigation index a thin client needs first. Pull symmetry without push
    // symmetry meant a closure never left the device that made it. The other
    // reserved collections deliberately stay local: freezes are marker-
    // convergence state (#589/#590 territory), archives record a per-
    // deployment hot→cold relocation, and target-purges describe the very
    // targets they would be pushed to.
    if (collection === PERIODS_COLLECTION && this.deps.onDirty) {
      await this.deps.onDirty(collection, key, 'put', envelope._v)
    }
    return envelope
  }

  /** Generic reserved-collection reader — serves `_period_freezes` companion reads. */
  private async readReserved<T>(collection: string, key: string): Promise<T | null> {
    const env = await this.deps.adapter.get(this.deps.vault, collection, key)
    if (!env) return null
    const json = this.deps.encrypted ? await openEnvelopeJson({ collection, id: key }, env, await this.deps.getDEK(collection)) : env._data
    return JSON.parse(json) as T
  }

  private async decryptPeriodRecord(periodId: string, envelope: EncryptedEnvelope): Promise<PeriodRecord> {
    let json: string
    if (this.deps.encrypted) {
      const dek = await this.deps.getDEK(PERIODS_COLLECTION)
      json = await openEnvelopeJson({ collection: PERIODS_COLLECTION, id: periodId }, envelope, dek)
    } else {
      json = envelope._data
    }
    return JSON.parse(json) as PeriodRecord
  }
}
