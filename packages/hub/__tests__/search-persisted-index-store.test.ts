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
})
