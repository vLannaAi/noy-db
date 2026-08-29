/**
 * collection.describe() — sync config-merge (#483 Task 3) + async exact-types (#483 Task 4).
 *
 * Sync tests (zero-arg describe()): config-only, no store I/O.
 * Covers: money→currency inference, ref→entity inference, staticDict values,
 * fieldMeta label/semanticType/unit/displayFor override, zero-store-I/O guarantee.
 *
 * Async tests (describe(opts)): validator-derived exact types, zod-4 .meta() merge,
 * dynamic dict label resolution, fieldMeta key-validation, validator-agnostic invariant.
 */

import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../../src/kernel/noydb.js'
import { money } from '../../src/via/money/descriptor.js'
import { staticDict, dictKey } from '../../src/via/i18n/dictionary.js'
import { i18nText } from '../../src/via/i18n/core.js'
import { ref } from '../../src/kernel/refs.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
import { ConflictError } from '../../src/kernel/errors.js'
import { FieldMetaUnknownFieldError } from '../../src/with-shape/introspection/field-meta.js'

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c)
      const s: VaultSnapshot = {}
      if (comp) {
        for (const [n, coll] of comp) {
          if (!n.startsWith('_')) {
            const r: Record<string, EncryptedEnvelope> = {}
            for (const [id, e] of coll) r[id] = e
            s[n] = r
          }
        }
      }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

interface Sale {
  id: string
  saleDate: string
  total: string
  status: string
  buyerId: string
}

describe('collection.describe() — sync path', () => {
  it('infers currency + sum from money field, picks unit from fieldMeta', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-describe' })
    const v = await db.openVault('v')

    const saleStatus = staticDict('saleStatus', {
      pending:    { en: 'Pending' },
      to_verify:  { en: 'To Verify' },
      paid:       { en: 'Paid' },
    }, { displayLocale: 'en' })

    const sales = v.collection<Sale>('sales', {
      moneyFields: { total: money({ currency: 'EUR' }) },
      dictKeyFields: { status: saleStatus },
      refs: { buyerId: ref('buyers') },
      fieldMeta: {
        saleDate: { label: 'Date' },
        total:    { label: 'Total', unit: '€' },
        buyerId:  { label: 'Buyer', displayFor: 'buyerName' },
      },
    })

    const d = sales.describe()
    const byKey = Object.fromEntries(d.fields.map((f) => [f.key, f]))

    // Collection name
    expect(d.collection).toBe('sales')

    // money field: inferred semanticType/aggregate + fieldMeta unit
    expect(byKey.total!.semanticType).toBe('currency')
    expect(byKey.total!.aggregate).toBe('sum')
    expect(byKey.total!.unit).toBe('€')
    expect(byKey.total!.money).toMatchObject({ mode: 'fixed', currency: 'EUR' })
    expect(byKey.total!.type).toBe('number')

    // ref field: inferred entity + fieldMeta displayFor
    expect(byKey.buyerId!.semanticType).toBe('entity')
    expect(byKey.buyerId!.ref).toMatchObject({ target: 'buyers' })
    expect(byKey.buyerId!.displayFor).toBe('buyerName')
    expect(byKey.buyerId!.type).toBe('string')

    // staticDict: dict block + values with labels
    expect(byKey.status!.dict).toMatchObject({ name: 'saleStatus', static: true })
    expect(byKey.status!.dict?.values).toEqual(
      expect.arrayContaining([{ value: 'to_verify', label: 'To Verify' }]),
    )
    expect(byKey.status!.type).toBe('enum')

    // fieldMeta label override
    expect(byKey.saleDate!.label).toBe('Date')
  })

  it('zero store I/O: describe() does not touch the store', async () => {
    // Build on a real store so createNoydb / openVault succeed (keyring write etc.)
    const mem = inlineMemory()
    const db = await createNoydb({ store: mem, user: 'alice', secret: 'pw-describe-2' })
    const v = await db.openVault('w')
    const coll = v.collection<Sale>('sales2', {
      moneyFields: { total: money({ currency: 'USD' }) },
      refs: { buyerId: ref('buyers') },
    })

    // Spy on every store method AFTER the vault is open (so init writes don't trip us).
    // Any call during describe() will be recorded — we assert zero calls.
    const getspy   = vi.spyOn(mem, 'get')
    const putspy   = vi.spyOn(mem, 'put')
    const delspy   = vi.spyOn(mem, 'delete')
    const listspy  = vi.spyOn(mem, 'list')
    const loadspy  = vi.spyOn(mem, 'loadAll')
    const savespy  = vi.spyOn(mem, 'saveAll')

    // describe() is sync and config-only — must never touch any store method.
    const desc = coll.describe()

    expect(getspy).not.toHaveBeenCalled()
    expect(putspy).not.toHaveBeenCalled()
    expect(delspy).not.toHaveBeenCalled()
    expect(listspy).not.toHaveBeenCalled()
    expect(loadspy).not.toHaveBeenCalled()
    expect(savespy).not.toHaveBeenCalled()

    // Sanity: the description is still correct.
    expect(desc.collection).toBe('sales2')
    expect(desc.fields.length).toBeGreaterThan(0)
  })

  it('dynamic dictKey: values list uses declared keys, no label', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-describe-4' })
    const v = await db.openVault('v2')
    const { dictKey } = await import('../../src/via/i18n/dictionary.js')

    const orders = v.collection('orders', {
      dictKeyFields: { phase: dictKey('phase', ['open', 'closed'] as const) },
    })

    const d = orders.describe()
    const byKey = Object.fromEntries(d.fields.map((f) => [f.key, f]))
    expect(byKey.phase!.dict).toMatchObject({ name: 'phase', static: false })
    // dynamic: values have no label
    expect(byKey.phase!.dict?.values).toEqual(
      expect.arrayContaining([{ value: 'open' }, { value: 'closed' }]),
    )
  })

  it('refArray field has isArray:true in ref block and type:array', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-describe-5' })
    const v = await db.openVault('v3')
    const { refArray } = await import('../../src/kernel/refs.js')

    const tasks = v.collection('tasks', {
      refs: { tagIds: refArray('tags') },
    })

    const d = tasks.describe()
    const byKey = Object.fromEntries(d.fields.map((f) => [f.key, f]))
    expect(byKey.tagIds!.ref?.isArray).toBe(true)
    expect(byKey.tagIds!.type).toBe('array')
  })

  it('sync describe surfaces inline dictKey labels (#485)', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-describe-6' })
    const v = await db.openVault('v4')

    const orders = v.collection('orders485', {
      dictKeyFields: { status: dictKey('saleStatus', { draft: 'Draft', to_verify: 'To Verify' }) },
    })

    const f = orders.describe().fields.find((x) => x.key === 'status')!
    expect(f.dict?.values).toEqual(expect.arrayContaining([
      { value: 'draft', label: 'Draft' }, { value: 'to_verify', label: 'To Verify' },
    ]))
  })
})

