import { describe, it, expect } from 'vitest'
import { withDeferredNumbering } from '../../src/with-commit/numbering/descriptor.js'
import { NumberingUncertaintyError, ConflictError } from '../../src/errors.js'
import { DeferredNumberingStore } from '../../src/with-commit/numbering/index.js'
import { createNoydb } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'

// In-memory store with a monotonic clock — the engine's full backend under test.
function clockStore(epsilon = 0): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  let clock = 0
  return {
    name: 'clock-memory',
    capabilities: { casAtomic: true, serverWriteTime: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, i) { return data.get(k(v, c, i)) ?? null },
    async put(v, c, i, env, ev) {
      const ex = data.get(k(v, c, i))
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      data.set(k(v, c, i), env)
    },
    async delete(v, c, i) { data.delete(k(v, c, i)) },
    async list(v, c) {
      const prefix = `${v}/${c}/`
      return [...data.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
    },
    async loadAll(v) {
      const out: VaultSnapshot = {}
      for (const [key, env] of data) {
        const [vn, cn, id] = key.split('/') as [string, string, string]
        if (vn === v && !cn.startsWith('_')) { out[cn] = out[cn] ?? {}; out[cn][id] = env }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) for (const i of Object.keys(payload[c]!)) data.set(k(v, c, i), payload[c]![i]!)
    },
    async getStoreTime() { const n = ++clock; return { earliest: n - epsilon, latest: n + epsilon } },
  }
}

// Engine + a Map-backed `stamp` double that records assignments (and lets a
// test simulate a "record gone" by pre-marking an id as missing).
function engine(store: NoydbStore, missing = new Set<string>()) {
  const stamped = new Map<string, number>()
  const eng = new DeferredNumberingStore({
    adapter: store,
    vault: 'v',
    encrypted: false,
    getDEK: async () => { throw new Error('unencrypted') },
    actor: 'op',
    configs: new Map([['invoices', { series: 'invoices', collection: 'sales', field: 'fiscalNumber', settleWindowMs: 0 }]]),
    stamp: async (_collection, recordId, _field, serial) => {
      if (missing.has(recordId)) return false
      stamped.set(recordId, serial)
      return true
    },
  })
  return { eng, stamped }
}

describe('withDeferredNumbering descriptor', () => {
  it('captures the series config with defaults', () => {
    const d = withDeferredNumbering({ series: 'invoices', collection: 'sales', field: 'fiscalNumber' })
    expect(d.series).toBe('invoices')
    expect(d.collection).toBe('sales')
    expect(d.field).toBe('fiscalNumber')
    expect(d.settleWindowMs).toBe(0) // default: interval commit-wait governs settling
  })
})

describe('NumberingUncertaintyError', () => {
  it('carries the series', () => {
    const e = new NumberingUncertaintyError('invoices')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('NumberingUncertaintyError')
    expect(e.message).toContain('invoices')
  })
})

describe('DeferredNumberingStore.enqueue', () => {
  it('writes a pending entry stamped with the store clock', async () => {
    const store = clockStore()
    const { eng } = engine(store)
    await eng.enqueue('invoices', 'r1')
    const env = await store.get('v', '_numbering_pending', 'invoices::r1')
    expect(env).not.toBeNull()
    const entry = JSON.parse(env!._data)
    expect(entry.recordId).toBe('r1')
    expect(entry.storeLatest).toBeGreaterThanOrEqual(entry.storeEarliest)
  })
})

