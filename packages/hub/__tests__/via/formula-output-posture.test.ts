/**
 * #642 Task 2 — enforcement: formula outputs derived from classified-bearing
 * collections become sealed/non-exportable, for BOTH target shapes:
 *
 *  - Shape A: a derivation/MV/overlay OUTPUT collection ('*' target) — the
 *    collection-level `defaultPosture` fallback (`ViaTaintOverlay.defaultPosture`,
 *    `postureFor`'s O(1) fallback, `taintBinding`'s `sealAllFields` mode).
 *  - Shape B: a rollup TARGET (a REAL field on the parent) — inherits the
 *    folded posture automatically through the EXISTING field-specific taint
 *    overlay (Task 1's graph fold + the unmodified per-field path).
 *
 * Three surfaces per shape: at-rest sealing (`_sealed` + SealedHandle), query
 * refusal (FieldNotQueryableError), export redaction ('[sealed]'). Plus the
 * cross-collection re-apply ordering gap (seam map finding 4/10): the folded
 * posture must still apply even when the dependent (output/parent) collection
 * was opened BEFORE the classified source ever registered its field.
 *
 * Ground truth: docs/superpowers/specs/2026-07-12-via-consolidation-design.md
 * §1; .superpowers/sdd/seam-map-consolidation.md PART 1 (esp. 1b/1c/1f) + PART 5.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withDerivation, withRollup, FieldNotQueryableError, SealedHandle } from '../../src/index.js'
import { withClassified } from '../../src/via/classified/index.js'
import type { ClassifiedFieldSpec } from '../../src/via/classified/index.js'
import { inlineMemory, spyStore } from '../classified/harness.js'
import { reapplyDependentOverlays } from '../../src/kernel/via/graph-wiring.js'

const ssnSpec = (): ClassifiedFieldSpec => ({
  _noydbClassified: true, preset: 'test-ssn', storage: 'recoverable',
  list: { kind: 'omit' }, sensitivity: 'secret',
})

interface Person extends Record<string, unknown> { id: string; name: string; ssn: string }
interface Leak extends Record<string, unknown> { ssnCopy?: string }

function leakDerivation() {
  return withDerivation<Person, { leak: { ssnCopy: string } }>({
    source: 'people',
    deterministic: true,
    outputs: { leak: { shape: 'record', collection: 'leaks' } },
    derive: (s) => ({ leak: { ssnCopy: s.ssn } }),
    lifecycle: 'eager',
  })
}

interface Sale extends Record<string, unknown> { id: string; buyerId: string; amount: number; ssn: string }
interface Buyer extends Record<string, unknown> { id: string; companyName: string; total?: number }

function totalRollup() {
  return withRollup<Sale, Buyer>({
    from: 'sales', key: 'buyerId', into: 'buyers', field: 'total',
    compute: (sales) => sales.reduce((t, s) => t + (typeof s.amount === 'number' ? s.amount : 0), 0),
  })
}

describe('#642 Task 2 — Shape A: derivation OUTPUT collection ("*" target) inherits the source fold', () => {
  async function setup(secret: string) {
    const store = inlineMemory()
    const db = await createNoydb({
      store, user: 'a', secret,
      classifiedStrategy: withClassified(),
      derivationStrategies: [leakDerivation()],
    })
    const v = await db.openVault('v1')
    // Natural ordering: source opened (and its classified field registered)
    // BEFORE the output collection — no ordering-gap hook needed here.
    const people = v.collection<Person>('people', { classifiedFields: { ssn: ssnSpec() } })
    const leaks = v.collection<Leak>('leaks')
    await people.put('p1', { id: 'p1', name: 'Alice', ssn: '123-45-6789' })
    return { db, v, people, leaks, store }
  }

  it('at-rest: the copied field seals into `_sealed`; get() returns a SealedHandle', async () => {
    const { leaks, store } = await setup('formula-posture-a-1')
    const rec = await leaks.get('p1')
    expect(rec?.ssnCopy).toBeInstanceOf(SealedHandle)
    const envelope = store._dump('v1', 'leaks', 'p1')
    expect(envelope).toBeDefined()
    expect(envelope!._sealed?.ssnCopy).toMatch(/^.+:.+$/)
    // `_derivedFrom` (reserved/internal metadata) is never swept into sealAllFields.
    expect(envelope!._sealed?._derivedFrom).toBeUndefined()
  })

  it('query: .where() on the copied field refuses (FieldNotQueryableError) per the honest clamp', async () => {
    const { leaks } = await setup('formula-posture-a-2')
    expect(() => leaks.query().where('ssnCopy', '==', '123-45-6789')).toThrow(FieldNotQueryableError)
  })

  it('export: exportJSON()/exportStream() redact the copied field to [sealed]', async () => {
    const { v } = await setup('formula-posture-a-3')
    const json = await v.exportJSON()
    const parsed = JSON.parse(json) as { collections: Record<string, { records: Array<Record<string, unknown>> }> }
    expect(parsed.collections.leaks!.records[0]!.ssnCopy).toBe('[sealed]')

    const chunks: { collection: string; records: unknown[] }[] = []
    for await (const chunk of v.exportStream()) chunks.push(chunk)
    const leaksChunk = chunks.find((ch) => ch.collection === 'leaks')!
    const serialized = JSON.parse(JSON.stringify(leaksChunk.records)) as Array<Record<string, unknown>>
    expect(serialized[0]!.ssnCopy).toBe('[sealed]')
  })
})

describe('#642 Task 2 — Shape B: rollup TARGET (real field) inherits the source fold (verifying "automatic")', () => {
  async function setup(secret: string) {
    const store = inlineMemory()
    const db = await createNoydb({
      store, user: 'a', secret,
      classifiedStrategy: withClassified(),
      derivationStrategies: [totalRollup()],
    })
    const v = await db.openVault('v1')
    // Natural ordering: child (source, classified) opened BEFORE the parent
    // (rollup target) — the automatic path Task 1's fold is supposed to feed
    // straight into the EXISTING field-specific taint overlay, unmodified.
    const sales = v.collection<Sale>('sales', { classifiedFields: { ssn: ssnSpec() } })
    const buyers = v.collection<Buyer>('buyers')
    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', amount: 100, ssn: '123-45-6789' })
    return { db, v, buyers, sales, store }
  }

  it('at-rest: the rollup field seals into `_sealed`; get() returns a SealedHandle', async () => {
    const { buyers, store } = await setup('formula-posture-b-1')
    const rec = await buyers.get('b1')
    expect(rec?.total).toBeInstanceOf(SealedHandle)
    const envelope = store._dump('v1', 'buyers', 'b1')
    expect(envelope).toBeDefined()
    expect(envelope!._sealed?.total).toMatch(/^.+:.+$/)
  })

  it('query: .where() on the rollup field refuses (FieldNotQueryableError)', async () => {
    const { buyers } = await setup('formula-posture-b-2')
    expect(() => buyers.query().where('total', '==', 100)).toThrow(FieldNotQueryableError)
  })

  it('export: exportJSON() redacts the rollup field to [sealed]', async () => {
    const { v } = await setup('formula-posture-b-3')
    const json = await v.exportJSON()
    const parsed = JSON.parse(json) as { collections: Record<string, { records: Array<Record<string, unknown>> }> }
    expect(parsed.collections.buyers!.records[0]!.total).toBe('[sealed]')
  })
})

describe('#642 Task 2 — cross-collection re-apply ordering gap (seam map finding 4/10)', () => {
  it('Shape A: OUTPUT opened BEFORE the classified SOURCE still seals once the source registers + writes', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store, user: 'a', secret: 'formula-posture-order-a',
      classifiedStrategy: withClassified(),
      derivationStrategies: [leakDerivation()],
    })
    const v = await db.openVault('v1')
    const leaks = v.collection<Leak>('leaks') // opened FIRST — no classified field registered yet anywhere
    const people = v.collection<Person>('people', { classifiedFields: { ssn: ssnSpec() } }) // opened SECOND
    await people.put('p1', { id: 'p1', name: 'Alice', ssn: '123-45-6789' })

    const rec = await leaks.get('p1')
    expect(rec?.ssnCopy).toBeInstanceOf(SealedHandle)
    const envelope = store._dump('v1', 'leaks', 'p1')
    expect(envelope).toBeDefined()
    expect(envelope!._sealed?.ssnCopy).toMatch(/^.+:.+$/)
    expect(() => leaks.query().where('ssnCopy', '==', '123-45-6789')).toThrow(FieldNotQueryableError)
  })

  it('Shape B: rollup PARENT opened BEFORE the classified child still seals once the child registers + writes', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store, user: 'a', secret: 'formula-posture-order-b',
      classifiedStrategy: withClassified(),
      derivationStrategies: [totalRollup()],
    })
    const v = await db.openVault('v1')
    const buyers = v.collection<Buyer>('buyers') // opened FIRST — 'sales' not registered yet
    const sales = v.collection<Sale>('sales', { classifiedFields: { ssn: ssnSpec() } }) // opened SECOND
    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', amount: 100, ssn: '123-45-6789' })

    const rec = await buyers.get('b1')
    expect(rec?.total).toBeInstanceOf(SealedHandle)
    const envelope = store._dump('v1', 'buyers', 'b1')
    expect(envelope).toBeDefined()
    expect(envelope!._sealed?.total).toMatch(/^.+:.+$/)
    expect(() => buyers.query().where('total', '==', 100)).toThrow(FieldNotQueryableError)
  })
})

/**
 * Fix wave 1 (reviewer in-wave findings on Task 2's own diff) — three
 * reviewer-prescribed corners, additive to this file only:
 *
 * 1. `_getStoredRecord`'s LAZY branch (collection.ts:2123) has the exact same
 *    latent gate-parity class `resolvePriorValues` had (see the report's "Bugs
 *    found" #2): it gates on local `sensitiveFields`, missing a taint-only-
 *    sealed collection (zero local `sensitiveFields`, sealed entirely via the
 *    graph-folded `taint` binding). Two observable corners:
 *      (i)  a cache-MISS caches the freshly-decrypted REAL record into the
 *           LRU instead of the SealedHandle form — a later `get()` cache HIT
 *           then leaks plaintext straight out of the working set.
 *      (ii) a cache-HIT returns the cached record AS-IS for use as a
 *           self-write PATCH BASE — if that cached record carries a retained
 *           SealedHandle for some OTHER already-sealed field (multi-field
 *           case), spreading it into the patch and writing it back re-seals
 *           `SealedHandle.toJSON()`'s `'[sealed]'` marker string in place of
 *           the real value — a silent, permanent data-corrupting bug.
 * 2. `applyTaintOverlay` (via/graph-wiring.ts) appends a fresh `taintBinding`
 *    onto the existing bindings list without stripping a PRIOR one — every
 *    `reapplyDependentOverlays` pass (#642's cross-collection re-apply gap
 *    fix) accumulates one more `brand: 'taint'` binding (benign in effect —
 *    the LAST one wins on every lookup — but wrong, and unbounded).
 * 3. The self-write cycle-termination guard's regression (report's "Bugs
 *    found" #2, an infinite write loop) was previously pinned only by the
 *    default 5000ms vitest timeout. Upgraded here with an explicit put-count
 *    assertion so a regression fails fast with a concrete count instead of a
 *    generic timeout, keeping the timeout itself as the backstop.
 */
