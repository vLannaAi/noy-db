/**
 * Gate test for the atomic-sequence capability (S4). `vault.sequence()` throws
 * `SequenceNotEnabledError` unless `sequenceStrategy: withSequence()` is passed
 * to createNoydb; opting in makes `.next()` / `.peek()` / `.seedTo()` live.
 * Deferred-numbering series are a separate capability and are NOT gated here.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError, SequenceNotEnabledError } from '../src/index.js'
import { withSequence } from '../src/with-commit/sequence/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'

function memory(casAtomic = true): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = store.get(v); if (!vm) { vm = new Map(); store.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    capabilities: { casAtomic, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const cm = gc(v, c); const ex = cm.get(id)
      if (ev !== undefined) {
        if (ev === 0 && ex) throw new ConflictError(ex._v)
        if (ev !== 0 && (!ex || ex._v !== ev)) throw new ConflictError(ex?._v ?? 0)
      }
      cm.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = store.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [n, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[n] = r
      }
      return snap
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const cm = gc(v, n)
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
      }
    },
  }
}

describe('sequence opt-in gate (S4)', () => {
  it('throws SequenceNotEnabledError when not opted in', async () => {
    const db = await createNoydb({ store: memory(), user: 'owner', secret: 'pw' })
    const v = await db.openVault('books')
    expect(() => v.sequence('invoice-2026')).toThrow(SequenceNotEnabledError)
  })

  it('works when opted in via withSequence()', async () => {
    const db = await createNoydb({ store: memory(), user: 'owner', secret: 'pw', sequenceStrategy: withSequence() })
    const v = await db.openVault('books')
    const seq = v.sequence('invoice-2026')
    expect(await seq.next()).toBe(1)
    expect(await seq.next()).toBe(2)
    expect(await seq.peek()).toBe(2)
  })
})
