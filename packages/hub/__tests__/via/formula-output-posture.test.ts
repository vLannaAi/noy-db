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
import { withClassified } from '../../src/shape/via-classified/index.js'
import type { ClassifiedFieldSpec } from '../../src/shape/via-classified/index.js'
import { inlineMemory } from '../classified/harness.js'

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