describe('#642 Fix wave 1 — _getStoredRecord lazy-branch at-rest gate parity (collection.ts:2123)', () => {
  it('corner (i): a cache-miss patch-base read never poisons the LRU with plaintext — get() stays sealed', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store, user: 'a', secret: 'lazy-gate-corner-1',
      classifiedStrategy: withClassified(),
      derivationStrategies: [totalRollup()],
    })
    const v = await db.openVault('v1')
    const sales = v.collection<Sale>('sales', { classifiedFields: { ssn: ssnSpec() } })
    // Parent is LAZY (prefetch:false + bounded cache) with ZERO local
    // sensitiveFields — sealed entirely via the folded `taint` binding.
    const buyers = v.collection<Buyer>('buyers', { prefetch: false, cache: { maxRecords: 16 } })
    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', amount: 100, ssn: '123-45-6789' })

    // Evict the write-populated LRU entry so the NEXT read cache-MISSES —
    // exactly the situation `recomputeRollup`'s `_getStoredRecord` patch-base
    // read hits on a second child write.
    ;(buyers as unknown as { lru: { remove: (id: string) => void } }).lru.remove('b1')

    // Mirror `recomputeRollup`'s own call — this internal patch-base accessor
    // is documented to return REAL values by design (never handles), so this
    // call itself is expected to see the plain number.
    const stored = await (buyers as unknown as { _getStoredRecord(id: string): Promise<Buyer | null> })._getStoredRecord('b1')
    expect(stored?.total).toBe(100)

    // The bug: pre-fix, that cache-miss populated the LRU with the REAL
    // record (not a SealedHandle). Peek the LRU directly, then confirm the
    // public read path agrees.
    const peeked = (buyers as unknown as { _peekCached(id: string): Buyer | null })._peekCached('b1')
    expect(peeked?.total).toBeInstanceOf(SealedHandle)

    const rec = await buyers.get('b1')
    expect(rec?.total).toBeInstanceOf(SealedHandle)
    expect(await (rec!.total as unknown as { reveal(): Promise<number> }).reveal()).toBe(100)
  })

  it('corner (ii): a retained SealedHandle in a multi-field patch base is never re-sealed to the "[sealed]" marker', async () => {
    interface MultiBuyer extends Record<string, unknown> { id: string; companyName: string; total?: number; saleCount?: number }
    const store = inlineMemory()
    const db = await createNoydb({
      store, user: 'a', secret: 'lazy-gate-corner-2',
      classifiedStrategy: withClassified(),
      // TWO rollups from the SAME classified child into the SAME lazy parent:
      // both target fields fold sealed (the rollup edge taints from the
      // WHOLE `from` record, not a specific field — see
      // `with-formula/derivations/registry.ts`'s `WHOLE_RECORD` source). The
      // second spec's patch-base read then hits the LRU entry the FIRST
      // spec's write just cached — a retained SealedHandle for `total`.
      derivationStrategies: [
        withRollup<Sale, MultiBuyer>({
          from: 'sales', key: 'buyerId', into: 'buyers', field: 'total',
          compute: (rows) => rows.reduce((t, s) => t + (typeof s.amount === 'number' ? s.amount : 0), 0),
        }),
        withRollup<Sale, MultiBuyer>({
          from: 'sales', key: 'buyerId', into: 'buyers', field: 'saleCount',
          compute: (rows) => rows.length,
        }),
      ],
    })
    const v = await db.openVault('v1')
    const sales = v.collection<Sale>('sales', { classifiedFields: { ssn: ssnSpec() } })
    const buyers = v.collection<MultiBuyer>('buyers', { prefetch: false, cache: { maxRecords: 16 } })
    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', amount: 100, ssn: '123-45-6789' })

    const rec = await buyers.get('b1')
    expect(rec?.total).toBeInstanceOf(SealedHandle)
    expect(await (rec!.total as unknown as { reveal(): Promise<number> }).reveal()).toBe(100)
    expect(rec?.saleCount).toBeInstanceOf(SealedHandle)
    expect(await (rec!.saleCount as unknown as { reveal(): Promise<number> }).reveal()).toBe(1)
  })
})

