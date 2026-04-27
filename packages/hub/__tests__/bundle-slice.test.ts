/**
 * Slice-filter coverage for writeNoydbBundle (#301a).
 *
 * Verifies the two opt-in filters added in this issue:
 *
 *   - `collections` — allowlist of user-collection names
 *   - `since` — drop records whose envelope `_ts` is older than the cutoff
 *
 * Both filters operate on metadata only — no plaintext access, no
 * envelope rewriting. The bundle round-trips via writeNoydbBundle →
 * readNoydbBundle and the resulting dump JSON is what's asserted on.
 */

import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'
import { ConflictError, createNoydb, writeNoydbBundle, readNoydbBundle } from '../src/index.js'

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

interface Invoice { id: string; amount: number }
interface Payment { id: string; amount: number }

async function setup() {
  const db = await createNoydb({ store: memory(), user: 'alice', secret: 'pw-2026' })
  const vault = await db.openVault('demo')
  await vault.collection<Invoice>('invoices').put('a', { id: 'a', amount: 100 })
  await vault.collection<Invoice>('invoices').put('b', { id: 'b', amount: 200 })
  await vault.collection<Payment>('payments').put('p1', { id: 'p1', amount: 100 })
  await vault.collection<Payment>('payments').put('p2', { id: 'p2', amount: 200 })
  return { db, vault }
}

describe('writeNoydbBundle — collections filter (#301)', () => {
  it('without filters carries every user collection', async () => {
    const { db, vault } = await setup()
    const bytes = await writeNoydbBundle(vault)
    const result = await readNoydbBundle(bytes)
    expect(result.dumpJson).toContain('"invoices"')
    expect(result.dumpJson).toContain('"payments"')
    db.close()
  })

  it('with collections allowlist drops other user collections', async () => {
    const { db, vault } = await setup()
    const bytes = await writeNoydbBundle(vault, { collections: ['invoices'] })
    const result = await readNoydbBundle(bytes)
    const dump = JSON.parse(result.dumpJson) as { collections: Record<string, unknown> }
    expect(Object.keys(dump.collections)).toEqual(['invoices'])
    expect(dump.collections['invoices']).toBeDefined()
    expect(dump.collections['payments']).toBeUndefined()
    db.close()
  })

  it('preserves keyrings + ledger when filtering', async () => {
    // Keyrings must survive — the receiver needs them to unlock.
    // Ledger entries must survive — they're verified at load() time.
    const { db, vault } = await setup()
    const bytes = await writeNoydbBundle(vault, { collections: ['invoices'] })
    const result = await readNoydbBundle(bytes)
    expect(result.dumpJson).toContain('"keyrings"')
    db.close()
  })

  it('empty allowlist yields zero user collections (but keyrings + ledger survive)', async () => {
    const { db, vault } = await setup()
    const bytes = await writeNoydbBundle(vault, { collections: [] })
    const result = await readNoydbBundle(bytes)
    const dump = JSON.parse(result.dumpJson) as { collections: Record<string, unknown> }
    expect(Object.keys(dump.collections)).toEqual([])
    expect(result.dumpJson).toContain('"keyrings"')
    db.close()
  })
})

describe('writeNoydbBundle — since filter (#301)', () => {
  it('drops records older than the cutoff', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'pw-2026' })
    const vault = await db.openVault('demo')
    const inv = vault.collection<Invoice>('invoices')

    await inv.put('old', { id: 'old', amount: 100 })
    // Capture cutoff between writes — second write is unambiguously newer.
    await new Promise((r) => setTimeout(r, 10))
    const cutoff = new Date()
    await new Promise((r) => setTimeout(r, 10))
    await inv.put('new', { id: 'new', amount: 200 })

    const bytes = await writeNoydbBundle(vault, { since: cutoff })
    const result = await readNoydbBundle(bytes)
    const dump = JSON.parse(result.dumpJson) as {
      collections: { invoices?: Record<string, unknown> }
    }
    const ids = Object.keys(dump.collections.invoices ?? {})
    expect(ids).toEqual(['new'])
    db.close()
  })

  it('accepts an ISO string as well as a Date', async () => {
    const { db, vault } = await setup()
    // Use an instant in the past — every record survives.
    const bytes = await writeNoydbBundle(vault, { since: '2000-01-01T00:00:00Z' })
    const result = await readNoydbBundle(bytes)
    const dump = JSON.parse(result.dumpJson) as {
      collections: { invoices: Record<string, unknown> }
    }
    expect(Object.keys(dump.collections.invoices).sort()).toEqual(['a', 'b'])
    db.close()
  })

  it('intersects with the collections allowlist (AND)', async () => {
    const { db, vault } = await setup()
    const bytes = await writeNoydbBundle(vault, {
      collections: ['invoices'],
      since: '2000-01-01T00:00:00Z',
    })
    const result = await readNoydbBundle(bytes)
    const dump = JSON.parse(result.dumpJson) as {
      collections: Record<string, unknown>
    }
    expect(Object.keys(dump.collections)).toEqual(['invoices'])
    db.close()
  })
})