// ─── Async describe(opts) — Task 4 (#483) ────────────────────────────────────

describe('collection.describe(opts) — async path', () => {
  /**
   * Shared vault + collections for async tests.
   *
   * zod-4 empirical finding (verified via `node -e "…z.toJSONSchema(schema)…"`):
   * toJSONSchema() emits .meta() keys INLINE on each JSON Schema property, at the
   * same level as `type` / `format`. For example:
   *   z.number().meta({ unit: 'kg' }) → { "type": "number", "unit": "kg" }
   * Keys mapped: label, description, unit, semanticType, sensitivity, aggregate,
   * aliases, displayFor. Unknown keys are ignored.
   * Optional fields are excluded from the `required` array at root level.
   */

  it('async describe derives exact types from the zod-4 validator', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-async-1' })
    const v = await db.openVault('av1')

    const salesSchema = z.object({
      id: z.string(),
      saleDate: z.string().optional(),
      total: z.number(),
      buyerId: z.string(),
    })

    const sales = v.collection('sales_async', {
      schema: salesSchema as unknown as import('../../src/kernel/schema.js').StandardSchemaV1,
    })

    const d = await sales.describe({})
    const byKey = Object.fromEntries(d.fields.map((f) => [f.key, f]))

    // Validator-derived types — not 'unknown'
    expect(byKey.saleDate!.type).toBe('string')
    expect(byKey.total!.type).toBe('number')
    // optional: saleDate is optional in zod schema, total/id are required
    expect(byKey.saleDate!.optional).toBe(true)
    expect(byKey.total!.optional).toBe(false)
  })

  it('async describe merges zod-4 .meta() when channel is silent', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-async-2' })
    const v = await db.openVault('av2')

    // net has .meta({ unit: 'kg' }), no fieldMeta entry for it
    const weightsSchema = z.object({
      id: z.string(),
      net: z.number().meta({ unit: 'kg' }),
    })

    const weights = v.collection('weights_async', {
      schema: weightsSchema as unknown as import('../../src/kernel/schema.js').StandardSchemaV1,
    })

    const d = await weights.describe({})
    const w = d.fields.find((f) => f.key === 'net')!

    // zod .meta({ unit: 'kg' }) should be merged via zodMeta path
    expect(w.unit).toBe('kg')
  })

  it('resolveDictLabels fills dynamic dict labels (async, reads _dict_)', async () => {
    const { withI18n } = await import('../../src/via/i18n/active.js')
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-async-3', i18nStrategy: withI18n() })
    const v = await db.openVault('av3')

    const tickets = v.collection('tickets_async', {
      dictKeyFields: { priority: dictKey('priority') },
    })

    await v.dictionary('priority').putAll({ hi: { en: 'High' }, lo: { en: 'Low' } })

    const d = await tickets.describe({ resolveDictLabels: true })
    const p = d.fields.find((f) => f.key === 'priority')!

    expect(p.dict?.values).toEqual(
      expect.arrayContaining([{ value: 'hi', label: 'High' }]),
    )
  })

  it('fieldMeta key-validation: typo in fieldMeta key rejects with FieldMetaUnknownFieldError', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-async-4' })
    const v = await db.openVault('av4')

    const schema = z.object({
      id: z.string(),
      total: z.number(),
    })

    // 'totl' is a typo — not a real field in the schema or any config.
    // Design pass: a Zod object's fields read synchronously, so this is now
    // refused at REGISTRATION and never reaches describe(). The check moved
    // earlier; it did not disappear.
    expect(() => v.collection('typo_coll', {
      schema: schema as unknown as import('../../src/kernel/schema.js').StandardSchemaV1,
      fieldMeta: {
        totl: { label: 'Total (typo)' },
      },
    })).toThrow(FieldMetaUnknownFieldError)
  })

  it('validator-agnostic: non-zod Standard-Schema validator + fieldMeta channel works in sync and async describe', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-async-5' })
    const v = await db.openVault('av5')

    // Hand-rolled Standard Schema v1 stub — vendor is NOT 'zod'
    const stubValidator: import('../../src/kernel/schema.js').StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'stub',
        validate: (value) => ({ value: value as Record<string, unknown> }),
      },
    }

    const c = v.collection('stub_coll', {
      schema: stubValidator,
      fieldMeta: {
        amount: { label: 'Amount', unit: '€' },
      },
    })

    // Sync describe — channel metadata must be present, no zod needed
    const syncDesc = c.describe()
    const syncField = syncDesc.fields.find((f) => f.key === 'amount')
    expect(syncField).toBeDefined()
    expect(syncField!.label).toBe('Amount')
    expect(syncField!.unit).toBe('€')

    // Async describe — same channel metadata; no zod = no exact types but no throw
    const asyncDesc = await c.describe({})
    const asyncField = asyncDesc.fields.find((f) => f.key === 'amount')
    expect(asyncField).toBeDefined()
    expect(asyncField!.label).toBe('Amount')
    expect(asyncField!.unit).toBe('€')
    // type falls back to 'unknown' since no zod schema (no JSON Schema derivable)
    expect(asyncField!.type).toBe('unknown')
  })

  // Fix 1 — fieldMeta reconcile on pre-created (cached) collection
  it('fieldMeta reconcile: re-declaring a cached collection with fieldMeta reflects label in describe()', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reconcile-1' })
    const v = await db.openVault('reconcile_vault')

    // First declaration — no fieldMeta (simulates MV auto-creation path)
    v.collection('rec_coll', {})

    // Second declaration with fieldMeta — must reconcile onto cached instance
    const c = v.collection('rec_coll', {
      fieldMeta: { price: { label: 'Unit Price', unit: '€' } },
    })

    const d = c.describe()
    const priceField = d.fields.find((f) => f.key === 'price')
    expect(priceField).toBeDefined()
    expect(priceField!.label).toBe('Unit Price')
    expect(priceField!.unit).toBe('€')
  })

  // Fix 2 — empty async dict must fall back to declared keys
  it('resolveDictLabels with empty store falls back to declared keys (async superset of sync)', async () => {
    const { withI18n } = await import('../../src/via/i18n/active.js')
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-emptydict-1', i18nStrategy: withI18n() })
    const v = await db.openVault('emptydict_vault')

    const c = v.collection('inv', {
      dictKeyFields: { status: dictKey('inv_status', ['draft', 'sent'] as const) },
    })

    // Do NOT call putAll — store is empty; resolveDictLabels returns {} for the dict
    const d = await c.describe({ resolveDictLabels: true })
    const statusField = d.fields.find((f) => f.key === 'status')!

    // Must surface the declared keys even though the store is empty
    const values = statusField.dict?.values?.map((entry) => entry.value)
    expect(values).toContain('draft')
    expect(values).toContain('sent')
  })
})

