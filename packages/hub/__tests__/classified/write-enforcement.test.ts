/**
 * classified write enforcement — storage:'never' rejection + preset validators
 * Task 4
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { classified, ClassifiedNeverStoredError, ClassifiedValidationError } from '../../src/shape/via-classified/index.js'
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

describe('classified write enforcement', () => {
  it('put() throws ClassifiedNeverStoredError when a storage:never field is present', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-wr-1' })
    const v = await db.openVault('v1')
    const c = v.collection('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan', cvc: 'cvc' }) },
    })
    await expect(c.put('r1', { pan: '4242424242424242', cvc: '123' }))
      .rejects.toBeInstanceOf(ClassifiedNeverStoredError)
    expect(await c.get('r1')).toBeNull()          // nothing persisted
  })

  it('put() throws ClassifiedValidationError on a Luhn-invalid PAN', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-wr-2' })
    const v = await db.openVault('v2')
    const c = v.collection('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
    })
    await expect(c.put('r1', { pan: '4242424242424241' }))
      .rejects.toBeInstanceOf(ClassifiedValidationError)
  })

  it('absent classified fields are fine (partial records)', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-wr-3' })
    const v = await db.openVault('v3')
    const c = v.collection('people', { classifiedFields: { dob: classified.birthDate() } })
    await c.put('p1', { name: 'x' })
    expect(((await c.get('p1')) as Record<string, unknown>).name).toBe('x')
  })
})
