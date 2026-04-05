import type { NoydbAdapter, EncryptedEnvelope, ChangeEvent, HistoryConfig, HistoryOptions, HistoryEntry, PruneOptions } from './types.js'
import { NOYDB_FORMAT_VERSION } from './types.js'
import { encrypt, decrypt } from './crypto.js'
import { ReadOnlyError, NoAccessError } from './errors.js'
import type { UnlockedKeyring } from './keyring.js'
import { hasWritePermission } from './keyring.js'
import type { NoydbEventEmitter } from './events.js'
import {
  saveHistory,
  getHistory as getHistoryEntries,
  getVersionEnvelope,
  pruneHistory as pruneHistoryEntries,
  clearHistory,
} from './history.js'
import { diff as computeDiff } from './diff.js'
import type { DiffEntry } from './diff.js'

/** Callback for dirty tracking (sync engine integration). */
export type OnDirtyCallback = (collection: string, id: string, action: 'put' | 'delete', version: number) => Promise<void>

/** A typed collection of records within a compartment. */
export class Collection<T> {
  private readonly adapter: NoydbAdapter
  private readonly compartment: string
  private readonly name: string
  private readonly keyring: UnlockedKeyring
  private readonly encrypted: boolean
  private readonly emitter: NoydbEventEmitter
  private readonly getDEK: (collectionName: string) => Promise<CryptoKey>
  private readonly onDirty: OnDirtyCallback | undefined
  private readonly historyConfig: HistoryConfig

  // In-memory cache of decrypted records
  private readonly cache = new Map<string, { record: T; version: number }>()
  private hydrated = false

  constructor(opts: {
    adapter: NoydbAdapter
    compartment: string
    name: string
    keyring: UnlockedKeyring
    encrypted: boolean
    emitter: NoydbEventEmitter
    getDEK: (collectionName: string) => Promise<CryptoKey>
    historyConfig?: HistoryConfig | undefined
    onDirty?: OnDirtyCallback | undefined
  }) {
    this.adapter = opts.adapter
    this.compartment = opts.compartment
    this.name = opts.name
    this.keyring = opts.keyring
    this.encrypted = opts.encrypted
    this.emitter = opts.emitter
    this.getDEK = opts.getDEK
    this.onDirty = opts.onDirty
    this.historyConfig = opts.historyConfig ?? { enabled: true }
  }

  /** Get a single record by ID. Returns null if not found. */
  async get(id: string): Promise<T | null> {
    await this.ensureHydrated()
    const entry = this.cache.get(id)
    return entry ? entry.record : null
  }

  /** Create or update a record. */
  async put(id: string, record: T): Promise<void> {
    if (!hasWritePermission(this.keyring, this.name)) {
      throw new ReadOnlyError()
    }

    await this.ensureHydrated()

    const existing = this.cache.get(id)
    const version = existing ? existing.version + 1 : 1

    // Save history snapshot of the PREVIOUS version before overwriting
    if (existing && this.historyConfig.enabled !== false) {
      const historyEnvelope = await this.encryptRecord(existing.record, existing.version)
      await saveHistory(this.adapter, this.compartment, this.name, id, historyEnvelope)

      this.emitter.emit('history:save', {
        compartment: this.compartment,
        collection: this.name,
        id,
        version: existing.version,
      })

      // Auto-prune if maxVersions configured
      if (this.historyConfig.maxVersions) {
        await pruneHistoryEntries(this.adapter, this.compartment, this.name, id, {
          keepVersions: this.historyConfig.maxVersions,
        })
      }
    }

    const envelope = await this.encryptRecord(record, version)
    await this.adapter.put(this.compartment, this.name, id, envelope)

    this.cache.set(id, { record, version })

    await this.onDirty?.(this.name, id, 'put', version)

    this.emitter.emit('change', {
      compartment: this.compartment,
      collection: this.name,
      id,
      action: 'put',
    } satisfies ChangeEvent)
  }

  /** Delete a record by ID. */
  async delete(id: string): Promise<void> {
    if (!hasWritePermission(this.keyring, this.name)) {
      throw new ReadOnlyError()
    }

    const existing = this.cache.get(id)

    // Save history snapshot before deleting
    if (existing && this.historyConfig.enabled !== false) {
      const historyEnvelope = await this.encryptRecord(existing.record, existing.version)
      await saveHistory(this.adapter, this.compartment, this.name, id, historyEnvelope)
    }

    await this.adapter.delete(this.compartment, this.name, id)
    this.cache.delete(id)

    await this.onDirty?.(this.name, id, 'delete', existing?.version ?? 0)

    this.emitter.emit('change', {
      compartment: this.compartment,
      collection: this.name,
      id,
      action: 'delete',
    } satisfies ChangeEvent)
  }

  /** List all records in the collection. */
  async list(): Promise<T[]> {
    await this.ensureHydrated()
    return [...this.cache.values()].map(e => e.record)
  }

  /** Filter records by a predicate. */
  query(predicate: (record: T) => boolean): T[] {
    return [...this.cache.values()].map(e => e.record).filter(predicate)
  }

  // ─── History Methods ────────────────────────────────────────────

