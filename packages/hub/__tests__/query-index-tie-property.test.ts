/**
 * #1369 — an index-served ordered page must be indistinguishable from the
 * scan it replaces after an ARBITRARY sequence of inserts, in-place updates
 * and deletes.
 *
 * This is deliberately a PROPERTY, not another example. #1344's tie tests
 * looked like coverage and could not see the defect they were nearest to,
 * because every record in them is inserted exactly once — and the only shape
 * that exposes it is an in-place update of a TIED record followed by an
 * ordered page. `SortedIndex.add()` minted a fresh `seq` on every insert
 * while `CollectionIndexes.upsert()` implemented an update as remove+add, so
 * the updated record drifted to the BACK of its tie run while the record
 * cache's `Map` kept it in its original slot.
 *
 * Two levels, both over BOTH index kinds (#1344 single-field, #1345 tuple):
 *   - unit: `CollectionIndexes.orderedIds`/`compoundOrderedIds` against a
 *     stable sort of the model, which is what `sortRecords()` is;
 *   - end-to-end: an indexed collection's `orderBy(...).limit(n)` page
 *     against the same page from an unindexed twin (the linear scan).
 */
import { describe, it, expect } from 'vitest'
import { CollectionIndexes } from '../src/with-lookup/indexing/eager-indexes.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withIndexing } from '../src/with-lookup/indexing/index.js'
import type { Noydb } from '../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'

/** Inline memory adapter — same pattern as `query-sorted-indexes.test.ts`. */
function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string): Map<string, EncryptedEnvelope> {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
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
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) {
        for (const [name, coll] of existing) if (name.startsWith('_')) comp.set(name, coll)
      }
      store.set(c, comp)
    },
  }
}

/** Deterministic PRNG — a property test that cannot be replayed is not evidence. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Row { id: string; status: string; amount: number }

type Op = { kind: 'put'; id: string; row: Row } | { kind: 'delete'; id: string }

/**
 * A random op sequence over a SMALL value domain, so ties are dense and
 * in-place updates (a `put` of an id already present) are frequent — the
 * two ingredients the example-based suites lacked.
 */
function opSequence(seed: number, length: number): Op[] {
  const next = rng(seed)
  const ids = Array.from({ length: 8 }, (_, i) => `r${i}`)
  const amounts = [10, 20, 30]
  const statuses = ['open', 'paid']
  const live = new Set<string>()
  const ops: Op[] = []
  for (let i = 0; i < length; i++) {
    const id = ids[Math.floor(next() * ids.length)]!
    if (live.has(id) && next() < 0.25) {
      live.delete(id)
      ops.push({ kind: 'delete', id })
      continue
    }
    live.add(id)
    ops.push({
      kind: 'put',
      id,
      row: {
        id,
        status: statuses[Math.floor(next() * statuses.length)]!,
        amount: amounts[Math.floor(next() * amounts.length)]!,
      },
    })
  }
  return ops
}

/** The model: a `Map` in the same insertion-order semantics the record cache has. */
function applyToModel(ops: readonly Op[]): Map<string, Row> {
  const model = new Map<string, Row>()
  for (const op of ops) {
    if (op.kind === 'delete') model.delete(op.id)
    else model.set(op.id, op.row)
  }
  return model
}

/** What `sortRecords()` is: a STABLE sort of the snapshot in cache order. */
function expectedOrder(model: Map<string, Row>, key: (r: Row) => number | string, direction: 'asc' | 'desc'): string[] {
  const rows = [...model.entries()]
  const cmp = (a: number | string, b: number | string): number => (a < b ? -1 : a > b ? 1 : 0)
  const sorted = rows
    .map((e, i) => ({ e, i }))
    .sort((x, y) => {
      const c = cmp(key(x.e[1]), key(y.e[1]))
      return (direction === 'asc' ? c : -c) || x.i - y.i
    })
  return sorted.map(s => s.e[0])
}

describe('#1369 — an index-served ordered page equals the scan, after ANY op sequence', () => {
  const seeds = Array.from({ length: 40 }, (_, i) => i + 1)

  it('property (unit): SortedIndex.orderedIds equals a stable sort of the model', () => {
    for (const seed of seeds) {
      const ops = opSequence(seed, 40)
      const idx = new CollectionIndexes()
      idx.declareSorted('amount')
      const live = new Map<string, Row>()
      for (const op of ops) {
        if (op.kind === 'delete') {
          const prev = live.get(op.id)
          if (prev) { idx.remove(op.id, prev); live.delete(op.id) }
        } else {
          idx.upsert(op.id, op.row, live.get(op.id) ?? null)
          live.set(op.id, op.row)
        }
      }
      for (const dir of ['asc', 'desc'] as const) {
        expect(idx.orderedIds('amount', dir), `seed ${seed} ${dir}`)
          .toEqual(expectedOrder(live, r => r.amount, dir))
      }
    }
  })

  it('property (unit): CompoundIndex.compoundOrderedIds equals a stable sort of the model', () => {
    for (const seed of seeds) {
      const ops = opSequence(seed, 40)
      const idx = new CollectionIndexes()
      idx.declareCompound(['status', 'amount'])
      const live = new Map<string, Row>()
      for (const op of ops) {
        if (op.kind === 'delete') {
          const prev = live.get(op.id)
          if (prev) { idx.remove(op.id, prev); live.delete(op.id) }
        } else {
          idx.upsert(op.id, op.row, live.get(op.id) ?? null)
          live.set(op.id, op.row)
        }
      }
      for (const status of ['open', 'paid']) {
        const subset = new Map([...live].filter(([, r]) => r.status === status))
        for (const dir of ['asc', 'desc'] as const) {
          expect(idx.compoundOrderedIds(['status', 'amount'], [status], dir), `seed ${seed} ${status} ${dir}`)
            .toEqual(expectedOrder(subset, r => r.amount, dir))
        }
      }
    }
  })

  it('property (end-to-end): an indexed orderBy().limit() page equals the unindexed scan', async () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const db: Noydb = await createNoydb({
        store: toMemory(),
        user: 'owner',
        secret: 'index-tie-property-secret-2026',
        indexingStrategy: withIndexing(),
      })
      const vault = await db.openVault('TEST')
      const indexed = vault.collection<Row>(`indexed-${seed}`, {
        indexes: [
          { fields: ['amount'], kind: 'sorted' },
          { fields: ['status', 'amount'], kind: 'sorted' },
        ],
      })
      const plain = vault.collection<Row>(`plain-${seed}`)

      for (const op of opSequence(seed, 30)) {
        if (op.kind === 'delete') {
          await indexed.delete(op.id)
          await plain.delete(op.id)
        } else {
          await indexed.put(op.id, op.row)
          await plain.put(op.id, op.row)
        }
      }

      const page = (c: typeof plain, dir: 'asc' | 'desc'): string[] =>
        c.query().orderBy('amount', dir).limit(4).toArray().map(r => r.id)
      const prefixPage = (c: typeof plain, dir: 'asc' | 'desc'): string[] =>
        c.query().where('status', '==', 'open').orderBy('amount', dir).limit(4).toArray().map(r => r.id)

      for (const dir of ['asc', 'desc'] as const) {
        expect(page(indexed, dir), `seed ${seed} single ${dir}`).toEqual(page(plain, dir))
        expect(prefixPage(indexed, dir), `seed ${seed} compound ${dir}`).toEqual(prefixPage(plain, dir))
      }
    }
  })
})
