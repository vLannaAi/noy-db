/**
 * #693: #606's per-collection `markerIds` set is authoritative only for a
 * store this instance solely writes (plus sync-relayed remote writes). Under
 * multi-tab coordination sharing one store (`enableTabCoordination` with
 * write-propagation), another tab can write a delete-marker directly to the
 * shared store; this instance's `markerIds` doesn't learn of it until the
 * BroadcastChannel relay delivers `_applyRemoteChange`. In that latency
 * window, a `put(id)` here hits the #589/#606 re-create gate with
 * `markerIds.has(id)` false → the store read is skipped → `version` resets
 * to 1 → the marker is overwritten → the record is lost on the next sync
 * (the #589 regression). The fix: when tab coordination is active at all —
 * presence/election alone or full write-propagation (`Noydb.tabCoordinator`
 * set), the gate falls back to the pre-#606 unconditional read, restoring
 * determinism at the cost of the #606 perf win — which stays intact for the
 * common non-tab-coordinated case (test below).
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import type { TabChannel } from '../src/with-sync/tab-coordination.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSync } from '../src/with-sync/index.js'
import { isDeleteMarker, buildDeleteMarker } from '../src/kernel/enclave/record-keys/tombstone.js'

/**
 * In-memory store exposing raw stored envelopes for white-box assertions,
 * plus a `_getCalls`/`_getCallsFor`/`_resetCounters()` set (pattern ported
 * from delete-tombstone-convergence.test.ts / lazy-hydration.test.ts) so the
 * #606 perf win can be proven by call count, not just by behavior.
 */
function toMemory(): NoydbStore & {
  raw(c: string, col: string, id: string): EncryptedEnvelope | undefined
  _getCalls: number
  _getCallsFor(col: string, id: string): number
  _resetCounters(): void
} {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const calls: { col: string; id: string }[] = []
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    raw(c, col, id) { return store.get(c)?.get(col)?.get(id) },
    get _getCalls() { return calls.length },
    _getCallsFor(col, id) { return calls.filter(x => x.col === col && x.id === id).length },
    _resetCounters() { calls.length = 0 },
    async get(c, col, id) {
      calls.push({ col, id })
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

/** Minimal injected channel — never delivers anything (no bus wired to a
 *  second tab). Enough to make `enableTabCoordination` mint a `tabCoordinator`
 *  (used as `channel` for presence-only tests, `writeChannel` when a
 *  `writeRelay` is also needed) — which is all `_tabCoordinationActive`
 *  consults; the relay/channel never needs to actually deliver anything
 *  since the scenario under test is the pre-delivery window. */
function mockChannel(): TabChannel {
  return { isOpen: true, send() {}, on() { return () => {} }, close() {} }
}

interface Note { body: string }
const V = 'V1'

describe('#693: re-create gate falls back to a store read under multi-tab coordination', () => {
  it('a marker written out-of-band by a peer tab (not yet relayed) is not lost on re-create', async () => {
    const local = toMemory(); const remote = toMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'a', syncStrategy: withSync(), encrypt: false })
    const notes = (await db.openVault(V)).collection<Note>('notes')

    // Trigger hydration BEFORE the marker lands, so `ensureHydrated()`'s cold
    // scan can't seed `markerIds` with it — the store doesn't have 'x' yet.
    await notes.put('anchor', { body: 'seed' })

    // Enable tab-coordination write-propagation with an injected mock channel
    // (mirrors tab-coordination-noydb.test.ts) so `db`'s `writeRelay` is set —
    // no real BroadcastChannel exists in node.
    db.enableTabCoordination({ writeChannel: mockChannel(), tabId: 'A' })

    // Simulate a peer tab writing a delete-marker directly into the SHARED
    // local store, bypassing this instance's Collection entirely — the
    // broadcast-relay latency window. Do NOT deliver any broadcast.
    await local.put(V, 'notes', 'x', buildDeleteMarker(2, 'peer'))

    // Pre-fix: markerIds has no entry for 'x' → gate skips the store read →
    // version resets to 1, silently overwriting the peer's marker (data loss).
    // Post-fix: `tabCoordinated()` is true → gate falls back to the
    // unconditional read → sees the marker → continues the version to 3.
    await notes.put('x', { body: 're-created' })
    const raw = local.raw(V, 'notes', 'x')!
    expect(isDeleteMarker(raw)).toBe(false)
    expect(raw._v).toBe(3) // marker._v (2) + 1 — FAILS pre-fix (_v === 1)
    db.close()
  })
})

describe('#693 scoping: the fallback only applies while tab-coordination is active', () => {
  it('tab coordination ENABLED: a genuinely-new insert into a synced-eager collection DOES read the store', async () => {
    const local = toMemory(); const remote = toMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const notes = (await db.openVault(V)).collection<Note>('notes')
    db.enableTabCoordination({ writeChannel: mockChannel(), tabId: 'A' })

    local._resetCounters()
    await notes.put('brand-new', { body: 'v1' })
    // No marker was ever recorded for this id — under the #606-only gate this
    // read would be skipped, but tab-coordination forces the fallback read.
    expect(local._getCallsFor('notes', 'brand-new')).toBeGreaterThanOrEqual(1)
    db.close()
  })

  it('tab coordination DISABLED: a genuinely-new insert into a synced-eager collection never reads the store (#606 win preserved)', async () => {
    const local = toMemory(); const remote = toMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const notes = (await db.openVault(V)).collection<Note>('notes')
    // Tab coordination never enabled — `writeRelay` stays undefined.

    local._resetCounters()
    await notes.put('brand-new', { body: 'v1' })
    expect(local._getCallsFor('notes', 'brand-new')).toBe(0)
    db.close()
  })
})

describe('#693: presence-only coordination (propagateWrites: false) also triggers the fallback', () => {
  it('a marker written out-of-band by a peer tab is not lost on re-create even with write-propagation disabled', async () => {
    const local = toMemory(); const remote = toMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'a', syncStrategy: withSync(), encrypt: false })
    const notes = (await db.openVault(V)).collection<Note>('notes')

    await notes.put('anchor', { body: 'seed' })

    // Presence/election only — no write relay. `propagateWrites: false` means
    // `Noydb.writeRelay` is NEVER set, so the narrow `writeRelay !== undefined`
    // signal this fix replaces would stay false for the entire test: the gap
    // this test closes. `tabCoordinator` is still set unconditionally by
    // `enableTabCoordination`, so the broadened `_tabCoordinationActive`
    // getter must catch this case.
    db.enableTabCoordination({ channel: mockChannel(), propagateWrites: false, tabId: 'A' })

    // Peer tab writes a delete-marker directly into the shared store, with no
    // relay in play to ever inform this instance.
    await local.put(V, 'notes', 'x', buildDeleteMarker(2, 'peer'))

    // Pre-fix (narrow `writeRelay !== undefined` signal): the fallback never
    // fires → gate skips the store read → version resets to 1, resurrecting
    // the deleted record. Post-fix (`tabCoordinator !== undefined`): the
    // fallback fires → sees the marker → continues the version to 3.
    await notes.put('x', { body: 're-created' })
    const raw = local.raw(V, 'notes', 'x')!
    expect(isDeleteMarker(raw)).toBe(false)
    expect(raw._v).toBe(3) // marker._v (2) + 1 — FAILS under the narrow getter (_v === 1)
    db.close()
  })
})
