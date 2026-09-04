/**
 * Cross-vault role-scoped queries., v0.5.
 *
 * Coverage:
 *   1. **Enumeration** — owner with N compartments sees all N; minRole
 *      filter narrows correctly; wrong-secret compartments are
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
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, StoreCapabilityError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import type { Noydb } from '../src/kernel/noydb.js'
import { withTeam } from '../src/with-party/team/index.js'

function toMemory(): NoydbStore {
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
    // v0.5: enumeration capability
    async listVaults() {
      return [...store.keys()]
    },
  }
}

/** Memory adapter without listVaults — for the StoreCapabilityError test. */
function memoryWithoutEnumeration(): NoydbStore {
  const adapter = toMemory()
  delete (adapter as { listVaults?: unknown }).listVaults
  return adapter
}

interface Invoice { amount: number; month: string }

describe('cross-vault queries.', () => {
  let adapter: NoydbStore
  let aliceDb: Noydb

  beforeEach(async () => {
    adapter = toMemory()
    aliceDb = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'alice', secret: 'alice-pass' })

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
      const ownerDb = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'bob', secret: 'bob-pass' })
      await ownerDb.openVault('T-shared')
      await ownerDb.grant('T-shared', {
        userId: 'alice', displayName: 'Alice', role: 'viewer', secret: 'alice-pass',
      })

      const ownerOnly = await aliceDb.listAccessibleVaults({ minRole: 'admin' })
      expect(ownerOnly.map((c) => c.id).sort()).toEqual(['T1', 'T2', 'T7'])

      const viewerAndUp = await aliceDb.listAccessibleVaults({ minRole: 'viewer' })
      expect(viewerAndUp.map((c) => c.id).sort()).toEqual(['T-shared', 'T1', 'T2', 'T7'])
    })

    it('does not leak existence — compartments alice cannot unwrap are silently excluded', async () => {
      // Bob creates a private vault alice has no keyring for.
      const bobDb = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'bob', secret: 'bob-pass' })
      const bobComp = await bobDb.openVault('bob-private')
      await bobComp.collection<{ secret: string }>('payments').put('p-1', { secret: 'classified' })

      // alice should still see only her three compartments — bob-private
      // is enumerated by the adapter but filtered out by core because
      // alice cannot load a keyring for it.
      const accessible = await aliceDb.listAccessibleVaults()
      expect(accessible.map((c) => c.id).sort()).toEqual(['T1', 'T2', 'T7'])
      expect(accessible.find((c) => c.id === 'bob-private')).toBeUndefined()
    })

    it('does not leak via wrong-secret probe — InvalidKeyError is silently caught', async () => {
      // Create a vault owned by bob, write a real record so bob's
      // keyring has at least one DEK to wrap (without this, the grant
      // produces a keyring file with `deks: {}` and loadKeyring trivially
      // succeeds with any secret because there's nothing to validate
      // — that empty-vault edge case is a separate v0.4 hardening
      // item, documented in the listAccessibleVaults JSDoc).
      const bobDb = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'bob', secret: 'bob-pass' })
      const bobComp = await bobDb.openVault('T-mismatched')
      await bobComp.collection<{ amount: number }>('payments').put('p-1', { amount: 50 })

      await bobDb.grant('T-mismatched', {
        userId: 'alice',
        displayName: 'Alice',
        role: 'admin',
        secret: 'a-totally-different-secret',
      })

      // alice's session secret is 'alice-pass' — that won't unwrap
      // the wrapped DEKs in her T-mismatched keyring file, so the
      // InvalidKeyError gets swallowed and the vault is not in
      // the result.
      const accessible = await aliceDb.listAccessibleVaults()
      expect(accessible.find((c) => c.id === 'T-mismatched')).toBeUndefined()
    })

    it('issue #82 follow-up: a partially-corrupted vault is silently skipped, not surfaced as KeyringCorruptError', async () => {
      // Without this, `listAccessibleVaults()` would throw the moment it
      // hit the corrupted vault, and the caller would not be able to
      // enumerate ANY of their healthy vaults — a single corruption would
      // poison the whole list.
      // Surgically corrupt one wrapped DEK in T2's _keyring/alice envelope
      // so loadKeyring throws KeyringCorruptError (mixed-success path).
      const env = await adapter.get('T2', '_keyring', 'alice')
      const file = JSON.parse(env!._data) as { deks: Record<string, string> }
      const collNames = Object.keys(file.deks).filter((n) => !n.startsWith('_'))
      const victim = collNames[0]!
      const original = file.deks[victim]!
      file.deks[victim] = Buffer.from(new Uint8Array(original.length).fill(0))
        .toString('base64')
        .slice(0, original.length)
      await adapter.put('T2', '_keyring', 'alice', { ...env!, _data: JSON.stringify(file) })

      // Enumeration must succeed and include T1 + T7. T2 is silently dropped.
      const accessible = await aliceDb.listAccessibleVaults()
      expect(accessible.map((c) => c.id).sort()).toEqual(['T1', 'T7'])
      expect(accessible.find((c) => c.id === 'T2')).toBeUndefined()
    })

    it('throws StoreCapabilityError against adapters without listVaults', async () => {
      const dumb = memoryWithoutEnumeration()
      const db = await createNoydb({ teamStrategy: withTeam(), store: dumb, user: 'alice', secret: 'alice-pass' })
      await db.openVault('T1')

      await expect(db.listAccessibleVaults()).rejects.toThrow(StoreCapabilityError)
      await expect(db.listAccessibleVaults()).rejects.toThrow(/listVaults/)
      await expect(db.listAccessibleVaults()).rejects.toThrow(/listAccessibleVaults/)
    })

    it('StoreCapabilityError exposes the missing capability for catch-block dispatch', async () => {
      const dumb = memoryWithoutEnumeration()
      const db = await createNoydb({ teamStrategy: withTeam(), store: dumb, user: 'alice', secret: 'alice-pass' })
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

      // The claim is about OVERLAP, so measure overlap directly — peak
      // in-flight count — instead of inferring it from elapsed wall clock.
      // The old shape compared two real durations (3 x 30ms serial vs ~30ms
      // parallel) and could invert on a loaded box with no bug present
      // (#1382 class). Peak concurrency is machine-speed independent.
      /**
       * `expectedOverlap` workers hold their slot open until that many are in
       * flight together, then all are released — so the test blocks only for
       * an overlap the configured concurrency can actually deliver, and never
       * deadlocks.
       */
      function probe(expectedOverlap: number) {
        let inFlight = 0
        let peak = 0
        const waiters: (() => void)[] = []
        return {
          peak: () => peak,
          fn: async () => {
            inFlight++
            peak = Math.max(peak, inFlight)
            if (inFlight >= expectedOverlap) {
              for (const release of waiters.splice(0)) release()
            } else {
              // The escape hatch exists only for the BROKEN path: if the
              // overlap never materialises, fail on the assertion below
              // rather than hanging until the suite timeout. A working
              // implementation releases on the peer's arrival immediately,
              // so this timer is never reached.
              await new Promise<void>((r) => {
                waiters.push(r)
                const escape = setTimeout(r, 2_000)
                waiters.push(() => clearTimeout(escape))
              })
            }
            inFlight--
            return null
          },
        }
      }

      const serial = probe(1)
      await aliceDb.queryAcross(ids, serial.fn, { concurrency: 1 })
      expect(serial.peak()).toBe(1) // serialized: never two at once

      const parallel = probe(2)
      await aliceDb.queryAcross(ids, parallel.fn, { concurrency: 3 })
      expect(parallel.peak()).toBeGreaterThan(1) // genuinely overlapped
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
