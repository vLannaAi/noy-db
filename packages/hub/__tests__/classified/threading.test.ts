/**
 * classifiedFields threading (Task 3) — config threading + sealed merge.
 * @module
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { classified, ClassifiedConfigError } from '../../src/with-shape/classified/index.js'
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

describe('classifiedFields threading', () => {
  it('recoverable classified fields come back sealed; riders are plain fields', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-cls-1' })
    const v = await db.openVault('v1')
    const c = v.collection('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'cardNumber' }) },
    })
    await c.put('r1', { cardNumber: '4242424242424242' })
    const rec = await c.get('r1') as Record<string, unknown>
    expect((rec.cardNumber as { sealed?: boolean }).sealed).toBe(true)   // SealedHandle
    expect(rec.cardNumber_last4).toBe('4242')                            // rider materialized
    expect(rec.cardNumber_bin).toBe('424242')
  })

  it('reconciles declarations arriving after auto-creation (first-wins _apply)', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-cls-2' })
    const v = await db.openVault('v2')
    v.collection('people')                                               // bare auto-open
    const c = v.collection('people', { classifiedFields: { dob: classified.birthDate() } })
    await c.put('p1', { dob: '1990-04-01' })
    const rec = await c.get('p1') as Record<string, unknown>
    expect(rec.dob_yob).toBe('1990')
  })

  it('throws ClassifiedConfigError on rider-computed collision', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-cls-3' })
    const v = await db.openVault('v3')
    // fresh-open collision: classifiedFields with rider conflicts with pre-declared computed field
    expect(() => v.collection('x1', {
      classifiedFields: { pan: classified.creditCard({ pan: 'pan' }) },  // creditCard ships last4 rider
      computed: { pan_last4: (r) => 'user' }                             // colliding key
    })).toThrow(ClassifiedConfigError)
  })

  it('throws ClassifiedConfigError on reconcile collision', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-cls-4' })
    const v = await db.openVault('v4')
    // reconcile collision: bare collection created first, then classifiedFields applied with rider that collides
    v.collection('x2', { computed: { pan_last4: (r) => 'user' } })     // pre-declare computed field
    expect(() => v.collection('x2', {
      classifiedFields: { pan: classified.creditCard({ pan: 'pan' }) }  // try to apply, but rider collides
    })).toThrow(ClassifiedConfigError)
  })
})