  /** Get version history for a record, newest first. */
  async history(id: string, options?: HistoryOptions): Promise<HistoryEntry<T>[]> {
    const envelopes = await getHistoryEntries(
      this.adapter, this.compartment, this.name, id, options,
    )

    const entries: HistoryEntry<T>[] = []
    for (const env of envelopes) {
      const record = await this.decryptRecord(env)
      entries.push({
        version: env._v,
        timestamp: env._ts,
        userId: env._by ?? '',
        record,
      })
    }
    return entries
  }

  /** Get a specific past version of a record. */
  async getVersion(id: string, version: number): Promise<T | null> {
    const envelope = await getVersionEnvelope(
      this.adapter, this.compartment, this.name, id, version,
    )
    if (!envelope) return null
    return this.decryptRecord(envelope)
  }

  /** Revert a record to a past version. Creates a new version with the old content. */
  async revert(id: string, version: number): Promise<void> {
    const oldRecord = await this.getVersion(id, version)
    if (!oldRecord) {
      throw new Error(`Version ${version} not found for record "${id}"`)
    }
    await this.put(id, oldRecord)
  }

  /**
   * Compare two versions of a record and return the differences.
   * Use version 0 to represent "before creation" (empty).
   * Omit versionB to compare against the current version.
   */
  async diff(id: string, versionA: number, versionB?: number): Promise<DiffEntry[]> {
    const recordA = versionA === 0 ? null : await this.resolveVersion(id, versionA)
    const recordB = versionB === undefined || versionB === 0
      ? (versionB === 0 ? null : await this.resolveCurrentOrVersion(id))
      : await this.resolveVersion(id, versionB)
    return computeDiff(recordA, recordB)
  }

  /** Resolve a version: try history first, then check if it's the current version. */
  private async resolveVersion(id: string, version: number): Promise<T | null> {
    // Check history
    const fromHistory = await this.getVersion(id, version)
    if (fromHistory) return fromHistory
    // Check if it's the current live version
    await this.ensureHydrated()
    const current = this.cache.get(id)
    if (current && current.version === version) return current.record
    return null
  }

  private async resolveCurrentOrVersion(id: string): Promise<T | null> {
    await this.ensureHydrated()
    return this.cache.get(id)?.record ?? null
  }

  /** Prune history entries for a record (or all records if id is undefined). */
  async pruneRecordHistory(id: string | undefined, options: PruneOptions): Promise<number> {
    const pruned = await pruneHistoryEntries(
      this.adapter, this.compartment, this.name, id, options,
    )
    if (pruned > 0) {
      this.emitter.emit('history:prune', {
        compartment: this.compartment,
        collection: this.name,
        id: id ?? '*',
        pruned,
      })
    }
    return pruned
  }

  /** Clear all history for this collection (or a specific record). */
  async clearHistory(id?: string): Promise<number> {
    return clearHistory(this.adapter, this.compartment, this.name, id)
  }

  // ─── Core Methods ─────────────────────────────────────────────

  /** Count records in the collection. */
  async count(): Promise<number> {
    await this.ensureHydrated()
    return this.cache.size
  }

  // ─── Internal ──────────────────────────────────────────────────

  /** Load all records from adapter into memory cache. */
  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) return

    const ids = await this.adapter.list(this.compartment, this.name)
    for (const id of ids) {
      const envelope = await this.adapter.get(this.compartment, this.name, id)
      if (envelope) {
        const record = await this.decryptRecord(envelope)
        this.cache.set(id, { record, version: envelope._v })
      }
    }
    this.hydrated = true
  }

  /** Hydrate from a pre-loaded snapshot (used by Compartment). */
  async hydrateFromSnapshot(records: Record<string, EncryptedEnvelope>): Promise<void> {
    for (const [id, envelope] of Object.entries(records)) {
      const record = await this.decryptRecord(envelope)
      this.cache.set(id, { record, version: envelope._v })
    }
    this.hydrated = true
  }

  /** Get all records as encrypted envelopes (for dump). */
  async dumpEnvelopes(): Promise<Record<string, EncryptedEnvelope>> {
    await this.ensureHydrated()
    const result: Record<string, EncryptedEnvelope> = {}
    for (const [id, entry] of this.cache) {
      result[id] = await this.encryptRecord(entry.record, entry.version)
    }
    return result
  }

  private async encryptRecord(record: T, version: number): Promise<EncryptedEnvelope> {
    const json = JSON.stringify(record)
    const by = this.keyring.userId

    if (!this.encrypted) {
      return {
        _noydb: NOYDB_FORMAT_VERSION,
        _v: version,
        _ts: new Date().toISOString(),
        _iv: '',
        _data: json,
        _by: by,
      }
    }

    const dek = await this.getDEK(this.name)
    const { iv, data } = await encrypt(json, dek)

    return {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: version,
      _ts: new Date().toISOString(),
      _iv: iv,
      _data: data,
      _by: by,
    }
  }

  private async decryptRecord(envelope: EncryptedEnvelope): Promise<T> {
    if (!this.encrypted) {
      return JSON.parse(envelope._data) as T
    }

    const dek = await this.getDEK(this.name)
    const json = await decrypt(envelope._iv, envelope._data, dek)
    return JSON.parse(json) as T
  }
}
