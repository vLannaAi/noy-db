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
import { NOYDB_FORMAT_VERSION } from '../../kernel/types.js'
import { encrypt, openEnvelopeJson, type EnclaveKey } from '../../kernel/enclave/index.js'
import type { EncryptedEnvelope, NoydbStore } from '../../kernel/types.js'
import type { LedgerStore } from '../../with-commit/history/ledger/store.js'
import type { Collection } from '../../kernel/collection.js'
import type { PeriodsStrategy } from './strategy.js'
import {
  PERIODS_COLLECTION,
  PERIOD_FREEZES_COLLECTION,
  periodExclusiveUpperBound,
  type PeriodRecord,
  type PeriodFreezeRecord,
  type ClosePeriodOptions,
  type OpenPeriodOptions,
} from './periods.js'

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
    this.deps.strategy.validatePeriodName(options.name, existing)
    if (typeof options.endDate !== 'string' || options.endDate.length === 0) {
      throw new ValidationError('closePeriod: endDate must be a non-empty ISO string.')
    }
    const anchor = await this.deps.strategy.chainAnchor(existing)
    const record: PeriodRecord = {
      name: options.name,
      kind: 'closed',
      endDate: options.endDate,
      closedAt: new Date().toISOString(),
      closedBy: this.deps.userId(),
      priorPeriodHash: anchor.priorPeriodHash,
      ...(anchor.priorPeriodName !== undefined && { priorPeriodName: anchor.priorPeriodName }),
      ...(options.dateField !== undefined && { dateField: options.dateField }),
    }
    const envelope = await this.writeReserved(PERIODS_COLLECTION, record.name, record)
    await this.deps.strategy.appendPeriodLedgerEntry(this.deps.getLedgerOrNull(), this.deps.userId(), envelope, record.name)
    existing.push(record)
    this.periodCache = existing
    return record
  }

  async openPeriod<TCollections extends Record<string, Record<string, unknown>>>(
    options: OpenPeriodOptions<TCollections>,
  ): Promise<PeriodRecord> {
    const existing = await this.loadPeriodsCache()
    this.deps.strategy.validatePeriodName(options.name, existing)
    const prior = existing.find((p) => p.name === options.fromPeriod)
    if (!prior) {
      throw new ValidationError(
        `openPeriod: fromPeriod "${options.fromPeriod}" does not exist in this vault.`,
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

    const anchor = await this.deps.strategy.chainAnchor(existing)
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
    }
    const envelope = await this.writeReserved(PERIODS_COLLECTION, record.name, record)
    await this.deps.strategy.appendPeriodLedgerEntry(this.deps.getLedgerOrNull(), this.deps.userId(), envelope, record.name)
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
  async freezePeriod(name: string): Promise<PeriodRecord> {
    const existing = await this.loadPeriodsCache()
    const period = existing.find((p) => p.name === name)
    if (!period) throw new ValidationError(`freezePeriod: no period named "${name}".`)
    if (period.kind !== 'closed') {
      throw new ValidationError(
        `freezePeriod: period "${name}" is "${period.kind}"; only a closed period can be frozen.`,
      )
    }
    const prior = await this.readReserved<PeriodFreezeRecord>(PERIOD_FREEZES_COLLECTION, name)
    if (prior) return this.mergeFreeze(period, prior) // idempotent no-op

    const before = periodExclusiveUpperBound(period.endDate)
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

  /** Merge freeze companion fields into a fresh `PeriodRecord` copy — never mutates `periodCache`. */
  private mergeFreeze(period: PeriodRecord, freeze: PeriodFreezeRecord): PeriodRecord {
    return {
      ...period,
      frozenAt: freeze.frozenAt,
      frozenBy: freeze.frozenBy,
      purgedMarkerCount: freeze.purgedMarkerCount,
    }
  }

  /** Return every closed / opened period in `closedAt` order, merged with any freeze companions. */
  async listPeriods(): Promise<readonly PeriodRecord[]> {
    const all = await this.loadPeriodsCache()
    const freezeIds = await this.deps.adapter.list(this.deps.vault, PERIOD_FREEZES_COLLECTION)
    const freezes = new Map<string, PeriodFreezeRecord>()
    for (const id of freezeIds) {
      const f = await this.readReserved<PeriodFreezeRecord>(PERIOD_FREEZES_COLLECTION, id)
      if (f) freezes.set(f.period, f)
    }
    return all.map((p) => {
      const f = freezes.get(p.name)
      return f ? this.mergeFreeze(p, f) : p
    })
  }

  /** Look up a single period by name, merged with its freeze companion if any. Returns `null` if not found. */
  async getPeriod(name: string): Promise<PeriodRecord | null> {
    const all = await this.loadPeriodsCache()
    const period = all.find((p) => p.name === name)
    if (!period) return null
    const freeze = await this.readReserved<PeriodFreezeRecord>(PERIOD_FREEZES_COLLECTION, name)
    return freeze ? this.mergeFreeze(period, freeze) : period
  }

  /** Called by the gate bus before put/delete. */
  async assertTsWritable(
    existing: { ts: string | null; record: Record<string, unknown> | null } | null,
    incoming: Record<string, unknown> | null,
  ): Promise<void> {
    // Fast path: nothing to check, and no periods ever touched this
    // vault — avoid a full adapter scan for every put.
    if (existing === null && incoming === null) return
    if (this.periodCache === null) {
      this.periodCache = await this.deps.strategy.loadPeriods(
        this.deps.adapter,
        this.deps.vault,
        (env) => this.decryptPeriodRecord(env),
      )
    }
    if (this.periodCache.length === 0) return
    this.deps.strategy.assertTsWritable(existing, incoming, this.periodCache)
  }

  private async loadPeriodsCache(): Promise<PeriodRecord[]> {
    if (this.periodCache !== null) return this.periodCache
    const loaded = await this.deps.strategy.loadPeriods(
      this.deps.adapter,
      this.deps.vault,
      (env: EncryptedEnvelope) => this.decryptPeriodRecord(env),
    )
    this.periodCache = loaded
    return loaded
  }

  /** Generic reserved-collection writer — serves `_periods` and `_period_freezes` alike. */
  private async writeReserved(collection: string, key: string, value: object): Promise<EncryptedEnvelope> {
    const json = JSON.stringify(value)
    let envelope: EncryptedEnvelope
    if (this.deps.encrypted) {
      const dek = await this.deps.getDEK(collection)
      const { iv, data } = await encrypt(json, dek)
      envelope = {
        _noydb: NOYDB_FORMAT_VERSION,
        _v: 1,
        _ts: new Date().toISOString(),
        _iv: iv,
        _data: data,
        _by: this.deps.userId(),
      }
    } else {
      envelope = {
        _noydb: NOYDB_FORMAT_VERSION,
        _v: 1,
        _ts: new Date().toISOString(),
        _iv: '',
        _data: json,
        _by: this.deps.userId(),
      }
    }
    await this.deps.adapter.put(this.deps.vault, collection, key, envelope)
    return envelope
  }

  /** Generic reserved-collection reader — serves `_period_freezes` companion reads. */
  private async readReserved<T>(collection: string, key: string): Promise<T | null> {
    const env = await this.deps.adapter.get(this.deps.vault, collection, key)
    if (!env) return null
    const json = this.deps.encrypted ? await openEnvelopeJson(env, await this.deps.getDEK(collection)) : env._data
    return JSON.parse(json) as T
  }

  private async decryptPeriodRecord(envelope: EncryptedEnvelope): Promise<PeriodRecord> {
    let json: string
    if (this.deps.encrypted) {
      const dek = await this.deps.getDEK(PERIODS_COLLECTION)
      json = await openEnvelopeJson(envelope, dek)
    } else {
      json = envelope._data
    }
    return JSON.parse(json) as PeriodRecord
  }
}
