/**
 * Task 10: the `equatable` surface — field knob, `acknowledgeEquatableRisk`
 * double door (R7/R8), and describe()/toJSONSchema() emission.
 * @module
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { classified } from '../../src/with-shape/classified/index.js'
import type { ClassifiedEntry, ClassifiedFieldSpec } from '../../src/with-shape/classified/descriptor.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
import { ClassifiedConfigError, ConflictError } from '../../src/kernel/errors.js'

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

let seq = 0
async function openEquatable(
  classifiedFields: Record<string, ClassifiedEntry>,
  { ack }: { ack: boolean },
) {
  const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: `pw-eq-${seq++}` })
  const v = await db.openVault('v1')
  return v.collection<Record<string, unknown>>('items', {
    perRecordKeys: true,
    classifiedFields,
    acknowledgeEquatableRisk: ack,
  })
}

// A recoverable spec carrying equatable — never constructible via the public
// presets (only digest-only presets expose the knob), so build it raw for R7.
const recoverableEquatable: ClassifiedFieldSpec = {
  _noydbClassified: true, preset: 'note', storage: 'recoverable',
  sensitivity: 'secret', list: { kind: 'omit' }, equatable: true,
}

describe('equatable double door + R7/R8', () => {
  it('R8: equatable field without acknowledgeEquatableRisk → ClassifiedConfigError', async () => {
    await expect(openEquatable(
      { password: classified.password({ equatable: true }) }, { ack: false },
    )).rejects.toBeInstanceOf(ClassifiedConfigError)
  })

  it('R8: acknowledge with zero equatable members is a silent no-op', async () => {
    await expect(openEquatable(
      { password: classified.password() }, { ack: true },
    )).resolves.toBeDefined()
  })

  it('R7: equatable on a non-digest-only field → ClassifiedConfigError', async () => {
    await expect(openEquatable(
      { note: recoverableEquatable }, { ack: true },
    )).rejects.toBeInstanceOf(ClassifiedConfigError)
  })

  it('describe()/toJSONSchema emit x-classified.equatable (ungated, boundary-noted)', async () => {
    const col = await openEquatable(
      { password: classified.password({ equatable: true }) }, { ack: true },
    )
    const d = await col.describe({})
    expect(d.fields.find((f) => f.key === 'password')?.classified?.equatable).toBe(true)
    const js = await col.toJSONSchema() as { properties: Record<string, Record<string, unknown>> }
    expect((js.properties.password!['x-classified'] as { equatable?: unknown }).equatable).toBe(true)
  })
})
