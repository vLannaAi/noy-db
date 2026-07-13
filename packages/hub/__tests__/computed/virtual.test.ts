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
import { dictKey } from '../../src/shape/via-i18n/dictionary.js'
import { withI18n } from '../../src/shape/via-i18n/index.js'
import { dict } from '../../src/shape/via-lookup/descriptor.js'

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

  it('composed grammar: via(computed(...), money(...)) on one field is accepted and computes, but money never dresses the virtual output — KNOWN LIMITATION (value-shape, not ordering)', async () => {
    // Decision 5's locked grammar (`via(computed(fn, { deps, mode }), money('EUR'))`) —
    // this pins that the composition is LEGAL and produces the computed function's raw
    // result, undressed. `_presentOrder` (`kernel/via-pipeline.ts`) is a THREE-WAY
    // partition (money-brand bindings, then computed-brand bindings, then everything
    // else) that deliberately keeps money FIRST, at its pre-#665 present position — an
    // early #665 draft ran money AFTER computed (a two-way computed-first partition) and
    // that regressed this composition from a benign missing-dressing gap into VALUE
    // CORRUPTION: money's `present()` (`decodeMoneyFields`, `via-money/binding.ts`)
    // unconditionally treats its input as a STORED SCALED-INT and derives both the
    // decoded amount and `<field>Formatted` from it, so a virtual computed field's raw
    // MAJOR-unit output (`21`) was misread as 21 SCALED units and decoded to `'0.21'`
    // EUR — wrong VALUE, not just missing dressing. With money restored to first, money's
    // present() runs BEFORE the virtual value exists (nothing stored to decode yet) and
    // computed's present() unconditionally sets the field afterward, so the raw computed
    // number survives untouched and no `<field>Formatted` key is ever added — exactly
    // the pre-#665 shape. This is a value-shape limitation, not an ordering one: money
    // would need a quantize-the-computed-output decision (is `21` already scaled, or
    // does money need to scale it?) before it could safely dress a virtual field's own
    // output, and that decision is left for a filed follow-up, not resolved by ordering.
    interface Priced extends Record<string, unknown> { id: string; base: number; doubledPrice?: string | number; doubledPriceFormatted?: string }
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
    expect(read?.doubledPriceFormatted).toBeUndefined() // no dressing — money's present() ran before the virtual value existed
    expect(() => c.query().where('doubledPrice', '==', 21)).toThrow(FieldNotQueryableError)
  })

  it('#665 regression pin: composed via(computed(virtual), money(...)) NEVER produces a scaled-down string like \'0.21\' — pins the three-way present partition (money-first) against a future regression to a generic computed-first order', async () => {
    // This is the corruption case an EARLIER, REJECTED #665 draft actually produced (a
    // two-way `[computed..., rest...]` partition ran money's decode AFTER the virtual
    // value existed, so money misread the raw major-unit `21` as a scaled-int and
    // decoded it to `'0.21'` EUR). The test above pins the (benign) KNOWN LIMITATION
    // shape; this test pins the ABSENCE of the corrupted shape specifically, so a future
    // change that reintroduces a generic computed-first partition (dropping money's
    // carve-out) fails loudly here, not just via the KNOWN LIMITATION test's exact-value
    // assertion. Asserts both value AND type — a scaled-down numeric `0.21` would be just
    // as wrong as the string `'0.21'`.
    interface Priced extends Record<string, unknown> { id: string; base: number; doubledPrice?: string | number }
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: 'via-computed-virtual-stack-regression-2026' })
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
    expect(read?.doubledPrice).not.toBe('0.21')
    expect(read?.doubledPrice).toBe(21)
    expect(typeof read?.doubledPrice).toBe('number')
  })

  it('composed grammar (MATERIALIZED default): via(computed(fn, { mode: "materialized" }), money(...)) on one field — money DOES format the computed output (pins the OPPOSITE of the virtual-mode case above)', async () => {
    // Unlike `mode: 'virtual'` above, a MATERIALIZED computed field is
    // evaluated by `evalComputedFields` in `_putInternal` BEFORE
    // `this.via.encodeWrite` runs (collection.ts's "Computed scalar fields —
    // evaluated FIRST" comment) — its raw output is merged into the record
    // exactly like any user-supplied value, so money's OWN encode/decode/
    // present hooks (which also cover this field, per `compileViaBindings`'s
    // ordering) apply to it normally on both write and read, same as a plain
    // money field (money/read-parity.test.ts's '122.00'-style decimal-string
    // format). Pinned empirically — do not change this behavior, only this
    // test's assertion, if it ever proves wrong.
    interface Priced extends Record<string, unknown> { id: string; base: number; total?: string | number }
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: 'via-computed-materialized-stack-2026' })
    const v = await db.openVault('v1')
    const c = v.collection<Priced>('priced', {
      viaFields: {
        total: via(
          computed((r) => (r.base as number) * 2, { deps: ['base'], mode: 'materialized' }),
          money({ currency: 'EUR', scale: 2 }),
        ),
      },
    })
    await c.put('a', { id: 'a', base: 10.5 })
    const read = await c.get('a')
    expect(read?.total).toBe('21.00')
    // materialized: STORED (unlike virtual mode) — money's own encode already
    // quantized the computed output before persistence.
    const raw = await c._getStoredRecord('a')
    expect((raw as Priced)?.total).toBeDefined()
  })

  // #631 review round 2 — the collision guard's `computed` exemption (kernel/
  // collection-config.ts#guardCrossBindingFieldCollisions) covers `money`/`i18n`/`lookup`
  // uniformly, on the theory that `mergeViaFields` folds `via()`-composition and two
  // independent sugar-map declarations into byte-IDENTICAL merged field maps — so if one
  // style genuinely composes, the other must too (provenance is erased before the guard
  // ever sees the config). Money's own proof is the pair of tests directly above; these
  // pin the SAME claim for the `i18n` (dictKey) and `lookup` (dict()) families, in BOTH
  // declaration styles, and — since #665 — pin that virtual mode now dresses too:
  // `ViaPipeline`'s `present()` folds over a present-phase-local `_presentOrder`
  // (`kernel/via-pipeline.ts`) that puts every `'computed'`-brand binding first, so a
  // virtual field's value exists BEFORE i18n/lookup's dressing `present()` hooks run on
  // it (previously `compileViaBindings`'s money→i18n→lookup→classified→blob→computed
  // ordering ran computed LAST, so a virtual field's label could never be dressed off a
  // value that didn't exist yet). Money is the one family #665 deliberately does NOT fix
  // for the composed-on-itself case — see the KNOWN LIMITATION test above and its comment.
  describe('composed grammar — computed + i18n/lookup families (#631 collision-guard exemption pins)', () => {
    interface Order extends Record<string, unknown> { id: string; base: number; status?: string; statusLabel?: string }

    async function labeledVault() {
      const store = inlineMemory()
      const db = await createNoydb({
        store, user: 'alice', secret: 'via-computed-i18n-lookup-2026', i18nStrategy: withI18n(),
      })
      const v = await db.openVault('v1')
      await v.dictionary('status').putAll({
        draft: { en: 'Draft', th: 'ฉบับร่าง' },
        paid: { en: 'Paid', th: 'ชำระแล้ว' },
      })
      return v
    }

    const statusFn = (r: Record<string, unknown>): string => ((r.base as number) >= 10 ? 'paid' : 'draft')

    it('via(computed(fn, { mode: "materialized" }), dictKey(...)) on one field — dictKey label dressing applies to the computed output (i18n family)', async () => {
      const v = await labeledVault()
      const c = v.collection<Order>('orders', {
        viaFields: {
          status: via(computed(statusFn, { mode: 'materialized' }), dictKey('status', ['draft', 'paid'] as const)),
        },
      })
      await c.put('a', { id: 'a', base: 25 })
      const read = await c.get('a', { locale: 'th' })
      expect(read?.status).toBe('paid')
      expect(read?.statusLabel).toBe('ชำระแล้ว')
      // materialized: STORED — the computed output is a plain field by the time dictKey's
      // (no-op on write) binding and money-precedent-style read dressing see it.
      const raw = await c._getStoredRecord('a')
      expect((raw as Order)?.status).toBe('paid')
    })

    it('two-sugar-maps (no via()): computed: {...} + dictKeyFields: {...} on the SAME field dresses <field>Label identically to the via()-composed form above (i18n family)', async () => {
      const v = await labeledVault()
      const c = v.collection<Order>('orders', {
        computed: { status: statusFn },
        dictKeyFields: { status: dictKey('status', ['draft', 'paid'] as const) },
      })
      await c.put('a', { id: 'a', base: 3 })
      const read = await c.get('a', { locale: 'th' })
      expect(read?.status).toBe('draft')
      expect(read?.statusLabel).toBe('ฉบับร่าง')
    })

    it('via(computed(fn, { mode: "virtual" }), dictKey(...)) on one field — #665: computed\'s present() now runs FIRST, so dictKey dresses the virtual value\'s label', async () => {
      const v = await labeledVault()
      const c = v.collection<Order>('orders', {
        viaFields: {
          status: via(computed(statusFn, { deps: ['base'], mode: 'virtual' }), dictKey('status', ['draft', 'paid'] as const)),
        },
      })
      await c.put('a', { id: 'a', base: 25 })
      const read = await c.get('a', { locale: 'th' }) as Order
      expect(read.status).toBe('paid') // the virtual value itself still computes correctly
      expect(read.statusLabel).toBe('ชำระแล้ว') // dressed — computed's present() ran BEFORE dictKey's
      const raw = await c._getStoredRecord('a')
      expect('status' in (raw as Record<string, unknown>)).toBe(false) // never stored (virtual)
    })

    it('via(computed(fn, { mode: "materialized" }), dict(...)) on one field — lookup label dressing applies to the computed output (lookup family)', async () => {
      const v = await labeledVault()
      const c = v.collection<Order>('orders', {
        viaFields: {
          status: via(computed(statusFn, { mode: 'materialized' }), dict('status')),
        },
      })
      await c.put('a', { id: 'a', base: 25 })
      const read = await c.get('a', { locale: 'th' })
      expect(read?.status).toBe('paid')
      expect(read?.statusLabel).toBe('ชำระแล้ว')
    })

    it('two-sugar-maps (no via()): computed: {...} + lookupFields: {...} on the SAME field dresses <field>Label identically to the via()-composed form above (lookup family)', async () => {
      const v = await labeledVault()
      const c = v.collection<Order>('orders', {
        computed: { status: statusFn },
        lookupFields: { status: dict('status') },
      })
      await c.put('a', { id: 'a', base: 3 })
      const read = await c.get('a', { locale: 'th' })
      expect(read?.status).toBe('draft')
      expect(read?.statusLabel).toBe('ฉบับร่าง')
    })

    it('via(computed(fn, { mode: "virtual" }), dict(...)) on one field — #665: same fix as dictKey above, lookup dresses the virtual value\'s label too (lookup family)', async () => {
      const v = await labeledVault()
      const c = v.collection<Order>('orders', {
        viaFields: {
          status: via(computed(statusFn, { deps: ['base'], mode: 'virtual' }), dict('status')),
        },
      })
      await c.put('a', { id: 'a', base: 25 })
      const read = await c.get('a', { locale: 'th' }) as Order
      expect(read.status).toBe('paid')
      expect(read.statusLabel).toBe('ชำระแล้ว')
    })
  })

  // #665 second-order effects — pinned explicitly so the design choice is on the record,
  // not just implicit in `_presentOrder`'s partition (`kernel/via-pipeline.ts`).
  describe('#665 present-order — second-order effects (pinned, not just implicit)', () => {
    it('(a) chained virtual computeds: a LATER-declared field reading an EARLIER-declared virtual field\'s output works — declaration order, not a topo sort, and unaffected by #665', async () => {
      // The `computed` binding is ONE ViaBinding covering every virtual field on the
      // collection (`shape/via-computed/binding.ts`'s `present` loops `cfg.virtualFields`,
      // a Map in DECLARATION order, mutating the SAME threaded record as it goes) — so
      // chaining across two virtual computed fields is entirely INTERNAL to that one
      // binding's present() and was never affected by where `computed` sits in the outer
      // `present()` fold, before or after #665. It works here because `quadrupled` is
      // declared AFTER `doubled` — swap the declaration order and it breaks (see (a2)).
      // #665 does not attempt a real topological sort of computed-to-computed deps; this
      // pins that today's "declaration order = compile order" behavior is unchanged.
      interface Item extends Record<string, unknown> { id: string; amount: number; doubled?: number; quadrupled?: number }
      const store = inlineMemory()
      const db = await createNoydb({ store, user: 'alice', secret: 'via-computed-665-chain-a-2026' })
      const v = await db.openVault('v1')
      const c = v.collection<Item>('items', {
        viaFields: {
          doubled: via(computed((r) => (r.amount as number) * 2, { deps: ['amount'], mode: 'virtual' })),
          quadrupled: via(computed((r) => ((r.doubled as number | undefined) ?? -999) * 2, { deps: ['doubled'], mode: 'virtual' })),
        },
      })
      await c.put('r1', { id: 'r1', amount: 5 })
      const read = await c.get('r1')
      expect(read?.doubled).toBe(10)
      expect(read?.quadrupled).toBe(20)
    })

    it('(a2) KNOWN LIMITATION: the SAME chain declared in reverse order sees a stale/missing upstream value — confirms (a) is declaration-order, not a real dependency-graph sort', async () => {
      interface Item extends Record<string, unknown> { id: string; amount: number; doubled?: number; quadrupled?: number }
      const store = inlineMemory()
      const db = await createNoydb({ store, user: 'alice', secret: 'via-computed-665-chain-a2-2026' })
      const v = await db.openVault('v1')
      const c = v.collection<Item>('items', {
        viaFields: {
          // quadrupled declared BEFORE doubled — its fn runs first and reads `doubled`
          // before that key has been set on the threaded record.
          quadrupled: via(computed((r) => ((r.doubled as number | undefined) ?? -999) * 2, { deps: ['doubled'], mode: 'virtual' })),
          doubled: via(computed((r) => (r.amount as number) * 2, { deps: ['amount'], mode: 'virtual' })),
        },
      })
      await c.put('r1', { id: 'r1', amount: 5 })
      const read = await c.get('r1')
      expect(read?.doubled).toBe(10) // computes fine on its own
      expect(read?.quadrupled).toBe(-1998) // (-999) * 2 — read `doubled` before it existed
    })

    it('(b) KNOWN LIMITATION introduced by #665: a virtual computed field reading a DIFFERENT field\'s i18n/lookup dressing (e.g. `<field>Label`) no longer sees it — computed now runs FIRST, before dressing hooks add it', async () => {
      // Before #665, `present()` ran computed LAST, so a virtual field's `fn` could read
      // ANOTHER field's dressing output (money `Formatted`, i18n/lookup `Label`) because
      // by the time computed ran, every dressing hook earlier in the fold had already
      // added its key to the threaded record. #665 flips that: computed now runs FIRST,
      // so a virtual field can no longer see any OTHER field's dressing. This reverse
      // composition (dressing -> computed, as opposed to computed -> dressing, the
      // ratified #665 scope) was never pinned by an existing test and is not part of
      // #665's ratified scope (i18n/lookup dressing a computed field's OWN output) — this
      // test makes the tradeoff explicit rather than leaving it an undocumented side effect.
      const store = inlineMemory()
      const db = await createNoydb({
        store, user: 'alice', secret: 'via-computed-665-reverse-b-2026', i18nStrategy: withI18n(),
      })
      const v = await db.openVault('v1')
      await v.dictionary('status').putAll({
        draft: { en: 'Draft', th: 'ฉบับร่าง' },
        paid: { en: 'Paid', th: 'ชำระแล้ว' },
      })
      interface Order2 extends Record<string, unknown> { id: string; status?: string; statusLabel?: string; summary?: string }
      const c = v.collection<Order2>('orders', {
        viaFields: {
          status: via(dictKey('status', ['draft', 'paid'] as const)),
          summary: via(computed((r) => `label=${(r.statusLabel as string | undefined) ?? 'MISSING'}`, { deps: ['status'], mode: 'virtual' })),
        },
      })
      await c.put('a', { id: 'a', status: 'paid' })
      const read = await c.get('a', { locale: 'th' }) as Order2
      expect(read.statusLabel).toBe('ชำระแล้ว') // status's own dressing still works
      expect(read.summary).toBe('label=MISSING') // but summary's computed ran BEFORE it existed
    })
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
