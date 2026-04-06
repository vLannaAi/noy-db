import type { NoydbAdapter, CompartmentBackup, HistoryConfig } from './types.js'
import { NOYDB_BACKUP_VERSION } from './types.js'
import { Collection } from './collection.js'
import type { CacheOptions } from './collection.js'
import type { IndexDef } from './query/indexes.js'
import type { OnDirtyCallback } from './collection.js'
import type { UnlockedKeyring } from './keyring.js'
import { ensureCollectionDEK } from './keyring.js'
import type { NoydbEventEmitter } from './events.js'
import { PermissionDeniedError } from './errors.js'

/** A compartment (tenant namespace) containing collections. */
export class Compartment {
  private readonly adapter: NoydbAdapter
  private readonly name: string
  private readonly keyring: UnlockedKeyring
  private readonly encrypted: boolean
  private readonly emitter: NoydbEventEmitter
  private readonly onDirty: OnDirtyCallback | undefined
  private readonly historyConfig: HistoryConfig
  private readonly getDEK: (collectionName: string) => Promise<CryptoKey>
  private readonly collectionCache = new Map<string, Collection<unknown>>()

  constructor(opts: {
    adapter: NoydbAdapter
    name: string
    keyring: UnlockedKeyring
    encrypted: boolean
    emitter: NoydbEventEmitter
    onDirty?: OnDirtyCallback | undefined
    historyConfig?: HistoryConfig | undefined
  }) {
    this.adapter = opts.adapter
    this.name = opts.name
    this.keyring = opts.keyring
    this.encrypted = opts.encrypted
    this.emitter = opts.emitter
    this.onDirty = opts.onDirty
    this.historyConfig = opts.historyConfig ?? { enabled: true }

    // Create the DEK resolver (lazy — generates DEKs on first use)
    // We need to store the promise to avoid recreating it
    let getDEKFn: ((collectionName: string) => Promise<CryptoKey>) | null = null
    this.getDEK = async (collectionName: string): Promise<CryptoKey> => {
      if (!getDEKFn) {
        getDEKFn = await ensureCollectionDEK(this.adapter, this.name, this.keyring)
      }
      return getDEKFn(collectionName)
    }
  }

  /**
   * Open a typed collection within this compartment.
   *
   * - `options.indexes` declares secondary indexes for the query DSL.
   *   Indexes are computed in memory after decryption; adapters never
   *   see plaintext index data.
   * - `options.prefetch` (default `true`) controls hydration. Eager mode
   *   loads everything on first access; lazy mode (`prefetch: false`)
   *   loads records on demand and bounds memory via the LRU cache.
   * - `options.cache` configures the LRU bounds. Required in lazy mode.
   *   Accepts `{ maxRecords, maxBytes: '50MB' | 1024 }`.
   *
   * Lazy mode + indexes is rejected at construction time — see the
   * Collection constructor for the rationale.
   */
  collection<T>(collectionName: string, options?: {
    indexes?: IndexDef[]
    prefetch?: boolean
    cache?: CacheOptions
  }): Collection<T> {
    let coll = this.collectionCache.get(collectionName)
    if (!coll) {
      const collOpts: ConstructorParameters<typeof Collection>[0] = {
        adapter: this.adapter,
        compartment: this.name,
        name: collectionName,
        keyring: this.keyring,
        encrypted: this.encrypted,
        emitter: this.emitter,
        getDEK: this.getDEK,
        onDirty: this.onDirty,
        historyConfig: this.historyConfig,
      }
      if (options?.indexes !== undefined) collOpts.indexes = options.indexes
      if (options?.prefetch !== undefined) collOpts.prefetch = options.prefetch
      if (options?.cache !== undefined) collOpts.cache = options.cache
      coll = new Collection<T>(collOpts)
      this.collectionCache.set(collectionName, coll)
    }
    return coll as Collection<T>
  }

  /** List all collection names in this compartment. */
  async collections(): Promise<string[]> {
    const snapshot = await this.adapter.loadAll(this.name)
    return Object.keys(snapshot)
  }

  /** Dump compartment as encrypted JSON backup string. */
  async dump(): Promise<string> {
    const snapshot = await this.adapter.loadAll(this.name)

    // Load keyrings
    const keyringIds = await this.adapter.list(this.name, '_keyring')
    const keyrings: Record<string, unknown> = {}
    for (const keyringId of keyringIds) {
      const envelope = await this.adapter.get(this.name, '_keyring', keyringId)
      if (envelope) {
        keyrings[keyringId] = JSON.parse(envelope._data)
      }
    }

    const backup: CompartmentBackup = {
      _noydb_backup: NOYDB_BACKUP_VERSION,
      _compartment: this.name,
      _exported_at: new Date().toISOString(),
      _exported_by: this.keyring.userId,
      keyrings: keyrings as CompartmentBackup['keyrings'],
      collections: snapshot,
    }

    return JSON.stringify(backup)
  }

  /** Restore compartment from an encrypted JSON backup string. */
  async load(backupJson: string): Promise<void> {
    const backup = JSON.parse(backupJson) as CompartmentBackup
    await this.adapter.saveAll(this.name, backup.collections)

    // Restore keyrings
    for (const [userId, keyringFile] of Object.entries(backup.keyrings)) {
      const envelope = {
        _noydb: 1 as const,
        _v: 1,
        _ts: new Date().toISOString(),
        _iv: '',
        _data: JSON.stringify(keyringFile),
      }
      await this.adapter.put(this.name, '_keyring', userId, envelope)
    }

    // Clear collection cache so they re-hydrate
    this.collectionCache.clear()
  }

  /** Export compartment as decrypted JSON (owner only). */
  async export(): Promise<string> {
    if (this.keyring.role !== 'owner') {
      throw new PermissionDeniedError('Only the owner can export decrypted data')
    }

    const result: Record<string, Record<string, unknown>> = {}
    const snapshot = await this.adapter.loadAll(this.name)

    for (const [collName, records] of Object.entries(snapshot)) {
      const coll = this.collection(collName)
      const decrypted: Record<string, unknown> = {}
      for (const id of Object.keys(records)) {
        decrypted[id] = await coll.get(id)
      }
      result[collName] = decrypted
    }

    return JSON.stringify(result)
  }
}