describe('DescribedField.id (#946)', () => {
  it('async describe() exposes a stable id per field once the schema is persisted', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: 'pw-fieldid-1' })
    let v = await db.openVault('fieldid_v1')

    const schema = z.object({ id: z.string(), amount: z.number() })
    v.collection('invoices', { schema, persistJsonSchema: true })
    await v._drainPendingSchemaWrites()

    // Reopen so describe()'s async path reads the just-persisted envelope
    // (mirrors the fence-state-accessor.test.ts fixture pattern).
    const db2 = await createNoydb({ store, user: 'alice', secret: 'pw-fieldid-1' })
    v = await db2.openVault('fieldid_v1')
    const invoices = v.collection('invoices', { schema, persistJsonSchema: true })

    const first = await invoices.describe({})
    const byKeyFirst = Object.fromEntries(first.fields.map((f) => [f.key, f]))
    expect(byKeyFirst.id!.id).toBeDefined()
    expect(byKeyFirst.amount!.id).toBeDefined()
    expect(byKeyFirst.id!.id).not.toBe(byKeyFirst.amount!.id)

    // Stable across a second describe() call.
    const second = await invoices.describe({})
    const byKeySecond = Object.fromEntries(second.fields.map((f) => [f.key, f]))
    expect(byKeySecond.id!.id).toBe(byKeyFirst.id!.id)
    expect(byKeySecond.amount!.id).toBe(byKeyFirst.amount!.id)
  })

  it('sync describe() never reads storage — id is always undefined', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: 'pw-fieldid-2' })
    const v = await db.openVault('fieldid_v2')

    const schema = z.object({ id: z.string(), amount: z.number() })
    const invoices = v.collection('invoices', { schema, persistJsonSchema: true })
    await v._drainPendingSchemaWrites()

    // Sync describe() takes no store I/O — id stays undefined even though a
    // persisted envelope with fieldIds now exists.
    const d = invoices.describe()
    for (const f of d.fields) expect(f.id).toBeUndefined()
  })

  it('a collection with no persisted schema yet — async describe() does not crash, id undefined', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-fieldid-3' })
    const v = await db.openVault('fieldid_v3')

    // No persistJsonSchema — never persisted, no `_schemas/<name>` envelope.
    const c = v.collection('bare', { fieldMeta: { amount: { label: 'Amount' } } })

    const d = await c.describe({})
    const f = d.fields.find((x) => x.key === 'amount')
    expect(f).toBeDefined()
    expect(f!.id).toBeUndefined()
  })
})

