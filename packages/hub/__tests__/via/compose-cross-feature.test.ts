/**
 * #629 whole-branch review fix wave — Folded Minor 1: promote the reviewer's
 * two live cross-feature sweeps (money + classified + blob compose on one
 * collection; forget() × export interplay) to shipped, pinned tests. Both
 * PASSED live against HEAD when the reviewer probed them by hand — these are
 * pins, not fixes.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, SealedHandle, FieldNotQueryableError } from '../../src/index.js'
import { money } from '../../src/via/money/descriptor.js'
import { classified } from '../../src/via/classified/presets.js'
import { withForgetCascade } from '../../src/with-audit/forget/index.js'
import { withHistory } from '../../src/with-commit/history/index.js'
import { EXPORT_REDACTION_MARKER } from '../../src/kernel/via/pipeline.js'
import { inlineMemory } from '../classified/harness.js'

interface Card extends Record<string, unknown> {
  id: string
  amount: number | string
  pan: string
  receipt: string
  name: string
}

describe('#629 whole-branch fix wave — triple-feature via compose (Folded Minor 1)', () => {
  it('money + classified + blob compose on one collection: get/where/orderBy/export behave per-field posture', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-compose-triple-1' })
    const v = await db.openVault('v1')
    const c = v.collection<Card>('cards', {
      moneyFields: { amount: money({ currency: 'USD', scale: 2 }) },
      classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
      blobFields: { receipt: {} },
    })
    await c.put('r1', { id: 'r1', amount: 100.04, pan: '4242424242424242', receipt: 'stored-plain-value', name: 'Ada' })

    // get(): money decoded, pan is a SealedHandle whose reveal() round-trips,
    // the plain field is untouched.
    const rec = await c.get('r1') as Record<string, unknown>
    expect(rec.amount).toBe('100.04')
    expect(rec.pan).toBeInstanceOf(SealedHandle)
    await expect((rec.pan as SealedHandle<unknown>).reveal()).resolves.toBe('4242424242424242')
    expect(rec.name).toBe('Ada')

    // where() on the money field (posture: 'ordered') matches.
    const whereRes = await c.query().where('amount', '>', 50).toArray()
    expect(whereRes.map((r) => r.id)).toEqual(['r1'])

    // where()/orderBy() on the blob field (posture: 'none') refuse.
    expect(() => c.query().where('receipt', '==', 'x')).toThrow(FieldNotQueryableError)
    expect(() => c.query().orderBy('receipt')).toThrow(FieldNotQueryableError)

    // exportStream: pan redacted to the plain '[sealed]' marker; money +
    // plain fields untouched (blob field, posture exportable:true, also
    // untouched).
    const chunks: { collection: string; records: unknown[] }[] = []
    for await (const chunk of v.exportStream()) chunks.push(chunk)
    const exported = chunks.find((ch) => ch.collection === 'cards')!.records[0] as Record<string, unknown>
    expect(exported.pan).toBe(EXPORT_REDACTION_MARKER)
    expect(exported.pan).not.toBeInstanceOf(SealedHandle)
    expect(exported.amount).toBe('100.04')
    expect(exported.receipt).toBe('stored-plain-value')
    expect(exported.name).toBe('Ada')

    await db.close()
  })
})

interface Person {
  id: string
  subjectId: string
  email: string
  name: string
}

describe('#629 whole-branch fix wave — forget() x export interplay (Folded Minor 1)', () => {
  it('a forgotten record is fully absent from export (no husk, no residue row); the surviving record stays deliberately redacted', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store, user: 'alice', secret: 'pw-compose-forget-export-1',
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { people: 'subjectId' } }),
    })
    const v = await db.openVault('v1')
    const people = v.collection<Person>('people', {
      perRecordKeys: true,
      classifiedFields: { email: classified.email() },
    })
    await people.put('p1', { id: 'p1', subjectId: 'subject-1', email: 'ada@example.com', name: 'Ada' })
    await people.put('p2', { id: 'p2', subjectId: 'subject-2', email: 'bob@example.com', name: 'Bob' })

    const result = await v.forget('subject-1')
    expect(result.sealedFieldsShredded).toBe(1)
    expect(result.sealedResidue).toEqual([])

    const chunks: { collection: string; records: unknown[] }[] = []
    for await (const chunk of v.exportStream()) chunks.push(chunk)
    const records = chunks.find((ch) => ch.collection === 'people')!.records as Record<string, unknown>[]

    // The forgotten record (p1) is entirely absent — no '[sealed]' husk row.
    expect(records).toHaveLength(1)
    expect(records[0]!.id).toBe('p2')
    // The surviving record stays deliberately redacted.
    expect(records[0]!.email).toBe(EXPORT_REDACTION_MARKER)
    expect(records[0]!.name).toBe('Bob')

    await db.close()
  })
})
