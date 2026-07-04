/**
 * Task 5: describe()/toJSONSchema() classified metadata emission.
 * @module
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { classified } from '../../src/with-shape/classified/index.js'
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

describe('classified in describe()/toJSONSchema()', () => {
  it('describe() emits the classified block and inferred sensitivity', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-de-1' })
    const v = await db.openVault('v1')
    const c = v.collection('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan', cvc: 'cvc' }) },
    })
    const desc = c.describe()
    const pan = desc.fields.find((f) => f.key === 'pan')!
    expect(pan.classified).toEqual({
      preset: 'creditCard.pan', storage: 'recoverable', list: { mask: '•••• ${last4}' },
    })
    expect(pan.sensitivity).toBe('secret')
    const cvc = desc.fields.find((f) => f.key === 'cvc')!
    expect(cvc.classified).toEqual({ preset: 'creditCard.cvc', storage: 'never', list: 'omit' })
  })

  it('toJSONSchema() emits x-classified', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-de-2' })
    const v = await db.openVault('v2')
    const c = v.collection('people', { classifiedFields: { dob: classified.birthDate() } })
    const js = await c.toJSONSchema() as { properties: Record<string, Record<string, unknown>> }
    expect(js.properties.dob!['x-classified']).toEqual({
      preset: 'birthDate', storage: 'recoverable', list: { mask: '${yob}-••-••' },
    })
    expect(js.properties.dob!['x-sensitivity']).toBe('pii')
  })

  it('channel fieldMeta sensitivity overrides the classified preset sensitivity', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-de-3' })
    const v = await db.openVault('v3')
    const c = v.collection('contacts', {
      classifiedFields: { mail: classified.email() },
      fieldMeta: { mail: { label: 'Mail', sensitivity: 'secret' } },
    })
    const desc = c.describe()
    const mail = desc.fields.find((f) => f.key === 'mail')!
    expect(mail.sensitivity).toBe('secret')
    expect(mail.classified?.preset).toBe('email')
  })
})