// ─── Task 3 (#483): i18n / widget / editable per-field enhancements ──────────

describe('collection.describe() — Task 3: i18n, widget, editable', () => {
  async function makeSalesVault() {
    const { withI18n } = await import('../../src/via/i18n/active.js')
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-t3-1', i18nStrategy: withI18n() })
    const v = await db.openVault('t3v1')

    // sales: total (money/currency), saleDate (z.iso.date semanticType), name (i18nText), subtotal (computed)
    const sales = v.collection('sales', {
      moneyFields: { total: money({ currency: 'EUR' }) },
      i18nFields: { name: i18nText({ languages: ['en', 'th'], required: 'all', densifyOnWrite: false }) },
      computed: { subtotal: () => 0 },
      fieldMeta: {
        saleDate: { label: 'Date', semanticType: 'date' },
        total: { label: 'Total', unit: '€' },
        name: { label: 'Name' },
      },
    })

    return { sales }
  }

  async function makeWidgetOverrideVault() {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-t3-2' })
    const v = await db.openVault('t3v2')

    // 'note' field with fieldMeta.widget override
    const withWidgetOverride = v.collection('notes', {
      fieldMeta: {
        note: { label: 'Note', widget: 'textarea' },
      },
    })

    return { withWidgetOverride }
  }

  it('surfaces i18n, derived widget, and editable', async () => {
    const { sales } = await makeSalesVault()
    // sales: total (money), saleDate (semanticType:date), name (i18nText), subtotal (computed)
    const d = sales.describe()
    const by = Object.fromEntries(d.fields.map(f => [f.key, f]))
    expect(by.total!.widget).toBe('money')
    expect(by.saleDate!.widget).toBe('date')
    expect(by.name!.i18n).toBeDefined()            // i18n block present
    expect(by.subtotal!.editable).toBe(false)      // computed → read-only
    expect(by.total!.editable).toBe(true)
  })

  it('fieldMeta.widget overrides the derived widget', async () => {
    const { withWidgetOverride } = await makeWidgetOverrideVault()
    const f = withWidgetOverride.describe().fields.find(x => x.key === 'note')!
    expect(f.widget).toBe('textarea')             // fieldMeta:{ note:{ widget:'textarea' } }
  })

  it('i18n block includes languages as locales and densifyOnWrite as densify', async () => {
    const { sales } = await makeSalesVault()
    const d = sales.describe()
    const name = d.fields.find(f => f.key === 'name')!
    expect(name.i18n).toBeDefined()
    expect(name.i18n?.locales).toEqual(['en', 'th'])
    expect(name.i18n?.densify).toBe(false)
  })

  it('editable=false for id field', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-t3-3' })
    const v = await db.openVault('t3v3')
    const c = v.collection('things', {
      fieldMeta: {
        id: { label: 'ID' },
        name: { label: 'Name' },
      },
    })
    const d = c.describe()
    const by = Object.fromEntries(d.fields.map(f => [f.key, f]))
    expect(by.id!.editable).toBe(false)
    expect(by.name!.editable).toBe(true)
  })

  it('widget derivation table: dict→select, default→text', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-t3-4' })
    const v = await db.openVault('t3v4')
    const c = v.collection('things', {
      dictKeyFields: { status: dictKey('status', ['a', 'b'] as const) },
      fieldMeta: {
        active: { label: 'Active', semanticType: 'boolean' as never },
        score: { label: 'Score', semanticType: 'number' as never },
        status: { label: 'Status' },
        note: { label: 'Note' },
      },
    })
    const d = c.describe()
    const by = Object.fromEntries(d.fields.map(f => [f.key, f]))
    // dict field → select
    expect(by.status!.widget).toBe('select')
    // non-special fieldMeta-only → text
    expect(by.note!.widget).toBe('text')
  })

  // Regression: i18nFields keys must be included in the async knownFields set so
  // validateFieldMetaKeys does not throw FieldMetaUnknownFieldError for fields that
  // live in i18nFields + fieldMeta but not in the zod schema (typical for i18nText).
  it('async describe does not throw when field is in both i18nFields and fieldMeta but not zod schema', async () => {
    const { withI18n } = await import('../../src/via/i18n/active.js')
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-t3-i18n-regress', i18nStrategy: withI18n() })
    const v = await db.openVault('t3v_i18n_regress')

    const c = v.collection('items', {
      i18nFields: { name: i18nText({ languages: ['en', 'th'], required: 'all', densifyOnWrite: false }) },
      fieldMeta: {
        name: { label: 'Item Name' },
      },
    })

    // Must not throw FieldMetaUnknownFieldError despite 'name' not being a zod schema field
    const d = await c.describe({})
    const nameField = d.fields.find(f => f.key === 'name')!
    expect(nameField).toBeDefined()
    expect(nameField.label).toBe('Item Name')
    expect(nameField.i18n).toBeDefined()
    expect(nameField.i18n?.locales).toEqual(['en', 'th'])
  })
})

