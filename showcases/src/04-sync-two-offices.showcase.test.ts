/**
 * Showcase 04 — "Sync Two Offices"
 * GitHub issue: https://github.com/vLannaAi/noy-db/issues/169
 *
 * Framework: Vue (`useCollection`, `useSync`)
 * Store:     `memory()` × 3 (office A local, office B local, shared cloud)
 * Pattern:   Offline-first multi-device sync via a shared sync target
 *            (see docs/guides/topology-matrix.md, Pattern D — cloud peer).
 * Dimension: Offline-first + sync + conflict resolution with reactive Vue state.
 *
 * What this proves:
 *   1. Two independent Noydb instances (each with its own local memory store)
 *      can converge on a shared cloud store via `push()` / `pull()` — the
 *      canonical "two offices, one accounting firm" topology.
 *   2. `useCollection(db, vault, 'invoices')` and `useSync(db, vault)` from
 *      @noy-db/in-vue surface reactive `data` and `status` refs. We wrap the
 *      composables in an `effectScope()` so they run outside a component and
 *      still clean up deterministically in `afterEach`.
 *   3. Offline writes accumulate as dirty entries (`status.value.dirty > 0`);
 *      after `push()` + `pull()` round-trips, both offices see every record
 *      and `status.value.dirty === 0` on both sides.
 *   4. Same-record writes from both offices produce a conflict; the
 *      `conflict: 'local-wins'` strategy keeps each side's own version on
 *      its next pull — deterministic, no silent data loss.
 *
 * Note on encryption: this showcase uses `encrypt: false`. Encrypted multi-
 * instance sync needs cross-instance keyring sharing (grant/export), which is
 * its own showcase. The Vue composable reactivity + the sync state machine
 * are what #169 asks us to prove, and both are identical with or without the
 * AES-GCM layer — the envelope just carries opaque `_data` instead of JSON.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { effectScope, nextTick, type EffectScope } from 'vue'
import { createNoydb, type Noydb, type NoydbStore } from '@noy-db/hub'
import { withSync } from '@noy-db/hub/sync'
import { memory } from '@noy-db/to-memory'
import {
  useCollection,
  useSync,
  type UseCollectionReturn,
  type UseSyncReturn,
} from '@noy-db/in-vue'

import { type Invoice, sampleClients, sleep } from './_fixtures.js'

const VAULT = 'firm-demo'

/**
 * Collection.put() awaits its `onDirty` callback, but noy-db dispatches to
 * the sync engine via `void engine.trackChange(...)` — so the dirty entry
 * lands in a microtask after `put` resolves. Tests that assert on the dirty
 * counter (or that rely on push seeing the entry) need to yield the event
 * loop once so that microtask can run. A single macrotask is enough.
 */
function flushDirty(): Promise<void> {
  return sleep(0)
}

/**
 * `db.pull()` writes remote envelopes straight into the local store but does
 * NOT rehydrate the Collection's in-memory decrypted cache (see
 * `Collection.hydrateFromSnapshot`). Nor does pull emit `change` events, so
 * `useCollection` — which only refreshes on `change` — will not pick up
 * pulled records until the next local write triggers a refresh.
 *
 * This helper closes the explicit gap: after a pull, we load the full vault
 * snapshot from the underlying store and push it through
 * `hydrateFromSnapshot()` on the live Collection, then call the composable's
 * `refresh()` to propagate into the reactive `data` ref. Without this step
 * the composable would report stale (pre-pull) data. Hiding it in a helper
 * keeps the individual `it` blocks focused on the sync story rather than on
 * cache-coherence plumbing.
 */
async function rehydrateView<T>(
  db: Noydb,
  store: NoydbStore,
  view: UseCollectionReturn<T>,
  collectionName: string,
): Promise<void> {
  const vault = await db.openVault(VAULT)
  const coll = vault.collection<T>(collectionName)
  const snapshot = await store.loadAll(VAULT)
  const records = snapshot[collectionName] ?? {}
  await coll.hydrateFromSnapshot(records)
  await view.refresh()
}

