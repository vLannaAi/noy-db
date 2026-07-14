import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createNoydb, money } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
import { withIndexing } from '../../src/with-lookup/indexing/index.js'
import { PersistedCollectionIndex } from '../../src/with-lookup/indexing/persisted-indexes.js'

// #677 — lazy twin of #672. The eager fix (`money-index-canonical.test.ts`)
// made `CollectionIndexes` bucket fixed-mode money keys through
// `ViaPipeline.canonicalizeIndexKey`, at every bucket-mutation site AND at
// the probe (via `candidateRecords()` resolving the probe value before
// `lookupEqual`/`lookupIn`). `PersistedCollectionIndex` (lazy mode) had
// NEITHER: it bucketed via its own raw `stringifyKey`, unconditionally, and
// `lazy-builder.ts` never consulted any via binding at all — a mixed-era
// lazy-mode collection had the same canonical-vs-raw bucket split #672
// fixed for eager, PLUS a probe that could never find even a canonical
// bucket by anything other than byte-identical luck.
//
// STEP 1 runtime-gap finding (recorded in the task report): before this
// fix, `lazyQuery().where('amount', '==', <any value>).toArray()` on a
// money field returns an EMPTY array — never a throw, never a correct
// result. Two independent reasons compound: (a) the bucket-write gap this
// file's Step 2 fixes, and (b) `LazyQuery`'s post-filter (`matchesAll`)
// re-evaluates every clause — including the index-driving one — against
// the DECODED record from `getRecord()`/`collection.get()` (which runs
// `via.present()`), using the GENERIC (non-via-aware) `evaluateClause`,
// so a money field's decoded decimal form ('1.00') never equality-matches
// a raw stored-space or major-unit query value. (b) is a real, separate,
// pre-existing gap — `LazyQuery.where()` never builds a `clause.via` the
// way `Query.where()`/`ScanBuilder.where()` do — outside #677's stated
// scope (thread `canonicalizeIndexKey` through the bucket + probe sites
// only) and outside this task's file/ceiling budget. It means: end-to-end
// `.toArray()` parity with the eager fix is only observable here when the
// money field's `scale` is 0 (decoded digit string == stored digit string,
// no decimal point inserted) AND the query value is passed in that same
// canonical digit-string form. The mixed-era / non-canonical-PROBE cases
// are verified at the index layer directly (spy on `lookupEqual`, and on
// which candidate ids the query fetches) — the correct place to observe a
// probe canonicalization fix whose benefit a separate bug (b) hides from
// the final decoded result. See `docs/subsystems/via-money.md` (Indexing)
// for the documented boundary.

interface Item extends Record<string, unknown> {
  id: string
  amount: number | string
}

const itemSchema = z.object({ id: z.string(), amount: z.union([z.number(), z.string()]) })

const USER = 'alice'
const PASS = 'money-index-canonical-lazy-passphrase-2026'
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
    // Native pagination, filtered to canonical (non-reserved-namespace) ids
    // only — `_idx/<field>/<id>` side-cars are not user records and would
    // otherwise fail `col.scan()`'s schema validation. Mirrors the
    // convention `with-lookup/indexing/collection-facade.ts`'s
    // `rebuildIndexes` applies when it walks a collection's id namespace.
    async listPage(c, col, cursor, limit = 100) {
      const coll = store.get(c)?.get(col)
      const ids = coll ? [...coll.keys()].filter((id) => !id.startsWith('_')).sort() : []
      const start = cursor ? parseInt(cursor, 10) : 0
      const end = Math.min(start + limit, ids.length)
      const items = ids.slice(start, end).map((id) => ({ id, envelope: coll!.get(id)! }))
      return { items, nextCursor: end < ids.length ? String(end) : null }
    },
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
async function seedLegacyRecord(adapter: NoydbStore, id: string, rawAmount: unknown): Promise<void> {
  const db = await createNoydb({ store: adapter, user: USER, secret: PASS })
  const vault = await db.openVault(VAULT)
  await vault.collection<Item>(COLL, { schema: itemSchema }).put(id, { id, amount: rawAmount } as Item)
  db.close()
}