/**
 * #1253 — fieldMeta key-validation on the SYNC path.
 *
 * The guard existed and was correct, but ran only on the async path, so a
 * typo'd key on `describe()` produced a phantom field carrying its declared
 * `sensitivity` while the real field went undescribed. Wrong in both
 * directions at once, silently, on the surface `sensitivity` exists to serve.
 *
 * Asserting the OUTPUT domain — "no described field may be one the collection
 * cannot have" — rather than the two inputs that happened to surface it.
 */
describe('#1253 fieldMeta key-validation on the sync path', () => {
  it('rejects a typo when a Zod schema is configured (the reported case)', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-1253-a' })
    const v = await db.openVault('v', { create: true })
    const mk = () => v.collection('workers', {
      schema: z.object({ id: z.string(), pin: z.string() }),
      fieldMeta: { pinn: { label: 'National ID', sensitivity: 'pii' } },
    })
    expect(mk).toThrow(FieldMetaUnknownFieldError)   // design pass: now at REGISTRATION
    await db.close()
  })

  it('stays silent when NO validator is configured — a TS generic carries real fields', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-1253-b' })
    const v = await db.openVault('v', { create: true })
    // The tempting-but-wrong rule is "no validator, so config keys are the whole
    // set". A collection typed by a TS generic alone has fields that are real and
    // in the data but in no runtime config, and fieldMeta legitimately names them.
    // Guarding here would reject correct code — see 'picks unit from fieldMeta'.
    const c = v.collection<{ id: string; saleDate: string }>('sales', {
      fieldMeta: { saleDate: { label: 'Date' } },
    })
    expect(() => c.describe()).not.toThrow()
    expect(c.describe().fields.map((f) => f.key)).toContain('saleDate')
    await db.close()
  })

  it('accepts a correct key and still carries sensitivity on the sync path', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-1253-c' })
    const v = await db.openVault('v', { create: true })
    const c = v.collection('workers', {
      schema: z.object({ id: z.string(), pin: z.string() }),
      fieldMeta: { pin: { label: 'National ID', sensitivity: 'pii' } },
    })
    const d = c.describe()
    const pin = d.fields.find((f) => f.key === 'pin')
    expect(pin?.sensitivity).toBe('pii')
    expect(pin?.label).toBe('National ID')
    // The control that gives the two rejections meaning: a legitimate schema
    // field is NOT rejected, so the guard discriminates rather than refusing.
    expect(d.fields.map((f) => f.key)).toContain('pin')
    await db.close()
  })

  it('stays silent for a validator whose fields hub cannot read', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-1253-d' })
    const v = await db.openVault('v', { create: true })
    // A StandardSchema-shaped validator with no readable `.shape`. Hub must not
    // guess: rejecting here would fail a legitimate field and teach people to
    // stop declaring fieldMeta.
    const opaque = { '~standard': { version: 1, vendor: 'x', validate: (x: unknown) => ({ value: x }) } }
    const c = v.collection('workers', {
      schema: opaque as never,
      fieldMeta: { whatever: { label: 'Whatever' } },
    })
    expect(() => c.describe()).not.toThrow()
    await db.close()
  })
})

