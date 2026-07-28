/**
 * Adversarial repro for #606 review: a delete-marker landing via pull WHILE the
 * eager collection is mid-hydration is never recorded in `markerIds`:
 *   - `_invalidateCacheEntry` early-returns on `!this.hydrated` BEFORE the add,
 *   - `ensureHydrated`'s `adapter.list()` snapshot was taken before the marker landed,
 * so the set permanently lacks the id for this session. A later re-create put
 * then resets to _v=1 instead of continuing past the marker (_v=3).
 * Pre-#606 the gate's unconditional adapter.get would have seen the marker.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSync } from '../src/with-sync/index.js'
import { isDeleteMarker } from '../src/kernel/enclave/record-keys/tombstone.js'

const V = 'v1'
interface Note { body: string }

function toMemory(): NoydbStore & {
  raw(c: string, col: string, id: string): EncryptedEnvelope | undefined
  stallNextGetFor(col: string, id: string): { release: () => void; hit: Promise<void> }
} {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  let stall: { col: string; id: string; gate: Promise<void>; release: () => void; onHit: () => void } | null = null
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    raw(c, col, id) { return store.get(c)?.get(col)?.get(id) },
    stallNextGetFor(col, id) {
      let release!: () => void
      let onHit!: () => void
      const gate = new Promise<void>(r => { release = r })
      const hit = new Promise<void>(r => { onHit = r })
      stall = { col, id, gate, release, onHit }
      return { release, hit }
    },
    async get(c, col, id) {
      if (stall && stall.col === col && stall.id === id) {
        const s = stall
        stall = null // one-shot
        s.onHit()
        await s.gate
      }
      return store.get(c)?.get(col)?.get(id) ?? null
    },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) }
    },
  }
}

describe('#606 adversarial: marker lands mid-hydration', () => {
  it('re-create over a pull-applied marker that landed mid-hydration resets to _v=1 (divergence)', async () => {
    const localA = toMemory(); const localB = toMemory(); const remote = toMemory()

    // Peer A creates + deletes 'ghost' → marker _v=2 pushed to remote. Also a
    // live 'anchor' record so B's hydration loop has an id to stall on.
    const dbA = await createNoydb({ store: localA, sync: remote, user: 'a', syncStrategy: withSync(), encrypt: false })
    const a = (await dbA.openVault(V)).collection<Note>('notes')
    await a.put('anchor', { body: 'x' })
    await a.put('ghost', { body: 'v1' })
    await a.delete('ghost') // marker _v=2
    await dbA.push(V)
    dbA.close()
    expect(isDeleteMarker(remote.raw(V, 'notes', 'ghost')!)).toBe(true)

    // Peer B: local store has ONLY the live 'anchor' (seeded in an earlier
    // session), no 'ghost' — so B's hydration list() will not contain 'ghost'.
    const dbB0 = await createNoydb({ store: localB, sync: remote, user: 'b', syncStrategy: withSync(), encrypt: false })
    const b0 = (await dbB0.openVault(V)).collection<Note>('notes')
    await b0.put('anchor', { body: 'x' })
    dbB0.close()

    // Fresh instance over B's store. Stall hydration at its first per-id get
    // ('anchor'), i.e. AFTER list() captured ids=['anchor'].
    const dbB = await createNoydb({ store: localB, sync: remote, user: 'b', syncStrategy: withSync(), encrypt: false })
    const b = (await dbB.openVault(V)).collection<Note>('notes')

    const { release, hit } = localB.stallNextGetFor('notes', 'anchor')
    const hydration = b.get('anchor') // kicks off ensureHydrated; stalls mid-loop
    await hit

    // While hydration is stalled: pull applies the remote marker for 'ghost'
    // into B's local store. The collection is mid-hydration (hydrated=false),
    // so _invalidateCacheEntry early-returns without markerIds.add.
    await dbB.pull(V)
    expect(isDeleteMarker(localB.raw(V, 'notes', 'ghost')!)).toBe(true) // marker IS in B's store

    release()
    await hydration // hydration completes; ids list never contained 'ghost'

    // The divergence: B re-creates 'ghost'. The store holds a marker _v=2, but
    // markerIds says "not a marker" → the gate skips the store read → _v=1.
    await b.put('ghost', { body: 're-created' })
    const raw = localB.raw(V, 'notes', 'ghost')!
    expect(raw._v).toBe(3) // #589 invariant — FAILS if the set diverged (1 = divergence)
    dbB.close()
  })
})