describe('DeferredNumberingStore.runPass', () => {
  it('assigns gap-free serials in store-time order and stamps the records', async () => {
    const store = clockStore()
    const { eng, stamped } = engine(store)
    for (const id of ['r1', 'r2', 'r3']) await eng.enqueue('invoices', id)

    const assignments = await eng.runPass('invoices')
    expect(assignments.map(a => a.serial)).toEqual([1, 2, 3])
    expect(assignments.map(a => a.recordId)).toEqual(['r1', 'r2', 'r3']) // store-time order
    expect(stamped.get('r2')).toBe(2)
    expect(await store.get('v', '_numbering_pending', 'invoices::r2')).toBeNull() // consumed
  })

  it('a second pass continues numbering after the head (gap-free across passes)', async () => {
    const store = clockStore()
    const { eng } = engine(store)
    await eng.enqueue('invoices', 'a')
    await eng.runPass('invoices') // a = 1
    await eng.enqueue('invoices', 'b')
    expect(await eng.runPass('invoices')).toEqual([{ recordId: 'b', serial: 2 }])
  })

  it('resolves the enqueue assigned Promise with the serial', async () => {
    const store = clockStore()
    const { eng } = engine(store)
    const { assigned } = await eng.enqueue('invoices', 'r1')
    await eng.runPass('invoices')
    await expect(assigned).resolves.toBe(1)
  })

  it('skips a record that is gone without burning a serial', async () => {
    const store = clockStore()
    const { eng, stamped } = engine(store, new Set(['gone']))
    await eng.enqueue('invoices', 'gone') // store-time 1 — sorts first
    await eng.enqueue('invoices', 'r1')   // store-time 2
    expect(await eng.runPass('invoices')).toEqual([{ recordId: 'r1', serial: 1 }])
    expect(stamped.has('gone')).toBe(false)
  })
})

describe('deferred numbering — correctness properties', () => {
  it('a record enqueued after a pass cannot renumber already-issued records (append-only)', async () => {
    const store = clockStore()
    const { eng, stamped } = engine(store)
    await eng.enqueue('invoices', 'r1')
    await eng.runPass('invoices')            // r1 = 1, head watermark advanced
    await eng.enqueue('invoices', 'r2')      // LATER store time → can only append
    expect(await eng.runPass('invoices')).toEqual([{ recordId: 'r2', serial: 2 }])
    expect(stamped.get('r1')).toBe(1)        // r1 never re-stamped
  })

  it('an entry whose interval has not settled is held for a later pass (commit-wait)', async () => {
    const store = clockStore(100) // ε = 100 → storeLatest far ahead of now.earliest
    const { eng } = engine(store)
    await eng.enqueue('invoices', 'r1')
    expect(await eng.runPass('invoices')).toEqual([]) // held, not numbered
  })

  it('throws NumberingUncertaintyError when the store has no clock', async () => {
    const noClock = clockStore()
    delete (noClock as { getStoreTime?: unknown }).getStoreTime
    const { eng } = engine(noClock)
    await expect(eng.runPass('invoices')).rejects.toBeInstanceOf(NumberingUncertaintyError)
  })
})

describe('vault deferred-numbering integration', () => {
  it('next({ for }) on a deferred series resolves at runNumberingPass', async () => {
    const db = await createNoydb({
      store: clockStore(), user: 'op', encrypt: false,
      numbering: [withDeferredNumbering({ series: 'invoices', collection: 'sales', field: 'fiscalNumber' })],
    })
    const v = await db.openVault('v')
    const sales = v.collection<{ id: string; amount: number; fiscalNumber?: number }>('sales')
    await sales.put('r1', { id: 'r1', amount: 100 })

    const pending = v.sequence('invoices').next({ for: 'r1' }) // Promise<number>, resolves at the pass
    await new Promise(r => setTimeout(r, 0))                    // let the enqueue write land first
    await v.runNumberingPass('invoices')
    await expect(pending).resolves.toBe(1)
    expect((await sales.get('r1'))!.fiscalNumber).toBe(1)
  })

  it('next() without a deferred config still uses the CAS counter', async () => {
    const db = await createNoydb({ store: clockStore(), user: 'op', encrypt: false })
    const v = await db.openVault('v')
    expect(await v.sequence('plain').next()).toBe(1)
    expect(await v.sequence('plain').next()).toBe(2)
  })
})
