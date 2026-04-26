/**
 * Cross-vault role-scoped queries — #63, v0.5.
 *
 * Coverage:
 *   1. **Enumeration** — owner with N compartments sees all N; minRole
 *      filter narrows correctly; wrong-passphrase compartments are
 *      silently dropped (existence-leak guarantee); compartments where
 *      the user has no keyring are silently dropped.
 *   2. **StoreCapabilityError** — adapters that don't implement
 *      `listVaults()` throw with a clear message naming the
 *      capability and the calling API.
 *   3. **queryAcross fan-out** — runs the callback against each
 *      vault, preserves caller-supplied order, returns results
 *      tagged by vault id.
 *   4. **Per-vault errors** — one compartment's callback
 *      throwing does NOT abort the others; the error appears in that
 *      compartment's result slot.
 *   5. **Concurrency** — `concurrency: > 1` actually overlaps work
 *      (probed via timing of artificial delays); default `concurrency: 1`
 *      serializes.
 *   6. **Composition with exportStream()** — the canonical
 *      cross-vault plaintext export pattern works end-to-end.
 *
 * The memory adapter is enriched with a custom `listVaults`
 * implementation in the inline helper, plus a separate variant
 * without it to exercise the StoreCapabilityError path.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError, StoreCapabilityError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
    // v0.5 #63: enumeration capability
    async listVaults() {
      return [...store.keys()]
    },
  }
}

/** Memory adapter without listVaults — for the StoreCapabilityError test. */
function memoryWithoutEnumeration(): NoydbStore {
  const adapter = memory()
  delete (adapter as { listVaults?: unknown }).listVaults
  return adapter
}

interface Invoice { amount: number; month: string }