describe('#642 Fix wave 1 — applyTaintOverlay reapply idempotency (taint-binding accumulation)', () => {
  it('two reapplies of the same dependent leave exactly ONE taint binding', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store, user: 'a', secret: 'reapply-idempotency-1',
      classifiedStrategy: withClassified(),
      derivationStrategies: [leakDerivation()],
    })
    const v = await db.openVault('v1')
    v.collection<Leak>('leaks') // opened FIRST — no classified field registered yet
    v.collection<Person>('people', { classifiedFields: { ssn: ssnSpec() } }) // opened SECOND — fires ONE reapply onto 'leaks'

    const coll = v._getCollection('leaks') as unknown as { via?: { bindings: ReadonlyArray<{ brand: string }> } }
    expect(coll.via?.bindings.filter((b) => b.brand === 'taint')).toHaveLength(1)

    // Force a SECOND reapply pass the same way the real 'people' registration
    // call site does (vault.ts's `reapplyDependentOverlays` call) — simulates
    // a second dependent-source registering/refreshing.
    reapplyDependentOverlays(v.graph, 'people', (n) => v._getCollection(n))

    expect(coll.via?.bindings.filter((b) => b.brand === 'taint')).toHaveLength(1)
  })
})

describe('#642 Fix wave 1 — self-write cycle-termination loop pin (put-count, fails fast)', () => {
  it('a rollup recompute on a taint-sealed target converges in a bounded number of store puts', async () => {
    const store = spyStore(inlineMemory())
    const db = await createNoydb({
      store, user: 'a', secret: 'loop-pin-1',
      classifiedStrategy: withClassified(),
      derivationStrategies: [totalRollup()],
    })
    const v = await db.openVault('v1')
    const sales = v.collection<Sale>('sales', { classifiedFields: { ssn: ssnSpec() } })
    const buyers = v.collection<Buyer>('buyers')
    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })

    // Count only writes to the `buyers` DATA collection (excluding the
    // incidental one-time `_keyring`/`_meta` housekeeping puts a first write
    // to a fresh collection triggers) — this isolates exactly the write the
    // self-write cycle-termination guard is responsible for bounding.
    const buyersPutsBefore = store.calls.filter((c) => c.op === 'put' && c.args[1] === 'buyers').length
    await sales.put('s1', { id: 's1', buyerId: 'b1', amount: 100, ssn: '123-45-6789' })
    const buyersPutsAfter = store.calls.filter((c) => c.op === 'put' && c.args[1] === 'buyers').length - buyersPutsBefore

    // Regression pin for the self-write cycle-termination guard: exactly ONE
    // `buyers` write (the rollup patch settling `total: 100`) results from
    // the single `sales.put`. Pre-fix, a SealedHandle patch base never
    // value-equals the freshly computed plain number, so the rollup write
    // re-triggers itself indefinitely — this assertion fails FAST with a
    // concrete over-count instead of waiting out the 5000ms default vitest
    // timeout the bug was previously only caught by.
    expect(buyersPutsAfter).toBe(1)
  })
})
