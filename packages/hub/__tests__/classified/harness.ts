import { ConflictError } from '../../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'

export interface InlineMemoryStore extends NoydbStore {
  /** Test-only raw envelope peek (bypasses the hub read path). */
  _dump(vault: string, collection: string, id: string): EncryptedEnvelope | undefined
}

export function inlineMemory(): InlineMemoryStore {
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
    _dump(c, col, id) { return store.get(c)?.get(col)?.get(id) },
  }
}

/** One recorded store call: the op name + the raw positional args. */
export interface StoreCall {
  readonly op: 'get' | 'put' | 'delete' | 'list' | 'loadAll' | 'saveAll'
  readonly args: readonly unknown[]
}

export interface SpyStore extends InlineMemoryStore {
  /** Ordered log of every store call, in invocation order. */
  readonly calls: StoreCall[]
}

/**
 * Thin recording wrapper around an {@link InlineMemoryStore}: appends
 * `{ op, args }` to `calls` for every store method, then delegates verbatim.
 * Pure test util — no behavioral change, no golden impact. Used by the C-B
 * store-shape vector to prove `findByDigest` issues exactly `list + N get`.
 */
export function spyStore(inner: InlineMemoryStore): SpyStore {
  const calls: StoreCall[] = []
  const spy: SpyStore = {
    calls,
    async get(c, col, id) { calls.push({ op: 'get', args: [c, col, id] }); return inner.get(c, col, id) },
    async put(c, col, id, env, ev) { calls.push({ op: 'put', args: [c, col, id, env, ev] }); return inner.put(c, col, id, env, ev) },
    async delete(c, col, id) { calls.push({ op: 'delete', args: [c, col, id] }); return inner.delete(c, col, id) },
    async list(c, col) { calls.push({ op: 'list', args: [c, col] }); return inner.list(c, col) },
    async loadAll(c) { calls.push({ op: 'loadAll', args: [c] }); return inner.loadAll(c) },
    async saveAll(c, data) { calls.push({ op: 'saveAll', args: [c, data] }); return inner.saveAll(c, data) },
    _dump(c, col, id) { return inner._dump(c, col, id) },
  }
  return spy
}
