import type { NoydbAdapter, EncryptedEnvelope, ChangeEvent } from './types.js'
import { NOYDB_FORMAT_VERSION } from './types.js'
import { encrypt, decrypt } from './crypto.js'
import { ReadOnlyError, NoAccessError } from './errors.js'
import type { UnlockedKeyring } from './keyring.js'
import { hasWritePermission } from './keyring.js'
import type { NoydbEventEmitter } from './events.js'

/** A typed collection of records within a compartment. */
export class Collection<T> {
  private readonly adapter: NoydbAdapter
  private readonly compartment: string
  private readonly name: string
  private readonly keyring: UnlockedKeyring
  private readonly encrypted: boolean
  private readonly emitter: NoydbEventEmitter
  private readonly getDEK: (collectionName: string) => Promise<CryptoKey>

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
  }) {
    this.adapter = opts.adapter
    this.compartment = opts.compartment
    this.name = opts.name
    this.keyring = opts.keyring
    this.encrypted = opts.encrypted
    this.emitter = opts.emitter
    this.getDEK = opts.getDEK
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

    const envelope = await this.encryptRecord(record, version)
    await this.adapter.put(this.compartment, this.name, id, envelope)

    this.cache.set(id, { record, version })

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

    await this.adapter.delete(this.compartment, this.name, id)
    this.cache.delete(id)

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

    if (!this.encrypted) {
      return {
        _noydb: NOYDB_FORMAT_VERSION,
        _v: version,
        _ts: new Date().toISOString(),
        _iv: '',
        _data: json,
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