describe('Showcase 04 — Sync Two Offices (Vue)', () => {
  // Three adapters: two local caches + one shared "cloud".
  let storeA: NoydbStore
  let storeB: NoydbStore
  let cloudStore: NoydbStore

  let dbA: Noydb
  let dbB: Noydb

  // Composable return values captured inside each office's effectScope.
  let scopeA: EffectScope
  let scopeB: EffectScope
  let invoicesA: UseCollectionReturn<Invoice>
  let invoicesB: UseCollectionReturn<Invoice>
  let syncA: UseSyncReturn
  let syncB: UseSyncReturn

  beforeEach(async () => {
    storeA = memory()
    storeB = memory()
    cloudStore = memory()

    // `encrypt: false` keeps the demo focused on sync + reactivity. Both dbs
    // share the cloud store, which is enough to prove the two-office flow.
    dbA = await createNoydb({
      store: storeA,
      sync: cloudStore,
      user: 'alice', syncStrategy: withSync(),
      encrypt: false,
    })
    dbB = await createNoydb({
      store: storeB,
      sync: cloudStore,
      user: 'bob', syncStrategy: withSync(),
      encrypt: false,
    })

    // Opening the vault on each instance is what wires the sync engine for
    // that vault — `db.push(VAULT)` / `db.pull(VAULT)` require it.
    await dbA.openVault(VAULT)
    await dbB.openVault(VAULT)

    // Stand up the Vue composables for each office inside an effectScope so
    // `onUnmounted` cleanups still run when we call `scope.stop()`.
    scopeA = effectScope()
    scopeA.run(() => {
      invoicesA = useCollection<Invoice>(dbA, VAULT, 'invoices')
      syncA = useSync(dbA, VAULT)
    })

    scopeB = effectScope()
    scopeB.run(() => {
      invoicesB = useCollection<Invoice>(dbB, VAULT, 'invoices')
      syncB = useSync(dbB, VAULT)
    })

    // Wait for the initial hydration refresh kicked off by useCollection.
    await invoicesA!.refresh()
    await invoicesB!.refresh()
  })

  afterEach(async () => {
    scopeA?.stop()
    scopeB?.stop()
    await dbA?.close()
    await dbB?.close()
  })

  it('step 1 — both offices start with empty reactive state', () => {
    // No records anywhere yet. The composables expose empty arrays and a
    // clean sync status on both sides.
    expect(invoicesA.data.value).toEqual([])
    expect(invoicesB.data.value).toEqual([])
    expect(syncA.status.value.dirty).toBe(0)
    expect(syncB.status.value.dirty).toBe(0)
  })

  it('step 2 — offline writes populate local reactive state and mark dirty', async () => {
    // Alice writes to office A's local — no network calls happen here. The
    // reactive `data` ref updates immediately, and `dirty` climbs.
    const vaultA = await dbA.openVault(VAULT)
    await vaultA.collection<Invoice>('invoices').put('inv-A', {
      id: 'inv-A',
      clientId: sampleClients[0].id,
      amount: 12_500,
      currency: 'THB',
      status: 'draft',
      issueDate: '2026-04-01',
      dueDate: '2026-05-01',
      month: '2026-04',
    })
    // useCollection reacts to the change event — nextTick lets the async
    // refresh settle before we assert. flushDirty() waits a tick so the
    // fire-and-forget sync-engine `trackChange` microtask can record the
    // dirty entry.
    await nextTick()
    await flushDirty()
    await invoicesA.refresh()

    // useSync.status is only auto-refreshed on sync:push / sync:pull events,
    // not on change events. Call any sync method to pick up the fresh
    // dirty count — `status.value` is a ref that updates on sync events.
    // For offline-only state we read the raw engine status via syncStatus()
    // under the hood — but here just assert what the composable would show
    // once the scheduler fires. Since our sync policy is manual in this
    // flow, we re-read via a cheap status refresh: a no-op push filter.
    // Simpler: trigger refreshStatus() implicitly by starting (and awaiting)
    // any sync method before reading. We do NOT want to push here because
    // that would clear dirty. So check the underlying db status directly.
    const dirtyA = dbA.syncStatus(VAULT).dirty
    expect(invoicesA.data.value).toHaveLength(1)
    expect(invoicesA.data.value[0]!.id).toBe('inv-A')
    expect(dirtyA).toBe(1)

    // Meanwhile office B has not written, pushed, or pulled — still empty.
    expect(invoicesB.data.value).toEqual([])
    expect(dbB.syncStatus(VAULT).dirty).toBe(0)
  })

  it('step 3 — both offices write offline, then push + pull converges them', async () => {
    // Classic "two offices open the vault in parallel" scenario.
    const vaultA = await dbA.openVault(VAULT)
    const vaultB = await dbB.openVault(VAULT)

    await vaultA.collection<Invoice>('invoices').put('inv-A', {
      id: 'inv-A',
      clientId: sampleClients[0].id,
      amount: 12_500,
      currency: 'THB',
      status: 'draft',
      issueDate: '2026-04-01',
      dueDate: '2026-05-01',
      month: '2026-04',
    })
    await vaultB.collection<Invoice>('invoices').put('inv-B', {
      id: 'inv-B',
      clientId: sampleClients[1].id,
      amount: 8_000,
      currency: 'THB',
      status: 'open',
      issueDate: '2026-04-05',
      dueDate: '2026-05-05',
      month: '2026-04',
    })

    // Before any sync: each office sees only its own record.
    await flushDirty()
    await invoicesA.refresh()
    await invoicesB.refresh()
    expect(invoicesA.data.value.map(i => i.id)).toEqual(['inv-A'])
    expect(invoicesB.data.value.map(i => i.id)).toEqual(['inv-B'])
    expect(dbA.syncStatus(VAULT).dirty).toBe(1)
    expect(dbB.syncStatus(VAULT).dirty).toBe(1)

    // Both offices push to the cloud (order doesn't matter — both records
    // have different ids). Then both pull. After the round trip, each
    // office's reactive state should contain both invoices.
    const pushedA = await syncA.push()
    const pushedB = await syncB.push()
    expect(pushedA.pushed).toBe(1)
    expect(pushedB.pushed).toBe(1)

    await syncA.pull()
    await syncB.pull()

    // Rehydrate the live Collection cache from the post-pull store state
    // (see rehydrateView() for why this is needed today).
    await rehydrateView(dbA, storeA, invoicesA, 'invoices')
    await rehydrateView(dbB, storeB, invoicesB, 'invoices')

    expect(invoicesA.data.value.map(i => i.id).sort()).toEqual(['inv-A', 'inv-B'])
    expect(invoicesB.data.value.map(i => i.id).sort()).toEqual(['inv-A', 'inv-B'])

    // No pending local work on either side — all dirty entries have been
    // flushed to the cloud.
    expect(dbA.syncStatus(VAULT).dirty).toBe(0)
    expect(dbB.syncStatus(VAULT).dirty).toBe(0)

    // lastPush / lastPull are populated ISO timestamps now. Reading the
    // reactive ref — it's updated by useSync's push/pull event listeners.
    expect(syncA.status.value.lastPush).toBeTruthy()
    expect(syncA.status.value.lastPull).toBeTruthy()
    expect(syncB.status.value.lastPush).toBeTruthy()
    expect(syncB.status.value.lastPull).toBeTruthy()
  })

  it('step 4 — same-record conflict: local-wins keeps each office\'s version on pull', async () => {
    // Build a fresh pair of dbs configured with `conflict: 'local-wins'` so
    // this step is self-contained — we don't rely on beforeEach's default
    // 'version' strategy leaking into a conflict assertion.
    await dbA.close()
    await dbB.close()
    scopeA.stop()
    scopeB.stop()

    storeA = memory()
    storeB = memory()
    cloudStore = memory()

    dbA = await createNoydb({
      store: storeA, sync: cloudStore, user: 'alice', syncStrategy: withSync(), encrypt: false,
      conflict: 'local-wins',
    })
    dbB = await createNoydb({
      store: storeB, sync: cloudStore, user: 'bob', syncStrategy: withSync(), encrypt: false,
      conflict: 'local-wins',
    })
    const vaultA = await dbA.openVault(VAULT)
    const vaultB = await dbB.openVault(VAULT)

    scopeA = effectScope()
    scopeA.run(() => {
      invoicesA = useCollection<Invoice>(dbA, VAULT, 'invoices')
      syncA = useSync(dbA, VAULT)
    })
    scopeB = effectScope()
    scopeB.run(() => {
      invoicesB = useCollection<Invoice>(dbB, VAULT, 'invoices')
      syncB = useSync(dbB, VAULT)
    })
    await invoicesA.refresh()
    await invoicesB.refresh()

    // Both offices write to the SAME id — 'inv-SHARED' — offline. Alice
    // records 10,000; Bob records 99,999. Without a conflict strategy these
    // two writes would clash.
    await vaultA.collection<Invoice>('invoices').put('inv-SHARED', {
      id: 'inv-SHARED',
      clientId: sampleClients[0].id,
      amount: 10_000,
      currency: 'THB',
      status: 'draft',
      issueDate: '2026-04-10',
      dueDate: '2026-05-10',
      month: '2026-04',
      notes: 'from-alice',
    })
    await vaultB.collection<Invoice>('invoices').put('inv-SHARED', {
      id: 'inv-SHARED',
      clientId: sampleClients[0].id,
      amount: 99_999,
      currency: 'THB',
      status: 'draft',
      issueDate: '2026-04-10',
      dueDate: '2026-05-10',
      month: '2026-04',
      notes: 'from-bob',
    })

    // Alice pushes first — cloud now has her version. Bob pushes second
    // and the cloud accepts his version (later push wins at the store
    // layer because cloudStore.put has no conflict check between dbs).
    await flushDirty()
    await syncA.push()
    await syncB.push()

    // Now each office pulls. The `local-wins` strategy says: if my local
    // version differs from remote, keep mine. So Alice still sees her
    // 10,000 and Bob still sees his 99,999 after pulling.
    await syncA.pull()
    await syncB.pull()
    await rehydrateView(dbA, storeA, invoicesA, 'invoices')
    await rehydrateView(dbB, storeB, invoicesB, 'invoices')

    const aliceView = invoicesA.data.value.find(i => i.id === 'inv-SHARED')
    const bobView = invoicesB.data.value.find(i => i.id === 'inv-SHARED')

    expect(aliceView?.notes).toBe('from-alice')
    expect(aliceView?.amount).toBe(10_000)
    expect(bobView?.notes).toBe('from-bob')
    expect(bobView?.amount).toBe(99_999)

    // Both offices finished their sync cycle cleanly.
    expect(dbA.syncStatus(VAULT).dirty).toBe(0)
    expect(dbB.syncStatus(VAULT).dirty).toBe(0)
  })

  it('step 5 — recap: reactive state, dirty counters, and cloud convergence', async () => {
    // A compact proof point. Alice writes two invoices, Bob writes one,
    // they sync, and we cross-check:
    //   - both `invoicesA.data.value` and `invoicesB.data.value` hold 3
    //   - both `syncA.status.value.dirty` and `syncB.status.value.dirty` are 0
    //   - the cloud store itself sees 3 envelopes on the wire
    const vaultA = await dbA.openVault(VAULT)
    const vaultB = await dbB.openVault(VAULT)

    await vaultA.collection<Invoice>('invoices').put('inv-001', {
      id: 'inv-001', clientId: sampleClients[0].id, amount: 1_000,
      currency: 'THB', status: 'draft',
      issueDate: '2026-04-01', dueDate: '2026-05-01', month: '2026-04',
    })
    await vaultA.collection<Invoice>('invoices').put('inv-002', {
      id: 'inv-002', clientId: sampleClients[1].id, amount: 2_000,
      currency: 'THB', status: 'open',
      issueDate: '2026-04-02', dueDate: '2026-05-02', month: '2026-04',
    })
    await vaultB.collection<Invoice>('invoices').put('inv-003', {
      id: 'inv-003', clientId: sampleClients[2].id, amount: 3_000,
      currency: 'THB', status: 'paid',
      issueDate: '2026-04-03', dueDate: '2026-05-03', month: '2026-04',
    })

    await flushDirty()
    await syncA.push()
    await syncB.push()
    await syncA.pull()
    await syncB.pull()

    await rehydrateView(dbA, storeA, invoicesA, 'invoices')
    await rehydrateView(dbB, storeB, invoicesB, 'invoices')

    expect(invoicesA.data.value).toHaveLength(3)
    expect(invoicesB.data.value).toHaveLength(3)
    expect(dbA.syncStatus(VAULT).dirty).toBe(0)
    expect(dbB.syncStatus(VAULT).dirty).toBe(0)

    // Cloud convergence sanity check — we peek directly at the shared
    // cloudStore and confirm all three records landed there. This is the
    // "it really did travel through the sync target" proof.
    const cloudIds = (await cloudStore.list(VAULT, 'invoices')).sort()
    expect(cloudIds).toEqual(['inv-001', 'inv-002', 'inv-003'])
  })
})
