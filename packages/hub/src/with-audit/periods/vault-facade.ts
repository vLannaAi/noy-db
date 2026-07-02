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
import { encrypt, decrypt } from '../../kernel/enclave/index.js'
import type { EncryptedEnvelope, NoydbStore } from '../../kernel/types.js'
import type { LedgerStore } from '../../with-commit/history/ledger/store.js'
import type { Collection } from '../../kernel/collection.js'
import type { PeriodsStrategy } from './strategy.js'
import {
  PERIODS_COLLECTION,
  type PeriodRecord,
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
  getDEK(collection: string): Promise<CryptoKey>
  /** The vault's ledger store, or null when history is off. */
  getLedgerOrNull(): LedgerStore | null
  /** Collection accessor (used by `openPeriod`'s carry-forward writes). */
  collection<T = unknown>(name: string): Collection<T>
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
    const envelope = await this.writePeriodRecord(record)
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
    const envelope = await this.writePeriodRecord(record)
    await this.deps.strategy.appendPeriodLedgerEntry(this.deps.getLedgerOrNull(), this.deps.userId(), envelope, record.name)
    existing.push(record)
    this.periodCache = existing
    return record
  }

  /** Return every closed / opened period in `closedAt` order. */
  async listPeriods(): Promise<readonly PeriodRecord[]> {
    return [...(await this.loadPeriodsCache())]
  }

  /** Look up a single period by name. Returns `null` if not found. */
  async getPeriod(name: string): Promise<PeriodRecord | null> {
    const all = await this.loadPeriodsCache()
    return all.find((p) => p.name === name) ?? null
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

  private async writePeriodRecord(record: PeriodRecord): Promise<EncryptedEnvelope> {
    const json = JSON.stringify(record)
    let envelope: EncryptedEnvelope
    if (this.deps.encrypted) {
      const dek = await this.deps.getDEK(PERIODS_COLLECTION)
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
    await this.deps.adapter.put(this.deps.vault, PERIODS_COLLECTION, record.name, envelope)
    return envelope
  }

  private async decryptPeriodRecord(envelope: EncryptedEnvelope): Promise<PeriodRecord> {
    let json: string
    if (this.deps.encrypted) {
      const dek = await this.deps.getDEK(PERIODS_COLLECTION)
      json = await decrypt(envelope._iv, envelope._data, dek)
    } else {
      json = envelope._data
    }
    return JSON.parse(json) as PeriodRecord
  }
}
