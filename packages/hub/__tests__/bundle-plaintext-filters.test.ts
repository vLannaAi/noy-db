/**
 * Plaintext-tier slice filters for writeNoydbBundle (#320 `where`,
 * #321 `tierAtMost`).
 *
 * Both filters operate on the unencrypted vault dump:
 *   - `where` decrypts each record, runs the predicate, keeps the
 *     original ciphertext for survivors (no re-encrypt).
 *   - `tierAtMost` filters on the envelope `_tier` (no decryption
 *     needed — tier lives on the unencrypted envelope).
 *
 * Both compose with the existing metadata-only `collections` /
 * `since` filters and with recipient re-keying.
 */

import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'
import { ConflictError, createNoydb, writeNoydbBundle, readNoydbBundle } from '../src/index.js'
import { withHistory } from '../src/history/index.js'

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

interface Invoice { id: string; amount: number; status: string }

async function setup() {
  const db = await createNoydb({
    store: memory(), user: 'alice', secret: 'pw-2026',
    historyStrategy: withHistory(),
  })
  const vault = await db.openVault('demo')
  const inv = vault.collection<Invoice>('invoices')
  await inv.put('a', { id: 'a', amount: 100, status: 'draft' })
  await inv.put('b', { id: 'b', amount: 200, status: 'paid' })
  await inv.put('c', { id: 'c', amount: 300, status: 'paid' })
  return { db, vault }
}

async function readDump(bytes: Uint8Array): Promise<{
  collections: Record<string, Record<string, EncryptedEnvelope>>
}> {
  const { dumpJson } = await readNoydbBundle(bytes)
  return JSON.parse(dumpJson)
}

describe('writeNoydbBundle — where filter (#320)', () => {
  it('predicate true for all → bundle identical to no-filter', async () => {
    const { db, vault } = await setup()
    const baseline = await writeNoydbBundle(vault)
    const filtered = await writeNoydbBundle(vault, { where: () => true })
    const a = await readDump(baseline)
    const b = await readDump(filtered)
    expect(Object.keys(b.collections.invoices ?? {}).sort())
      .toEqual(Object.keys(a.collections.invoices ?? {}).sort())
    db.close()
  })

  it('predicate false for all → empty collection in bundle', async () => {
    const { db, vault } = await setup()
    const bytes = await writeNoydbBundle(vault, { where: () => false })
    const dump = await readDump(bytes)
    expect(Object.keys(dump.collections.invoices ?? {})).toEqual([])
    db.close()
  })

  it('selective predicate keeps only matching records', async () => {
    const { db, vault } = await setup()
    const bytes = await writeNoydbBundle(vault, {
      where: (record) => (record as Invoice).status === 'paid',
    })
    const dump = await readDump(bytes)
    expect(Object.keys(dump.collections.invoices ?? {}).sort()).toEqual(['b', 'c'])
    db.close()
  })

  it('predicate ctx exposes collection + id', async () => {
    const { db, vault } = await setup()
    const observed: Array<{ collection: string; id: string }> = []
    await writeNoydbBundle(vault, {
      where: (_record, ctx) => { observed.push(ctx); return true },
    })
    expect(observed.map((o) => o.collection)).toEqual(['invoices', 'invoices', 'invoices'])
    expect(observed.map((o) => o.id).sort()).toEqual(['a', 'b', 'c'])
    db.close()
  })

  it('async predicate is awaited', async () => {
    const { db, vault } = await setup()
    const bytes = await writeNoydbBundle(vault, {
      where: async (record) => {
        await new Promise((r) => setTimeout(r, 1))
        return (record as Invoice).amount >= 200
      },
    })
    const dump = await readDump(bytes)
    expect(Object.keys(dump.collections.invoices ?? {}).sort()).toEqual(['b', 'c'])
    db.close()
  })

  it('composes with collections allowlist', async () => {
    const { db, vault } = await setup()
    await vault.collection('payments').put('p', { id: 'p', amount: 999 })
    const bytes = await writeNoydbBundle(vault, {
      collections: ['invoices'],
      where: (record) => (record as Invoice).status === 'paid',
    })
    const dump = await readDump(bytes)
    expect(Object.keys(dump.collections.invoices ?? {}).sort()).toEqual(['b', 'c'])
    expect(dump.collections.payments).toBeUndefined()
    db.close()
  })

  it('survivors carry their ORIGINAL ciphertext (no re-encrypt)', async () => {
    const { db, vault } = await setup()
    const baseline = await readDump(await writeNoydbBundle(vault))
    const filtered = await readDump(await writeNoydbBundle(vault, {
      where: (record) => (record as Invoice).status === 'paid',
    }))
    // Surviving record 'b' should carry the byte-identical _iv + _data
    // from the baseline bundle — proves we kept the original envelope
    // rather than re-encrypting on output.
    expect(filtered.collections.invoices!.b!._iv).toBe(baseline.collections.invoices!.b!._iv)
    expect(filtered.collections.invoices!.b!._data).toBe(baseline.collections.invoices!.b!._data)
    db.close()
  })
})

describe('writeNoydbBundle — tierAtMost filter (#321)', () => {
  it('vault without tiers → option is a no-op', async () => {
    const { db, vault } = await setup()
    const baseline = await readDump(await writeNoydbBundle(vault))
    const filtered = await readDump(await writeNoydbBundle(vault, { tierAtMost: 2 }))
    expect(Object.keys(filtered.collections.invoices ?? {}).sort())
      .toEqual(Object.keys(baseline.collections.invoices ?? {}).sort())
    db.close()
  })

  // Note: hierarchical-tier vaults need the tier-config seam (separate
  // setup); the no-op-on-untiered path above is the contract this PR
  // establishes. Tier-aware coverage lands when the test fixture for
  // tiered vaults is plumbed (tracked alongside this issue).
})

describe('writeNoydbBundle — where + tierAtMost compose', () => {
  it('untiered vault: tierAtMost is a no-op, where still trims', async () => {
    const { db, vault } = await setup()
    const bytes = await writeNoydbBundle(vault, {
      tierAtMost: 1,
      where: (record) => (record as Invoice).amount >= 200,
    })
    const dump = await readDump(bytes)
    expect(Object.keys(dump.collections.invoices ?? {}).sort()).toEqual(['b', 'c'])
    db.close()
  })
})
