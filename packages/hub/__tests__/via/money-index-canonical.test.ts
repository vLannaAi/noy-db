import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createNoydb, money } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
import { withIndexing } from '../../src/with-lookup/indexing/index.js'
import { CollectionIndexes } from '../../src/with-lookup/indexing/eager-indexes.js'

// #672 — the eager-index fast path used to bucket a fixed-mode money field
// by its RAW stored string (`stringifyKey`), so a legacy non-canonical
// value (e.g. '0100' written before the field's `money()` declaration) was
// invisible to a canonical probe ('100') while the BigInt-lenient scan
// (`evaluateMoneyClause`) still matched it — the fast path silently
// returned a subset for mixed-era data. This suite proves the fix: the
// index now buckets money keys through `ViaPipeline.canonicalizeIndexKey`
// (money's `moneyScaledValue`-based canonicalizer), so the fast path and
// the scan agree.

interface Item extends Record<string, unknown> {
  id: string
  amount: number | string
}

const itemSchema = z.object({ id: z.string(), amount: z.union([z.number(), z.string()]) })

const USER = 'alice'
const PASS = 'money-index-canonical-passphrase-2026'
const VAULT = 'books'
const COLL = 'items'

/** Shared memory adapter — persists across `createNoydb()` calls (simulates reopen). */
function persistentMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env) { gc(c, col).set(id, env) },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) }
    },
  }
}

/** Session 1: no money declared on 'items' — writes 'amount' as a raw, non-canonical string. */
async function seedLegacyRecord(adapter: NoydbStore): Promise<void> {
  const db = await createNoydb({ store: adapter, user: USER, secret: PASS })
  const vault = await db.openVault(VAULT)
  await vault.collection<Item>(COLL, { schema: itemSchema }).put('legacy', { id: 'legacy', amount: '0100' })
  db.close()
}

/** A fresh session declaring money(fixed) + an eager index on 'amount'. */
async function openMoneyIndexedSession(adapter: NoydbStore) {
  const db = await createNoydb({ store: adapter, user: USER, secret: PASS, indexStrategy: withIndexing() })
  const vault = await db.openVault(VAULT)
  const col = vault.collection<Item>(COLL, {
    schema: itemSchema,
    moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
    indexes: ['amount'],
  })
  return { db, col }
}

