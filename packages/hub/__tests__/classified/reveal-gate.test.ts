import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { classified, withClassified } from '../../src/with-shape/classified/index.js'
import { ClassifiedNotEnabledError } from '../../src/kernel/errors.js'
import { ConflictError } from '../../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'

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

describe('withClassified gate + reveal', () => {
  it('reveal throws ClassifiedNotEnabledError without the strategy', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-rv-1' })
    const v = await db.openVault('v1')
    const c = v.collection('cards', { classifiedFields: { card: classified.creditCard({ pan: 'pan' }) } })
    await c.put('r1', { pan: '4242424242424242' })
    await expect(c.reveal('r1', 'pan')).rejects.toBeInstanceOf(ClassifiedNotEnabledError)
  })

  it('reveal returns the plaintext with withClassified(), and refuses unknown/never fields', async () => {
    const db = await createNoydb({
      store: inlineMemory(), user: 'a', secret: 'pw-rv-2',
      classifiedStrategy: withClassified(),
    })
    const v = await db.openVault('v2')
    const c = v.collection('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan', cvc: 'cvc' }) },
    })
    await c.put('r1', { pan: '4242424242424242' })
    expect(await c.reveal('r1', 'pan')).toBe('4242424242424242')
    await expect(c.reveal('r1', 'cvc')).rejects.toThrow(/never/)     // nothing stored to reveal
    await expect(c.reveal('r1', 'nope')).rejects.toThrow(/not classified/)
  })
})
