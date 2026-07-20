/**
 * Reserved-tier sync (#647, #650 Task 4) — choke-point participation +
 * reserved-prefix pull + wave reachability.
 *
 * Before this task: `LookupHandle.put/delete/rename` wrote via raw
 * `adapter.put`/`adapter.delete` — no `onDirty` (push's dirty log never saw
 * them), no `_onRecordMutated`. `SyncEngine.pull()` enumerated remote
 * collections via `remote.loadAll()`, whose store contract skips every
 * `_`-prefixed name (`memory-store.ts`'s "system collections hydrate
 * lazily" comment) — so `_dict_*`/`_lookup_*` rows never crossed the wire.
 * Net: reserved lookup collections (dictionaries) never synced.
 *
 * This closes that: `LookupHandle` local writes now fire `onDirty` (dirty
 * log) + `onRecordMutated` (a one-shot graph-dispatch wave open, the
 * local-write origin's thin `graphDispatch.collect`-equivalent), and
 * `SyncEngine.pull()` enumerates an EXPLICIT reserved-lookup prefix
 * registry (declared at `collection()`/`dictionary()` time — NOT a blanket
 * underscore-glob; every other `_`-prefixed namespace keeps its
 * `loadAll`-skip semantics) via `remote.list()` + `remote.get()`, applied
 * through the SAME `applyRemote` path used by ordinary collections, INSIDE
 * `pull()`'s existing try block, BEFORE `persistMeta`/`flush` — so a pulled
 * vocabulary row lands before the phase-C wave (flushed once at pull's end)
 * recomputes any dependent.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withI18n } from '../../src/via/i18n/index.js'
import { withSync } from '../../src/with-party/sync/index.js'
import { SyncEngine, type ReservedLookupSource } from '../../src/with-party/team/sync.js'
import { dict } from '../../src/via/lookup/descriptor.js'
import { reservedDictDepsOf } from '../../src/via/lookup/registry.js'
import { NoydbEventEmitter } from '../../src/kernel/events.js'
import { ConflictError } from '../../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'

// ─── Inline memory adapter (list() does NOT skip `_`-prefixed names; loadAll() does — the store
// contract the whole task rests on, mirrored from dictionary.test.ts / sync-dispatch.test.ts). ───
function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(v: string, c: string) {
    let vm = store.get(v); if (!vm) { vm = new Map(); store.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const cm = gc(v, c); const ex = cm.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      cm.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = store.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [n, cm] of vm) {
        if (n.startsWith('_')) continue // system collections hydrate lazily
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[n] = r
      }
      return snap
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const cm = gc(v, n)
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
      }
    },
  }
}

interface Order extends Record<string, unknown> { id: string; status: string; statusLabel?: string }

describe('reserved-lookup sync (#647, #650 Task 4)', () => {
  it('a vocabulary edit AND a rename on A propagate to B via push/pull; the dependent order re-dresses correctly', async () => {
    const remote = memory()
    const dbA = await createNoydb({ store: memory(), sync: remote, user: 'user-a', syncStrategy: withSync(), i18nStrategy: withI18n(), encrypt: false })
    const dbB = await createNoydb({ store: memory(), sync: remote, user: 'user-b', syncStrategy: withSync(), i18nStrategy: withI18n(), encrypt: false })

    const vA = await dbA.openVault('demo')
    vA.collection<Order>('orders', { lookupFields: { status: dict('status') } })
    await vA.dictionary('status').put('paid', { en: 'Paid' })
    await vA.collection<Order>('orders').put('o1', { id: 'o1', status: 'paid' })
    await dbA.push('demo')

    const vB = await dbB.openVault('demo')
    // Declared BEFORE pull — the reserved-lookup registry is populated at collection()-declare
    // time (not lazily on first vault.dictionary() call), so a fresh instance's FIRST pull already
    // knows to enumerate `_dict_status`.
    vB.collection<Order>('orders', { lookupFields: { status: dict('status') } })

    const pull1 = await dbB.pull('demo')
    expect(pull1.errors).toHaveLength(0)

    // #647: the reserved _dict_status row is now visible after pull — was invisible pre-fix
    // (remote.loadAll() skips `_`-prefixed names; the old pull() never enumerated it at all).
    expect(await vB.dictionary('status').get('paid')).toEqual({ en: 'Paid' })
    const dressed1 = await vB.collection<Order>('orders').get('o1', { locale: 'en' })
    expect(dressed1?.statusLabel).toBe('Paid')

    // Rename on A — cascades to the referencing order's own `status` field via
    // findAndUpdateReferences (an ordinary, choke-point coll.put()), so BOTH the dict row and the
    // order's code change on A.
    await vA.dictionary('status').rename('paid', 'settled')
    await dbA.push('demo')

    const pull2 = await dbB.pull('demo')
    expect(pull2.errors).toHaveLength(0)

    // Ordering assertion: the vocabulary row must have landed BEFORE B's read below observes it —
    // both the renamed order (status: 'settled') and the new dict row are visible together.
    const dressed2 = await vB.collection<Order>('orders').get('o1', { locale: 'en' })
    expect(dressed2?.status).toBe('settled')
    expect(dressed2?.statusLabel).toBe('Paid') // same label under the new key — not stale, not missing

    dbA.close(); dbB.close()
  })

  it('a vault with no reserved-lookup collections declared: pull() never calls remote.list() — zero behavior change (byte-parity)', async () => {
    let listCalls = 0
    const remoteBase = memory()
    const remote: NoydbStore = {
      ...remoteBase,
      async list(v, c) { listCalls++; return remoteBase.list(v, c) },
    }
    const dbA = await createNoydb({ store: memory(), sync: remote, user: 'user-a', syncStrategy: withSync(), encrypt: false })
    const dbB = await createNoydb({ store: memory(), sync: remote, user: 'user-b', syncStrategy: withSync(), encrypt: false })

    const vA = await dbA.openVault('plain')
    await vA.collection<Order>('orders').put('o1', { id: 'o1', status: 'paid' })
    await dbA.push('plain')

    const vB = await dbB.openVault('plain')
    vB.collection<Order>('orders')
    const result = await dbB.pull('plain')

    expect(result.pulled).toBe(1)
    expect(listCalls).toBe(0) // the new reserved-lookup loop is gated on a non-empty registry — never fires here
    dbA.close(); dbB.close()
  })

  it('snapshot invalidation: a pulled reserved-lookup row refreshes an already-warmed LookupHandle — no stale membership verdicts', async () => {
    const remote = memory()
    const dbA = await createNoydb({ store: memory(), sync: remote, user: 'user-a', syncStrategy: withSync(), i18nStrategy: withI18n(), encrypt: false })
    const dbB = await createNoydb({ store: memory(), sync: remote, user: 'user-b', syncStrategy: withSync(), i18nStrategy: withI18n(), encrypt: false })

    const vA = await dbA.openVault('demo')
    await vA.dictionary('status').put('paid', { en: 'Paid' })
    await dbA.push('demo')

    const vB = await dbB.openVault('demo')
    const orders = vB.collection<Order>('orders', { lookupFields: { status: dict('status', { vocabulary: 'closed' }) } })
    // Warm B's LookupHandle BEFORE pull — an empty snapshot (nothing local yet), but now cached
    // in vault.dictionaryCache, so the invalidation path below has something to refresh.
    await vB.dictionary('status').list()
    expect(await vB.dictionary('status').list()).toHaveLength(0)

    await dbB.pull('demo')

    // Without the sync-apply invalidation, the already-warmed (empty) _syncCache would still be
    // empty here, and the closed-vocabulary membership check below would wrongly refuse 'paid'.
    expect(vB.dictionary('status').snapshotEntries().map((e) => e['key'])).toContain('paid')
    await expect(orders.put('o1', { id: 'o1', status: 'paid' })).resolves.not.toThrow()

    dbA.close(); dbB.close()
  })

  it('ordering pin: reserved-lookup rows are applied to the local store BEFORE the graph-dispatch wave flushes', async () => {
    const local = memory()
    const remote = memory()
    const seedEnvelope: EncryptedEnvelope = {
      _noydb: 1, _v: 1, _ts: new Date().toISOString(), _iv: '', _data: JSON.stringify({ key: 'settled', labels: { en: 'Settled' } }),
    }
    await remote.put('demo', '_dict_status', 'settled', seedEnvelope)

    const engine = new SyncEngine({ local, remote, vault: 'demo', strategy: 'version', emitter: new NoydbEventEmitter() })
    const source: ReservedLookupSource = { collections: () => ['_dict_status'] }
    engine.setReservedLookupSource(source)

    let sawRowAtFlush: EncryptedEnvelope | null = null
    let flushCalled = false
    engine.setGraphBatchController({
      begin() {},
      async flush() {
        flushCalled = true
        sawRowAtFlush = await local.get('demo', '_dict_status', 'settled')
      },
    })

    const before = await local.get('demo', '_dict_status', 'settled')
    expect(before).toBeNull() // not applied yet

    await engine.pull()

    expect(flushCalled).toBe(true)
    // The row was ALREADY applied locally by the time flush() ran — proves the record-apply stage
    // (this task's new reserved-prefix loop) precedes the wave flush, not the reverse.
    expect(sawRowAtFlush).not.toBeNull()
    expect((sawRowAtFlush as EncryptedEnvelope | null)?._data).toBe(seedEnvelope._data)
  })

  // ─── #647 fix wave 1 — reserved delete/rename-removal propagation (delete-markers) ───────────

  it('a key deleted on A propagates to B on pull: get is null, closed-vocabulary membership refuses it, snapshot excludes it', async () => {
    const remote = memory()
    const dbA = await createNoydb({ store: memory(), sync: remote, user: 'user-a', syncStrategy: withSync(), i18nStrategy: withI18n(), encrypt: false })
    const dbB = await createNoydb({ store: memory(), sync: remote, user: 'user-b', syncStrategy: withSync(), i18nStrategy: withI18n(), encrypt: false })

    const vA = await dbA.openVault('demo')
    await vA.dictionary('status').put('paid', { en: 'Paid' })
    await dbA.push('demo')

    const vB = await dbB.openVault('demo')
    const orders = vB.collection<Order>('orders', { lookupFields: { status: dict('status', { vocabulary: 'closed' }) } })
    await dbB.pull('demo')
    expect(await vB.dictionary('status').get('paid')).toEqual({ en: 'Paid' })
    // Warm B's cache (closed-vocabulary membership is a sync, cache-only read) and confirm
    // 'paid' is known before the delete lands.
    await vB.dictionary('status').list()
    await expect(orders.put('o1', { id: 'o1', status: 'paid' })).resolves.not.toThrow()

    // A deletes the key and pushes.
    await vA.dictionary('status').delete('paid')
    await dbA.push('demo')

    const pull2 = await dbB.pull('demo')
    expect(pull2.errors).toHaveLength(0)

    // Pre-fix: LookupHandle.delete() does a raw adapter.delete() — invisible to remote.list() —
    // so none of this observes the deletion; 'paid' persists on B forever (silent resurrection risk).
    expect(await vB.dictionary('status').get('paid')).toBeNull()
    expect(vB.dictionary('status').snapshotEntries().map((e) => e['key'])).not.toContain('paid')
    await expect(orders.put('o2', { id: 'o2', status: 'paid' })).rejects.toThrow()

    dbA.close(); dbB.close()
  })

  it('phantom-rename: A renames paid->settled and pushes; B pulls and has settled AND NOT paid', async () => {
    const remote = memory()
    const dbA = await createNoydb({ store: memory(), sync: remote, user: 'user-a', syncStrategy: withSync(), i18nStrategy: withI18n(), encrypt: false })
    const dbB = await createNoydb({ store: memory(), sync: remote, user: 'user-b', syncStrategy: withSync(), i18nStrategy: withI18n(), encrypt: false })

    const vA = await dbA.openVault('demo')
    await vA.dictionary('status').put('paid', { en: 'Paid' })
    await dbA.push('demo')

    const vB = await dbB.openVault('demo')
    vB.dictionary('status') // declare BEFORE pull — registers `_dict_status` in the reserved-lookup registry pull() enumerates
    await dbB.pull('demo')
    expect(await vB.dictionary('status').get('paid')).toEqual({ en: 'Paid' })

    await vA.dictionary('status').rename('paid', 'settled')
    await dbA.push('demo')

    const pull2 = await dbB.pull('demo')
    expect(pull2.errors).toHaveLength(0)

    expect(await vB.dictionary('status').get('settled')).toEqual({ en: 'Paid' })
    // Pre-fix: rename's old-key removal is a raw adapter.delete() on A's LOCAL store — invisible
    // to remote.list() (the row simply vanishes from remote) — so B's pull loop never encounters
    // 'paid' at all, and its stale local copy from the earlier pull survives forever (the phantom
    // key the original E2E test's assertions never checked for).
    expect(await vB.dictionary('status').get('paid')).toBeNull()
    await vB.dictionary('status').list()
    const keys = vB.dictionary('status').snapshotEntries().map((e) => e['key'])
    expect(keys).toContain('settled')
    expect(keys).not.toContain('paid')

    dbA.close(); dbB.close()
  })

  it('resurrection-prevention: a concurrent local edit on B does not resurrect a key A deleted at a converging version', async () => {
    const remote = memory()
    const dbA = await createNoydb({ store: memory(), sync: remote, user: 'user-a', syncStrategy: withSync(), i18nStrategy: withI18n(), encrypt: false })
    const dbB = await createNoydb({ store: memory(), sync: remote, user: 'user-b', syncStrategy: withSync(), i18nStrategy: withI18n(), encrypt: false })

    const vA = await dbA.openVault('demo')
    await vA.dictionary('status').put('paid', { en: 'Paid' })
    await dbA.push('demo')

    const vB = await dbB.openVault('demo')
    vB.dictionary('status') // declare BEFORE pull — registers `_dict_status` in the reserved-lookup registry pull() enumerates
    await dbB.pull('demo')
    expect(await vB.dictionary('status').get('paid')).toEqual({ en: 'Paid' })

    // B edits K locally (dirty, unsynced) while A independently deletes K and pushes first — A's
    // delete marker lands on the remote at a version that TIES B's own local (unsynced) edit.
    await vB.dictionary('status').put('paid', { en: 'Paid (B edit)' })
    await vA.dictionary('status').delete('paid')
    await dbA.push('demo')

    // B pulls: the delete marker must win the tie over B's own unsynced edit — no resurrection.
    const pull2 = await dbB.pull('demo')
    expect(pull2.errors).toHaveLength(0)
    expect(await vB.dictionary('status').get('paid')).toBeNull()

    // B's own subsequent push must not resurrect the key on the remote either — the pending
    // dirty 'put' from B's edit must not silently win the CAS.
    const push2 = await dbB.push('demo')
    expect(push2.errors).toHaveLength(0)

    // Converged: a THIRD, fresh instance pulling from the same remote never sees 'paid' resurrected.
    const dbC = await createNoydb({ store: memory(), sync: remote, user: 'user-c', syncStrategy: withSync(), i18nStrategy: withI18n(), encrypt: false })
    const vC = await dbC.openVault('demo')
    vC.dictionary('status') // declare BEFORE pull — same registration requirement as B above
    await dbC.pull('demo')
    expect(await vC.dictionary('status').get('paid')).toBeNull()

    dbA.close(); dbB.close(); dbC.close()
  })

  // ─── #653 — partial sync must auto-include the reserved dicts a named collection depends on ───

  it('#653: partial pull([\'orders\']) still resolves the reserved dict orders depends on (literal filter would drop _dict_status)', async () => {
    const remote = memory()
    const dbA = await createNoydb({ store: memory(), sync: remote, user: 'user-a', syncStrategy: withSync(), i18nStrategy: withI18n(), encrypt: false })
    const dbB = await createNoydb({ store: memory(), sync: remote, user: 'user-b', syncStrategy: withSync(), i18nStrategy: withI18n(), encrypt: false })

    const vA = await dbA.openVault('demo')
    vA.collection<Order>('orders', { lookupFields: { status: dict('status') } })
    await vA.dictionary('status').put('paid', { en: 'Paid' })
    await vA.collection<Order>('orders').put('o1', { id: 'o1', status: 'paid' })
    await dbA.push('demo')

    const vB = await dbB.openVault('demo')
    vB.collection<Order>('orders', { lookupFields: { status: dict('status') } })

    // Adopters never name `_dict_*` in a partial-sync filter — only 'orders' is named here.
    const pull1 = await dbB.pull('demo', { collections: ['orders'] })
    expect(pull1.errors).toHaveLength(0)

    // #653: a collections-filtered pull must still auto-include orders' reserved dict dependency.
    // Pre-fix, the literal filter drops `_dict_status` — this resolves to `undefined`.
    expect(await vB.dictionary('status').get('paid')).toEqual({ en: 'Paid' })
    const dressed = await vB.collection<Order>('orders').get('o1', { locale: 'en' })
    expect(dressed?.statusLabel).toBe('Paid')

    dbA.close(); dbB.close()
  })

  it('#653: partial pull of a collection with NO lookup fields does not over-pull an unrelated dict', async () => {
    interface Payment extends Record<string, unknown> { id: string; amount: number }
    const remote = memory()
    const dbA = await createNoydb({ store: memory(), sync: remote, user: 'user-a', syncStrategy: withSync(), i18nStrategy: withI18n(), encrypt: false })
    const dbB = await createNoydb({ store: memory(), sync: remote, user: 'user-b', syncStrategy: withSync(), i18nStrategy: withI18n(), encrypt: false })

    const vA = await dbA.openVault('demo')
    vA.collection<Order>('orders', { lookupFields: { status: dict('status') } })
    await vA.dictionary('status').put('paid', { en: 'Paid' })
    await vA.collection<Order>('orders').put('o1', { id: 'o1', status: 'paid' })
    vA.collection<Payment>('payments')
    await vA.collection<Payment>('payments').put('p1', { id: 'p1', amount: 100 })
    await dbA.push('demo')

    const vB = await dbB.openVault('demo')
    // Both a dict-backed collection AND the unrelated, lookup-field-free 'payments' are declared —
    // only 'payments' is named in the filter below.
    vB.collection<Order>('orders', { lookupFields: { status: dict('status') } })
    vB.collection<Payment>('payments')

    const pull1 = await dbB.pull('demo', { collections: ['payments'] })
    expect(pull1.errors).toHaveLength(0)

    expect(await vB.collection<Payment>('payments').get('p1')).toEqual({ id: 'p1', amount: 100 })
    // Guard against over-pulling: 'orders' was never named, so its dict dependency must stay absent.
    expect(await vB.dictionary('status').get('paid')).toBeNull()

    dbA.close(); dbB.close()
  })
})

describe('reservedDictDepsOf (#653 unit)', () => {
  it('maps a named collection to its one-hop reserved dict dependency', () => {
    const registry = new Map([['orders', { status: 'status' }]])
    expect(reservedDictDepsOf(['orders'], registry)).toEqual(['_dict_status'])
  })

  it('returns empty for a named collection with no lookup-field dependencies', () => {
    const registry = new Map([['orders', { status: 'status' }]])
    expect(reservedDictDepsOf(['payments'], registry)).toEqual([])
  })
})
