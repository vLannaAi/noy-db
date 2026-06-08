import { describe, it, expect } from 'vitest'
import { withDeferredNumbering } from '../../src/numbering/descriptor.js'
import { NumberingUncertaintyError, ConflictError } from '../../src/errors.js'
import { DeferredNumberingStore } from '../../src/numbering/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/types.js'

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
        const [vn, cn, id] = key.split('/')
        if (vn === v && !cn.startsWith('_')) { out[cn] = out[cn] ?? {}; out[cn][id] = env }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) for (const i of Object.keys(payload[c])) data.set(k(v, c, i), payload[c][i])
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
