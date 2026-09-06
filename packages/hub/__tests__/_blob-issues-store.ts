/** Shared CAS-honouring memory store for the #1451/#1452/#1453 suites. */
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'

export function makeStore(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function bucket(vault: string, coll: string) {
    let v = store.get(vault)
    if (!v) { v = new Map(); store.set(vault, v) }
    let c = v.get(coll)
    if (!c) { c = new Map(); v.set(coll, c) }
    return c
  }
  return {
    name: 'memory',
    async get(vault, coll, id) { return bucket(vault, coll).get(id) ?? null },
    async put(vault, coll, id, env, ev) {
      const b = bucket(vault, coll)
      const ex = b.get(id)
      if (ev !== undefined && (ex?._v ?? 0) !== ev) throw new ConflictError(ex?._v ?? 0)
      b.set(id, env)
    },
    async delete(vault, coll, id) { bucket(vault, coll).delete(id) },
    async list(vault, coll) { return [...bucket(vault, coll).keys()] },
    async loadAll(vault) {
      const v = store.get(vault)
      const snap: VaultSnapshot = {}
      if (v) for (const [n, c] of v) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of c) r[id] = e; snap[n] = r }
      return snap
    },
    async saveAll(vault, data) {
      for (const [n, recs] of Object.entries(data)) for (const [id, e] of Object.entries(recs)) bucket(vault, n).set(id, e)
    },
  } as NoydbStore
}

export function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n)
  let x = seed
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = x & 0xff }
  return out
}
