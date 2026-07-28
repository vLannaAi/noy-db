/**
 * Read-path filtering (#589, Task 2): a `_del` marker reads as absent at
 * every read choke point — `get()`, `list()`/`query()` (eager), `scan()`
 * (both modes) — in both eager and lazy collection modes. Mirrors the #590
 * sync/tombstone test harness (see
 * docs/superpowers/plans/2026-07-09-delete-tombstone-convergence.md
 * "Shared test harness").
 *
 * Assertion-shape note: the brief's draft asserted on `.query().all()` and on
 * `expect.objectContaining({ id: 'n1' })`; adjusted here because (a) `Query`'s
 * terminal is `.toArray()`, not `.all()`, (b) both `list()` and `query()`
 * throw in lazy mode (`prefetch: false`) — `scan()` is the mode-agnostic
 * enumeration API, and (c) `Note` carries no `id` field, so an
 * `objectContaining({ id })` match against `list()`'s output is vacuously
 * true regardless of whether the marker is filtered. Asserting the returned
 * array/iteration is empty proves absence directly.
 *
 * `encrypt`-mode note: the brief's draft used `encrypt: false`. On an
 * unencrypted collection, `decryptJsonString`'s pre-existing #598 branch
 * (`envelope._data === '' ? null : envelope._data`) ALREADY returns null for
 * any empty-`_data` envelope regardless of `_del` — so a `_del` marker reads
 * as absent even on an unpatched checkout and the test never goes RED. Using
 * a real `secret` (encrypted collection, `storeCiphertext: true`) makes the
 * marker's shape NOT match `isTombstoneShape` (guarded by `_del !== true`),
 * so pre-fix it falls through to a real `decrypt('', '', dek)` call — an
 * AES-GCM throw — which is exactly the "or throws on decrypt" failure mode
 * Step 2 of the brief anticipated.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'

/** In-memory store exposing raw stored envelopes for white-box assertions. */
function toMemory(): NoydbStore & { raw(c: string, col: string, id: string): EncryptedEnvelope | undefined } {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    raw(c, col, id) { return store.get(c)?.get(col)?.get(id) },
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
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

interface Note { body: string }
const V = 'V1'
const SECRET = 'delete-marker-read-filter-test-1234'

describe('delete marker reads as absent (#589)', () => {
  async function seedMarker(lazy: boolean) {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'u', secret: SECRET })
    const vault = await db.openVault(V)
    const notes = vault.collection<Note>('notes', lazy ? { prefetch: false, cache: { maxRecords: 100 } } : {})
    await notes.put('n1', { body: 'live' })
    // Simulate a delete marker landing in the raw store (as sync would deliver):
    const live = store.raw(V, 'notes', 'n1')!
    await store.put(V, 'notes', 'n1', { ...live, _v: live._v + 1, _iv: '', _data: '', _del: true })
    return { store, db, vault, notes }
  }

  for (const lazy of [false, true]) {
    it(`get/list/query/scan treat a marker as absent (lazy=${lazy})`, async () => {
      const { store, db } = await seedMarker(lazy)
      // Fresh handle to bypass any warm cache from the initial put: `db.openVault`/
      // `vault.collection` cache their Vault/Collection instances by name, so reusing
      // `db` would just hand back the already-warm collection from `seedMarker`. A
      // genuinely cold read needs a second `createNoydb` bound to the same raw store.
      const db2 = await createNoydb({ store, user: 'u', secret: SECRET })
      const fresh = (await db2.openVault(V)).collection<Note>('notes', lazy ? { prefetch: false, cache: { maxRecords: 100 } } : {})
      expect(await fresh.get('n1')).toBeNull()

      const scanned: Note[] = []
      for await (const rec of fresh.scan()) scanned.push(rec)
      expect(scanned).toEqual([])

      if (!lazy) {
        // list()/query() throw in lazy mode (prefetch: false) — eager-only.
        expect(await fresh.list()).toEqual([])
        expect(fresh.query().toArray()).toEqual([])
      }

      db.close()
      db2.close()
    })
  }
})