/**
 * #1249 pilot report — object-level `.refine()` on Zod 3 wraps the object in
 * a ZodEffects whose `.shape` is undefined, so both field guards (#1253
 * fieldMeta, #1249 triggerBy match) were silent for exactly the schemas most
 * worth guarding. schemaFieldKeys now unwraps refinement effects — and ONLY
 * refinements: a transform changes the output shape, so its inner keys would
 * be a lie.
 *
 * #1262 (same pilot, second finding): `z.preprocess()` belongs on the UNWRAP
 * side, not the carve-out side — it rewrites the INPUT and then parses with
 * the inner schema, so the parsed keys ARE the inner keys. Following the
 * OUTPUT side is the one rule that covers every wrapper on both majors:
 * Zod 3 refinement/preprocess -> `_def.schema`; Zod 4 `ZodPipe` -> `_def.out`
 * (preprocess reaches the object, `.transform()` reaches a shapeless
 * ZodTransform and stays silent with no effect-kind test at all).
 *
 * `preprocess` and `transform` are one string apart and mean opposite things
 * here, so each is pinned against the other on BOTH majors.
 */
describe('schemaFieldKeys through ZodEffects (#1249 pilot report)', () => {
  it('fieldMeta guard fires through a Zod-3-style object-level refine', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-ze-1' })
    const v = await db.openVault('v', { create: true })
    // Zod 3 ZodEffects duck: `.shape` absent, object at `_def.schema`,
    // effect.type 'refinement'. (Hub's dev dep is Zod 4, where `.refine`
    // keeps `.shape` — this fixture pins the Zod 3 wire shape itself.)
    const zod3StyleEffects = {
      _def: { effect: { type: 'refinement' }, schema: z.object({ id: z.string(), pin: z.string() }) },
      '~standard': { version: 1, vendor: 'zod', validate: (x: unknown) => ({ value: x }) },
    }
    const mk = () => v.collection('workers', {
      schema: zod3StyleEffects as never,
      fieldMeta: { pinn: { label: 'National ID', sensitivity: 'pii' } },  // typo
    })
    expect(mk).toThrow(FieldMetaUnknownFieldError)   // design pass: now at REGISTRATION
    await db.close()
  })

  it('Zod 4 object-level refine keeps .shape — guard fires natively', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-ze-2' })
    const v = await db.openVault('v', { create: true })
    const mk = () => v.collection('workers', {
      schema: z.object({ id: z.string(), pin: z.string() }).refine(() => true, 'obj check'),
      fieldMeta: { pinn: { label: 'x' } },
    })
    expect(mk).toThrow(FieldMetaUnknownFieldError)   // design pass: now at REGISTRATION
    await db.close()
  })

  it('fieldMeta guard fires through a Zod-3-style preprocess (#1262)', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-ze-4' })
    const v = await db.openVault('v', { create: true })
    // z.preprocess(fn, inner) parses WITH `inner`, so the parsed record's keys
    // are inner's keys — measured on zod@3.25.76: preprocess({a,b}) -> ['a','b'].
    const zod3StylePreprocess = {
      _def: { effect: { type: 'preprocess' }, schema: z.object({ id: z.string(), pin: z.string() }) },
      '~standard': { version: 1, vendor: 'zod', validate: (x: unknown) => ({ value: x }) },
    }
    const mk = () => v.collection('workers', {
      schema: zod3StylePreprocess as never,
      fieldMeta: { pinn: { label: 'National ID', sensitivity: 'pii' } },  // typo
    })
    expect(mk).toThrow(FieldMetaUnknownFieldError)   // design pass: now at REGISTRATION
    await db.close()
  })

  it('Zod 4 z.preprocess is a ZodPipe — guard fires through the output side (#1262)', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-ze-5' })
    const v = await db.openVault('v', { create: true })
    const mk = () => v.collection('workers', {
      schema: z.preprocess((x) => x, z.object({ id: z.string(), pin: z.string() })),
      fieldMeta: { pinn: { label: 'x' } },
    })
    expect(mk).toThrow(FieldMetaUnknownFieldError)   // design pass: now at REGISTRATION
    await db.close()
  })

  it('Zod 4 .transform() is the opposite pipe direction and stays SILENT (#1262)', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-ze-6' })
    const v = await db.openVault('v', { create: true })
    // pipe(object -> transform): the OUTPUT side has no shape, so the probe
    // gives up rather than reporting the input's keys.
    const c = v.collection('workers', {
      schema: z.object({ id: z.string() }).transform((r) => ({ renamed: r.id })),
      fieldMeta: { anything: { label: 'x' } },
    })
    expect(() => c.describe()).not.toThrow()
    await db.close()
  })

  it('a Zod-4 preprocess control does NOT throw on a correct field (#1262)', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-ze-7' })
    const v = await db.openVault('v', { create: true })
    const c = v.collection('workers', {
      schema: z.preprocess((x) => x, z.object({ id: z.string(), pin: z.string() })),
      fieldMeta: { pin: { label: 'National ID', sensitivity: 'pii' } },
    })
    expect(() => c.describe()).not.toThrow()
    await db.close()
  })

  it('BOTH describe paths guard a wrapped schema — not the sync path only (#1262)', async () => {
    // Characterization, not a #1262 regression guard — the distinction matters.
    // The async assertion here was ALREADY true before #1262's fix (verified by
    // running it against the pre-fix source): derivePersistedSchema sees through
    // preprocess on its own, so the async path gets a populated field map and
    // never reaches the schemaFieldKeys fallback. Only the SYNC assertion below
    // can fail on pre-fix code.
    //
    // Both are pinned anyway because the two paths guard via INDEPENDENT
    // mechanisms — derived field map vs. the sync fallback — and nothing else
    // states that. A change to derivePersistedSchema could silently drop the
    // async half while every schemaFieldKeys test stays green.
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-ze-8' })
    const v = await db.openVault('v', { create: true })
    const mk = () => v.collection('workers', {
      schema: z.preprocess((x) => x, z.object({ id: z.string(), pin: z.string() })),
      fieldMeta: { pinn: { label: 'x' } },
    })
    expect(mk).toThrow(FieldMetaUnknownFieldError)
    // The async assertion that stood here is deliberately GONE, and the reason
    // is worth recording rather than deleting silently: once the guard runs at
    // registration, a schema whose fields read synchronously can no longer
    // REACH describe() with a bad key. So this schema cannot demonstrate the
    // two independent mechanisms any more. The describe-time check still
    // exists and is still correct — it now covers only the tier where fields
    // are NOT synchronously readable but ARE derivable (a non-Zod Standard
    // Schema validator; see the validator-agnostic test above). That tier is
    // narrower than it was, which is the intended consequence, not a gap.
    await db.close()
  })

  it('a transform-effect schema stays SILENT — inner keys describe the input, not the output', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-ze-3' })
    const v = await db.openVault('v', { create: true })
    const transformDuck = {
      _def: { effect: { type: 'transform' }, schema: z.object({ id: z.string() }) },
      '~standard': { version: 1, vendor: 'zod', validate: (x: unknown) => ({ value: x }) },
    }
    const c = v.collection('workers', {
      schema: transformDuck as never,
      fieldMeta: { anything: { label: 'x' } },
    })
    expect(() => c.describe()).not.toThrow()
    await db.close()
  })
})