describe('cross-vault queries — #63', () => {
  let adapter: NoydbStore
  let aliceDb: Noydb

  beforeEach(async () => {
    adapter = memory()
    aliceDb = await createNoydb({ store: adapter, user: 'alice', secret: 'alice-pass' })

    // alice owns three compartments: T1, T2, T7. Each has an `invoices`
    // collection with a couple of records keyed by month.
    for (const id of ['T1', 'T2', 'T7']) {
      const comp = await aliceDb.openVault(id)
      await comp.collection<Invoice>('invoices').put('inv-1', { amount: 100, month: '2026-03' })
      await comp.collection<Invoice>('invoices').put('inv-2', { amount: 200, month: '2026-04' })
    }
  })

  describe('listAccessibleVaults', () => {
    it('returns every vault alice can unwrap (default minRole)', async () => {
      const accessible = await aliceDb.listAccessibleVaults()
      expect(accessible.map((c) => c.id).sort()).toEqual(['T1', 'T2', 'T7'])
      // alice opened all three with createNoydb, so she's owner of every one.
      expect(accessible.every((c) => c.role === 'owner')).toBe(true)
    })

    it('filters by minRole — admin keeps owner+admin only', async () => {
      // Add a fourth vault where alice is granted as 'viewer'.
      const ownerDb = await createNoydb({ store: adapter, user: 'bob', secret: 'bob-pass' })
      await ownerDb.openVault('T-shared')
      await ownerDb.grant('T-shared', {
        userId: 'alice', displayName: 'Alice', role: 'viewer', passphrase: 'alice-pass',
      })

      const ownerOnly = await aliceDb.listAccessibleVaults({ minRole: 'admin' })
      expect(ownerOnly.map((c) => c.id).sort()).toEqual(['T1', 'T2', 'T7'])

      const viewerAndUp = await aliceDb.listAccessibleVaults({ minRole: 'viewer' })
      expect(viewerAndUp.map((c) => c.id).sort()).toEqual(['T-shared', 'T1', 'T2', 'T7'])
    })

    it('does not leak existence — compartments alice cannot unwrap are silently excluded', async () => {
      // Bob creates a private vault alice has no keyring for.
      const bobDb = await createNoydb({ store: adapter, user: 'bob', secret: 'bob-pass' })
      const bobComp = await bobDb.openVault('bob-private')
      await bobComp.collection<{ secret: string }>('payments').put('p-1', { secret: 'classified' })

      // alice should still see only her three compartments — bob-private
      // is enumerated by the adapter but filtered out by core because
      // alice cannot load a keyring for it.
      const accessible = await aliceDb.listAccessibleVaults()
      expect(accessible.map((c) => c.id).sort()).toEqual(['T1', 'T2', 'T7'])
      expect(accessible.find((c) => c.id === 'bob-private')).toBeUndefined()
    })

    it('does not leak via wrong-passphrase probe — InvalidKeyError is silently caught', async () => {
      // Create a vault owned by bob, write a real record so bob's
      // keyring has at least one DEK to wrap (without this, the grant
      // produces a keyring file with `deks: {}` and loadKeyring trivially
      // succeeds with any passphrase because there's nothing to validate
      // — that empty-vault edge case is a separate v0.4 hardening
      // item, documented in the listAccessibleVaults JSDoc).
      const bobDb = await createNoydb({ store: adapter, user: 'bob', secret: 'bob-pass' })
      const bobComp = await bobDb.openVault('T-mismatched')
      await bobComp.collection<{ amount: number }>('payments').put('p-1', { amount: 50 })

      await bobDb.grant('T-mismatched', {
        userId: 'alice',
        displayName: 'Alice',
        role: 'admin',
        passphrase: 'a-totally-different-passphrase',
      })

      // alice's session passphrase is 'alice-pass' — that won't unwrap
      // the wrapped DEKs in her T-mismatched keyring file, so the
      // InvalidKeyError gets swallowed and the vault is not in
      // the result.
      const accessible = await aliceDb.listAccessibleVaults()
      expect(accessible.find((c) => c.id === 'T-mismatched')).toBeUndefined()
    })

    it('throws StoreCapabilityError against adapters without listVaults', async () => {
      const dumb = memoryWithoutEnumeration()
      const db = await createNoydb({ store: dumb, user: 'alice', secret: 'alice-pass' })
      await db.openVault('T1')

      await expect(db.listAccessibleVaults()).rejects.toThrow(StoreCapabilityError)
      await expect(db.listAccessibleVaults()).rejects.toThrow(/listVaults/)
      await expect(db.listAccessibleVaults()).rejects.toThrow(/listAccessibleVaults/)
    })

    it('StoreCapabilityError exposes the missing capability for catch-block dispatch', async () => {
      const dumb = memoryWithoutEnumeration()
      const db = await createNoydb({ store: dumb, user: 'alice', secret: 'alice-pass' })
      try {
        await db.listAccessibleVaults()
        expect.fail('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(StoreCapabilityError)
        expect((err as StoreCapabilityError).capability).toBe('listVaults')
        expect((err as StoreCapabilityError).code).toBe('STORE_CAPABILITY')
      }
    })
  })

  describe('queryAcross', () => {
    it('runs the callback against every supplied vault and tags results', async () => {
      const accessible = await aliceDb.listAccessibleVaults()
      const results = await aliceDb.queryAcross(
        accessible.map((c) => c.id).sort(),
        async (comp) => {
          const invoices = await comp.collection<Invoice>('invoices').list()
          return invoices.length
        },
      )

      expect(results).toHaveLength(3)
      expect(results.map((r) => r.vault).sort()).toEqual(['T1', 'T2', 'T7'])
      for (const r of results) {
        expect(r.error).toBeUndefined()
        expect(r.result).toBe(2) // each vault seeded with 2 invoices
      }
    })

    it('preserves caller-supplied order regardless of completion order', async () => {
      // Seed each vault with a per-vault marker so the
      // callback can identify which vault it's running in. The
      // marker doubles as the per-vault artificial delay used
      // to force completion order to differ from input order.
      const ids = ['T1', 'T2', 'T7']
      const delays: Record<string, number> = { T1: 30, T2: 10, T7: 20 }
      for (const id of ids) {
        const comp = await aliceDb.openVault(id)
        await comp.collection<{ name: string }>('marker').put('id', { name: id })
      }

      const results = await aliceDb.queryAcross(
        ids,
        async (comp) => {
          const marker = await comp.collection<{ name: string }>('marker').get('id')
          await new Promise((r) => setTimeout(r, delays[marker?.name ?? '']))
          return marker?.name
        },
        { concurrency: 3 },
      )

      // Result order matches input order — even though T2 (10ms)
      // finishes first and T1 (30ms) finishes last under concurrency 3.
      expect(results.map((r) => r.vault)).toEqual(ids)
      expect(results.map((r) => r.result)).toEqual(['T1', 'T2', 'T7'])
    })

    it('per-vault errors do not abort other compartments', async () => {
      // Mark T2 as the vault that should throw, leave T1 and T7
      // marked as "ok" — the callback dispatches on the marker.
      for (const id of ['T1', 'T2', 'T7']) {
        const comp = await aliceDb.openVault(id)
        await comp.collection<{ kind: string }>('marker').put('id', {
          kind: id === 'T2' ? 'fail' : 'ok',
        })
      }

      const results = await aliceDb.queryAcross(
        ['T1', 'T2', 'T7'],
        async (comp) => {
          const m = await comp.collection<{ kind: string }>('marker').get('id')
          if (m?.kind === 'fail') throw new Error('intentional failure')
          return 'ok'
        },
      )

      expect(results).toHaveLength(3)
      const t1Result = results.find((r) => r.vault === 'T1')!
      const t2Result = results.find((r) => r.vault === 'T2')!
      const t7Result = results.find((r) => r.vault === 'T7')!

      expect(t1Result.result).toBe('ok')
      expect(t1Result.error).toBeUndefined()

      expect(t7Result.result).toBe('ok')
      expect(t7Result.error).toBeUndefined()

      // T2 captured the error per-slot — neither aborts the others
      // nor surfaces as a top-level rejection.
      expect(t2Result.result).toBeUndefined()
      expect(t2Result.error).toBeInstanceOf(Error)
      expect(t2Result.error?.message).toBe('intentional failure')
    })

    it('concurrency > 1 overlaps work; concurrency 1 serializes', async () => {
      const ids = ['T1', 'T2', 'T7']

      // With concurrency 1 and 30ms per call, total ≈ 90ms.
      // With concurrency 3 and 30ms per call, total ≈ 30ms.
      const startSerial = Date.now()
      await aliceDb.queryAcross(
        ids,
        async () => { await new Promise((r) => setTimeout(r, 30)); return null },
        { concurrency: 1 },
      )
      const serialMs = Date.now() - startSerial

      const startParallel = Date.now()
      await aliceDb.queryAcross(
        ids,
        async () => { await new Promise((r) => setTimeout(r, 30)); return null },
        { concurrency: 3 },
      )
      const parallelMs = Date.now() - startParallel

      // Generous bounds — CI machines vary. The point is that
      // parallel is meaningfully faster than serial, not exact timing.
      expect(serialMs).toBeGreaterThanOrEqual(80)
      expect(parallelMs).toBeLessThan(serialMs)
    })

    it('handles an empty vault list cleanly', async () => {
      const results = await aliceDb.queryAcross([], async () => 'never-called')
      expect(results).toEqual([])
    })

    it('composes with exportStream() — cross-vault plaintext export', async () => {
      const accessible = await aliceDb.listAccessibleVaults({ minRole: 'admin' })
      const exports = await aliceDb.queryAcross(
        accessible.map((c) => c.id).sort(),
        async (comp) => {
          const collections: string[] = []
          for await (const chunk of comp.exportStream()) {
            collections.push(chunk.collection)
          }
          return collections
        },
      )
      expect(exports).toHaveLength(3)
      for (const e of exports) {
        expect(e.error).toBeUndefined()
        expect(e.result).toContain('invoices')
      }
    })
  })
})
