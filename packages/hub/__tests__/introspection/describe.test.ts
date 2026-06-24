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
import { createNoydb } from '../../src/noydb.js'
import { money } from '../../src/money/descriptor.js'
import { staticDict, dictKey } from '../../src/i18n/dictionary.js'
import { ref } from '../../src/refs.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/types.js'
import { ConflictError } from '../../src/errors.js'
import { FieldMetaUnknownFieldError } from '../../src/introspection/field-meta.js'

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
    expect(byKey.total.semanticType).toBe('currency')
    expect(byKey.total.aggregate).toBe('sum')
    expect(byKey.total.unit).toBe('€')
    expect(byKey.total.money).toMatchObject({ mode: 'fixed', currency: 'EUR' })
    expect(byKey.total.type).toBe('number')

    // ref field: inferred entity + fieldMeta displayFor
    expect(byKey.buyerId.semanticType).toBe('entity')
    expect(byKey.buyerId.ref).toMatchObject({ target: 'buyers' })
    expect(byKey.buyerId.displayFor).toBe('buyerName')
    expect(byKey.buyerId.type).toBe('string')

    // staticDict: dict block + values with labels
    expect(byKey.status.dict).toMatchObject({ name: 'saleStatus', static: true })
    expect(byKey.status.dict?.values).toEqual(
      expect.arrayContaining([{ value: 'to_verify', label: 'To Verify' }]),
    )
    expect(byKey.status.type).toBe('enum')

    // fieldMeta label override
    expect(byKey.saleDate.label).toBe('Date')
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
    const { dictKey } = await import('../../src/i18n/dictionary.js')

    const orders = v.collection('orders', {
      dictKeyFields: { phase: dictKey('phase', ['open', 'closed'] as const) },
    })

    const d = orders.describe()
    const byKey = Object.fromEntries(d.fields.map((f) => [f.key, f]))
    expect(byKey.phase.dict).toMatchObject({ name: 'phase', static: false })
    // dynamic: values have no label
    expect(byKey.phase.dict?.values).toEqual(
      expect.arrayContaining([{ value: 'open' }, { value: 'closed' }]),
    )
  })

  it('refArray field has isArray:true in ref block and type:array', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-describe-5' })
    const v = await db.openVault('v3')
    const { refArray } = await import('../../src/refs.js')

    const tasks = v.collection('tasks', {
      refs: { tagIds: refArray('tags') },
    })

    const d = tasks.describe()
    const byKey = Object.fromEntries(d.fields.map((f) => [f.key, f]))
    expect(byKey.tagIds.ref?.isArray).toBe(true)
    expect(byKey.tagIds.type).toBe('array')
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
      schema: salesSchema as unknown as import('../../src/schema.js').StandardSchemaV1,
    })

    const d = await sales.describe({})
    const byKey = Object.fromEntries(d.fields.map((f) => [f.key, f]))

    // Validator-derived types — not 'unknown'
    expect(byKey.saleDate.type).toBe('string')
    expect(byKey.total.type).toBe('number')
    // optional: saleDate is optional in zod schema, total/id are required
    expect(byKey.saleDate.optional).toBe(true)
    expect(byKey.total.optional).toBe(false)
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
      schema: weightsSchema as unknown as import('../../src/schema.js').StandardSchemaV1,
    })

    const d = await weights.describe({})
    const w = d.fields.find((f) => f.key === 'net')!

    // zod .meta({ unit: 'kg' }) should be merged via zodMeta path
    expect(w.unit).toBe('kg')
  })

  it('resolveDictLabels fills dynamic dict labels (async, reads _dict_)', async () => {
    const { withI18n } = await import('../../src/i18n/active.js')
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

    // 'totl' is a typo — not a real field in the schema or any config
    const c = v.collection('typo_coll', {
      schema: schema as unknown as import('../../src/schema.js').StandardSchemaV1,
      fieldMeta: {
        totl: { label: 'Total (typo)' },
      },
    })

    await expect(c.describe({})).rejects.toBeInstanceOf(FieldMetaUnknownFieldError)
  })

  it('validator-agnostic: non-zod Standard-Schema validator + fieldMeta channel works in sync and async describe', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-async-5' })
    const v = await db.openVault('av5')

    // Hand-rolled Standard Schema v1 stub — vendor is NOT 'zod'
    const stubValidator: import('../../src/schema.js').StandardSchemaV1 = {
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
})
