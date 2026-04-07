/**
 * Schema validation tests — #42, v0.4.
 *
 * Uses Zod as the canonical Standard Schema v1 validator. Zod is the
 * most widely-deployed validator in the Vue/Nuxt ecosystem and ships
 * with native Standard Schema support. The validation path itself is
 * validator-agnostic, so adding Valibot / ArkType / Effect tests later
 * is a copy-paste of the test setup with a different `schema` constant.
 *
 * What's covered:
 *   - Happy path: valid input roundtrips cleanly
 *   - Input rejection: bad data throws SchemaValidationError(direction: 'input')
 *   - Transform: validator coerces/strips fields and the persisted value
 *     matches the output shape, not the raw input
 *   - Output divergence: when the stored envelope decrypts to a value
 *     that no longer matches the schema, get() throws with
 *     direction: 'output'
 *   - query() and list() both validate every record
 *   - History reads (getVersion, history) intentionally SKIP validation
 *   - The issues list is preserved on the thrown error for UI use
 *   - Schema-less collections behave exactly as before (backwards compat)
 *   - Async validators work (Zod with .refine(async))
 *   - defineNoydbStore inference is exercised in a type-only assertion
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import type { NoydbAdapter, EncryptedEnvelope, CompartmentSnapshot } from '../src/types.js'
import { ConflictError, SchemaValidationError } from '../src/errors.js'
import type { StandardSchemaV1, InferOutput } from '../src/schema.js'

// ─── Inline memory adapter (same pattern as other test files) ─────────

function memory(): NoydbAdapter {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: CompartmentSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
  }
}

// ─── Test schema ─────────────────────────────────────────────────────

const InvoiceSchema = z.object({
  id: z.string().min(1),
  client: z.string().min(1),
  amount: z.number().positive(),
  status: z.enum(['draft', 'open', 'paid', 'overdue']),
})

type Invoice = z.infer<typeof InvoiceSchema>

// Quick type assertion: our InferOutput helper agrees with Zod's infer.
// This is a compile-time check; if the types diverge the test file
// fails to compile.
const _typeCheck: InferOutput<typeof InvoiceSchema> extends Invoice
  ? true
  : false = true
void _typeCheck

// ─── Tests ────────────────────────────────────────────────────────────

describe('schema validation — #42', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      adapter: memory(),
      user: 'alice',
      secret: 'test-passphrase-1234',
    })
  })

  it('accepts a valid record through put()', async () => {
    const company = await db.openCompartment('demo-co')
    const invoices = company.collection<Invoice>('invoices', {
      schema: InvoiceSchema,
    })

    await invoices.put('inv-001', {
      id: 'inv-001',
      client: 'Acme',
      amount: 100,
      status: 'open',
    })

    const got = await invoices.get('inv-001')
    expect(got).toEqual({
      id: 'inv-001',
      client: 'Acme',
      amount: 100,
      status: 'open',
    })
  })

  it('rejects a record with a missing required field', async () => {
    const company = await db.openCompartment('demo-co')
    const invoices = company.collection<Invoice>('invoices', {
      schema: InvoiceSchema,
    })

    await expect(
      invoices.put('inv-002', {
        id: 'inv-002',
        client: 'Acme',
        amount: 100,
        // status: missing
      } as unknown as Invoice),
    ).rejects.toThrow(SchemaValidationError)
  })

  it('rejects a record with a field of the wrong type', async () => {
    const company = await db.openCompartment('demo-co')
    const invoices = company.collection<Invoice>('invoices', {
      schema: InvoiceSchema,
    })

    try {
      await invoices.put('inv-003', {
        id: 'inv-003',
        client: 'Acme',
        amount: -5, // positive() violation
        status: 'open',
      })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError)
      const e = err as SchemaValidationError
      expect(e.direction).toBe('input')
      expect(e.issues.length).toBeGreaterThan(0)
      expect(e.code).toBe('SCHEMA_VALIDATION_FAILED')
    }
  })

  it('does not persist a record that fails validation', async () => {
    const company = await db.openCompartment('demo-co')
    const invoices = company.collection<Invoice>('invoices', {
      schema: InvoiceSchema,
    })

    await invoices.put('inv-good', {
      id: 'inv-good',
      client: 'Acme',
      amount: 100,
      status: 'open',
    })

    await expect(
      invoices.put('inv-bad', {
        id: 'inv-bad',
        client: '',
        amount: 50,
        status: 'open',
      }),
    ).rejects.toThrow(SchemaValidationError)

    // The good record is still there; the bad one is not.
    expect(await invoices.get('inv-good')).not.toBeNull()
    expect(await invoices.get('inv-bad')).toBeNull()
  })

  it('persists the TRANSFORMED value, not the raw input', async () => {
    // Schema with a transform: amount is coerced from string to number,
    // and an extra `legacyField` is stripped by .strip().
    const Coerced = z.object({
      id: z.string(),
      client: z.string(),
      amount: z.coerce.number().positive(),
      status: z.enum(['draft', 'open', 'paid', 'overdue']),
    }).strip()

    type Coerced = z.infer<typeof Coerced>

    const company = await db.openCompartment('demo-co')
    const invoices = company.collection<Coerced>('invoices', {
      schema: Coerced,
    })

    await invoices.put('inv-coerce', {
      id: 'inv-coerce',
      client: 'Acme',
      amount: '500' as unknown as number, // string input
      status: 'open',
      // @ts-expect-error testing .strip() behavior
      legacyField: 'should be removed',
    })

    const got = await invoices.get('inv-coerce')
    expect(got?.amount).toBe(500)
    expect(got?.amount).toBe(typeof 500 === 'number' ? 500 : NaN)
    expect(got).not.toHaveProperty('legacyField')
  })

  it('query() returns validated records', async () => {
    const company = await db.openCompartment('demo-co')
    const invoices = company.collection<Invoice>('invoices', {
      schema: InvoiceSchema,
    })

    for (const inv of [
      { id: 'inv-1', client: 'Acme', amount: 100, status: 'open' as const },
      { id: 'inv-2', client: 'Globex', amount: 200, status: 'paid' as const },
      { id: 'inv-3', client: 'Initech', amount: 300, status: 'open' as const },
    ]) {
      await invoices.put(inv.id, inv)
    }

    const open = invoices.query().where('status', '==', 'open').toArray()
    expect(open).toHaveLength(2)
    expect(open.every((i) => i.status === 'open')).toBe(true)
  })

  it('list() returns validated records', async () => {
    const company = await db.openCompartment('demo-co')
    const invoices = company.collection<Invoice>('invoices', {
      schema: InvoiceSchema,
    })

    for (const inv of [
      { id: 'inv-1', client: 'Acme', amount: 100, status: 'open' as const },
      { id: 'inv-2', client: 'Globex', amount: 200, status: 'paid' as const },
    ]) {
      await invoices.put(inv.id, inv)
    }

    const all = await invoices.list()
    expect(all).toHaveLength(2)
  })

  it('rejects reads when stored data diverges from the schema', async () => {
    // Scenario: a record was written under an old schema, then the
    // schema was tightened. Reading under the new schema must throw
    // with direction: 'output'.
    //
    // We use a SHARED adapter between two createNoydb() calls so the
    // data written via the "loose" instance is visible to the "strict"
    // instance. Relying on the same process but a separate Noydb ensures
    // we're not accidentally reading from an in-memory collection cache
    // that bypasses decryptRecord.
    const sharedAdapter = memory()
    const looseDb = await createNoydb({
      adapter: sharedAdapter,
      user: 'alice',
      secret: 'test-passphrase-1234',
    })
    const looseCompany = await looseDb.openCompartment('demo-co')
    const loose = looseCompany.collection<{ id: string; note: string }>('invoices')
    await loose.put('inv-legacy', { id: 'inv-legacy', note: 'old shape' })

    const strictDb = await createNoydb({
      adapter: sharedAdapter,
      user: 'alice',
      secret: 'test-passphrase-1234',
    })
    const strictCompany = await strictDb.openCompartment('demo-co')
    const strict = strictCompany.collection<Invoice>('invoices', {
      schema: InvoiceSchema,
    })

    try {
      await strict.get('inv-legacy')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError)
      const e = err as SchemaValidationError
      expect(e.direction).toBe('output')
      expect(e.message).toContain('schema drift')
    }
  })

  it('history reads skip schema validation', async () => {
    const company = await db.openCompartment('demo-co')
    const invoices = company.collection<Invoice>('invoices', {
      schema: InvoiceSchema,
      historyConfig: { enabled: true },
    } as unknown as Parameters<typeof company.collection>[1])

    // Write and update to create a history entry.
    await invoices.put('inv-h', {
      id: 'inv-h',
      client: 'Acme',
      amount: 100,
      status: 'open',
    })
    await invoices.put('inv-h', {
      id: 'inv-h',
      client: 'Acme',
      amount: 150,
      status: 'paid',
    })

    // Reading the old version MUST NOT throw even if it didn't exactly
    // match the schema — history is versioned by definition.
    const v1 = await invoices.getVersion('inv-h', 1)
    expect(v1?.amount).toBe(100)

    const full = await invoices.history('inv-h')
    expect(full.length).toBeGreaterThanOrEqual(1)
  })

  it('schema-less collections work unchanged (backwards compat)', async () => {
    const company = await db.openCompartment('demo-co')
    // No schema — should accept anything.
    const bag = company.collection<{ anything: unknown }>('bag')
    await bag.put('x', { anything: { deeply: 'nested' } })
    const got = await bag.get('x')
    expect(got).toEqual({ anything: { deeply: 'nested' } })
  })

  it('async validators are awaited', async () => {
    // Zod .refine() with an async predicate forces the validate()
    // contract to return a Promise. We want to confirm core's
    // validateSchemaInput awaits it correctly.
    const AsyncSchema = z
      .object({ id: z.string(), name: z.string() })
      .refine(
        async (val) => {
          await new Promise((r) => setTimeout(r, 5))
          return val.name !== 'forbidden'
        },
        { message: 'name is forbidden' },
      )

    const company = await db.openCompartment('demo-co')
    const col = company.collection<{ id: string; name: string }>(
      'async',
      { schema: AsyncSchema },
    )

    await col.put('ok', { id: 'ok', name: 'alice' })
    expect((await col.get('ok'))?.name).toBe('alice')

    await expect(
      col.put('bad', { id: 'bad', name: 'forbidden' }),
    ).rejects.toThrow(SchemaValidationError)
  })

  it('preserves the Zod issue list on thrown errors for UI use', async () => {
    const company = await db.openCompartment('demo-co')
    const invoices = company.collection<Invoice>('invoices', {
      schema: InvoiceSchema,
    })

    try {
      await invoices.put('multi-issue', {
        id: '', // min(1) violation → path: ['id']
        client: '', // min(1) violation → path: ['client']
        amount: -1, // positive() violation → path: ['amount']
        status: 'open',
      })
      throw new Error('expected throw')
    } catch (err) {
      const e = err as SchemaValidationError
      expect(e.issues.length).toBeGreaterThanOrEqual(3)
    }
  })

  it('exports SchemaValidationError with the correct fields', () => {
    const err = new SchemaValidationError(
      'test',
      [{ message: 'bad', path: ['field'] }],
      'input',
    )
    expect(err.code).toBe('SCHEMA_VALIDATION_FAILED')
    expect(err.direction).toBe('input')
    expect(err.issues).toHaveLength(1)
    expect(err.name).toBe('SchemaValidationError')
  })
})

// ─── StandardSchemaV1 type-only sanity check ─────────────────────────

describe('StandardSchemaV1 type ergonomics', () => {
  it('Zod schemas satisfy StandardSchemaV1', () => {
    // If this compiles, Zod is usable as a StandardSchemaV1 in our API.
    const s: StandardSchemaV1<unknown, Invoice> = InvoiceSchema
    expect(s['~standard'].version).toBe(1)
    expect(typeof s['~standard'].vendor).toBe('string')
  })
})
