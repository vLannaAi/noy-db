/**
 * Cross-compartment role-scoped queries — #63, v0.5.
 *
 * Coverage:
 *   1. **Enumeration** — owner with N compartments sees all N; minRole
 *      filter narrows correctly; wrong-passphrase compartments are
 *      silently dropped (existence-leak guarantee); compartments where
 *      the user has no keyring are silently dropped.
 *   2. **AdapterCapabilityError** — adapters that don't implement
 *      `listCompartments()` throw with a clear message naming the
 *      capability and the calling API.
 *   3. **queryAcross fan-out** — runs the callback against each
 *      compartment, preserves caller-supplied order, returns results
 *      tagged by compartment id.
 *   4. **Per-compartment errors** — one compartment's callback
 *      throwing does NOT abort the others; the error appears in that
 *      compartment's result slot.
 *   5. **Concurrency** — `concurrency: > 1` actually overlaps work
 *      (probed via timing of artificial delays); default `concurrency: 1`
 *      serializes.
 *   6. **Composition with exportStream()** — the canonical
 *      cross-compartment plaintext export pattern works end-to-end.
 *
 * The memory adapter is enriched with a custom `listCompartments`
 * implementation in the inline helper, plus a separate variant
 * without it to exercise the AdapterCapabilityError path.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbAdapter, EncryptedEnvelope, CompartmentSnapshot } from '../src/types.js'
import { ConflictError, AdapterCapabilityError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'

function memory(): NoydbAdapter {
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
      const comp = store.get(c); const s: CompartmentSnapshot = {}
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
    async listCompartments() {
      return [...store.keys()]
    },
  }
}

/** Memory adapter without listCompartments — for the AdapterCapabilityError test. */
function memoryWithoutEnumeration(): NoydbAdapter {
  const adapter = memory()
  delete (adapter as { listCompartments?: unknown }).listCompartments
  return adapter
}

interface Invoice { amount: number; month: string }

