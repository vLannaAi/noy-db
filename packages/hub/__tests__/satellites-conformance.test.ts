/**
 * Cross-cutting integration conformance vectors for satellite collections
 * (#591, Task 13). Tasks 1–12 already have unit coverage per-file; this suite
 * is the spec's § Conformance vectors transcribed end-to-end, covering only
 * the vectors that cut ACROSS fan-out (Task 6), JoinedHandle (Task 7), forget
 * fan-out (Task 8), search/det existence filtering (Task 9), and sync
 * pair-expansion (Task 11) — never duplicating a single-task unit test.
 *
 * Spec: design-history/2026-07-05-satellite-collections-design.md
 *
 * Fixture patterns are copied (not reinvented) from:
 *  - satellites-fanout.test.ts   — spy store with put ordering
 *  - satellites-joined.test.ts / satellites-search-filter.test.ts — raw-store
 *    injection to simulate offline-resurrection / late-arriving states
 *  - satellites-forget.test.ts  — forget-covered pair with perRecordKeys
 *  - satellites-sync-pair.test.ts — inline CAS-aware memory adapter, driven
 *    same-version conflicts
 *  - embeddings-retrieve.test.ts — deterministic stub embeddings encoder
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSync } from '../src/with-sync/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { withForget } from '../src/with-audit/forget/index.js'
import { withSearch } from '../src/with-lookup/search/index.js'
import { toMemory } from '../../to-memory/src/index.js'
import { ConflictError, SatelliteConfigError } from '../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'

const SECRET = 'satellites-conformance-test-1234'

interface Msg extends Record<string, unknown> {
  from?: string
  subject?: string
  body?: string
}

// ---------------------------------------------------------------------------
// Vector (a)/(b): base put shape + crash injection
// ---------------------------------------------------------------------------

/** In-memory store instrumented with put ordering + one-shot per-collection
 *  put/delete failure injection (copied from satellites-fanout.test.ts). */
function spyMemory() {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let comp = data.get(v); if (!comp) { comp = new Map(); data.set(v, comp) }
    let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  const putOrder: Array<[string, string]> = []
  let failPut: string | null = null
  let failDelete: string | null = null
  const store: NoydbStore = {
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env) {
      if (failPut === c) { failPut = null; throw new Error(`spy: forced put failure for "${c}"`) }
      putOrder.push([c, id])
      gc(v, c).set(id, env)
    },
    async delete(v, c, id) {
      if (failDelete === c) { failDelete = null; throw new Error(`spy: forced delete failure for "${c}"`) }
      gc(v, c).delete(id)
    },
    async list(v, c) { const coll = data.get(v)?.get(c); return coll ? [...coll.keys()] : [] },
    async loadAll(v) {
      const comp = data.get(v); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll(v, recs) {
      for (const [n, byId] of Object.entries(recs)) { const coll = gc(v, n); for (const [id, e] of Object.entries(byId)) coll.set(id, e) }
    },
  }
  return {
    store, putOrder,
    failNextPutFor: (c: string): void => { failPut = c },
    failNextDeleteFor: (c: string): void => { failDelete = c },
  }
}

async function openCrashPair() {
  const spy = spyMemory()
  const db = await createNoydb({ store: spy.store, user: 'alice', secret: SECRET })
  const vault = await db.openVault('v1')
  vault.collection<Msg>('msgs', {})
  vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full' })
  const pairOnly = (): Array<[string, string]> => spy.putOrder.filter(([c]) => c === 'msgs' || c === 'msgs_text')
  return {
    vault, rawStore: spy.store, putOrder: pairOnly,
    failNextPutFor: spy.failNextPutFor, failNextDeleteFor: spy.failNextDeleteFor,
  }
}

