/**
 * Regression test for issue #294:
 * `vault.dumpSchema()` returns `fields: {}` for collections whose schema is a
 * `z.discriminatedUnion(...)`.
 *
 * Root cause: `jsonSchemaToFields()` bailed early when the top-level JSON
 * Schema had `anyOf` instead of `properties` (which is what zod-to-json-schema
 * emits for a discriminated union).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import type { Noydb } from '../src/kernel/noydb.js'

function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
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
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

const Iv = z.object({ kind: z.literal('IV'), billId: z.string(), paidTotal: z.number() })
const Re = z.object({ kind: z.literal('RE'), billId: z.string(), amount: z.number() })
const ReceiptUnion = z.discriminatedUnion('kind', [Iv, Re])
const ReceiptUnionWithRefine = z.discriminatedUnion('kind', [Iv, Re]).superRefine(() => {})

describe('vault.dumpSchema() — discriminated union fields (#294)', () => {
  const COMP = 'firm'
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({ store: toMemory(), user: 'owner-01', secret: 'pass' })
  })

  it('surfaces fields for a bare discriminated union (persistJsonSchema)', async () => {
    const vault = await db.openVault(COMP)
    vault.collection('receipts', { schema: ReceiptUnion, persistJsonSchema: true })
    await vault._drainPendingSchemaWrites()

    const snap = await vault.dumpSchema()
    const fields = snap.collections['receipts']?.fields

    // 1. fields must NOT be empty
    expect(fields).toBeDefined()
    expect(Object.keys(fields!)).not.toHaveLength(0)

    // 2. common field billId is present
    expect(fields).toHaveProperty('billId')

    // 3. member-specific fields present (union of all member fields)
    expect(fields).toHaveProperty('paidTotal')
    expect(fields).toHaveProperty('amount')

    // 4. discriminator field kind is present and surfaces its literal set
    expect(fields).toHaveProperty('kind')
    const kindField = fields!['kind']
    expect(kindField?.type).toBe('enum')
    expect(kindField?.constraints?.values).toEqual(expect.arrayContaining(['IV', 'RE']))
  })

  it('member-specific fields are marked optional; common field billId is required', async () => {
    const vault = await db.openVault(COMP)
    vault.collection('receipts', { schema: ReceiptUnion, persistJsonSchema: true })
    await vault._drainPendingSchemaWrites()

    const snap = await vault.dumpSchema()
    const fields = snap.collections['receipts']?.fields!

    // billId is required in both members → not optional
    expect(fields['billId']?.optional).toBeFalsy()

    // paidTotal only in Iv member → optional
    expect(fields['paidTotal']?.optional).toBe(true)

    // amount only in Re member → optional
    expect(fields['amount']?.optional).toBe(true)
  })

  it('surfaces fields for a discriminated union wrapped in .superRefine() (ZodEffects)', async () => {
    const vault = await db.openVault(COMP)
    vault.collection('receipts', { schema: ReceiptUnionWithRefine, persistJsonSchema: true })
    await vault._drainPendingSchemaWrites()

    const snap = await vault.dumpSchema()
    const fields = snap.collections['receipts']?.fields

    // superRefine wrapping should NOT cause empty fields
    expect(fields).toBeDefined()
    expect(Object.keys(fields!)).not.toHaveLength(0)
    expect(fields).toHaveProperty('billId')
    expect(fields).toHaveProperty('kind')
  })

  it('live-validator path also surfaces fields for discriminated union (no persistJsonSchema)', async () => {
    const vault = await db.openVault(COMP)
    vault.collection('receipts', { schema: ReceiptUnion })

    const snap = await vault.dumpSchema()
    const fields = snap.collections['receipts']?.fields

    expect(fields).toBeDefined()
    expect(Object.keys(fields!)).not.toHaveLength(0)
    expect(fields).toHaveProperty('billId')
    expect(fields).toHaveProperty('kind')
    expect(fields).toHaveProperty('paidTotal')
    expect(fields).toHaveProperty('amount')
  })
})
