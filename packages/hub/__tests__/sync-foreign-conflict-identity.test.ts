/**
 * #935 — a store may bind a DIFFERENT copy of `@noy-db/hub/to` than the sync
 * engine's own (npm failing to dedupe hub in production; src-vs-dist in the
 * workspace, where the simulation-sync harness first hit it). Its
 * `ConflictError` is then a foreign class identity, and a bare `instanceof`
 * check silently MISSES it: the CAS conflict lands in `push().errors` with no
 * resolution run, instead of being routed through `handleConflict`.
 *
 * The fix is the identity-safe `isConflictError` predicate (kernel/errors.ts)
 * at every site that catches a store-thrown conflict. This suite drives the
 * sync engine's push channel — the site #935 reported — with a remote whose
 * ConflictError is a locally-declared class that only shares the NAME and
 * shape, which is exactly what a second hub copy produces.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError } from '../src/index.js'
import { isConflictError } from '../src/kernel/errors.js'
import { withSync } from '../src/with-sync/index.js'
import type { EncryptedEnvelope, NoydbStore, VaultSnapshot } from '../src/kernel/types.js'

const COMP = 'acme'

/** The shape a SECOND copy of @noy-db/hub/to produces: same name, same fields, foreign identity. */
class ForeignConflictError extends Error {
  readonly code = 'CONFLICT'
  readonly version: number
  constructor(version: number, message = 'Version conflict') {
    super(message)
    this.name = 'ConflictError'
    this.version = version
  }
}

/** Inline memory store whose CAS failures throw the FOREIGN ConflictError. */
function foreignMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ForeignConflictError(ex._v)
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

interface Note extends Record<string, unknown> { title: string }

describe('#935 — foreign-identity ConflictError at the store boundary', () => {
  it('isConflictError accepts both identities and rejects everything else', () => {
    expect(isConflictError(new ConflictError(3))).toBe(true)
    expect(isConflictError(new ForeignConflictError(3))).toBe(true)
    expect(isConflictError(new Error('Version conflict'))).toBe(false)
    expect(isConflictError(undefined)).toBe(false)
  })

  it('push routes a foreign ConflictError through conflict resolution, not errors', async () => {
    const remote = foreignMemory()
    const db = await createNoydb({ store: foreignMemory(), sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const comp = await db.openVault(COMP)
    const notes = comp.collection<Note>('notes')

    // Seed and sync so remote holds v1, then a concurrent writer bumps the
    // remote behind the engine's back while a local edit goes dirty.
    await notes.put('note-1', { title: 'v1' })
    await db.push(COMP)
    const behind = (await remote.get(COMP, 'notes', 'note-1'))!
    await remote.put(COMP, 'notes', 'note-1', { ...behind, _v: 2, _data: JSON.stringify({ title: 'remote v2' }) })
    await notes.put('note-1', { title: 'local v2' })

    // The push CAS fails with the FOREIGN ConflictError. It must be treated
    // exactly like the native one: detected, resolved (default 'version'
    // policy, local _v 2 >= remote 2 → local force-put), nothing in errors.
    const result = await db.push(COMP)
    expect(result.errors).toEqual([])
    expect(result.conflicts).toHaveLength(1)
    expect(JSON.parse((await remote.get(COMP, 'notes', 'note-1'))!._data).title).toBe('local v2')
  })
})
