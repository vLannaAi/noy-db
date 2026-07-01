/**
 * @category capability
 * Deferred numbering engine — store-clock-ordered, gap-free serials assigned
 * at an explicit numbering pass. See the design spec.
 */
import type { NoydbStore, EncryptedEnvelope, StoreTime } from '../../kernel/types.js'
import { NOYDB_FORMAT_VERSION } from '../../kernel/types.js'
import { encrypt, decrypt } from '../../kernel/enclave/crypto.js'
import { ConflictError, NumberingUncertaintyError } from '../../errors.js'
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

  /** Current last-assigned serial for a series (0 if none). */
  async peek(series: string): Promise<number> {
    const { value } = await this.readJson<NumberingHead>(NUMBERING_HEAD_COLLECTION, series)
    return value?.lastSerial ?? 0
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

  private async listPending(series: string): Promise<Array<{ id: string; entry: PendingEntry }>> {
    const ids = await this.adapter.list(this.vault, NUMBERING_PENDING_COLLECTION)
    const prefix = `${series}::`
    const out: Array<{ id: string; entry: PendingEntry }> = []
    for (const id of ids) {
      if (!id.startsWith(prefix)) continue
      const { value } = await this.readJson<PendingEntry>(NUMBERING_PENDING_COLLECTION, id)
      if (value) out.push({ id, entry: value })
    }
    return out
  }

  /**
   * Run a numbering pass for `series`: select entries provably settled
   * (`storeLatest ≤ now.earliest` — commit-wait), order by
   * `(storeEarliest, recordId)`, assign serials after the head, stamp each
   * record's field, advance the head with one CAS, and consume the entries.
   * Idempotent/convergent: a losing concurrent pass returns `[]` and the next
   * pass reconciles. Resolves any in-process enqueue() `assigned` Promises.
   */
  async runPass(series: string): Promise<Assignment[]> {
    const cfg = this.configs.get(series)
    if (!cfg) throw new NumberingUncertaintyError(series)
    if (typeof this.adapter.getStoreTime !== 'function') throw new NumberingUncertaintyError(series)

    const now = await this.adapter.getStoreTime()
    const settled = (await this.listPending(series))
      .filter(p => p.entry.storeLatest <= now.earliest) // commit-wait
      .sort((a, b) =>
        a.entry.storeEarliest - b.entry.storeEarliest ||
        (a.entry.recordId < b.entry.recordId ? -1 : a.entry.recordId > b.entry.recordId ? 1 : 0),
      )
    if (settled.length === 0) return []

    const { env: headEnv, value: head } = await this.readJson<NumberingHead>(NUMBERING_HEAD_COLLECTION, series)
    let serial = head?.lastSerial ?? 0
    const assignments: Assignment[] = []

    // Stamp each user record THROUGH the Collection layer (cache-coherent).
    for (const { entry } of settled) {
      serial += 1
      const ok = await this.stamp(entry.collection, entry.recordId, entry.field, serial)
      if (!ok) { serial -= 1; continue } // record gone — skip, do not burn a number
      assignments.push({ recordId: entry.recordId, serial })
    }

    // Advance the head with one CAS. On conflict another pass ran; bail — the
    // next pass reconciles (idempotent: consumed entries won't reappear).
    try {
      await this.writeJson(NUMBERING_HEAD_COLLECTION, series, { series, lastSerial: serial, watermark: now.earliest }, headEnv?._v ?? 0)
    } catch (err) {
      if (err instanceof ConflictError) return []
      throw err
    }

    // Consume pending entries + resolve in-process waiters.
    for (const { id, entry } of settled) {
      await this.adapter.delete(this.vault, NUMBERING_PENDING_COLLECTION, id)
      const a = assignments.find(x => x.recordId === entry.recordId)
      if (a) { this.waiters.get(id)?.resolve(a.serial); this.waiters.delete(id) }
    }
    return assignments
  }
}