/**
 * A fresh lazy-mode session declaring money(fixed, scale:0) + a persisted
 * index on 'amount'. `reconcileOnOpen: 'auto'` is REQUIRED for the
 * mixed-era scenarios below: unlike eager mode (whose `build()` always
 * rescans every canonical record on hydrate), a lazy-mode legacy record
 * written before `indexes: ['amount']` was declared has NO `_idx/amount/*`
 * side-car at all — it is invisible to `ensurePersistedIndexesLoaded()`'s
 * bulk-load (which only reads EXISTING side-cars) until a reconcile pass
 * backfills one via `maintainPersistedIndexesOnPut` (the same `upsert()`
 * mutation site the fix canonicalizes). This is the lazy-mode analogue of
 * eager's automatic rebuild-on-hydrate self-correction.
 */
async function openMoneyIndexedLazySession(adapter: NoydbStore) {
  const db = await createNoydb({ store: adapter, user: USER, secret: PASS, indexStrategy: withIndexing() })
  const vault = await db.openVault(VAULT)
  const col = vault.collection<Item>(COLL, {
    schema: itemSchema,
    prefetch: false,
    cache: { maxRecords: 100 },
    moneyFields: { amount: money({ currency: 'EUR', scale: 0 }) },
    indexes: ['amount'],
    reconcileOnOpen: 'auto',
  })
  return { db, col }
}

/** Drain a ScanBuilder (AsyncIterable) into an array of ids. */
async function scanIds<T extends { id: string }>(
  builder: AsyncIterable<T>,
): Promise<string[]> {
  const out: string[] = []
  for await (const r of builder) out.push(r.id)
  return out
}