describe('money index-key canonicalization (#672)', () => {
  it('mixed-era fast path: a legacy non-canonical record and a canonical record both match == via the index', async () => {
    const adapter = persistentMemory()
    await seedLegacyRecord(adapter) // 'legacy' stored as raw, non-canonical '0100'

    const { db, col } = await openMoneyIndexedSession(adapter)
    // Write a second record THROUGH the money write path — lands canonical '100'.
    await col.put('canonical', { id: 'canonical', amount: 1 })

    const spy = vi.spyOn(CollectionIndexes.prototype, 'lookupEqual')
    try {
      const hit = col.query().where('amount', '==', 1).toArray()
      expect(hit.map((r) => r.id).sort()).toEqual(['canonical', 'legacy'])
      // Fast-path evidence: exactly one probe, against the canonical scaled key.
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith('amount', '100')
    } finally {
      spy.mockRestore()
    }
    db.close()
  })

  it('rebuild-on-hydrate canonicalizes: a fresh vault reopen re-derives the same canonical buckets', async () => {
    const adapter = persistentMemory()
    await seedLegacyRecord(adapter)
    {
      const { db, col } = await openMoneyIndexedSession(adapter)
      await col.put('canonical', { id: 'canonical', amount: 1 })
      db.close()
    }

    // Close/reopen the vault again — eager indexes rebuild fresh from the
    // hydrated cache on THIS session's first access, independent of the
    // previous session's in-memory state.
    const { db, col } = await openMoneyIndexedSession(adapter)
    // query()/.toArray() reads the in-memory cache synchronously — force
    // hydration (and the eager-index rebuild) via an awaited op first.
    await col.list()
    const spy = vi.spyOn(CollectionIndexes.prototype, 'lookupEqual')
    try {
      const hit = col.query().where('amount', '==', 1).toArray()
      expect(hit.map((r) => r.id).sort()).toEqual(['canonical', 'legacy'])
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith('amount', '100')
    } finally {
      spy.mockRestore()
    }
    db.close()
  })

  describe('scan parity across mixed-era stored shapes', () => {
    interface ShapeRecord extends Record<string, unknown> {
      id: string
      amount: unknown
    }
    const shapeSchema = z.object({ id: z.string(), amount: z.unknown() })
    const SHAPES_COLL = 'shapes'

    // Every shape is written BEFORE money is declared (raw, unquantized) —
    // exactly how mixed-era data accumulates in practice.
    const shapes: Record<string, unknown> = {
      'r-canonical': '100', // already canonical
      'r-legacy-zero': '0100', // legacy non-canonical (the #672 repro)
      'r-junk-space': ' 100', // whitespace — BigInt-tolerant on both paths
      'r-number': 100, // raw JS number, not the string form
      'r-nonnumeric': 'abc', // unparseable — must no-match on both paths
      'r-null': null, // never indexed (nor scan-matched) on either path
    }

    async function seedShapes(adapter: NoydbStore): Promise<void> {
      const db = await createNoydb({ store: adapter, user: USER, secret: PASS })
      const vault = await db.openVault(VAULT)
      const col = vault.collection<ShapeRecord>(SHAPES_COLL, { schema: shapeSchema })
      for (const [id, amount] of Object.entries(shapes)) {
        await col.put(id, { id, amount })
      }
      db.close()
    }

    async function openFastPath(adapter: NoydbStore) {
      const db = await createNoydb({ store: adapter, user: USER, secret: PASS, indexStrategy: withIndexing() })
      const vault = await db.openVault(VAULT)
      const col = vault.collection<ShapeRecord>(SHAPES_COLL, {
        schema: shapeSchema,
        moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
        indexes: ['amount'],
      })
      return { db, col }
    }

    /** Same money declaration, but no `indexStrategy` — `getIndexes()` returns null, forcing the scan. */
    async function openForcedScan(adapter: NoydbStore) {
      const db = await createNoydb({ store: adapter, user: USER, secret: PASS })
      const vault = await db.openVault(VAULT)
      const col = vault.collection<ShapeRecord>(SHAPES_COLL, {
        schema: shapeSchema,
        moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
      })
      return { db, col }
    }

    it('== and in agree between the fast path and a forced scan for every stored shape', async () => {
      const adapter = persistentMemory()
      await seedShapes(adapter)

      const { db: dbFast, col: colFast } = await openFastPath(adapter)
      const { db: dbScan, col: colScan } = await openForcedScan(adapter)
      // query()/.toArray() reads the in-memory cache synchronously — force
      // hydration (and the eager-index rebuild) via an awaited op first.
      await colFast.list()
      await colScan.list()

      const eqSpy = vi.spyOn(CollectionIndexes.prototype, 'lookupEqual')
      const inSpy = vi.spyOn(CollectionIndexes.prototype, 'lookupIn')
      try {
        const fastEq = colFast.query().where('amount', '==', 1).toArray().map((r) => r.id).sort()
        const scanEq = colScan.query().where('amount', '==', 1).toArray().map((r) => r.id).sort()
        expect(fastEq).toEqual(scanEq)
        expect(eqSpy).toHaveBeenCalled()
        // The #672 repro record must be present, and truly unparseable/absent
        // shapes must be consistently excluded on both paths.
        expect(fastEq).toContain('r-canonical')
        expect(fastEq).toContain('r-legacy-zero')
        expect(fastEq).not.toContain('r-nonnumeric')
        expect(fastEq).not.toContain('r-null')

        const fastIn = colFast.query().where('amount', 'in', [1, 2]).toArray().map((r) => r.id).sort()
        const scanIn = colScan.query().where('amount', 'in', [1, 2]).toArray().map((r) => r.id).sort()
        expect(fastIn).toEqual(scanIn)
        expect(inSpy).toHaveBeenCalled()
      } finally {
        eqSpy.mockRestore()
        inSpy.mockRestore()
      }
      dbFast.close()
      dbScan.close()
    })
  })
})
