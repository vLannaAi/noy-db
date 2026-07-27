import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createNoydb, money, FieldNotQueryableError } from '../../src/index.js'
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
const PASS = 'money-index-canonical-lazy-secret-2026'
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
  const db = await createNoydb({ store: adapter, user: USER, secret: PASS, indexingStrategy: withIndexing() })
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

      // Fence the upsert remove-old canonicalize site directly (#677 review F1):
      // `.toArray()` alone can't fully prove a stranded bucket was cleared —
      // post-#684, the post-filter is via-aware and would correctly reject a
      // stranded 'legacy' anyway (its raw amount is now 2, not 1) — so assert
      // on the CANDIDATE SET the index itself resolves for the old-value probe
      // (`lookupEqual`'s return value) rather than inferring it from fetch
      // calls (#684 moved the post-filter's raw fetch behind a private
      // `Collection#getRaw`, unobservable via `vi.spyOn(col, 'get')`).
      const lookupSpy = vi.spyOn(PersistedCollectionIndex.prototype, 'lookupEqual')
      const oldHit = await col.lazyQuery().where('amount', '==', '1').toArray()
      const oldCandidateIds = [...(lookupSpy.mock.results[0]?.value ?? [])]
      lookupSpy.mockClear()
      const newHit = await col.lazyQuery().where('amount', '==', '2').toArray()
      lookupSpy.mockRestore()
      db.close()

      expect(oldHit.map((r) => r.id)).toEqual([]) // must NOT still return the stale-bucket 'legacy' id
      expect(oldCandidateIds).not.toContain('legacy') // and must NOT linger in the old '1' bucket
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
        // with it. Asserted on `lookupEqual`'s own return value (#684 moved
        // the post-filter's raw fetch behind a private `Collection#getRaw`,
        // unobservable via `vi.spyOn(col, 'get')`).
        const candidateIds = [...(lookupSpy.mock.results[0]?.value ?? [])]
        expect(candidateIds).toContain('legacy')
      } finally {
        lookupSpy.mockRestore()
      }
      db.close()
    })

    it('in: every non-canonical value in the array is canonicalized before lookupIn', async () => {
      const adapter = persistentMemory()
      await seedLegacyRecord(adapter, 'legacy', '0001')

      const { db, col } = await openMoneyIndexedLazySession(adapter)
      const lookupSpy = vi.spyOn(PersistedCollectionIndex.prototype, 'lookupIn')
      try {
        await col.lazyQuery().where('amount', 'in', ['001', '999']).toArray()
        expect(lookupSpy).toHaveBeenCalledWith('amount', ['1', '999'])
        // Asserted on `lookupIn`'s own return value — see the `==` test
        // above for why (#684 moved the raw fetch behind a private method).
        const candidateIds = [...(lookupSpy.mock.results[0]?.value ?? [])]
        expect(candidateIds).toContain('legacy')
      } finally {
        lookupSpy.mockRestore()
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
      const db = await createNoydb({ store: adapter, user: USER, secret: PASS, indexingStrategy: withIndexing() })
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

// #684 — scale:2 (decode is NOT identity): `LazyQuery.where()` never built
// `clause.via`, so the post-filter ran the generic (non-Via-aware)
// `evaluateClause` against the DECODED record (`getRecord()`'s `via.
// present()` output). At `scale: 0` (the suite above) decode is the
// identity transform on the digit string, so the bug was invisible; at
// `scale > 0` decode inserts a decimal point (stored '100' -> decoded
// '1.00'), so EVERY lazy money query returned an empty `.toArray()`
// regardless of how the operand was spelled. This suite pins the fix: the
// post-filter now runs against the RAW (stored-form) record via a
// dedicated raw-fetch seam on `Collection`, `clause.via.evaluate` sees the
// same operand/actual-value space eager's `filterRecords` does, and only
// survivors are decoded (`present()`) on the way out.
describe('lazy-mode via-aware post-filter at scale > 0 (#684)', () => {
  /** scale:2 lazy session — decode is NOT identity (stored '100' <-> decoded '1.00'), the #684 repro precondition. */
  async function openMoneyIndexedLazySession2(adapter: NoydbStore) {
    const db = await createNoydb({ store: adapter, user: USER, secret: PASS, indexingStrategy: withIndexing() })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<Item>(COLL, {
      schema: itemSchema,
      prefetch: false,
      cache: { maxRecords: 100 },
      moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
      indexes: ['amount'],
      reconcileOnOpen: 'auto',
    })
    return { db, col }
  }

  /** Eager counterpart — same moneyFields, `prefetch: true` (default) — for the mandatory eager-vs-lazy parity assertion. */
  async function openMoneyIndexedEagerSession2(adapter: NoydbStore) {
    const db = await createNoydb({ store: adapter, user: USER, secret: PASS, indexingStrategy: withIndexing() })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<Item>(COLL, {
      schema: itemSchema,
      moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
      indexes: ['amount'],
    })
    return { db, col }
  }

  /**
   * amount:1 -> stored '100', 2 -> '200', 3 -> '300' (scale:2 quantization).
   * Written through a PLAIN money session (moneyFields, but no
   * `indexingStrategy`/`indexes`) so the adapter ends up holding only the three
   * canonical `Item` records — no `_idx/*` side-cars. That leaves the
   * adapter safe to layer EITHER a lazy-indexed or an eager-indexed read
   * session on top afterward (a lazy-indexed WRITE session would persist
   * `_idx/amount/*` side-cars that an eager `ensureHydrated()` read on the
   * same collection can't schema-validate as `Item` records).
   */
  async function seedDataset(adapter: NoydbStore): Promise<void> {
    const db = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<Item>(COLL, {
      schema: itemSchema,
      moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
    })
    await col.put('r1', { id: 'r1', amount: 1 })
    await col.put('r2', { id: 'r2', amount: 2 })
    await col.put('r3', { id: 'r3', amount: 3 })
    db.close()
  }

  it('== matches the 1.00 row for equivalent major-unit operand spellings, probing the canonical stored-form index key', async () => {
    const adapter = persistentMemory()
    await seedDataset(adapter)

    const { db, col } = await openMoneyIndexedLazySession2(adapter)
    const lookupSpy = vi.spyOn(PersistedCollectionIndex.prototype, 'lookupEqual')
    let byNumber: Item[]
    let byMajorString: Item[]
    try {
      byNumber = await col.lazyQuery().where('amount', '==', 1).toArray()
      byMajorString = await col.lazyQuery().where('amount', '==', '1.00').toArray()
      // Both equivalent major-unit spellings resolve to the SAME canonical
      // STORED-form probe key ('100' — amount 1 quantized at scale 2),
      // proving `clause.via.indexValue` (not the raw operand) drives the
      // fast path.
      expect(lookupSpy).toHaveBeenCalledWith('amount', '100')
    } finally {
      lookupSpy.mockRestore()
    }
    db.close()

    // Pre-#684 both returned [] (post-filter compared the DECODED '1.00'
    // record against the raw scaled-int operand and never matched).
    expect(byNumber.map((r) => r.id)).toEqual(['r1'])
    expect(byMajorString.map((r) => r.id)).toEqual(['r1'])
  })

  it('in returns every matching row', async () => {
    const adapter = persistentMemory()
    await seedDataset(adapter)

    const { db, col } = await openMoneyIndexedLazySession2(adapter)
    const hit = await col.lazyQuery().where('amount', 'in', [1, 2]).toArray()
    db.close()

    // Pre-#684 this returned [].
    expect(hit.map((r) => r.id).sort()).toEqual(['r1', 'r2'])
  })

  it('range (> and between) post-filter in scaled-int space, not the raw typed stored value', async () => {
    const adapter = persistentMemory()
    await seedDataset(adapter)

    const { db, col } = await openMoneyIndexedLazySession2(adapter)
    const gt = await col.lazyQuery().where('amount', '>', 1).toArray()
    const between = await col.lazyQuery().where('amount', 'between', [1, 3]).toArray()
    db.close()

    // Pre-#684 both returned [] — and even pre-#677/#684, `resolveCandidateIds`
    // sent every range op through `lookupRange`'s raw/typed comparison
    // unconditionally (no scan fallback), which is simply the wrong space
    // for a money field's scaled-int stored form.
    expect(gt.map((r) => r.id).sort()).toEqual(['r2', 'r3'])
    expect(between.map((r) => r.id).sort()).toEqual(['r1', 'r2', 'r3'])
  })

  // MANDATORY parity: lazy must agree with eager (and a forced scan) on the
  // result-id SET for every op — the real #684 regression guard, since at
  // scale:0 (the suite above) eager and lazy could agree by accident
  // (decode is identity there, so the post-filter bug was masked).
  it('eager, lazy, and scan agree on the result-id set for ==, in, >, and between', async () => {
    const adapter = persistentMemory()
    await seedDataset(adapter)

    // Open + hydrate EAGER first, before the lazy session's `reconcileOnOpen:
    // 'auto'` gets a chance to persist `_idx/amount/*` side-cars into the
    // SAME adapter (see `seedDataset`'s doc comment — eager's
    // `ensureHydrated()` can't schema-validate those as `Item` records).
    // query()/.toArray() reads the in-memory cache synchronously — force
    // hydration (and the eager-index build) via an awaited op first (same
    // requirement as the eager suite in money-index-canonical.test.ts).
    const { db: dbEager, col: colEager } = await openMoneyIndexedEagerSession2(adapter)
    await colEager.list()

    const { db: dbLazy, col: colLazy } = await openMoneyIndexedLazySession2(adapter)

    const cases: ReadonlyArray<{ op: '==' | 'in' | '>' | 'between'; value: unknown }> = [
      { op: '==', value: 1 },
      { op: 'in', value: [1, 2] },
      { op: '>', value: 1 },
      { op: 'between', value: [1, 3] },
    ]

    for (const { op, value } of cases) {
      const lazyIds = (await colLazy.lazyQuery().where('amount', op, value).toArray()).map((r) => r.id).sort()
      const eagerIds = colEager.query().where('amount', op, value).toArray().map((r) => r.id).sort()
      const scannedIds = (await scanIds(colLazy.scan({ pageSize: 10 }).where('amount', op, value))).sort()
      expect(lazyIds).toEqual(eagerIds)
      expect(scannedIds).toEqual(lazyIds)
    }

    dbLazy.close()
    dbEager.close()
  })
})

// #684 review-fix 1 — `LazyQuery.where()` was missing the
// `queryable: 'none'` posture guard the eager builders apply at `.where()`
// time (`kernel/query/builder.ts:289`, `kernel/query/scan-builder.ts:182`):
// `if (via?.postureFor(field)?.queryable === 'none') throw new
// FieldNotQueryableError(field)`. Without it, `lazyQuery().where(<blob
// field>, ...)` built a bare (non-via) clause and only failed later, from
// `toArray()`, as a deferred `IndexRequiredError` — the wrong error class,
// at the wrong call site. Blob fields (`blobFields`) are the existing
// `queryable: 'none'` fixture (see `via/query-posture-b.test.ts`'s #629
// Task 8 suite, which pins the SAME assertion for `query()`/`scan()`).
describe('lazy-mode queryable:"none" posture guard (#684 review-fix 1 — parity with query()/scan())', () => {
  interface Doc extends Record<string, unknown> { id: string; title: string; receipt: string }
  const docSchema = z.object({ id: z.string(), title: z.string(), receipt: z.string() })

  async function blobLazySession(adapter: NoydbStore) {
    const db = await createNoydb({
      store: adapter, user: 'alice', secret: 'blob-lazy-posture-secret-2026',
      indexingStrategy: withIndexing(),
    })
    const vault = await db.openVault('docs-vault')
    const col = vault.collection<Doc>('docs', {
      schema: docSchema,
      prefetch: false,
      cache: { maxRecords: 100 },
      blobFields: { receipt: {} },
      // `title` (not `receipt`) satisfies lazyQuery()'s "at least one
      // indexed field" precondition — the posture guard must fire from
      // `.where()` itself, before `toArray()`'s index-coverage check ever
      // runs, so `receipt` need not be indexed for this test to be valid.
      indexes: ['title'],
    })
    await col.put('d1', { id: 'd1', title: 'x', receipt: 'unused-placeholder' })
    return { db, col }
  }

  it('where(blobField) throws FieldNotQueryableError at .where() time (not a deferred IndexRequiredError from toArray())', async () => {
    const adapter = persistentMemory()
    const { db, col } = await blobLazySession(adapter)
    expect(() => col.lazyQuery().where('receipt', '==', 'x')).toThrow(FieldNotQueryableError)
    db.close()
  })

  it('a non-blob (indexed) field on the same collection is unaffected', async () => {
    const adapter = persistentMemory()
    const { db, col } = await blobLazySession(adapter)
    const hit = await col.lazyQuery().where('title', '==', 'x').toArray()
    expect(hit.map((r) => r.id)).toEqual(['d1'])
    db.close()
  })
})

// #684 review-fix 2 — a sole `==`/`in` clause on a multi-MODE
// money field (`money({ currencies: [...] })`) has `clause.via.indexValue
// === undefined` (`moneyIndexProbe` only ever probes fixed-mode: no single
// stored-form value the hash index can serve for a per-record-currency
// field). Before this fix, `resolveCandidateIds()` treated that as "no
// driver" and `continue`d past the clause entirely, so `toArray()` threw
// `IndexRequiredError` — where eager's `candidateRecords()`
// (`builder.ts:1176`) instead falls back to a full scan and returns the
// correct rows. The fix mirrors the RANGE branch immediately above it in
// `resolveCandidateIds()` (already handling the identical "no sound
// bucket" case): enumerate the field's full indexed id set via
// `orderedBy()` as the candidate superset, and let the (already via-aware,
// #684) post-filter in `toArray()` decide.
describe('lazy-mode multi-currency money == / in (#684 review-fix 2 — parity with query(), not IndexRequiredError)', () => {
  interface Payment extends Record<string, unknown> { id: string; amount: unknown }
  const paymentSchema = z.object({ id: z.string(), amount: z.unknown() })

  async function seedMultiCurrency(adapter: NoydbStore): Promise<void> {
    const db = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<Payment>('payments', {
      schema: paymentSchema,
      moneyFields: { amount: money({ currencies: ['EUR', 'USD'] }) },
    })
    await col.put('e1', { id: 'e1', amount: { amount: 100, currency: 'EUR' } })
    await col.put('e2', { id: 'e2', amount: { amount: 250, currency: 'EUR' } })
    await col.put('u1', { id: 'u1', amount: { amount: 100, currency: 'USD' } })
    db.close()
  }

  async function openMultiCurrencyLazySession(adapter: NoydbStore) {
    const db = await createNoydb({ store: adapter, user: USER, secret: PASS, indexingStrategy: withIndexing() })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<Payment>('payments', {
      schema: paymentSchema,
      prefetch: false,
      cache: { maxRecords: 100 },
      moneyFields: { amount: money({ currencies: ['EUR', 'USD'] }) },
      indexes: ['amount'],
      reconcileOnOpen: 'auto',
    })
    return { db, col }
  }

  async function openMultiCurrencyEagerSession(adapter: NoydbStore) {
    const db = await createNoydb({ store: adapter, user: USER, secret: PASS, indexingStrategy: withIndexing() })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<Payment>('payments', {
      schema: paymentSchema,
      moneyFields: { amount: money({ currencies: ['EUR', 'USD'] }) },
      indexes: ['amount'],
    })
    return { db, col }
  }

  it('== returns the matching row via the orderedBy candidate superset, not a lookupEqual bucket probe', async () => {
    const adapter = persistentMemory()
    await seedMultiCurrency(adapter)

    const { db, col } = await openMultiCurrencyLazySession(adapter)
    const eqSpy = vi.spyOn(PersistedCollectionIndex.prototype, 'lookupEqual')
    const orderedSpy = vi.spyOn(PersistedCollectionIndex.prototype, 'orderedBy')
    let hit: Payment[]
    try {
      hit = await col.lazyQuery().where('amount', '==', { amount: 100, currency: 'EUR' }).toArray()
      // Pre-fix: this threw IndexRequiredError instead of returning here.
      expect(hit.map((r) => r.id)).toEqual(['e1'])
      // Multi-mode never has a sound bucket key — the fast path must NOT
      // probe lookupEqual for this clause; it must fall back to orderedBy.
      expect(eqSpy).not.toHaveBeenCalled()
      expect(orderedSpy).toHaveBeenCalledWith('amount', 'asc')
    } finally {
      eqSpy.mockRestore()
      orderedSpy.mockRestore()
    }
    db.close()
  })

  it("'in' returns every matching row via the orderedBy candidate superset", async () => {
    const adapter = persistentMemory()
    await seedMultiCurrency(adapter)

    const { db, col } = await openMultiCurrencyLazySession(adapter)
    const inSpy = vi.spyOn(PersistedCollectionIndex.prototype, 'lookupIn')
    let hit: Payment[]
    try {
      hit = await col.lazyQuery().where('amount', 'in', [
        { amount: 100, currency: 'EUR' },
        { amount: 250, currency: 'EUR' },
      ]).toArray()
      expect(hit.map((r) => r.id).sort()).toEqual(['e1', 'e2'])
      expect(inSpy).not.toHaveBeenCalled()
    } finally {
      inSpy.mockRestore()
    }
    db.close()
  })

  // MANDATORY parity: lazy must agree with eager on the result-id set —
  // the real FIX 2 regression guard.
  it('eager and lazy agree on the result-id set for == and in', async () => {
    const adapter = persistentMemory()
    await seedMultiCurrency(adapter)

    const { db: dbEager, col: colEager } = await openMultiCurrencyEagerSession(adapter)
    await colEager.list() // force hydration, same requirement as the scale:2 suite above

    const { db: dbLazy, col: colLazy } = await openMultiCurrencyLazySession(adapter)

    const cases: ReadonlyArray<{ op: '==' | 'in'; value: unknown }> = [
      { op: '==', value: { amount: 100, currency: 'EUR' } },
      { op: 'in', value: [{ amount: 100, currency: 'EUR' }, { amount: 250, currency: 'EUR' }] },
    ]

    for (const { op, value } of cases) {
      const lazyIds = (await colLazy.lazyQuery().where('amount', op, value).toArray()).map((r) => r.id).sort()
      const eagerIds = colEager.query().where('amount', op, value).toArray().map((r) => r.id).sort()
      expect(lazyIds).toEqual(eagerIds)
    }

    dbLazy.close()
    dbEager.close()
  })
})

// #695 — `LazyQuery.toArray()` decoded every survivor BEFORE sorting, then
// sorted the DECODED records with the generic (non-Via-aware) comparator.
// At scale:2, money's decoded form is a decimal string ('1.00'), so `orderBy`
// ordered money lexicographically ('10.00' < '2.00'), diverging from eager's
// `sortRecords(result, plan.orderBy, source.via, labelMaps)` in
// `kernel/query/builder.ts`, which sorts the RAW (stored-form) records
// via-aware (`via.compareForOrder`) and decodes only afterward. The fix
// mirrors that: sort RAW survivors via-aware, slice offset/limit, decode
// only the returned page.
describe('lazy-mode orderBy is Via-aware (#695)', () => {
  /** scale:2 lazy session — decode is NOT identity, same #684 repro precondition. */
  async function openLazySession(adapter: NoydbStore) {
    const db = await createNoydb({ store: adapter, user: USER, secret: PASS, indexingStrategy: withIndexing() })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<Item>(COLL, {
      schema: itemSchema,
      prefetch: false,
      cache: { maxRecords: 100 },
      moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
      indexes: ['amount'],
      reconcileOnOpen: 'auto',
    })
    return { db, col }
  }

  /** Eager counterpart — same moneyFields/indexes, for the mandatory eager-vs-lazy order parity assertion. */
  async function openEagerSession(adapter: NoydbStore) {
    const db = await createNoydb({ store: adapter, user: USER, secret: PASS, indexingStrategy: withIndexing() })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<Item>(COLL, {
      schema: itemSchema,
      moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
      indexes: ['amount'],
    })
    return { db, col }
  }

  /**
   * amount 1 -> stored '100', 2 -> '200', 10 -> '1000' (scale:2 quantization).
   * Written through a PLAIN money session (no `indexingStrategy`) so the adapter
   * holds only the three canonical `Item` records — same reasoning as
   * `seedDataset` in the #684 suite above (keeps the adapter safe to layer
   * either a lazy-indexed or an eager-indexed read session on top).
   */
  async function seedDataset(adapter: NoydbStore): Promise<void> {
    const db = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<Item>(COLL, {
      schema: itemSchema,
      moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
    })
    await col.put('r1', { id: 'r1', amount: 1 })
    await col.put('r2', { id: 'r2', amount: 2 })
    await col.put('r10', { id: 'r10', amount: 10 })
    db.close()
  }

  it('orderBy asc sorts money numerically, not lexicographically', async () => {
    const adapter = persistentMemory()
    await seedDataset(adapter)

    const { db, col } = await openLazySession(adapter)
    const rows = await col.lazyQuery().orderBy('amount', 'asc').toArray()
    db.close()

    // Pre-#695: the DECODED decimal strings ('1.00', '2.00', '10.00') sorted
    // lexicographically -> ['r1', 'r10', 'r2']. Numeric order is r1, r2, r10.
    expect(rows.map((r) => r.id)).toEqual(['r1', 'r2', 'r10'])
  })

  it('orderBy desc sorts money numerically', async () => {
    const adapter = persistentMemory()
    await seedDataset(adapter)

    const { db, col } = await openLazySession(adapter)
    const rows = await col.lazyQuery().orderBy('amount', 'desc').toArray()
    db.close()

    expect(rows.map((r) => r.id)).toEqual(['r10', 'r2', 'r1'])
  })

  // MANDATORY parity: lazy must agree with eager on the ORDER (not just the
  // result-id set) — the real #695 regression guard.
  it('eager and lazy agree on order, asc and desc', async () => {
    const adapter = persistentMemory()
    await seedDataset(adapter)

    // Open + hydrate EAGER first, before the lazy session's `reconcileOnOpen:
    // 'auto'` gets a chance to persist `_idx/amount/*` side-cars into the
    // SAME adapter (same ordering requirement as the #684 parity test above).
    const { db: dbEager, col: colEager } = await openEagerSession(adapter)
    await colEager.list() // force hydration

    const { db: dbLazy, col: colLazy } = await openLazySession(adapter)

    const ascLazy = (await colLazy.lazyQuery().orderBy('amount', 'asc').toArray()).map((r) => r.id)
    const ascEager = colEager.query().orderBy('amount', 'asc').toArray().map((r) => r.id)
    const descLazy = (await colLazy.lazyQuery().orderBy('amount', 'desc').toArray()).map((r) => r.id)
    const descEager = colEager.query().orderBy('amount', 'desc').toArray().map((r) => r.id)

    dbLazy.close()
    dbEager.close()

    expect(ascLazy).toEqual(ascEager)
    expect(descLazy).toEqual(descEager)
  })
})

// #696 — `resolveCandidateIds()`'s composite fast path builds `eqMap` from
// RAW `clause.value` (the major-unit operand, e.g. `1`) and probes
// `idx.lookupEqual(def.key, tuple)`. The composite mirror buckets on
// `stringifyKey(tuple)` — the per-field money canonicalizer
// (`ViaPipeline.canonicalizeIndexKey`) only ever keys off a SINGLE field
// name, never the joined composite key (`'amount|tag'`), so a composite that
// covers a money field never lands the write-side bucket and the raw-operand
// tuple never matches it: `lookupEqual` returns an empty (but non-null) Set,
// so the fast path returns `[]` instead of falling back. The fix skips the
// composite fast path when any covered `==` clause is Via-covered, falling
// through to the already-Via-aware single-field path below it.
describe('lazy-mode composite-index == skips the fast path for Via-covered fields (#696)', () => {
  interface Row extends Record<string, unknown> {
    id: string
    amount: number | string
    tag: string
  }
  const rowSchema = z.object({ id: z.string(), amount: z.union([z.number(), z.string()]), tag: z.string() })

  /** scale:2 lazy session — single index on 'amount' (required for the single-field fallback) PLUS a composite over ['amount', 'tag']. */
  async function openLazySession(adapter: NoydbStore) {
    const db = await createNoydb({ store: adapter, user: USER, secret: PASS, indexingStrategy: withIndexing() })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<Row>(COLL, {
      schema: rowSchema,
      prefetch: false,
      cache: { maxRecords: 100 },
      moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
      indexes: ['amount', ['amount', 'tag']],
      reconcileOnOpen: 'auto',
    })
    return { db, col }
  }

  /** Eager counterpart — same moneyFields/indexes, for the mandatory eager-vs-lazy parity assertion. */
  async function openEagerSession(adapter: NoydbStore) {
    const db = await createNoydb({ store: adapter, user: USER, secret: PASS, indexingStrategy: withIndexing() })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<Row>(COLL, {
      schema: rowSchema,
      moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
      indexes: ['amount', ['amount', 'tag']],
    })
    return { db, col }
  }

  async function seedDataset(adapter: NoydbStore): Promise<void> {
    const db = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<Row>(COLL, {
      schema: rowSchema,
      moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
    })
    await col.put('r1', { id: 'r1', amount: 1, tag: 'x' })
    await col.put('r2', { id: 'r2', amount: 1, tag: 'y' })
    await col.put('r3', { id: 'r3', amount: 2, tag: 'x' })
    db.close()
  }

  it('== + == on a composite covering a money field falls through to the single-field Via-aware path', async () => {
    const adapter = persistentMemory()
    await seedDataset(adapter)

    const { db, col } = await openLazySession(adapter)
    const hit = await col.lazyQuery().where('amount', '==', 1).where('tag', '==', 'x').toArray()
    db.close()

    // Pre-#696: the composite fast path probed a tuple built from the RAW
    // major-unit operand (`1`) against buckets keyed on the raw stored
    // value, canonicalized under a field name ('amount|tag') the money
    // binding never covers — the probe missed and this returned [].
    expect(hit.map((r) => r.id)).toEqual(['r1'])
  })

  // MANDATORY parity: lazy must agree with eager on the result-id set — the
  // real #696 regression guard.
  it('eager and lazy agree on the result-id set', async () => {
    const adapter = persistentMemory()
    await seedDataset(adapter)

    // Open + hydrate EAGER first, before the lazy session's `reconcileOnOpen:
    // 'auto'` gets a chance to persist `_idx/*` side-cars into the SAME
    // adapter (same ordering requirement as the suites above).
    const { db: dbEager, col: colEager } = await openEagerSession(adapter)
    await colEager.list() // force hydration

    const { db: dbLazy, col: colLazy } = await openLazySession(adapter)

    const lazyIds = (await colLazy.lazyQuery().where('amount', '==', 1).where('tag', '==', 'x').toArray())
      .map((r) => r.id).sort()
    const eagerIds = colEager.query().where('amount', '==', 1).where('tag', '==', 'x').toArray()
      .map((r) => r.id).sort()

    dbLazy.close()
    dbEager.close()

    expect(lazyIds).toEqual(eagerIds)
  })
})

// #698 — a composite-ONLY lazy declaration (`indexes: [['amount', 'tag']]`,
// no standalone `'amount'` entry) declared only the composite mirror in
// `declareAll` (`with-lookup/indexing/active.ts`). After #696 made the
// composite `==` fast path skip Via-covered (money) fields and fall through
// to the single-field Via-aware path, that fallback had no driver — the
// field was never `declare()`d singly — so `resolveCandidateIds()` returned
// null and `toArray()` threw `IndexRequiredError` where eager (which always
// decomposes a composite into its component single-field indexes, see the
// eager branch in `withIndexing()`) returns results. The fix decomposes a
// composite into its component single-field indexes on declare, like eager,
// keeping the composite mirror for the multi-field fast path.
describe('lazy-mode composite-ONLY declaration decomposes into component singles (#698)', () => {
  interface Row extends Record<string, unknown> {
    id: string
    amount: number | string
    tag: string
  }
  const rowSchema = z.object({ id: z.string(), amount: z.union([z.number(), z.string()]), tag: z.string() })

  /** scale:2 lazy session — COMPOSITE-ONLY over ['amount', 'tag']; no standalone 'amount' index entry. */
  async function openCompositeOnlyLazySession(adapter: NoydbStore) {
    const db = await createNoydb({ store: adapter, user: USER, secret: PASS, indexingStrategy: withIndexing() })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<Row>(COLL, {
      schema: rowSchema,
      prefetch: false,
      cache: { maxRecords: 100 },
      moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
      indexes: [['amount', 'tag']],
      reconcileOnOpen: 'auto',
    })
    return { db, col }
  }

  /** Eager counterpart — same moneyFields, same composite-only declaration, for the mandatory eager-parity assertion. */
  async function openCompositeOnlyEagerSession(adapter: NoydbStore) {
    const db = await createNoydb({ store: adapter, user: USER, secret: PASS, indexingStrategy: withIndexing() })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<Row>(COLL, {
      schema: rowSchema,
      moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
      indexes: [['amount', 'tag']],
    })
    return { db, col }
  }

  async function seedDataset(adapter: NoydbStore): Promise<void> {
    const db = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<Row>(COLL, {
      schema: rowSchema,
      moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
    })
    await col.put('r1', { id: 'r1', amount: 1, tag: 'x' })
    await col.put('r2', { id: 'r2', amount: 1, tag: 'y' })
    await col.put('r3', { id: 'r3', amount: 2, tag: 'x' })
    db.close()
  }

  it('composite-only + money, double == returns the correct row (was IndexRequiredError), matching eager', async () => {
    const adapter = persistentMemory()
    await seedDataset(adapter)

    const { db: dbEager, col: colEager } = await openCompositeOnlyEagerSession(adapter)
    await colEager.list() // force eager hydration

    const { db: dbLazy, col: colLazy } = await openCompositeOnlyLazySession(adapter)

    // Pre-#698: the composite fast path skips this Via-covered clause (#696)
    // and falls through to the single-field path — but 'amount' was never
    // declared singly (composite-only declaration), so `resolveCandidateIds`
    // returned null and this threw IndexRequiredError.
    const lazyHit = await colLazy.lazyQuery().where('amount', '==', 1).where('tag', '==', 'x').toArray()
    const eagerHit = colEager.query().where('amount', '==', 1).where('tag', '==', 'x').toArray()

    dbLazy.close()
    dbEager.close()

    expect(lazyHit.map((r) => r.id)).toEqual(['r1'])
    expect(lazyHit.map((r) => r.id).sort()).toEqual(eagerHit.map((r) => r.id).sort())
  })

  it('composite-only + single-field query on the covered money field returns the right rows (was IndexRequiredError)', async () => {
    const adapter = persistentMemory()
    await seedDataset(adapter)

    const { db: dbEager, col: colEager } = await openCompositeOnlyEagerSession(adapter)
    await colEager.list() // force eager hydration

    const { db: dbLazy, col: colLazy } = await openCompositeOnlyLazySession(adapter)

    // Pre-#698: 'amount' has no single-field driver on a composite-only
    // declaration, so this single-clause query threw IndexRequiredError.
    const lazyHit = await colLazy.lazyQuery().where('amount', '==', 1).toArray()
    const eagerHit = colEager.query().where('amount', '==', 1).toArray()

    dbLazy.close()
    dbEager.close()

    expect(lazyHit.map((r) => r.id).sort()).toEqual(['r1', 'r2'])
    expect(lazyHit.map((r) => r.id).sort()).toEqual(eagerHit.map((r) => r.id).sort())
  })
})
