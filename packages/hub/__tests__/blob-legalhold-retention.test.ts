/**
 * #311 — blob legal-hold + period-bound retention floor over compaction.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'
import { ConflictError, createNoydb } from '../src/index.js'
import { withBlobs } from '../src/blobs/index.js'
import type { Noydb, Vault } from '../src/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = store.get(v); if (!vm) { vm = new Map(); store.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const cm = gc(v, c); const ex = cm.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      cm.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = store.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [n, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[n] = r
      }
      return snap
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const cm = gc(v, n)
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
      }
    },
  }
}

interface Invoice { id: string; status: string; onHold?: boolean; fiscalYearEnd?: string }

async function setup(): Promise<Vault> {
  const db: Noydb = await createNoydb({ store: memory(), user: 'owner', secret: 'pw', blobStrategy: withBlobs() })
  return db.openVault('acme')
}

const bytes = (s: string) => new TextEncoder().encode(s)

describe('#311 blob legalHold', () => {
  it('blocks an otherwise-due eviction while the hold predicate is true', async () => {
    const vault = await setup()
    const inv = vault.collection<Invoice>('invoices', {
      blobFields: { pdf: { evictWhen: (r) => r.status === 'confirmed', legalHold: (r) => r.onHold === true } },
    })
    await inv.put('a', { id: 'a', status: 'confirmed', onHold: true })   // due-to-evict but held
    await inv.put('b', { id: 'b', status: 'confirmed', onHold: false })  // due-to-evict, not held
    await inv.blob('a').put('pdf', bytes('A'))
    await inv.blob('b').put('pdf', bytes('B'))

    const r = await vault.compact()
    expect(r.evicted).toBe(1)  // only b
    expect(r.held).toBe(1)     // a held
    expect(await inv.blob('a').list()).toHaveLength(1) // a's pdf retained
    expect(await inv.blob('b').list()).toHaveLength(0)
  })

  it('releasing the hold lets a later compaction evict', async () => {
    const vault = await setup()
    const inv = vault.collection<Invoice>('invoices', {
      blobFields: { pdf: { evictWhen: () => true, legalHold: (r) => r.onHold === true } },
    })
    await inv.put('a', { id: 'a', status: 'x', onHold: true })
    await inv.blob('a').put('pdf', bytes('A'))
    expect((await vault.compact()).held).toBe(1)
    expect(await inv.blob('a').list()).toHaveLength(1)

    await inv.put('a', { id: 'a', status: 'x', onHold: false }) // release hold
    const r = await vault.compact()
    expect(r.evicted).toBe(1)
    expect(await inv.blob('a').list()).toHaveLength(0)
  })

  it('fail-closed: a throwing legalHold predicate retains the slot', async () => {
    const vault = await setup()
    const inv = vault.collection<Invoice>('invoices', {
      blobFields: { pdf: { evictWhen: () => true, legalHold: () => { throw new Error('boom') } } },
    })
    await inv.put('a', { id: 'a', status: 'x' })
    await inv.blob('a').put('pdf', bytes('A'))
    const r = await vault.compact()
    expect(r.evicted).toBe(0)
    expect(r.held).toBe(1)
  })
})

describe('#311 blob retainUntil (period-bound floor)', () => {
  it('retains until the date, then evicts after it', async () => {
    const vault = await setup()
    const inv = vault.collection<Invoice>('invoices', {
      blobFields: { pdf: { evictWhen: () => true, retainUntil: (r) => r.fiscalYearEnd } },
    })
    await inv.put('a', { id: 'a', status: 'x', fiscalYearEnd: '2036-12-31' })
    await inv.blob('a').put('pdf', bytes('A'))

    // before the floor → held
    let r = await vault.compact({ now: new Date('2030-01-01T00:00:00Z') })
    expect(r.held).toBe(1)
    expect(r.evicted).toBe(0)

    // after the floor → evicts
    r = await vault.compact({ now: new Date('2037-01-01T00:00:00Z') })
    expect(r.evicted).toBe(1)
    expect(await inv.blob('a').list()).toHaveLength(0)
  })

  it('fail-closed: an unparseable retainUntil string holds the slot (not evicted)', async () => {
    // '31/12/2036' is not ISO-8601 — Date.parse returns NaN in V8.
    // now is far-future so even if it somehow parsed it would be in the past → evictable.
    // Only a genuine NaN (fail-closed) keeps it held.
    const vault = await setup()
    const inv = vault.collection<Invoice>('invoices', {
      blobFields: { pdf: { evictWhen: () => true, retainUntil: () => '31/12/2036' } },
    })
    await inv.put('a', { id: 'a', status: 'x' })
    await inv.blob('a').put('pdf', bytes('A'))

    const r = await vault.compact({ now: new Date('2099-01-01T00:00:00Z') })
    expect(r.held).toBe(1)
    expect(r.evicted).toBe(0)
    expect(await inv.blob('a').list()).toHaveLength(1)
  })

  it('fail-closed: a throwing retainUntil holds the slot', async () => {
    const vault = await setup()
    const inv = vault.collection<Invoice>('invoices', {
      blobFields: { pdf: { evictWhen: () => true, retainUntil: () => { throw new Error('storage unavailable') } } },
    })
    await inv.put('a', { id: 'a', status: 'x' })
    await inv.blob('a').put('pdf', bytes('A'))

    const r = await vault.compact()
    expect(r.evicted).toBe(0)
    expect(r.held).toBe(1)
    expect(await inv.blob('a').list()).toHaveLength(1)
  })
})
