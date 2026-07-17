// packages/hub/__tests__/search-persisted-index-store.test.ts
import { describe, it, expect } from 'vitest'
import { PersistedIndexStore, type Fingerprint } from '../src/with-lookup/search/persisted-index-store.js'
import type { IndexDoc } from '../src/with-lookup/search/inverted-index.js'

const docs: IndexDoc[] = [{ id: 'a', fields: [{ field: 'd', text: 'invoice' }] }]

function harness(fp: Fingerprint = { count: 1, maxVersion: 1 }) {
  const blob: { json: string; fingerprint: Fingerprint } | null = null as any
  const state = { blob, saves: 0, removes: 0, fp }
  const store = new PersistedIndexStore({
    load: async () => state.blob,
    save: async (json, f) => { state.saves++; state.blob = { json, fingerprint: f } },
    remove: async () => { state.removes++; state.blob = null },
    currentFingerprint: () => state.fp,
    debounceMs: 10,
  })
  return { store, state }
}

describe('PersistedIndexStore (#308 L1.5)', () => {
  it('cold build persists; warm load skips the build fn', async () => {
    const { store, state } = harness()
    let builds = 0
    const build = () => { builds++; return docs }
    await store.ensureBuilt(build)            // cold: build + save
    expect(builds).toBe(1); expect(state.saves).toBe(1)
    // simulate a NEW session: fresh store, same blob + matching fingerprint
    const store2 = new PersistedIndexStore({
      load: async () => state.blob, save: async () => {}, remove: async () => {},
      currentFingerprint: () => state.fp, debounceMs: 10,
    })
    let builds2 = 0
    await store2.ensureBuilt(() => { builds2++; return docs })
    expect(builds2).toBe(0)                    // warm: deserialized, no rebuild
    expect((await store2.ensureBuilt(() => docs)).query('invoice').map((h) => h.id)).toEqual(['a'])
  })

  it('stale fingerprint forces a rebuild', async () => {
    const { store, state } = harness()
    await store.ensureBuilt(() => docs)
    state.fp = { count: 2, maxVersion: 5 } // someone wrote elsewhere
    const store2 = new PersistedIndexStore({
      load: async () => state.blob, save: async () => {}, remove: async () => {},
      currentFingerprint: () => state.fp, debounceMs: 10,
    })
    let builds = 0
    await store2.ensureBuilt(() => { builds++; return docs })
    expect(builds).toBe(1) // blob fingerprint {1,1} != current {2,5} → rebuild
  })

  it('markDirty debounces a single flush; flush() is immediate', async () => {
    const { store, state } = harness()
    await store.ensureBuilt(() => docs)        // saves=1
    store.markDirty(); store.markDirty(); store.markDirty()
    await new Promise((r) => setTimeout(r, 30)) // debounce window (10ms) elapses
    expect(state.saves).toBe(2)                 // one coalesced flush
    store.markDirty(); await store.flush()
    expect(state.saves).toBe(3)                 // explicit immediate
  })

  it('removePersisted deletes the blob + marks dirty', async () => {
    const { store, state } = harness()
    await store.ensureBuilt(() => docs)
    await store.removePersisted()
    expect(state.removes).toBe(1); expect(store.built).toBe(false)
  })
})