/**
 * Design pass, decision 1 — "refuse as early as the information allows".
 *
 * The `fieldMeta` typo guard fired only at `describe()`, so a collection nobody
 * describes was never checked — and `fieldMeta` carries `sensitivity`, so the
 * unchecked case was the one with a data-classification inventory hanging off
 * it. It now also fires at `vault.collection()`.
 *
 * Three tiers of knowability, not two, which is why the describe-time check
 * STAYS rather than moving:
 *   always      — a name declared in the config itself (needs no schema at all;
 *                 see the virtual-field refusal in the derivation registry)
 *   at reg.     — a validator whose fields read synchronously   <- this block
 *   at describe — fields that exist only after async derivation
 * Hoisting alone would move the check earlier for some collections and remove
 * it entirely for others.
 */
describe('fieldMeta guard at REGISTRATION (design pass, decision 1)', () => {
  it('refuses a typo at vault.collection(), before anyone calls describe()', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reg-1' })
    const v = await db.openVault('v', { create: true })
    expect(() => v.collection('workers', {
      schema: z.object({ id: z.string(), pin: z.string() }),
      fieldMeta: { pinn: { label: 'National ID', sensitivity: 'pii' } },
    })).toThrow(FieldMetaUnknownFieldError)
    await db.close()
  })

  it('a correct key registers cleanly — the control', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reg-3' })
    const v = await db.openVault('v', { create: true })
    expect(() => v.collection('workers', {
      schema: z.object({ id: z.string(), pin: z.string() }),
      fieldMeta: { pin: { label: 'National ID', sensitivity: 'pii' } },
    })).not.toThrow()
    await db.close()
  })

  it('stays SILENT with no readable validator — a TS-generic collection is not a typo', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reg-4' })
    const v = await db.openVault('v', { create: true })
    // Real fields, present in the data, named by fieldMeta, in no runtime
    // config. Rejecting these teaches people to stop declaring fieldMeta.
    expect(() => v.collection<{ id: string; salary: number }>('staff', {
      fieldMeta: { salary: { label: 'Salary', sensitivity: 'pii' } },
    })).not.toThrow()
    await db.close()
  })
})
