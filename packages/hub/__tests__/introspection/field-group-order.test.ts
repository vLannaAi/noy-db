/**
 * FieldMeta group/order → DescribedField (Item Release, UI card grouping).
 *
 * group/order are descriptive layout hints: they surface on DescribedField
 * (channel > zod .meta() > inferred precedence, like every other meta key)
 * while the emitted fields array stays alphabetically sorted.
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

describe('FieldMeta group/order flow through describe()', () => {
  async function collectionWith(fieldMeta: Record<string, Record<string, unknown>>) {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-group-order' })
    const v = await db.openVault('v')
    return v.collection('invoices', {
      schema: z.object({ id: z.string(), total: z.number(), issuedOn: z.string() }),
      fieldMeta: fieldMeta as never,
    })
  }

  it('channel fieldMeta group/order surface on DescribedField', async () => {
    const col = await collectionWith({
      total: { label: 'Total', group: 'Amounts', order: 2 },
      issuedOn: { label: 'Issued', group: 'Dates', order: 1 },
    })
    const fields = col.describe().fields
    const total = fields.find((f) => f.key === 'total')!
    expect(total.group).toBe('Amounts')
    expect(total.order).toBe(2)
    const issued = fields.find((f) => f.key === 'issuedOn')!
    expect(issued.group).toBe('Dates')
    expect(issued.order).toBe(1)
  })

  it('fields stay alphabetically sorted in the emitted array (group/order are metadata only)', async () => {
    const col = await collectionWith({ total: { label: 'Total', order: 1 } })
    const keys = col.describe().fields.map((f) => f.key)
    expect(keys).toEqual([...keys].sort())
  })

  it('zod .meta() group/order flow through the async describe path, channel wins', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-group-order' })
    const v = await db.openVault('v2')
    const col = v.collection('items', {
      schema: z.object({
        id: z.string(),
        a: z.number().meta({ group: 'FromZod', order: 7 }),
        b: z.number().meta({ group: 'Loser' }),
      }),
      fieldMeta: { b: { label: 'B', group: 'ChannelWins' } } as never,
    })
    const fields = (await col.describe({})).fields
    expect(fields.find((f) => f.key === 'a')!.group).toBe('FromZod')
    expect(fields.find((f) => f.key === 'a')!.order).toBe(7)
    expect(fields.find((f) => f.key === 'b')!.group).toBe('ChannelWins')
  })

  it('absent group/order are absent, not undefined-valued keys', async () => {
    const col = await collectionWith({ total: { label: 'Total' } })
    const total = col.describe().fields.find((f) => f.key === 'total')!
    expect('group' in total).toBe(false)
    expect('order' in total).toBe(false)
  })
})
