/**
 * Collection.validateInput — validate a record against the collection schema
 * WITHOUT writing it. Used by FR-8 migrate-then-merge to pre-validate staged
 * records before any merge write.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/errors.js'

// ─── Inline memory adapter (mirrored from schema.test.ts) ─────────────

function memory(): NoydbStore {
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

// ─── Test schema ──────────────────────────────────────────────────────

const ItemSchema = z.object({
  id: z.string(),
  n: z.number(),
})

type Item = z.infer<typeof ItemSchema>

// ─── Tests ────────────────────────────────────────────────────────────

describe('Collection.validateInput', () => {
  it('returns the record when it matches the schema', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'test-passphrase-1234',
    })
    const vault = await db.openVault('test-co')
    const c = vault.collection<Item>('items', { schema: ItemSchema })

    await expect(c.validateInput({ id: 'a', n: 1 })).resolves.toEqual({ id: 'a', n: 1 })
  })

  it('throws when the record violates the schema (without writing)', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'test-passphrase-1234',
    })
    const vault = await db.openVault('test-co')
    const c = vault.collection<Item>('items', { schema: ItemSchema })

    await expect(c.validateInput({ id: 'a', n: 'not-a-number' } as never)).rejects.toThrow()
    // nothing was written:
    expect(await c.get('a')).toBeNull()
  })

  it('passes any record through when the collection has no schema', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'test-passphrase-1234',
    })
    const vault = await db.openVault('test-co')
    const c = vault.collection('items')

    await expect(c.validateInput({ anything: true } as never)).resolves.toEqual({ anything: true })
  })
})
