import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'
import { ConflictError, createNoydb, diffVault } from '../src/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string) => {
    let comp = store.get(v); if (!comp) { comp = new Map(); store.set(v, comp) }
    let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = gc(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const comp = store.get(v); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (n.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of coll) r[id] = e
        s[n] = r
      }
      return s
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(v, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

interface Invoice { id: string; client: string; amount: number; status: string }

async function setup() {
  const db = await createNoydb({ store: memory(), user: 'alice', secret: 'pw-2026' })
  const vault = await db.openVault('demo')
  const invoices = vault.collection<Invoice>('invoices')
  await invoices.put('a', { id: 'a', client: 'X', amount: 100, status: 'paid' })
  await invoices.put('b', { id: 'b', client: 'Y', amount: 200, status: 'draft' })
  await invoices.put('c', { id: 'c', client: 'Z', amount: 300, status: 'paid' })
  return { db, vault }
}

describe('diffVault — plain object candidate', () => {
  it('detects added / modified / deleted records relative to a plain map', async () => {
    const { db, vault } = await setup()

    const candidate: Record<string, Invoice[]> = {
      invoices: [
        // 'a' — unchanged
        { id: 'a', client: 'X', amount: 100, status: 'paid' },
        // 'b' — modified (status: 'draft' → 'paid')
        { id: 'b', client: 'Y', amount: 200, status: 'paid' },
        // 'c' — deleted (omitted from candidate)
        // 'd' — added
        { id: 'd', client: 'W', amount: 400, status: 'paid' },
      ],
    }

    const plan = await diffVault<Invoice>(vault, candidate)

    expect(plan.summary).toEqual({ add: 1, modify: 1, delete: 1, total: 3 })
    expect(plan.added.map((e) => e.id)).toEqual(['d'])
    expect(plan.deleted.map((e) => e.id)).toEqual(['c'])
    expect(plan.modified).toHaveLength(1)
    expect(plan.modified[0]!.id).toBe('b')
    expect(plan.modified[0]!.fieldsChanged).toEqual(['status'])
    expect(plan.modified[0]!.fieldDiffs).toEqual([
      { path: 'status', type: 'changed', from: 'draft', to: 'paid' },
    ])

    db.close()
  })

  it('returns zero changes when candidate matches the live vault', async () => {
    const { db, vault } = await setup()
    const candidate: Record<string, Invoice[]> = {
      invoices: [
        { id: 'a', client: 'X', amount: 100, status: 'paid' },
        { id: 'b', client: 'Y', amount: 200, status: 'draft' },
        { id: 'c', client: 'Z', amount: 300, status: 'paid' },
      ],
    }
    const plan = await diffVault<Invoice>(vault, candidate)
    expect(plan.summary).toEqual({ add: 0, modify: 0, delete: 0, total: 0 })
    db.close()
  })
})

describe('diffVault — Vault-vs-Vault candidate', () => {
  it('walks both vaults via exportStream and emits the same shape', async () => {
    const live = await setup()
    const cand = await setup()
    // Mutate the candidate so they diverge.
    const candVault = await cand.db.openVault('demo')
    await candVault.collection<Invoice>('invoices').put('e', {
      id: 'e', client: 'V', amount: 500, status: 'paid',
    })

    const plan = await diffVault<Invoice>(live.vault, candVault)
    expect(plan.summary.add).toBe(1)
    expect(plan.added[0]!.id).toBe('e')

    live.db.close()
    cand.db.close()
  })
})

describe('diffVault — collections filter', () => {
  it('restricts diff to the requested collections only', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'pw-2026' })
    const vault = await db.openVault('demo')
    await vault.collection<Invoice>('invoices').put('a', { id: 'a', client: 'X', amount: 100, status: 'paid' })
    await vault.collection<{ id: string; amt: number }>('payments').put('p', { id: 'p', amt: 100 })

    const candidate = {
      invoices: [{ id: 'a', client: 'X', amount: 100, status: 'paid' }],
      // payments missing — would normally show as a deleted record
    }

    const all = await diffVault(vault, candidate)
    expect(all.summary.delete).toBe(1)

    const scoped = await diffVault(vault, candidate, { collections: ['invoices'] })
    expect(scoped.summary).toEqual({ add: 0, modify: 0, delete: 0, total: 0 })

    db.close()
  })
})

describe('diffVault — formatter', () => {
  it('emits a human-readable summary', async () => {
    const { db, vault } = await setup()
    const plan = await diffVault<Invoice>(vault, {
      invoices: [
        { id: 'a', client: 'X', amount: 100, status: 'paid' },
        { id: 'b', client: 'Y', amount: 250, status: 'draft' },
      ],
    })

    const count = plan.format({ detail: 'count' })
    expect(count).toMatch(/0 added.*1 modified.*1 deleted/)

    const full = plan.format({ detail: 'full' })
    expect(full).toContain('invoices/b')
    expect(full).toContain('modified')
    expect(full).toContain('amount: 200 → 250')
    expect(full).toContain('invoices/c')
    expect(full).toContain('deleted')
    db.close()
  })
})

describe('diffVault — vault.dump() JSON candidate', () => {
  it('parses a dump string and reduces it to the map shape', async () => {
    const { db: db1, vault: v1 } = await setup()
    const dump = await v1.dump()
    db1.close()

    // Live side has one extra record vs the dump.
    const { db: db2, vault: v2 } = await setup()
    await v2.collection<Invoice>('invoices').put('z', {
      id: 'z', client: 'fresh', amount: 99, status: 'paid',
    })

    const plan = await diffVault<Invoice>(v2, dump)
    // The dump is missing 'z' relative to v2, so 'z' is "deleted" from v2's perspective.
    expect(plan.deleted.map((e) => e.id)).toContain('z')
    db2.close()
  })
})

describe('diffVault — includeUnchanged', () => {
  it('returns unchanged buckets when explicitly requested', async () => {
    const { db, vault } = await setup()
    const candidate: Record<string, Invoice[]> = {
      invoices: [
        { id: 'a', client: 'X', amount: 100, status: 'paid' },
        { id: 'b', client: 'Y', amount: 200, status: 'draft' },
        { id: 'c', client: 'Z', amount: 300, status: 'paid' },
      ],
    }
    const off = await diffVault<Invoice>(vault, candidate)
    expect(off.unchanged).toBeUndefined()

    const on = await diffVault<Invoice>(vault, candidate, { includeUnchanged: true })
    expect(on.unchanged).toHaveLength(3)
    expect(on.unchanged!.map((e) => e.id).sort()).toEqual(['a', 'b', 'c'])
    db.close()
  })
})
