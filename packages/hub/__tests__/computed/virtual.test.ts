/**
 * #638 Task 7 — computed(virtual): the read-time mode + computed as a
 * via-feature. Ground truth: spec §6, seam map Part 4 (the money-`Formatted`/
 * i18n-`Label` precedent this generalizes).
 *
 * A virtual field is computed fresh on every `present()` (get()/list()),
 * NEVER stored (absent from `_data`, never reachable via `_getStoredRecord`),
 * `queryable: 'none'` (`FieldNotQueryableError` via the existing posture
 * gate), and — when its declared `deps` include a classified/tainted source
 * — redacted with the SAME `EXPORT_REDACTION_MARKER` on every read, not just
 * export (`via-taint-binding.ts`'s extended `presentRedactFields`).
 * Materialized mode (the default) is BYTE-FOR-BYTE today's stage-5 eager
 * compute — the parity test below pins it against the plain `computed:`
 * sugar form.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, FieldNotQueryableError, ValidationError, SealedHandle } from '../../src/index.js'
import { via } from '../../src/kernel/via-compose.js'
import { computed } from '../../src/shape/via-computed/descriptor.js'
import { money } from '../../src/shape/via-money/descriptor.js'
import { classified } from '../../src/shape/via-classified/presets.js'
import { withClassified } from '../../src/shape/via-classified/index.js'
import type { ClassifiedFieldSpec } from '../../src/shape/via-classified/index.js'
import { inlineMemory } from '../classified/harness.js'

interface Item extends Record<string, unknown> {
  id: string
  amount: number
  doubled?: number
}

async function virtualVault(secret: string) {
  const store = inlineMemory()
  const db = await createNoydb({ store, user: 'alice', secret })
  const v = await db.openVault('v1')
  const c = v.collection<Item>('items', {
    viaFields: { doubled: via(computed((r) => (r.amount as number) * 2, { deps: ['amount'], mode: 'virtual' })) },
  })
  return { db, v, c, store }
}

describe('computed(virtual) — read-time, never-stored mode (#638 Task 7)', () => {
  it('(a) get()/list() present the virtual field', async () => {
    const { c } = await virtualVault('via-computed-virtual-a-2026')
    await c.put('r1', { id: 'r1', amount: 21 })

    const got = await c.get('r1')
    expect(got?.doubled).toBe(42)

    const list = await c.list()
    expect(list.find((r) => r.id === 'r1')?.doubled).toBe(42)
  })

  it('(b) the raw stored record never contains the virtual field', async () => {
    const { c } = await virtualVault('via-computed-virtual-b-2026')
    await c.put('r1', { id: 'r1', amount: 21 })

    const raw = await c._getStoredRecord('r1')
    expect(raw).not.toBeNull()
    expect('doubled' in (raw as Record<string, unknown>)).toBe(false)
  })

  it('(c) querying the virtual field throws FieldNotQueryableError', async () => {
    const { c } = await virtualVault('via-computed-virtual-c-2026')
    await c.put('r1', { id: 'r1', amount: 21 })

    expect(() => c.query().where('doubled', '==', 42)).toThrow(FieldNotQueryableError)
  })

  it('(d) a money-only collection with a virtual computed field stays a SYNC stack (#553) — money\'s own query path is untouched', async () => {
    interface Sale extends Record<string, unknown> { id: string; price: number | string; qty: number; doubled?: number }
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: 'via-computed-virtual-d-2026' })
    const v = await db.openVault('v1')
    const c = v.collection<Sale>('sales', {
      moneyFields: { price: money({ currency: 'EUR', scale: 2 }) },
      viaFields: { doubled: via(computed((r) => (r.qty as number) * 2, { deps: ['qty'], mode: 'virtual' })) },
    })
    await c.put('a', { id: 'a', price: 10, qty: 3 })
    await c.put('b', { id: 'b', price: 20, qty: 1 })

    // money's own sync buildClause/evaluateClause query path is unaffected by
    // the presence of a virtual computed binding on the same pipeline — note
    // `.toArray()` itself is SYNCHRONOUS (no `await`), the #553 sync-stack contract.
    const results = c.query().where('price', '>', 10).toArray()
    expect(results.map((r) => r.id)).toEqual(['b'])
    expect((await c.get('a'))?.doubled).toBe(6)
  })

  it('(e) via(computed(fn, { mode: "materialized" })) stores byte-identically to the plain `computed:` sugar form', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: 'via-computed-virtual-e-2026' })
    const sugarVault = await db.openVault('sugar')
    const viaVaultDb = await db.openVault('via')

    const fn = (r: Record<string, unknown>) => (r.amount as number) * 2
    const sugarCol = sugarVault.collection<Item>('items', { computed: { doubled: fn } })
    const viaCol = viaVaultDb.collection<Item>('items', {
      viaFields: { doubled: via(computed(fn, { mode: 'materialized' })) },
    })

    await sugarCol.put('a', { id: 'a', amount: 21 })
    await viaCol.put('a', { id: 'a', amount: 21 })

    const sugarEnv = await store.get('sugar', 'items', 'a')
    const viaEnv = await store.get('via', 'items', 'a')
    expect(viaEnv).not.toBeNull()
    expect(sugarEnv).not.toBeNull()
    expect(viaEnv!._noydb).toBe(sugarEnv!._noydb)
    expect(viaEnv!._v).toBe(sugarEnv!._v)

    const sugarRead = await sugarCol.get('a')
    const viaRead = await viaCol.get('a')
    expect(viaRead).toEqual(sugarRead)
    expect((viaRead as Item).doubled).toBe(42)

    // materialized: STORED, unlike virtual mode — _getStoredRecord DOES carry it.
    const raw = await viaCol._getStoredRecord('a')
    expect((raw as Item)?.doubled).toBe(42)
  })

  it('via(computed(...)) no longer throws in mergeViaFields — the "computed" brand is accepted', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: 'via-computed-virtual-brand-2026' })
    const v = await db.openVault('v1')
    expect(() =>
      v.collection<Item>('items', {
        viaFields: { doubled: via(computed((r) => (r.amount as number) * 2, { deps: ['amount'], mode: 'virtual' })) },
      }),
    ).not.toThrow()
  })

  it('composed grammar: via(computed(...), money(...)) on one field is accepted and computes without throwing', async () => {
    // Decision 5's locked grammar (`via(computed(fn, { deps, mode }), money('EUR'))`) —
    // this pins that the composition is LEGAL and produces the computed function's
    // result. `compileViaBindings` runs computed LAST (so a virtual field's `deps` can
    // read OTHER fields' money/i18n-DECODED output, test (d)/the taint test above) — for
    // a field composing computed+money on ITSELF, money's `present()` therefore runs
    // before the virtual value exists (nothing stored to decode) and computed's
    // present() unconditionally sets the field afterward, so the raw computed number
    // is what survives, not a money-formatted string. Documented as a known limitation
    // in the task report — money-decorating-a-virtual-field's-own-output is not
    // exercised by the brief's RED list and is left for a follow-up if ever needed.
    interface Priced extends Record<string, unknown> { id: string; base: number; doubledPrice?: string | number }
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: 'via-computed-virtual-stack-2026' })
    const v = await db.openVault('v1')
    const c = v.collection<Priced>('priced', {
      viaFields: {
        doubledPrice: via(
          computed((r) => (r.base as number) * 2, { deps: ['base'], mode: 'virtual' }),
          money({ currency: 'EUR', scale: 2 }),
        ),
      },
    })
    await c.put('a', { id: 'a', base: 10.5 })
    const read = await c.get('a')
    expect(read?.doubledPrice).toBe(21)
    expect(() => c.query().where('doubledPrice', '==', 21)).toThrow(FieldNotQueryableError)
  })

  it('a depsless virtual field on a non-classified collection is legal and always non-queryable', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: 'via-computed-virtual-depsless-2026' })
    const v = await db.openVault('v1')
    const c = v.collection<Item>('items', {
      viaFields: { doubled: via(computed((r) => (r.amount as number) * 2, { mode: 'virtual' })) },
    })
    await c.put('r1', { id: 'r1', amount: 5 })
    expect((await c.get('r1'))?.doubled).toBe(10)
    expect(() => c.query().where('doubled', '==', 10)).toThrow(FieldNotQueryableError)
  })

  it('a depsless computed entry (any mode) on a classified collection still throws (#636 guard applies uniformly)', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store, user: 'alice', secret: 'via-computed-virtual-leak-2026', classifiedStrategy: withClassified(),
    })
    const v = await db.openVault('v1')
    expect(() =>
      v.collection<Item & { email: string }>('people', {
        classifiedFields: { email: classified.email() },
        viaFields: { doubled: via(computed((r) => (r.amount as number) * 2, { mode: 'virtual' })) },
      }),
    ).toThrow(ValidationError)
  })

  it('a virtual field sourced from a classified field is redacted on EVERY read (get/list), not just export', async () => {
    interface Person extends Record<string, unknown> { id: string; ssn: string; ssnLeak?: string }
    const ssnSpec = (): ClassifiedFieldSpec => ({
      _noydbClassified: true, preset: 'test-ssn', storage: 'recoverable',
      list: { kind: 'omit' }, sensitivity: 'secret',
    })
    const store = inlineMemory()
    const db = await createNoydb({
      store, user: 'alice', secret: 'via-computed-virtual-taint-2026', classifiedStrategy: withClassified(),
    })
    const v = await db.openVault('v1')
    const c = v.collection<Person>('people', {
      classifiedFields: { ssn: ssnSpec() },
      viaFields: { ssnLeak: via(computed((r) => r.ssn as string, { deps: ['ssn'], mode: 'virtual' })) },
    })
    await c.put('r1', { id: 'r1', ssn: '123-45-6789' })

    const rec = await c.get('r1')
    expect(rec?.ssn).toBeInstanceOf(SealedHandle)
    // the virtual field is REDACTED, not the plaintext fn(record) result and
    // not a revealable SealedHandle — there is no sealed slot behind it.
    expect(rec?.ssnLeak).toBe('[sealed]')
    expect(JSON.stringify(rec?.ssnLeak)).toBe('"[sealed]"')

    const list = await c.list()
    expect(list.find((r) => r.id === 'r1')?.ssnLeak).toBe('[sealed]')

    // never stored regardless of taint.
    const raw = await c._getStoredRecord('r1')
    expect('ssnLeak' in (raw as Record<string, unknown>)).toBe(false)

    // still refused for querying (queryable:'none' is unconditional for virtual, not just taint-driven).
    expect(() => c.query().where('ssnLeak', '==', '123-45-6789')).toThrow(FieldNotQueryableError)
  })

  it('mode: "virtual" has no late-attach reconcile door — declaring it on a reconcile call throws', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: 'via-computed-virtual-reconcile-2026' })
    const v = await db.openVault('v1')
    v.collection<Item>('items', {}) // fresh, bare construction
    expect(() =>
      v.collection<Item>('items', {
        computed: { doubled: { fn: (r) => (r.amount as number) * 2, mode: 'virtual' } },
      }),
    ).toThrow(ValidationError)
  })
})