describe('PersistedIndexStore epoch-guarded flush/purge race (#725)', () => {
  it('removePersisted mid-flight self-undoes an in-flight save once it settles', async () => {
    const state: { blob: { json: string; fingerprint: Fingerprint } | null; removes: number } = { blob: null, removes: 0 }
    let gate: Promise<void> | null = null
    let reached: (() => void) | null = null
    const store = new PersistedIndexStore({
      load: async () => state.blob,
      save: async (json, f) => {
        if (gate) { reached?.(); await gate }
        state.blob = { json, fingerprint: f }
      },
      remove: async () => { state.removes++; state.blob = null },
      currentFingerprint: () => ({ count: 1, maxVersion: 1 }),
      debounceMs: 10,
    })

    // Warm build + save, uninterrupted (gate not yet armed).
    await store.ensureBuilt(() => docs)
    expect(state.blob).not.toBeNull()

    // Arm the gate for the NEXT save and start a flush — it blocks INSIDE
    // save(), after the epoch has been captured, before the blob is written.
    let release!: () => void
    gate = new Promise<void>((r) => { release = r })
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const flushPromise = store.flush()
    await reachedPromise // the flush is now genuinely in flight

    // A purge lands while that save is still in flight.
    const removePromise = store.removePersisted()

    release()
    await Promise.all([flushPromise, removePromise])

    // The in-flight save's resurrection must not survive the purge.
    expect(state.blob).toBeNull()
    expect(store.built).toBe(false)
  })

  it('a flush with no interleaved purge still persists normally', async () => {
    const { store, state } = harness()
    await store.ensureBuilt(() => docs)
    const savesBefore = state.saves
    store.markDirty()
    await store.flush()
    expect(state.saves).toBe(savesBefore + 1)
    expect(state.blob).not.toBeNull()
  })

  it('gate-before-put: isStale() goes true while a save is mid-"encrypt" (before its own write), and the save skips the write entirely', async () => {
    // Mirrors collection-facade.ts's real save(): an async encrypt-like gap, THEN a
    // pre-put staleness check — proving the check actually prevents the write (not
    // just papering over it after the fact, which is persist()'s separate backstop).
    const state: { blob: { json: string; fingerprint: Fingerprint } | null; puts: number } = { blob: null, puts: 0 }
    let encryptGate: Promise<void> | null = null
    let reachedEncrypt: (() => void) | null = null
    const store = new PersistedIndexStore({
      load: async () => state.blob,
      save: async (json, f, isStale) => {
        if (encryptGate) { reachedEncrypt?.(); await encryptGate }
        if (isStale()) return
        state.puts++
        state.blob = { json, fingerprint: f }
      },
      remove: async () => { state.blob = null },
      currentFingerprint: () => ({ count: 1, maxVersion: 1 }),
      debounceMs: 10,
    })

    await store.ensureBuilt(() => docs) // warm build + save, uninterrupted
    const putsBefore = state.puts

    let releaseEncrypt!: () => void
    encryptGate = new Promise<void>((r) => { releaseEncrypt = r })
    const reachedPromise = new Promise<void>((r) => { reachedEncrypt = r })
    const flushPromise = store.flush()
    await reachedPromise // blocked mid-"encrypt" — isStale() has NOT been checked yet

    await store.removePersisted() // the purge lands while the save is still encrypting

    releaseEncrypt()
    await flushPromise

    expect(state.puts).toBe(putsBefore) // the write itself was skipped — isStale() caught it pre-put
    expect(state.blob).toBeNull()
  })

  it('a failed compensation is retried by the NEXT store operation, not silently dropped (#725 review)', async () => {
    const state: { blob: { json: string; fingerprint: Fingerprint } | null; removeCalls: number } = { blob: null, removeCalls: 0 }
    let failOnCall = -1
    let gate: Promise<void> | null = null
    let reached: (() => void) | null = null
    const store = new PersistedIndexStore({
      load: async () => state.blob,
      save: async (json, f) => {
        if (gate) { reached?.(); await gate }
        state.blob = { json, fingerprint: f }
      },
      remove: async () => {
        state.removeCalls++
        if (state.removeCalls === failOnCall) throw new Error('simulated remove failure')
        state.blob = null
      },
      currentFingerprint: () => ({ count: 1, maxVersion: 1 }),
      debounceMs: 10,
    })

    await store.ensureBuilt(() => docs) // warm build + save, uninterrupted

    // Arm the gate for a racy save; let removePersisted's OWN remove (call #1)
    // succeed, but make the save's COMPENSATING remove (call #2) fail once.
    let release!: () => void
    gate = new Promise<void>((r) => { release = r })
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const flushPromise = store.flush()
    await reachedPromise

    failOnCall = 2
    await store.removePersisted() // call #1 — succeeds
    expect(state.blob).toBeNull()

    release() // the stale save lands, then its own compensation (call #2) fails
    await expect(flushPromise).rejects.toThrow('simulated remove failure')
    // The debounced-flush path would swallow this exact failure via its
    // `.catch(() => {})` — here it propagates because flush() is awaited
    // directly, but the RESIDUE (a resurrected blob) is identical either way.
    expect(state.blob).not.toBeNull() // the resurrection survives the failed compensation…

    // …but is NOT silently dropped: the next store operation retries it first.
    await store.removePersisted() // call #3 — retries the pending compensation, then does its own remove
    expect(state.blob).toBeNull()
    expect(state.removeCalls).toBeGreaterThanOrEqual(3)
  })

  it('variant (b) is subsumed: removePersisted always clears the in-memory index, so a flush after a purge can never skip the rebuild and pair a stale (pre-purge) index with the live fingerprint', async () => {
    const withE1: IndexDoc[] = [{ id: 'e1', fields: [{ field: 'd', text: 'topsecret-e1' }] }, { id: 't0', fields: [{ field: 'd', text: 'public-t0' }] }]
    const withoutE1: IndexDoc[] = [{ id: 't0', fields: [{ field: 'd', text: 'public-t0' }] }]
    let liveCacheDocs: IndexDoc[] = withE1
    const buildFromLiveCache = () => liveCacheDocs

    const state: { blob: { json: string; fingerprint: Fingerprint } | null; fp: Fingerprint } =
      { blob: null, fp: { count: 2, maxVersion: 1 } }
    const store = new PersistedIndexStore({
      load: async () => state.blob,
      save: async (json, f) => { state.blob = { json, fingerprint: f } },
      remove: async () => { state.blob = null },
      currentFingerprint: () => state.fp,
      debounceMs: 10,
    })

    // Warm build INCLUDING e1 (state before any purge).
    await store.ensureBuilt(buildFromLiveCache)
    expect(state.blob?.json).toContain('e1')

    // A write happens (markDirty) — a debounced flush is now conceptually pending.
    store.markDirty()

    // Before that flush fires, a retrieve() rebuilds using the SAME (still
    // pre-purge) live cache — the issue's "retrieve() rebuilt the index between
    // markDirty and the timer firing." Force a rebuild (not a fingerprint-matched
    // warm-load) by bumping the fingerprint, simulating an unrelated write.
    state.fp = { count: 2, maxVersion: 2 }
    await store.ensureBuilt(buildFromLiveCache)
    expect(state.blob?.json).toContain('e1') // still pre-purge — expected, no purge yet

    // NOW the purge lands (elevate/forget): cache eviction always precedes
    // removePersisted() in both call paths, so the live cache flips first.
    liveCacheDocs = withoutE1
    state.fp = { count: 1, maxVersion: 2 }
    await store.removePersisted()
    expect(state.blob).toBeNull()

    // The debounced flush "fires": `lastBuild` is still `buildFromLiveCache`, but
    // removePersisted() just cleared `this.index`, so this MUST rebuild (not skip
    // it) — and rebuilding calls `buildFromLiveCache()`, which now reads the
    // POST-eviction cache.
    await store.flush()

    // The persisted blob must reflect the post-eviction state — never a stale
    // pre-purge snapshot paired with a coincidentally-live-matching fingerprint.
    expect(state.blob?.json).not.toContain('e1')
    expect(state.blob?.fingerprint).toEqual({ count: 1, maxVersion: 2 })
  })
})