describe('cross-compartment queries — #63', () => {
  let adapter: NoydbAdapter
  let aliceDb: Noydb

  beforeEach(async () => {
    adapter = memory()
    aliceDb = await createNoydb({ adapter, user: 'alice', secret: 'alice-pass' })

    // alice owns three compartments: T1, T2, T7. Each has an `invoices`
    // collection with a couple of records keyed by month.
    for (const id of ['T1', 'T2', 'T7']) {
      const comp = await aliceDb.openCompartment(id)
      await comp.collection<Invoice>('invoices').put('inv-1', { amount: 100, month: '2026-03' })
      await comp.collection<Invoice>('invoices').put('inv-2', { amount: 200, month: '2026-04' })
    }
  })

  describe('listAccessibleCompartments', () => {
    it('returns every compartment alice can unwrap (default minRole)', async () => {
      const accessible = await aliceDb.listAccessibleCompartments()
      expect(accessible.map((c) => c.id).sort()).toEqual(['T1', 'T2', 'T7'])
      // alice opened all three with createNoydb, so she's owner of every one.
      expect(accessible.every((c) => c.role === 'owner')).toBe(true)
    })

    it('filters by minRole — admin keeps owner+admin only', async () => {
      // Add a fourth compartment where alice is granted as 'viewer'.
      const ownerDb = await createNoydb({ adapter, user: 'bob', secret: 'bob-pass' })
      await ownerDb.openCompartment('T-shared')
      await ownerDb.grant('T-shared', {
        userId: 'alice', displayName: 'Alice', role: 'viewer', passphrase: 'alice-pass',
      })

      const ownerOnly = await aliceDb.listAccessibleCompartments({ minRole: 'admin' })
      expect(ownerOnly.map((c) => c.id).sort()).toEqual(['T1', 'T2', 'T7'])

      const viewerAndUp = await aliceDb.listAccessibleCompartments({ minRole: 'viewer' })
      expect(viewerAndUp.map((c) => c.id).sort()).toEqual(['T-shared', 'T1', 'T2', 'T7'])
    })

    it('does not leak existence — compartments alice cannot unwrap are silently excluded', async () => {
      // Bob creates a private compartment alice has no keyring for.
      const bobDb = await createNoydb({ adapter, user: 'bob', secret: 'bob-pass' })
      const bobComp = await bobDb.openCompartment('bob-private')
      await bobComp.collection<{ secret: string }>('payments').put('p-1', { secret: 'classified' })

      // alice should still see only her three compartments — bob-private
      // is enumerated by the adapter but filtered out by core because
      // alice cannot load a keyring for it.
      const accessible = await aliceDb.listAccessibleCompartments()
      expect(accessible.map((c) => c.id).sort()).toEqual(['T1', 'T2', 'T7'])
      expect(accessible.find((c) => c.id === 'bob-private')).toBeUndefined()
    })

    it('does not leak via wrong-passphrase probe — InvalidKeyError is silently caught', async () => {
      // Create a compartment owned by bob, write a real record so bob's
      // keyring has at least one DEK to wrap (without this, the grant
      // produces a keyring file with `deks: {}` and loadKeyring trivially
      // succeeds with any passphrase because there's nothing to validate
      // — that empty-compartment edge case is a separate v0.4 hardening
      // item, documented in the listAccessibleCompartments JSDoc).
      const bobDb = await createNoydb({ adapter, user: 'bob', secret: 'bob-pass' })
      const bobComp = await bobDb.openCompartment('T-mismatched')
      await bobComp.collection<{ amount: number }>('payments').put('p-1', { amount: 50 })

      await bobDb.grant('T-mismatched', {
        userId: 'alice',
        displayName: 'Alice',
        role: 'admin',
        passphrase: 'a-totally-different-passphrase',
      })

      // alice's session passphrase is 'alice-pass' — that won't unwrap
      // the wrapped DEKs in her T-mismatched keyring file, so the
      // InvalidKeyError gets swallowed and the compartment is not in
      // the result.
      const accessible = await aliceDb.listAccessibleCompartments()
      expect(accessible.find((c) => c.id === 'T-mismatched')).toBeUndefined()
    })

    it('throws AdapterCapabilityError against adapters without listCompartments', async () => {
      const dumb = memoryWithoutEnumeration()
      const db = await createNoydb({ adapter: dumb, user: 'alice', secret: 'alice-pass' })
      await db.openCompartment('T1')

      await expect(db.listAccessibleCompartments()).rejects.toThrow(AdapterCapabilityError)
      await expect(db.listAccessibleCompartments()).rejects.toThrow(/listCompartments/)
      await expect(db.listAccessibleCompartments()).rejects.toThrow(/listAccessibleCompartments/)
    })

    it('AdapterCapabilityError exposes the missing capability for catch-block dispatch', async () => {
      const dumb = memoryWithoutEnumeration()
      const db = await createNoydb({ adapter: dumb, user: 'alice', secret: 'alice-pass' })
      try {
        await db.listAccessibleCompartments()
        expect.fail('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(AdapterCapabilityError)
        expect((err as AdapterCapabilityError).capability).toBe('listCompartments')
        expect((err as AdapterCapabilityError).code).toBe('ADAPTER_CAPABILITY')
      }
    })
  })

  describe('queryAcross', () => {
    it('runs the callback against every supplied compartment and tags results', async () => {
      const accessible = await aliceDb.listAccessibleCompartments()
      const results = await aliceDb.queryAcross(
        accessible.map((c) => c.id).sort(),
        async (comp) => {
          const invoices = await comp.collection<Invoice>('invoices').list()
          return invoices.length
        },
      )

      expect(results).toHaveLength(3)
      expect(results.map((r) => r.compartment).sort()).toEqual(['T1', 'T2', 'T7'])
      for (const r of results) {
        expect(r.error).toBeUndefined()
        expect(r.result).toBe(2) // each compartment seeded with 2 invoices
      }
    })

    it('preserves caller-supplied order regardless of completion order', async () => {
      // Seed each compartment with a per-compartment marker so the
      // callback can identify which compartment it's running in. The
      // marker doubles as the per-compartment artificial delay used
      // to force completion order to differ from input order.
      const ids = ['T1', 'T2', 'T7']
      const delays: Record<string, number> = { T1: 30, T2: 10, T7: 20 }
      for (const id of ids) {
        const comp = await aliceDb.openCompartment(id)
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
      expect(results.map((r) => r.compartment)).toEqual(ids)
      expect(results.map((r) => r.result)).toEqual(['T1', 'T2', 'T7'])
    })

    it('per-compartment errors do not abort other compartments', async () => {
      // Mark T2 as the compartment that should throw, leave T1 and T7
      // marked as "ok" — the callback dispatches on the marker.
      for (const id of ['T1', 'T2', 'T7']) {
        const comp = await aliceDb.openCompartment(id)
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
      const t1Result = results.find((r) => r.compartment === 'T1')!
      const t2Result = results.find((r) => r.compartment === 'T2')!
      const t7Result = results.find((r) => r.compartment === 'T7')!

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

    it('handles an empty compartment list cleanly', async () => {
      const results = await aliceDb.queryAcross([], async () => 'never-called')
      expect(results).toEqual([])
    })

    it('composes with exportStream() — cross-compartment plaintext export', async () => {
      const accessible = await aliceDb.listAccessibleCompartments({ minRole: 'admin' })
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
