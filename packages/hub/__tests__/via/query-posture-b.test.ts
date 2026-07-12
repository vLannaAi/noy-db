/**
 * #629 Task 8 — posture enforcement: query.
 *
 * PARITY-FIRST: the classified/money/i18n assertions below pin TODAY's
 * observable query-DSL behavior (verified by hand against the unflipped
 * branch — see task-8-report.md) and must keep passing byte-for-byte after
 * the flip. The blob assertions are the TDD RED→GREEN half: blob's
 * `queryable: 'none'` posture had NO runtime refusal before this task (a
 * blobFields slot simply isn't present in the decrypted record, so
 * `.where()`/`.orderBy()`/`.aggregate()` silently no-op/no-match on it) —
 * the flip makes that an explicit `FieldNotQueryableError`.
 *
 * `pipeline.postureFor(field)` / `ViaBinding.covers` are also unit-tested
 * directly, mirroring `via/classified-binding.test.ts` / `via/blob-binding.test.ts`.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, count, sum, FieldNotQueryableError } from '../../src/index.js'
import { classified, withClassified } from '../../src/shape/via-classified/index.js'
import { withAggregate } from '../../src/with-lookup/aggregate/index.js'
import { moneyBinding } from '../../src/shape/via-money/binding.js'
import { i18nBinding } from '../../src/shape/via-i18n/binding.js'
import { classifiedBinding } from '../../src/shape/via-classified/binding.js'
import { blobBinding } from '../../src/shape/via-blob/binding.js'
import { ViaPipeline } from '../../src/kernel/via-pipeline.js'
import type { ViaPosture } from '../../src/kernel/via.js'
import { NO_I18N } from '../../src/port/with/i18n-strategy.js'
import { inlineMemory } from '../classified/harness.js'

// ─── postureFor / covers — direct binding + pipeline unit tests ───────────

describe('ViaPipeline.postureFor (#629 Task 8 — new small pipeline accessor)', () => {
  it('money: covers declared fields, posture queryable "ordered"', () => {
    const b = moneyBinding({ amount: { currency: 'USD', scale: 2 } as never })
    const p = ViaPipeline.build([b])!
    expect(p.postureFor('amount')).toEqual({ encryptedAtRest: 'envelope', queryable: 'ordered', exportable: true, forgettable: true })
    expect(p.postureFor('other')).toBeUndefined()
  })

  it('i18n: covers declared i18nFields/dictKeyFields, posture queryable "full"', () => {
    const b = i18nBinding({ i18nFields: { title: {} }, strategy: NO_I18N, collectionName: 'c' })
    const p = ViaPipeline.build([b])!
    expect(p.postureFor('title')?.queryable).toBe('full')
    expect(p.postureFor('other')).toBeUndefined()
  })

  it('classified: covers declared fields, posture queryable "det-exact"', () => {
    const b = classifiedBinding({
      entries: { pw: classified.password({ equatable: true }) },
      collectionName: 'c',
      guardCtx: {
        perRecordKeys: true, crdt: false, hasConflictPolicy: false, storeCiphertext: true,
        deterministicFields: null, indexedFields: new Set(), textIndexFields: new Set(),
        vectorSourceFields: new Set(), subjectKeyField: undefined, bareSensitiveFields: new Set(),
        acknowledgeEquatableRisk: true,
      },
    })
    const p = ViaPipeline.build([b])!
    expect(p.postureFor('pw')?.queryable).toBe('det-exact')
    expect(p.postureFor('other')).toBeUndefined()
  })

  it('blob: covers declared blobFields, posture queryable "none"', () => {
    const b = blobBinding({ fields: { receipt: {} }, collectionName: 'c' })
    const p = ViaPipeline.build([b])!
    expect(p.postureFor('receipt')?.queryable).toBe('none')
    expect(p.postureFor('other')).toBeUndefined()
  })

  it('undefined when no binding is compiled (zero-via)', () => {
    expect(ViaPipeline.build([])).toBeUndefined()
  })

  it('#642 — defaultPosture fallback: postureFor returns it for any field when no binding/taint entry covers it (non-sealed collection default)', () => {
    const defaultPosture: ViaPosture = { encryptedAtRest: 'envelope', queryable: 'full', exportable: true, forgettable: true }
    const p = ViaPipeline.build([], { postures: new Map(), sealFields: new Set(), defaultPosture })!
    expect(p.postureFor('anyField')).toEqual(defaultPosture)
  })

  it('#642 — a field-specific taint posture still wins over defaultPosture', () => {
    const defaultPosture: ViaPosture = { encryptedAtRest: 'envelope', queryable: 'full', exportable: true, forgettable: true }
    const fieldPosture: ViaPosture = { encryptedAtRest: 'sealed', queryable: 'det-exact', exportable: false, forgettable: true }
    const p = ViaPipeline.build([], { postures: new Map([['ssn', fieldPosture]]), sealFields: new Set(), defaultPosture })!
    expect(p.postureFor('ssn')).toEqual(fieldPosture)
    expect(p.postureFor('other')).toEqual(defaultPosture)
  })
})

// ─── Parity pins: classified fields keep TODAY's silent (non-throwing) ────
// ─── query-DSL behavior — det-exact stays out of .where()/.orderBy()/    ──
// ─── .aggregate(); only findByDigest (the real _bidx path) is live.      ──

describe('PARITY: classified fields in the query DSL (unchanged by the Task 8 flip)', () => {
  async function cardsVault() {
    const db = await createNoydb({
      store: inlineMemory(), user: 'a', secret: 'pw-parity-1',
      classifiedStrategy: withClassified(),
    })
    const v = await db.openVault('v1')
    const c = v.collection<{ id: string; pan: string; name: string }>('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
    })
    await c.put('r1', { id: 'r1', pan: '4242424242424242', name: 'Ada' })
    await c.put('r2', { id: 'r2', pan: '4111111111111111', name: 'Bob' })
    return c
  }

  it('where() on a recoverable classified field does not throw and matches nothing (SealedHandle !== raw value)', async () => {
    const c = await cardsVault()
    const res = await c.query().where('pan', '==', '4242424242424242').toArray()
    expect(res).toEqual([])
  })

  it('orderBy() on a recoverable classified field does not throw; order is stable (SealedHandle is non-comparable)', async () => {
    const c = await cardsVault()
    const res = await c.query().orderBy('pan').toArray()
    expect(res.map(r => r.id)).toEqual(['r1', 'r2']) // insertion order preserved — generic comparator treats SealedHandle pairs as equal
  })

  it('aggregate() count() over a classified-field collection does not throw', async () => {
    const db = await createNoydb({
      store: inlineMemory(), user: 'a', secret: 'pw-parity-1b',
      classifiedStrategy: withClassified(), aggregateStrategy: withAggregate(),
    })
    const v = await db.openVault('v1')
    const c = v.collection<{ id: string; pan: string; name: string }>('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
    })
    await c.put('r1', { id: 'r1', pan: '4242424242424242', name: 'Ada' })
    expect(c.query().aggregate({ n: count() }).run()).toEqual({ n: 1 })
  })

  it('aggregate() sum() bare-spec over a recoverable classified field does not throw (silently sums to 0 — known pre-existing gap, not this task\'s scope)', async () => {
    const db = await createNoydb({
      store: inlineMemory(), user: 'a', secret: 'pw-parity-1c',
      classifiedStrategy: withClassified(), aggregateStrategy: withAggregate(),
    })
    const v = await db.openVault('v1')
    const c = v.collection<{ id: string; pan: string; name: string }>('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
    })
    await c.put('r1', { id: 'r1', pan: '4242424242424242', name: 'Ada' })
    expect(c.query().aggregate({ n: sum('pan') }).run()).toEqual({ n: 0 })
  })

  it('where() on a digest-only (non-equatable) classified field does not throw and matches nothing (field absent from _data)', async () => {
    const db = await createNoydb({
      store: inlineMemory(), user: 'a', secret: 'pw-parity-2',
      classifiedStrategy: withClassified(),
    })
    const v = await db.openVault('v1')
    const c = v.collection<{ id: string; password: string; name: string }>('users', {
      perRecordKeys: true,
      classifiedFields: { password: classified.password() },
    })
    await c.put('r1', { id: 'r1', password: 'supersecret1', name: 'Ada' })
    const res = await c.query().where('password', '==', 'supersecret1').toArray()
    expect(res).toEqual([])
  })

  it('where() on a digest-only EQUATABLE classified field also does not throw and matches nothing — det-exact stays OUT of .where(), unlike findByDigest', async () => {
    const db = await createNoydb({
      store: inlineMemory(), user: 'a', secret: 'pw-parity-3',
      classifiedStrategy: withClassified(),
    })
    const v = await db.openVault('v1')
    const c = v.collection<{ id: string; password: string; name: string }>('users', {
      perRecordKeys: true, acknowledgeEquatableRisk: true,
      classifiedFields: { password: classified.password({ equatable: true }) },
    })
    await c.put('r1', { id: 'r1', password: 'supersecret1', name: 'Ada' })
    const whereRes = await c.query().where('password', '==', 'supersecret1').toArray()
    expect(whereRes).toEqual([])
  })
})

describe('PARITY: det-exact routes to the existing _bidx equality path (findByDigest), unaffected by the flip', () => {
  it('findByDigest still finds records by the equatable blind-index tag', async () => {
    const db = await createNoydb({
      store: inlineMemory(), user: 'a', secret: 'pw-parity-4',
      classifiedStrategy: withClassified(),
    })
    const v = await db.openVault('v1')
    const c = v.collection<{ id: string; password: string; name: string }>('users', {
      perRecordKeys: true, acknowledgeEquatableRisk: true,
      classifiedFields: { password: classified.password({ equatable: true }) },
    })
    await c.put('r1', { id: 'r1', password: 'supersecret1', name: 'Ada' })
    await c.put('r2', { id: 'r2', password: 'other-password', name: 'Bob' })
    expect(await c.findByDigest('password', 'supersecret1')).toEqual(['r1'])
  })
})

describe('PARITY: money "ordered" and i18n "full" query behavior unaffected', () => {
  it('money field where()/orderBy() still work exactly as before (numeric, not lexical, ordering)', async () => {
    const { money } = await import('../../src/index.js')
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-parity-money' })
    const v = await db.openVault('v1')
    const c = v.collection<{ id: string; amount: number | string }>('sales', {
      moneyFields: { amount: money({ currency: 'USD', scale: 2 }) },
    })
    await c.put('a', { id: 'a', amount: 100.04 })
    await c.put('b', { id: 'b', amount: 98.82 })
    // Lexical string-sort of scaled-int space would order '10004' < '9882';
    // the money binding's compareForOrder keeps this numeric. Decoded money
    // reads come back as a formatted decimal string (MoneyString).
    expect((await c.query().orderBy('amount').toArray()).map(r => r.amount)).toEqual(['98.82', '100.04'])
    expect((await c.query().where('amount', '>', 99).toArray()).map(r => r.id)).toEqual(['a'])
  })

  it('i18n dictKeyFields field where()/orderBy() still work exactly as before — queries/sorts the stored stable key, not a locale label (#629 Task 8 fix wave 1, Minor 1)', async () => {
    const { withI18n } = await import('../../src/shape/via-i18n/index.js')
    const { dictKey } = await import('../../src/shape/via-i18n/dictionary.js')
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-parity-i18n', i18nStrategy: withI18n() })
    const v = await db.openVault('v1')
    const statusDict = v.dictionary('status')
    await statusDict.putAll({
      draft: { en: 'Draft' },
      paid: { en: 'Paid' },
    })
    const c = v.collection<{ id: string; status: string }>('invoices', {
      dictKeyFields: { status: dictKey('status', ['draft', 'paid'] as const) },
    })
    await c.put('a', { id: 'a', status: 'paid' })
    await c.put('b', { id: 'b', status: 'draft' })
    // where() equality matches on the stored stable key (unaffected by the flip).
    expect((await c.query().where('status', '==', 'paid').toArray()).map(r => r.id)).toEqual(['a'])
    // Default orderBy() sorts by the stored code, not the resolved label — same
    // as the existing `#285 dictKey label-sort` pin ('default orderBy sorts by
    // the stored code'): 'draft' < 'paid' lexically.
    expect((await c.query().orderBy('status').toArray()).map(r => r.id)).toEqual(['b', 'a'])
  })
})

// ─── TDD RED→GREEN: blob fields ('none' posture) refuse the query DSL ─────

describe('TDD (#629 Task 8): blobFields refuse .where()/.orderBy()/.aggregate() — queryable: "none"', () => {
  interface Doc { id: string; title: string; receipt: string }

  async function docsVault() {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-blob-1', aggregateStrategy: withAggregate() })
    const v = await db.openVault('v1')
    const c = v.collection<Doc>('docs', { blobFields: { receipt: {} } })
    await c.put('d1', { id: 'd1', title: 'x', receipt: 'unused-placeholder' })
    return c
  }

  it('where() throws FieldNotQueryableError', async () => {
    const c = await docsVault()
    expect(() => c.query().where('receipt', '==', 'x')).toThrow(FieldNotQueryableError)
  })

  it('orderBy() throws FieldNotQueryableError', async () => {
    const c = await docsVault()
    expect(() => c.query().orderBy('receipt')).toThrow(FieldNotQueryableError)
  })

  it('aggregate() bare-spec form throws FieldNotQueryableError', async () => {
    const c = await docsVault()
    expect(() => c.query().aggregate({ n: sum('receipt') })).toThrow(FieldNotQueryableError)
  })

  it('aggregate() builder form throws FieldNotQueryableError', async () => {
    const c = await docsVault()
    expect(() => c.query().aggregate(b => ({ n: b.sum('receipt') }))).toThrow(FieldNotQueryableError)
  })

  it('scan().where() throws FieldNotQueryableError', async () => {
    const c = await docsVault()
    expect(() => c.scan().where('receipt', '==', 'x')).toThrow(FieldNotQueryableError)
  })

  it('groupBy().aggregate() throws FieldNotQueryableError (grouped aggregation shares wrapReducers)', async () => {
    const c = await docsVault()
    expect(() => c.query().groupBy('title').aggregate({ n: sum('receipt') })).toThrow(FieldNotQueryableError)
  })

  it('a non-blob field on the same collection is unaffected', async () => {
    const c = await docsVault()
    expect(await c.query().where('title', '==', 'x').toArray()).toHaveLength(1)
  })
})

// ─── Fix wave 1 (review): ScanBuilder.aggregate() consults posture too ────
// ─── Important finding — scan().aggregate() had NO wrapReducers/postureFor ─
// ─── call at all, so a blob-field reducer silently coerced to 0 instead of ─
// ─── throwing. The fix is metadata-only (ViaPipeline.refuseUnqueryableReducers) ─
// ─── — it must NOT wire full wrapReducers into ScanBuilder.aggregate(), which ─
// ─── would newly activate money/i18n reducer wrapping on a path that has ──
// ─── never run it (a parity break for existing brands).                   ─

describe('TDD (#629 Task 8 fix wave 1): ScanBuilder.aggregate() consults posture — queryable: "none"', () => {
  interface Doc { id: string; title: string; receipt: string }

  async function docsVault() {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-scan-blob-1' })
    const v = await db.openVault('v1')
    const c = v.collection<Doc>('docs', { blobFields: { receipt: {} } })
    await c.put('d1', { id: 'd1', title: 'x', receipt: 'unused-placeholder' })
    return c
  }

  it('scan().aggregate({ n: sum(blobField) }) throws FieldNotQueryableError (was silently coercing to 0)', async () => {
    const c = await docsVault()
    await expect(c.scan().aggregate({ n: sum('receipt') })).rejects.toThrow(FieldNotQueryableError)
  })

  it('scan().aggregate() count() over a blobFields collection still works (count has no .field to gate)', async () => {
    const c = await docsVault()
    expect(await c.scan().aggregate({ n: count() })).toEqual({ n: 1 })
  })

  it('a non-blob field on the same collection is unaffected', async () => {
    const c = await docsVault()
    expect(await c.scan().aggregate({ n: count() })).toEqual({ n: 1 })
    const rows: Doc[] = []
    for await (const r of c.scan().where('title', '==', 'x')) rows.push(r)
    expect(rows).toHaveLength(1)
  })

  it('scan().aggregate({ n: sum(moneyField) }) behaves EXACTLY as before the fix — no wrapReducers wrapping activated, raw-coercion result unchanged', async () => {
    const { money } = await import('../../src/index.js')
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-scan-money-1' })
    const v = await db.openVault('v1')
    const c = v.collection<{ id: string; amount: number | string }>('sales', {
      moneyFields: { amount: money({ currency: 'USD', scale: 2 }) },
    })
    await c.put('a', { id: 'a', amount: 100.04 })
    await c.put('b', { id: 'b', amount: 98.82 })
    // ScanBuilder.aggregate() never calls wrapReducers (money's exact-BigInt
    // reducer rewrite is not wired here — a pre-existing gap this fix must
    // NOT close). By the time a record reaches the generic `sum` reducer,
    // ScanBuilder's own decodeVia() has already turned the money field into
    // its canonical decimal STRING (e.g. '100.04') — readNumber only accepts
    // a plain `number`, so it coerces the string to 0. That is today's raw
    // behavior and must stay byte-for-byte identical after this fix.
    expect(await c.scan().aggregate({ n: sum('amount') })).toEqual({ n: 0 })
  })
})
