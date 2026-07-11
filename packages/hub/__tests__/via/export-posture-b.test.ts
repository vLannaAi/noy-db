/**
 * #629 Task 9 — posture enforcement: export.
 *
 * PARITY-FIRST: today's classified export redaction is an ACCIDENT — there is
 * zero classified-aware export code; `exportStream()`/`exportJSON()` read every
 * record through `coll.get(id, localeOpts)` (the same public read path
 * everything else uses, always `sealedAsHandles: true`), so a recoverable
 * classified field comes back as a `SealedHandle` instance, and redaction only
 * happens as a side effect of `SealedHandle.toJSON()` returning `'[sealed]'`
 * when a consumer `JSON.stringify`s the record (verified against the unflipped
 * branch — see task-9-report.md for the probe output). Digest-only classified
 * fields are simply absent (never reach `_data`). `blobFields`-declared fields
 * are ordinary plain data (no write-pipeline hook strips them) and export
 * unredacted, matching their `exportable: true` posture.
 *
 * The PARITY block below pins that accident-only byte output BEFORE the flip.
 * The TDD block is new: after the flip, `exportStream()` deliberately redacts
 * non-exportable fields on the record itself (not just at JSON.stringify time),
 * so even a direct (non-JSON) `chunk.records` consumer never sees a revealable
 * `SealedHandle` for a `posture.exportable: false` field.
 * `SealedHandle.toJSON()` itself is untouched — the Belt-and-braces block
 * proves the accident still works completely independently of the deliberate
 * layer (a `collection.get()` read, bypassing `exportStream()` entirely).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/index.js'
import { SealedHandle } from '../../src/index.js'
import { classified, withClassified } from '../../src/shape/via-classified/index.js'
import { moneyBinding } from '../../src/shape/via-money/binding.js'
import { i18nBinding } from '../../src/shape/via-i18n/binding.js'
import { classifiedBinding } from '../../src/shape/via-classified/binding.js'
import { blobBinding } from '../../src/shape/via-blob/binding.js'
import { ViaPipeline, EXPORT_REDACTION_MARKER } from '../../src/kernel/via-pipeline.js'
import { NO_I18N } from '../../src/port/with/i18n-strategy.js'
import { inlineMemory } from '../classified/harness.js'

interface Card { id: string; pan: string; name: string }

async function cardsVault(secret: string) {
  const db = await createNoydb({ store: inlineMemory(), user: 'a', secret, classifiedStrategy: withClassified() })
  const v = await db.openVault('v1')
  const c = v.collection<Card>('cards', {
    classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
  })
  await c.put('r1', { id: 'r1', pan: '4242424242424242', name: 'Ada' })
  return { db, v, c }
}

// ─── redactForExport — direct unit tests (metadata-driven, no brand checks) ──

describe('ViaPipeline.redactForExport (#629 Task 9 — new pipeline method)', () => {
  it('classified: redacts a covered field to the marker; leaves other fields (incl. riders) untouched', () => {
    const b = classifiedBinding({
      entries: { card: classified.creditCard({ pan: 'pan' }) },
      collectionName: 'c',
      guardCtx: {
        perRecordKeys: true, crdt: false, hasConflictPolicy: false, storeCiphertext: true,
        deterministicFields: null, indexedFields: new Set(), textIndexFields: new Set(),
        vectorSourceFields: new Set(), subjectKeyField: undefined, bareSensitiveFields: new Set(),
        acknowledgeEquatableRisk: true,
      },
    })
    const p = ViaPipeline.build([b])!
    const record = { id: 'r1', pan: '4242424242424242', pan_last4: '4242', name: 'Ada' }
    const out = p.redactForExport(record)
    expect(out).toEqual({ id: 'r1', pan: EXPORT_REDACTION_MARKER, pan_last4: '4242', name: 'Ada' })
    expect(EXPORT_REDACTION_MARKER).toBe('[sealed]') // locks it to SealedHandle.toJSON()'s literal
  })

  it('classified: does not mutate the input record', () => {
    const b = classifiedBinding({
      entries: { card: classified.creditCard({ pan: 'pan' }) },
      collectionName: 'c',
      guardCtx: {
        perRecordKeys: true, crdt: false, hasConflictPolicy: false, storeCiphertext: true,
        deterministicFields: null, indexedFields: new Set(), textIndexFields: new Set(),
        vectorSourceFields: new Set(), subjectKeyField: undefined, bareSensitiveFields: new Set(),
        acknowledgeEquatableRisk: true,
      },
    })
    const p = ViaPipeline.build([b])!
    const record = { id: 'r1', pan: '4242424242424242' }
    const out = p.redactForExport(record)
    expect(record.pan).toBe('4242424242424242') // original untouched
    expect(out).not.toBe(record) // a new object was returned
  })

  it('money: exportable:true — record reference is returned unchanged (nothing to redact)', () => {
    const b = moneyBinding({ amount: { currency: 'USD', scale: 2 } as never })
    const p = ViaPipeline.build([b])!
    const record = { id: 'r1', amount: '100.04' }
    expect(p.redactForExport(record)).toBe(record) // same reference — no copy made
  })

  it('i18n: exportable:true — unaffected', () => {
    const b = i18nBinding({ i18nFields: { title: {} }, strategy: NO_I18N, collectionName: 'c' })
    const p = ViaPipeline.build([b])!
    const record = { id: 'r1', title: 'hello' }
    expect(p.redactForExport(record)).toBe(record)
  })

  it('blob: exportable:true — unaffected', () => {
    const b = blobBinding({ fields: { receipt: {} }, collectionName: 'c' })
    const p = ViaPipeline.build([b])!
    const record = { id: 'r1', receipt: 'stored-plain-value' }
    expect(p.redactForExport(record)).toBe(record)
  })

  it('a field no binding covers is left alone even when some other field IS redacted', () => {
    const b = classifiedBinding({
      entries: { card: classified.creditCard({ pan: 'pan' }) },
      collectionName: 'c',
      guardCtx: {
        perRecordKeys: true, crdt: false, hasConflictPolicy: false, storeCiphertext: true,
        deterministicFields: null, indexedFields: new Set(), textIndexFields: new Set(),
        vectorSourceFields: new Set(), subjectKeyField: undefined, bareSensitiveFields: new Set(),
        acknowledgeEquatableRisk: true,
      },
    })
    const p = ViaPipeline.build([b])!
    const out = p.redactForExport({ id: 'r1', pan: 'x', other: 'y' })
    expect(out.other).toBe('y')
  })
})

// ─── PARITY: classified export redaction — today's accident, pinned ───────

describe('PARITY: classified field export redaction (today: SealedHandle.toJSON() accident only)', () => {
  it('exportJSON(): recoverable classified field serializes to "[sealed]"; riders + other fields stay plaintext', async () => {
    const { v } = await cardsVault('pw-export-parity-1')
    const json = await v.exportJSON()
    const parsed = JSON.parse(json) as {
      collections: Record<string, { records: Array<{ id: string; pan: string; pan_last4: string; name: string }> }>
    }
    const rec = parsed.collections.cards!.records[0]!
    expect(rec.pan).toBe('[sealed]')
    expect(rec.pan_last4).toBe('4242')
    expect(rec.name).toBe('Ada')
    expect(rec.id).toBe('r1')
  })

  it('exportStream() collection-granularity chunk, JSON.stringify\'d, matches the same byte output as exportJSON()', async () => {
    const { v } = await cardsVault('pw-export-parity-2')
    const chunks: { collection: string; records: unknown[] }[] = []
    for await (const chunk of v.exportStream()) chunks.push(chunk)
    const cardsChunk = chunks.find((c) => c.collection === 'cards')!
    const serialized = JSON.parse(JSON.stringify(cardsChunk.records)) as Array<{ pan: string }>
    expect(serialized[0]!.pan).toBe('[sealed]')
  })

  it('digest-only classified field: absent from the exported record (never reaches _data)', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-export-parity-3', classifiedStrategy: withClassified() })
    const v = await db.openVault('v1')
    const c = v.collection<{ id: string; password: string; name: string }>('users', {
      perRecordKeys: true,
      classifiedFields: { password: classified.password() },
    })
    await c.put('r1', { id: 'r1', password: 'supersecret1', name: 'Ada' })
    const json = await v.exportJSON()
    const parsed = JSON.parse(json) as { collections: Record<string, { records: Array<Record<string, unknown>> }> }
    const rec = parsed.collections.users!.records[0]!
    expect('password' in rec).toBe(false)
    expect(rec.name).toBe('Ada')
  })
})

describe('PARITY: money "exportable:true" and i18n "exportable:true" export behavior unaffected', () => {
  it('money field exports its decoded (formatted decimal string) value, unredacted', async () => {
    const { money } = await import('../../src/index.js')
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-export-money-1' })
    const v = await db.openVault('v1')
    const c = v.collection<{ id: string; amount: number | string }>('sales', {
      moneyFields: { amount: money({ currency: 'USD', scale: 2 }) },
    })
    await c.put('a', { id: 'a', amount: 100.04 })
    const json = await v.exportJSON()
    const parsed = JSON.parse(json) as { collections: Record<string, { records: Array<{ amount: string }> }> }
    expect(parsed.collections.sales!.records[0]!.amount).toBe('100.04')
  })

  it('i18n dictKeyFields field exports its stored stable key, unredacted', async () => {
    const { withI18n } = await import('../../src/shape/via-i18n/index.js')
    const { dictKey } = await import('../../src/shape/via-i18n/dictionary.js')
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-export-i18n-1', i18nStrategy: withI18n() })
    const v = await db.openVault('v1')
    const statusDict = v.dictionary('status')
    await statusDict.putAll({ draft: { en: 'Draft' }, paid: { en: 'Paid' } })
    const c = v.collection<{ id: string; status: string }>('invoices', {
      dictKeyFields: { status: dictKey('status', ['draft', 'paid'] as const) },
    })
    await c.put('a', { id: 'a', status: 'paid' })
    const json = await v.exportJSON()
    const parsed = JSON.parse(json) as { collections: Record<string, { records: Array<{ status: string }> }> }
    expect(parsed.collections.invoices!.records[0]!.status).toBe('paid')
  })
})

describe('PARITY: blob "exportable:true" — blobFields-declared field is ordinary plain data, exports unredacted', () => {
  it('exports the field\'s stored value verbatim (no write-pipeline hook strips it; confirmed empirically pre-flip)', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-export-blob-1' })
    const v = await db.openVault('v1')
    const c = v.collection<{ id: string; title: string; receipt: string }>('docs', { blobFields: { receipt: {} } })
    await c.put('d1', { id: 'd1', title: 'x', receipt: 'stored-plain-value' })
    const json = await v.exportJSON()
    const parsed = JSON.parse(json) as { collections: Record<string, { records: Array<Record<string, unknown>> }> }
    const rec = parsed.collections.docs!.records[0]!
    expect(rec.title).toBe('x')
    expect(rec.receipt).toBe('stored-plain-value')
  })
})

// ─── Belt-and-braces: the toJSON accident, independent of the deliberate layer ─

describe('Belt-and-braces (#629 Task 9): SealedHandle.toJSON() redacts on its own, independent of exportStream()', () => {
  it('collection.get() (bypassing exportStream entirely) still yields a SealedHandle that redacts on JSON.stringify', async () => {
    const { c } = await cardsVault('pw-export-belt-1')
    const rec = await c.get('r1')
    expect(rec!.pan).toBeInstanceOf(SealedHandle) // get() never runs the deliberate export-layer redaction
    expect(JSON.parse(JSON.stringify(rec)).pan).toBe('[sealed]') // the accident alone still protects it
  })
})

// ─── TDD RED→GREEN: exportStream() deliberately redacts — posture.exportable: false ─

describe('TDD (#629 Task 9): exportStream() deliberately redacts non-exportable fields on the record itself', () => {
  it('collection-granularity: chunk.records carries the plain marker directly, not a revealable SealedHandle', async () => {
    const { v } = await cardsVault('pw-export-tdd-1')
    const chunks: { collection: string; records: unknown[] }[] = []
    for await (const chunk of v.exportStream()) chunks.push(chunk)
    const rec = chunks.find((c) => c.collection === 'cards')!.records[0] as { pan: unknown }
    expect(rec.pan).toBe(EXPORT_REDACTION_MARKER)
    expect(rec.pan).not.toBeInstanceOf(SealedHandle)
  })

  it('record-granularity: same deliberate redaction applies', async () => {
    const { v } = await cardsVault('pw-export-tdd-2')
    const chunks: { collection: string; records: unknown[] }[] = []
    for await (const chunk of v.exportStream({ granularity: 'record' })) chunks.push(chunk)
    const rec = chunks.find((c) => c.collection === 'cards')!.records[0] as { pan: unknown }
    expect(rec.pan).toBe(EXPORT_REDACTION_MARKER)
    expect(rec.pan).not.toBeInstanceOf(SealedHandle)
  })

  it('exportJSON() byte output is unaffected by the flip (still "[sealed]" — parity holds through either layer)', async () => {
    const { v } = await cardsVault('pw-export-tdd-3')
    const json = await v.exportJSON()
    const parsed = JSON.parse(json) as { collections: Record<string, { records: Array<{ pan: string }> }> }
    expect(parsed.collections.cards!.records[0]!.pan).toBe('[sealed]')
  })
})