describe('spec conformance — cross-cutting vectors (#591, Task 13)', () => {
  it('base put touches exactly one envelope: 1 put, 0 satellite ops (store-shape)', async () => {
    // spec: Conformance — base-handle put performs NO satellite fan-out (audit reversal: no auto-create)
    const { vault, putOrder } = await openCrashPair()
    await vault.collection<Msg>('msgs').put('x', { from: 'a' })
    expect(putOrder()).toEqual([['msgs', 'x']])
  })

  describe('crash injection: only safe-direction persisted states survive a mid-fanout kill', () => {
    // Reads happen through a FRESH db/vault bound to the same underlying
    // store rather than the live vault that (would have) performed the
    // fan-out: a real process kill loses the in-memory cache too, so
    // asserting through the live vault's still-warm cache would prove
    // nothing about the actually-PERSISTED state — only a fresh rehydration
    // does.
    async function reopenCrashPair(rawStore: NoydbStore) {
      const db2 = await createNoydb({ store: rawStore, user: 'alice', secret: SECRET })
      const vault2 = await db2.openVault('v1')
      vault2.collection<Msg>('msgs', {})
      vault2.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full' })
      return vault2
    }

    it('double-fault torn pair: satellite-leg failure whose best-effort revert ALSO fails leaves the torn state standing — readable safe-direction-only, live and after re-open', async () => {
      // spec: Atomicity — crash-window torn pair (double fault: leg failure + best-effort revert failure) reads safe-direction-only
      //
      // Drives the REAL fan-out path (joinedPut via vault.joined().put) into
      // its accepted crash window: the satellite leg's adapter put throws,
      // and the subsequent best-effort revert of the already-executed base
      // leg ALSO fails. For a fresh id the base leg's prior envelope is null,
      // so fanout.ts's revertAndCompensate issues an adapter DELETE to undo
      // it — that is the op armed to fail here. Revert failures are swallowed
      // by design (surfacing one would mask the original leg error), so this
      // double fault leaves the torn state standing: base carries the NEW hot
      // fields, satellite absent.
      const { vault, rawStore, failNextPutFor, failNextDeleteFor } = await openCrashPair()
      failNextPutFor('msgs_text')  // satellite leg throws
      failNextDeleteFor('msgs')    // ...and the base-leg revert (delete of the fresh envelope) also fails

      // The ORIGINAL satellite-leg error surfaces, not the swallowed revert error.
      await expect(vault.joined<Msg>('msgs_full').put('x', { from: 'a', subject: 's', body: 'B' }))
        .rejects.toThrow(/msgs_text/)

      // Torn persisted state: base stands with the new hot fields; satellite
      // never produced (no base-less satellite either — folded from vector (a)).
      expect(await rawStore.get('v1', 'msgs', 'x')).not.toBeNull()
      expect(await rawStore.get('v1', 'msgs_text', 'x')).toBeNull()
      expect(await rawStore.list('v1', 'msgs_text')).not.toContain('x')

      // Same-session reads of the torn state are safe-direction-only:
      expect(await vault.joined<Msg>('msgs_full').get('x')).toEqual({ from: 'a', subject: null, body: null })
      expect(await vault.collection<Msg>('msgs_text').get('x')).toBeNull()

      // And the PERSISTED torn state is equally safe after a fresh re-open:
      const fresh = await reopenCrashPair(rawStore)
      expect(await fresh.joined<Msg>('msgs_full').get('x')).toEqual({ from: 'a', subject: null, body: null })
    })

    it('pair delete killed after the satellite leg: satellite gone, base present, joined still reads safely', async () => {
      // spec: Conformance — crash injection, pair-delete kill after the first fan-out op
      // (satellite leg runs FIRST for delete — convergence rule 3).
      const { vault, rawStore } = await openCrashPair()
      await vault.joined<Msg>('msgs_full').put('y', { from: 'b', body: 'B' })
      // Simulate the kill: remove ONLY the satellite envelope directly,
      // bypassing pairDelete's own revert path entirely.
      await rawStore.delete('v1', 'msgs_text', 'y')

      expect(await rawStore.get('v1', 'msgs', 'y')).not.toBeNull()
      expect(await rawStore.get('v1', 'msgs_text', 'y')).toBeNull()

      const fresh = await reopenCrashPair(rawStore)
      expect(await fresh.joined<Msg>('msgs_full').get('y')).toEqual({ from: 'b', subject: null, body: null })
    })
  })

  // ---------------------------------------------------------------------------
  // Vector (c): offline resurrection containment
  // ---------------------------------------------------------------------------
  describe('offline resurrection containment: a lingering satellite is unreachable via every surface once the base is gone', () => {
    async function openContainmentPair() {
      const rawStore = toMemory()
      const db = await createNoydb({ store: rawStore, user: 'alice', secret: SECRET, searchStrategy: withSearch() })
      const vault = await db.openVault('v1')
      vault.collection<Msg>('msgs')
      vault.collection<Msg>('msgs_text', {
        satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full',
        textIndexes: ['body'], textIndexPersist: true,
      })
      return { vault, rawStore }
    }

    it('get/list/query-refusal/search/joined all treat a raw-store-injected offline resurrection as unreachable; the envelope itself remains', async () => {
      // spec: Conformance — offline resurrection containment (raw-store injection)
      const { vault, rawStore } = await openContainmentPair()
      await vault.joined<Msg>('msgs_full').put('x', { from: 'a', body: 'zebra unique' })
      await vault.collection<Msg>('msgs_text').retrieve('zebra') // force the persisted index to build while live

      const satEnvBefore = await rawStore.get('v1', 'msgs_text', 'x')
      expect(satEnvBefore).not.toBeNull()

      // Offline resurrection: the base disappears out-of-band (e.g. a peer
      // deleted it) while the satellite envelope keeps lingering locally —
      // simulated with a raw store injection, same as satellites-joined.test.ts.
      await rawStore.delete('v1', 'msgs', 'x')

      expect(await vault.collection<Msg>('msgs_text').get('x')).toBeNull()
      expect(await vault.collection<Msg>('msgs_text').list()).toEqual([])
      expect(() => vault.collection<Msg>('msgs_text').query()).toThrowError(SatelliteConfigError)
      expect(await vault.collection<Msg>('msgs_text').retrieve('zebra')).toEqual([])
      expect(await vault.collection<Msg>('msgs_text').search('body', 'zebra')).toEqual([]) // scan-mode search, same filterLiveHits path
      expect(await vault.joined<Msg>('msgs_full').get('x')).toBeNull()

      // Containment is purely observational — the satellite envelope was
      // never physically touched.
      expect(await rawStore.get('v1', 'msgs_text', 'x')).toEqual(satEnvBefore)
    })
  })

  // ---------------------------------------------------------------------------
  // Vector (d): post-forget late-arriving satellite put
  // ---------------------------------------------------------------------------
  describe('post-forget late-arriving satellite put stays unreachable (observational containment — resurrection PREVENTION is #590, not asserted here)', () => {
    it('a raw-store put of a valid satellite envelope onto a tombstoned base id is unreachable through every enumerated surface', async () => {
      // spec: Conformance — post-forget late-arriving satellite put
      const store = toMemory()
      const opts = {
        store, user: 'alice', secret: SECRET, searchStrategy: withSearch(),
        historyStrategy: withHistory(),
        forgetStrategy: withForget({ subjects: { msgs: 'from' } }),
      }
      const db1 = await createNoydb(opts)
      const vault1 = await db1.openVault('v1')
      vault1.collection<Msg>('msgs', { perRecordKeys: true })
      vault1.collection<Msg>('msgs_text', {
        satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full', perRecordKeys: true,
        textIndexes: ['body'], textIndexPersist: true,
      })
      await vault1.joined<Msg>('msgs_full').put('x', { from: 'alice@x', body: 'walrus unique' })
      const validSatEnv = await store.get('v1', 'msgs_text', 'x') // a genuinely valid, decryptable envelope
      expect(validSatEnv).not.toBeNull()

      await vault1.forget('alice@x') // tombstones base + satellite locally

      // A late-arriving write (e.g. a delayed sync pull) lands directly on
      // the raw store for the now-forgotten id — bypassing collection.put
      // entirely, same as a real out-of-band store write would.
      await store.put('v1', 'msgs_text', 'x', validSatEnv!)

      // Re-open fresh (same store/secret) so the collection genuinely
      // re-hydrates from the store — otherwise forget()'s own cache eviction
      // would trivially hide the late arrival regardless of existence
      // filtering, which would prove nothing. On reopen the satellite
      // envelope IS decryptable and would otherwise be visible; only the
      // base's tombstoned state should suppress it.
      const db2 = await createNoydb(opts)
      const vault2 = await db2.openVault('v1')
      vault2.collection<Msg>('msgs', { perRecordKeys: true })
      vault2.collection<Msg>('msgs_text', {
        satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full', perRecordKeys: true,
        textIndexes: ['body'], textIndexPersist: true,
      })

      expect(await vault2.collection<Msg>('msgs_text').get('x')).toBeNull()
      expect(await vault2.collection<Msg>('msgs_text').list()).toEqual([])
      expect(() => vault2.collection<Msg>('msgs_text').query()).toThrowError(SatelliteConfigError)
      expect(await vault2.collection<Msg>('msgs_text').retrieve('walrus')).toEqual([])
      expect(await vault2.joined<Msg>('msgs_full').get('x')).toBeNull()

      // The re-injected envelope is left exactly as written: containment
      // does not silently re-tombstone or purge it.
      expect(await store.get('v1', 'msgs_text', 'x')).toEqual(validSatEnv)
    })
  })

  // ---------------------------------------------------------------------------
  // Vector (e): field-group conflict granularity ("tearing")
  // ---------------------------------------------------------------------------
  describe('field-group conflict granularity: divergent joined writes converge to a mixed record (documented behavior, not a bug)', () => {
    function inlineMemory(): NoydbStore {
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

    it('base and satellite resolve conflicts INDEPENDENTLY, converging under vault.joined() to a torn/mixed record', async () => {
      // spec: Conformance — field-group conflict granularity ("tearing")
      const COMP = 'v1'
      const local = inlineMemory()
      const remote = inlineMemory()
      const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
      const vault = await db.openVault(COMP)
      vault.collection<Msg>('msgs', { conflictPolicy: 'last-writer-wins' })
      vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full' })

      await vault.joined<Msg>('msgs_full').put('m', { from: 'local0', subject: 'local0', body: '' })
      await db.push(COMP) // remote msgs + msgs_text both land at _v=1

      // Someone else pushes divergent v2s out-of-band, with deliberately
      // opposite-signed timestamps so LWW picks a DIFFERENT side per collection.
      const future = new Date(Date.now() + 60_000).toISOString()
      const past = new Date(Date.now() - 60_000).toISOString()
      await remote.put(COMP, 'msgs', 'm', { _noydb: 1, _v: 2, _ts: future, _iv: '', _data: JSON.stringify({ from: 'REMOTE' }) })
      await remote.put(COMP, 'msgs_text', 'm', { _noydb: 1, _v: 2, _ts: past, _iv: '', _data: JSON.stringify({ subject: 'REMOTE', body: 'remote-body' }) })

      // Local writes its own v2 to BOTH legs in one joined call — a real
      // "now" timestamp, strictly between `past` and `future`.
      await vault.joined<Msg>('msgs_full').put('m', { from: 'local1', subject: 'local1', body: 'local-body' })

      const result = await db.push(COMP)
      expect(result.conflicts).toHaveLength(2) // base AND satellite each conflict independently

      // Conflict resolution writes the winner straight to the raw local
      // store (sync.ts push()), bypassing the live Collection's cache —
      // reopen fresh (same store) so the read reflects the actually
      // PERSISTED post-resolution state rather than the live vault's
      // now-stale in-memory cache.
      const db2 = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
      const vault2 = await db2.openVault(COMP)
      vault2.collection<Msg>('msgs', {})
      vault2.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full' })

      // Each collection's LWW resolver picks its OWN winner: msgs → remote
      // (future ts beats "now"), msgs_text → local ("now" beats past ts).
      // The merged joined record is genuinely torn — half remote, half
      // local — which is the documented behavior for this design (base and
      // satellite are separate collections resolved independently, never one
      // atomic joined transaction), not a bug to fix here.
      const merged = await vault2.joined<Msg>('msgs_full').get('m')
      expect(merged).toEqual({ from: 'REMOTE', subject: 'local1', body: 'local-body' })
    })
  })

  // ---------------------------------------------------------------------------
  // Vector (f): R-S7 retro clause
  // ---------------------------------------------------------------------------
  describe('R-S7 retro clause: adding forget coverage over a base whose existing satellite lacks perRecordKeys is refused', () => {
    it('reopening with newly-added forget coverage refuses to redeclare the pre-existing non-perRecordKeys satellite', async () => {
      // spec: Conformance — R-S7 retro clause
      const store = toMemory()
      // Session 1: no forget coverage — satellite declared WITHOUT perRecordKeys.
      const db1 = await createNoydb({ store, user: 'alice', secret: SECRET })
      const vault1 = await db1.openVault('v1')
      vault1.collection<Msg>('msgs', {})
      vault1.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full' })
      await vault1.joined<Msg>('msgs_full').put('x', { from: 'alice@x', subject: 's', body: 'b' })
      expect(await store.get('v1', 'msgs_text', 'x')).not.toBeNull() // the pre-existing satellite really has data

      // Session 2: forget coverage is added over the base. The base itself
      // auto-forces perRecordKeys (vault.ts's existing force-on, warn-only),
      // but the PRE-EXISTING satellite was never migrated to perRecordKeys —
      // R-S7's retro clause must refuse the redeclare outright.
      const db2 = await createNoydb({
        store, user: 'alice', secret: SECRET,
        forgetStrategy: withForget({ subjects: { msgs: 'from' } }),
      })
      const vault2 = await db2.openVault('v1')
      expect(() => vault2.collection<Msg>('msgs', {})).not.toThrow() // base: perRecordKeys force-on, no refusal
      expect(() => vault2.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full' }))
        .toThrowError(/R-S7/)

      // This is a declaration-time refusal, not data loss — the persisted
      // satellite data is untouched. See task-13-report.md for the finding:
      // there is no dedicated satellite-CEK migration path implemented yet
      // to get PAST this refusal (only the generic, unwired
      // `_applyCutoverTransform` primitive exists) — so once hit, the pair
      // is unusable (not even readable) in that session until one is built.
      expect(await store.get('v1', 'msgs_text', 'x')).not.toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Vector (g): satellite history tombstoning under forget
  // ---------------------------------------------------------------------------
  describe('satellite history tombstoning under forget: every displaced version, not just the live envelope', () => {
    it('tombstones all displaced satellite history versions when the subject is forgotten', async () => {
      // spec: Conformance — satellite history tombstoning under forget
      const rawStore = toMemory()
      const db = await createNoydb({
        store: rawStore, user: 'alice', secret: SECRET,
        historyStrategy: withHistory(),
        forgetStrategy: withForget({ subjects: { msgs: 'from' } }),
      })
      const vault = await db.openVault('v1')
      vault.collection<Msg>('msgs', { perRecordKeys: true })
      vault.collection<Msg>('msgs_text', {
        satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full', perRecordKeys: true,
      })

      await vault.joined<Msg>('msgs_full').put('x', { from: 'alice@x', subject: 's0', body: 'v0' })
      await vault.joined<Msg>('msgs_full').put('x', { from: 'alice@x', subject: 's1', body: 'v1' })
      await vault.joined<Msg>('msgs_full').put('x', { from: 'alice@x', subject: 's2', body: 'v2' })

      const satHistoryIds = async (): Promise<string[]> =>
        (await rawStore.list('v1', '_history')).filter((k) => k.startsWith('msgs_text:x:'))

      const historyIdsBefore = await satHistoryIds()
      expect(historyIdsBefore.length).toBeGreaterThan(0) // displaced versions recorded

      const result = await vault.forget('alice@x')
      expect(result.historyVersionsShredded).toBeGreaterThan(0)

      for (const id of await satHistoryIds()) {
        expect((await rawStore.get('v1', '_history', id))?._data).toBe('')
      }
      // Sanity: the live satellite envelope is tombstoned by the same call.
      expect((await rawStore.get('v1', 'msgs_text', 'x'))?._data).toBe('')
    })
  })

  // ---------------------------------------------------------------------------
  // Vector (h): similarTo existence filter (mock-embeddings fixture reused
  // from embeddings-retrieve.test.ts — a reasonable one exists in the repo)
  // ---------------------------------------------------------------------------
  describe('similarTo() existence-filter for a satellite (mirrors the search/retrieve vector)', () => {
    // Deterministic stub encoder, copied from embeddings-retrieve.test.ts:
    // bag-of-chars hash → Float32Array of given dim.
    const enc = (dim: number, model = 'stub') => ({
      dim, model, source: 'body',
      encode: async (t: string) => {
        const v = new Float32Array(dim)
        for (let i = 0; i < t.length; i++) { const idx = t.charCodeAt(i) % dim; v[idx] = (v[idx] ?? 0) + 1 }
        return v
      },
    })

    it('similarTo() drops a satellite hit whose base was raw-deleted (existence post-filter)', async () => {
      // spec: Conformance — similarTo/embeddings existence filter
      const rawStore = toMemory()
      const encoder = enc(8)
      const db = await createNoydb({ store: rawStore, user: 'alice', secret: SECRET, searchStrategy: withSearch() })
      const vault = await db.openVault('v1')
      vault.collection<Msg>('msgs')
      vault.collection<Msg>('msgs_text', {
        satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full', embeddings: encoder,
      })

      await vault.joined<Msg>('msgs_full').put('x', { from: 'a', body: 'zebra unique text' })
      await vault.joined<Msg>('msgs_full').put('y', { from: 'b', body: 'completely different stuff' })

      const qVec = await encoder.encode('zebra unique text')
      const before = await vault.collection<Msg>('msgs_text').similarTo(qVec, { k: 5 })
      expect(before.map((h) => h.id)).toContain('x')

      await rawStore.delete('v1', 'msgs', 'x')

      const hits = await vault.collection<Msg>('msgs_text').similarTo(qVec, { k: 5 })
      expect(hits.map((h) => h.id)).not.toContain('x')
    })
  })
})
