/**
 * @category capability
 * Deferred numbering engine — store-clock-ordered, gap-free serials assigned
 * at an explicit numbering pass. See the design spec.
 */
import type { NoydbStore, EncryptedEnvelope, StoreTime } from '../types.js'
import { NOYDB_FORMAT_VERSION } from '../types.js'
import { encrypt, decrypt } from '../crypto.js'
import { ConflictError, NumberingUncertaintyError } from '../errors.js'
import type { DeferredNumberingConfig } from './descriptor.js'

export const NUMBERING_HEAD_COLLECTION = '_numbering_head'
export const NUMBERING_PENDING_COLLECTION = '_numbering_pending'

interface PendingEntry {
  series: string
  recordId: string
  collection: string
  field: string
  storeEarliest: number
  storeLatest: number
  enqueuedAt: number
}
interface NumberingHead { series: string; lastSerial: number; watermark: number }
export interface Assignment { recordId: string; serial: number }

type PendingPromise = { resolve: (n: number) => void; reject: (e: Error) => void }

export class DeferredNumberingStore {
  private readonly adapter: NoydbStore
  private readonly vault: string
  private readonly encrypted: boolean
  private readonly getDEK: (collectionName: string) => Promise<CryptoKey>
  private readonly actor: string
  private readonly configs: Map<string, DeferredNumberingConfig>
  /**
   * Stamp a serial onto a USER record THROUGH the Collection layer (so the
   * cache, indexes, and MVs stay coherent — the engine must NOT write user
   * collections at the raw adapter level). Returns false if the record is
   * gone (the engine then skips it without burning a serial). Provided by the
   * vault; unit tests pass a Map-backed double.
   */
  private readonly stamp: (collection: string, recordId: string, field: string, serial: number) => Promise<boolean>
  /** In-process registry: `${series}::${recordId}` → resolver for the live next() Promise. */
  private readonly waiters = new Map<string, PendingPromise>()
  private readonly dekCache = new Map<string, Promise<CryptoKey>>()

  constructor(opts: {
    adapter: NoydbStore
    vault: string
    encrypted: boolean
    getDEK: (collectionName: string) => Promise<CryptoKey>
    actor: string
    configs: Map<string, DeferredNumberingConfig>
    stamp: (collection: string, recordId: string, field: string, serial: number) => Promise<boolean>
  }) {
    this.adapter = opts.adapter
    this.vault = opts.vault
    this.encrypted = opts.encrypted
    this.getDEK = opts.getDEK
    this.actor = opts.actor
    this.configs = opts.configs
    this.stamp = opts.stamp
  }

  has(series: string): boolean {
    return this.configs.has(series)
  }

  private dek(collection: string): Promise<CryptoKey> {
    let p = this.dekCache.get(collection)
    if (!p) { p = this.getDEK(collection); this.dekCache.set(collection, p) }
    return p
  }

  private async readJson<T>(collection: string, id: string): Promise<{ env: EncryptedEnvelope | null; value: T | null }> {
    const env = await this.adapter.get(this.vault, collection, id)
    if (!env) return { env: null, value: null }
    const json = this.encrypted ? await decrypt(env._iv, env._data, await this.dek(collection)) : env._data
    return { env, value: JSON.parse(json) as T }
  }

  private async writeJson(collection: string, id: string, value: unknown, expectedVersion: number): Promise<void> {
    const json = JSON.stringify(value)
    let env: EncryptedEnvelope
    if (!this.encrypted) {
      env = { _noydb: NOYDB_FORMAT_VERSION, _v: expectedVersion + 1, _ts: new Date().toISOString(), _iv: '', _data: json, _by: this.actor }
    } else {
      const { iv, data } = await encrypt(json, await this.dek(collection))
      env = { _noydb: NOYDB_FORMAT_VERSION, _v: expectedVersion + 1, _ts: new Date().toISOString(), _iv: iv, _data: data, _by: this.actor }
    }
    await this.adapter.put(this.vault, collection, id, env, expectedVersion)
  }

  private pendingId(series: string, recordId: string): string {
    return `${series}::${recordId}`
  }

  /**
   * Enqueue a record for numbering: stamp it with the current store clock and
   * durably write a pending entry. The returned Promise resolves once the
   * record is durably enqueued; its `assigned` field resolves with the serial
   * at the next pass (the record's `field` is the durable source of truth —
   * `assigned` is an in-process convenience that a crash may drop).
   */
  async enqueue(series: string, recordId: string): Promise<{ assigned: Promise<number> }> {
    const cfg = this.configs.get(series)
    if (!cfg) throw new NumberingUncertaintyError(series)
    if (typeof this.adapter.getStoreTime !== 'function') throw new NumberingUncertaintyError(series)
    const st: StoreTime = await this.adapter.getStoreTime()
    const id = this.pendingId(series, recordId)
    const { env } = await this.readJson<PendingEntry>(NUMBERING_PENDING_COLLECTION, id)
    const entry: PendingEntry = {
      series, recordId, collection: cfg.collection, field: cfg.field,
      storeEarliest: st.earliest, storeLatest: st.latest, enqueuedAt: Date.now(),
    }
    await this.writeJson(NUMBERING_PENDING_COLLECTION, id, entry, env?._v ?? 0)
    const assigned = new Promise<number>((resolve, reject) => { this.waiters.set(id, { resolve, reject }) })
    return { assigned }
  }
}
