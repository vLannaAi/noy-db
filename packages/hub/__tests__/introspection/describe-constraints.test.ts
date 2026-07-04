/**
 * Async describe({}) validator-derived constraints → DescribedField.constraints.
 *
 * deriveZodFields extracts constraints (minimum/maximum/maxLength/...) via
 * jsonSchemaToFields, but the field-assembly block in describe.ts must spread
 * them onto the emitted DescribedField or they're silently dropped.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
import { ConflictError } from '../../src/kernel/errors.js'

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

describe('async describe({}) surfaces validator constraints', () => {
  it('zod min/max and maxLength flow onto DescribedField.constraints', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-constraints' })
    const v = await db.openVault('v')
    const col = v.collection('items', {
      schema: z.object({
        id: z.string(),
        year: z.number().int().min(1900).max(2100),
        notes: z.string().max(300).optional(),
      }),
    })
    const fields = (await col.describe({})).fields
    const year = fields.find((f) => f.key === 'year')!
    expect(year.constraints).toMatchObject({ minimum: 1900, maximum: 2100 })
    const notes = fields.find((f) => f.key === 'notes')!
    expect(notes.constraints).toMatchObject({ maxLength: 300 })
    expect(notes.optional).toBe(true)
  })

  it('sync describe() (no validator run) emits no constraints key', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-constraints' })
    const v = await db.openVault('v2')
    // Sync describe() is config-only (zodFields: undefined) — a field only appears
    // in the emitted array if it's referenced by config (fieldMeta here), since
    // schema-only keys aren't knowable without running the async validator derivation.
    const col = v.collection('items', {
      schema: z.object({ id: z.string(), n: z.number().min(1) }),
      fieldMeta: { n: { label: 'N' } },
    })
    const n = col.describe().fields.find((f) => f.key === 'n')!
    expect('constraints' in n).toBe(false)
  })
})