describe('lazy-mode money index-key canonicalization + probe (#677)', () => {
  it('mixed-era fast path: a legacy non-canonical record and a canonical record both match == via the lazy index fast path', async () => {
    const adapter = persistentMemory()
    await seedLegacyRecord(adapter, 'legacy', '0001') // non-canonical: BigInt('0001') === 1n

    const { db, col } = await openMoneyIndexedLazySession(adapter)
    // Write a second record THROUGH the money write path — lands canonical '1' (scale:0).
    await col.put('canonical', { id: 'canonical', amount: 1 })

    const spy = vi.spyOn(PersistedCollectionIndex.prototype, 'lookupEqual')
    let hit: Item[]
    try {
      // scale:0 => decoded digit string === stored digit string === '1', so a
      // canonical-form query value round-trips through the post-filter too
      // (see the file-header note on the separate post-filter gap).
      hit = await col.lazyQuery().where('amount', '==', '1').toArray()
      expect(hit.map((r) => r.id).sort()).toEqual(['canonical', 'legacy'])
      // Fast-path evidence: exactly one probe, against the canonical key —
      // proves BOTH records' buckets collapsed to the same '1' key (bucket
      // fix) and that no scan/IndexRequiredError fallback occurred.
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith('amount', '1')
    } finally {
      spy.mockRestore()
    }

    // Scan parity: a forced full scan (money-aware `ScanBuilder.where()`,
    // major-unit operand) agrees with the fast path on the record SET.
    const scanned = await scanIds(col.scan({ pageSize: 10 }).where('amount', '==', 1))
    expect(scanned.sort()).toEqual(['canonical', 'legacy'])

    db.close()
  })

  it('rebuild-on-hydrate (ingest bulk-load) canonicalizes: a fresh session re-derives the same canonical buckets from side-cars alone', async () => {
    const adapter = persistentMemory()
    await seedLegacyRecord(adapter, 'legacy', '0001')
    {
      const { db, col } = await openMoneyIndexedLazySession(adapter)
      await col.put('canonical', { id: 'canonical', amount: 1 })
      db.close()
    }

    // Fresh session: the in-memory mirror is empty, so the first lazyQuery()
    // call bulk-loads `_idx/amount/*` side-cars via `ingest()` — the ONLY
    // mutation site exercised here (no incremental upsert/remove in this
    // session at all).
    const { db, col } = await openMoneyIndexedLazySession(adapter)
    const spy = vi.spyOn(PersistedCollectionIndex.prototype, 'lookupEqual')
    try {
      const hit = await col.lazyQuery().where('amount', '==', '1').toArray()
      expect(hit.map((r) => r.id).sort()).toEqual(['canonical', 'legacy'])
      expect(spy).toHaveBeenCalledWith('amount', '1')
    } finally {
      spy.mockRestore()
    }
    db.close()
  })

  // Bucket-mutation-dimension parity — every mutation site (ingest, upsert,
  // remove) must canonicalize, or a record can be stranded in a bucket the
  // opposite operation can never reach again.
  describe('mutation-dimension parity', () => {
    it('(a) update: mutating a legacy record clears its old canonical bucket', async () => {
      const adapter = persistentMemory()
      await seedLegacyRecord(adapter, 'legacy', '0001')

      const { db, col } = await openMoneyIndexedLazySession(adapter)
      // Force bulk-load (ingest+reconcile) first, so 'legacy' lands in the
      // canonicalized '1' bucket — then the update below must go through
      // `upsert()` -> `removeFromState()` on that SAME canonical key.
      const preHit = await col.lazyQuery().where('amount', '==', '1').toArray()
      expect(preHit.map((r) => r.id)).toEqual(['legacy']) // pins the ingest-side canonicalization this test depends on
      await col.put('legacy', { id: 'legacy', amount: 2 }) // update through the money write path

      const oldHit = await col.lazyQuery().where('amount', '==', '1').toArray()
      const newHit = await col.lazyQuery().where('amount', '==', '2').toArray()
      db.close()

      expect(oldHit.map((r) => r.id)).toEqual([]) // must NOT still return the stale-bucket 'legacy' id
      expect(newHit.map((r) => r.id)).toEqual(['legacy'])
    })

    it('(b) delete: deleting a legacy record clears it from the canonical bucket', async () => {
      const adapter = persistentMemory()
      await seedLegacyRecord(adapter, 'legacy', '0001')

      const { db, col } = await openMoneyIndexedLazySession(adapter)
      const preHit = await col.lazyQuery().where('amount', '==', '1').toArray() // ingest canonicalizes 'legacy' into bucket '1'
      expect(preHit.map((r) => r.id)).toEqual(['legacy'])
      await col.delete('legacy')

      const hit = await col.lazyQuery().where('amount', '==', '1').toArray()
      db.close()

      expect(hit.map((r) => r.id)).toEqual([])
    })

    it('(c) delete-then-recreate: reusing the same id with a different amount is not stranded in the old bucket', async () => {
      const adapter = persistentMemory()
      await seedLegacyRecord(adapter, 'legacy', '0001')

      const { db, col } = await openMoneyIndexedLazySession(adapter)
      const preHit = await col.lazyQuery().where('amount', '==', '1').toArray() // ingest canonicalizes 'legacy' into bucket '1'
      expect(preHit.map((r) => r.id)).toEqual(['legacy'])
      await col.delete('legacy')
      await col.put('legacy', { id: 'legacy', amount: 3 }) // recreate same id, different amount

      const oldHit = await col.lazyQuery().where('amount', '==', '1').toArray()
      const newHit = await col.lazyQuery().where('amount', '==', '3').toArray()
      db.close()

      expect(oldHit.map((r) => r.id)).toEqual([])
      expect(newHit.map((r) => r.id)).toEqual(['legacy'])
    })
  })

  // Probe-side canonicalization: proven at the INDEX layer directly. A
  // non-canonical PROBE value can only be observed to find the right
  // candidate BEFORE the (separate, undocumented-here) post-filter gap
  // would reject it on a raw-string mismatch — see the file-header note.
  describe('probe-side canonicalization (lazy-builder.ts resolveCandidateIds)', () => {
    it('a non-canonical probe value canonicalizes to the same bucket key a canonical write produced', async () => {
      const adapter = persistentMemory()
      await seedLegacyRecord(adapter, 'legacy', '0001') // stored raw; write-side fix buckets it under '1'

      const { db, col } = await openMoneyIndexedLazySession(adapter)
      const lookupSpy = vi.spyOn(PersistedCollectionIndex.prototype, 'lookupEqual')
      const getSpy = vi.spyOn(col, 'get')
      try {
        // '001' is a DIFFERENT non-canonical spelling of the same magnitude
        // (BigInt('001') === BigInt('0001') === 1n) — never byte-identical
        // to either the legacy stored form or the bucket-fix's own
        // normalization target, so this can only find 'legacy' if
        // `resolveCandidateIds()` canonicalizes the PROBE, not just if the
        // bucket-write fix ran.
        await col.lazyQuery().where('amount', '==', '001').toArray()
        // The lookup call itself proves the closure ran: the index was
        // probed with the CANONICAL key ('1'), not the raw clause value.
        expect(lookupSpy).toHaveBeenCalledWith('amount', '1')
        // And the candidate id set the index resolved from that
        // canonicalized probe included 'legacy' — i.e. the fast path found
        // the right record, independent of what the post-filter later does
        // with it.
        expect(getSpy.mock.calls.map((c) => c[0])).toContain('legacy')
      } finally {
        lookupSpy.mockRestore()
        getSpy.mockRestore()
      }
      db.close()
    })

    it('in: every non-canonical value in the array is canonicalized before lookupIn', async () => {
      const adapter = persistentMemory()
      await seedLegacyRecord(adapter, 'legacy', '0001')

      const { db, col } = await openMoneyIndexedLazySession(adapter)
      const lookupSpy = vi.spyOn(PersistedCollectionIndex.prototype, 'lookupIn')
      const getSpy = vi.spyOn(col, 'get')
      try {
        await col.lazyQuery().where('amount', 'in', ['001', '999']).toArray()
        expect(lookupSpy).toHaveBeenCalledWith('amount', ['1', '999'])
        expect(getSpy.mock.calls.map((c) => c[0])).toContain('legacy')
      } finally {
        lookupSpy.mockRestore()
        getSpy.mockRestore()
      }
      db.close()
    })
  })

  describe('scan parity across mixed-era stored shapes', () => {
    interface ShapeRecord extends Record<string, unknown> {
      id: string
      amount: unknown
    }
    const shapeSchema = z.object({ id: z.string(), amount: z.unknown() })

    const shapes: Record<string, unknown> = {
      'r-canonical': '1', // already canonical
      'r-legacy-zero': '0001', // legacy non-canonical (the #677 repro)
      'r-junk-space': ' 1', // whitespace — BigInt-tolerant on both paths
      'r-number': 1, // raw JS number, not the string form
      'r-nonnumeric': 'abc', // unparseable — must no-match on both paths
      'r-null': null, // never indexed (nor scan-matched) on either path
    }

    async function seedShapes(adapter: NoydbStore): Promise<void> {
      const db = await createNoydb({ store: adapter, user: USER, secret: PASS })
      const vault = await db.openVault(VAULT)
      const col = vault.collection<ShapeRecord>(COLL, { schema: shapeSchema })
      for (const [id, amount] of Object.entries(shapes)) {
        await col.put(id, { id, amount })
      }
      db.close()
    }

    /** Same session shape as `openMoneyIndexedLazySession`, but `amount: z.unknown()` — some shapes are null/garbage. */
    async function openShapesLazySession(adapter: NoydbStore) {
      const db = await createNoydb({ store: adapter, user: USER, secret: PASS, indexStrategy: withIndexing() })
      const vault = await db.openVault(VAULT)
      const col = vault.collection<ShapeRecord>(COLL, {
        schema: shapeSchema,
        prefetch: false,
        cache: { maxRecords: 100 },
        moneyFields: { amount: money({ currency: 'EUR', scale: 0 }) },
        indexes: ['amount'],
        reconcileOnOpen: 'auto',
      })
      return { db, col }
    }

    it('== agrees between the lazy fast path and a forced scan for every stored shape', async () => {
      const adapter = persistentMemory()
      await seedShapes(adapter)

      const { db, col } = await openShapesLazySession(adapter)
      const eqSpy = vi.spyOn(PersistedCollectionIndex.prototype, 'lookupEqual')
      let fastEq: string[]
      try {
        fastEq = (await col.lazyQuery().where('amount', '==', '1').toArray()).map((r) => r.id).sort()
        expect(eqSpy).toHaveBeenCalled()
      } finally {
        eqSpy.mockRestore()
      }
      const scanEq = (await scanIds(col.scan({ pageSize: 10 }).where('amount', '==', 1))).sort()

      expect(fastEq).toEqual(scanEq)
      expect(fastEq).toContain('r-canonical')
      expect(fastEq).toContain('r-legacy-zero')
      expect(fastEq).not.toContain('r-nonnumeric')
      expect(fastEq).not.toContain('r-null')
      db.close()
    })
  })
})
