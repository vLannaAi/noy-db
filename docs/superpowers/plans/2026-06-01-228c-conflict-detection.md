# Cross-tab conflict detection (#228 sub-slice c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When two same-origin tabs write the same document concurrently, each tab emits a `WriteConflict` (decrypted `local`/`remote`/`base` + versions) so the app can reconcile; the hub converges the cache to the store's authoritative value but never auto-resolves.

**Architecture:** Extend the (b) propagation signal with `baseV`/`v` (sourced from two new `WriteEvent` fields). The relay keeps a per-doc own-write ledger and detects a conflict when an incoming write's `baseV` is below this tab's own-write version; it then calls a host `reportConflict` callback that captures the clobbered record, converges via the existing (b) re-read, reads the ancestor from history, and emits `write:conflict`. Post-hoc, role-agnostic, no write-path CAS.

**Tech Stack:** TypeScript, Vitest. Package: `packages/hub`. Builds on (b)'s `CrossTabWriteRelay`, `_applyRemoteChange`, `_applyRemoteWrite`.

**Spec:** `docs/superpowers/specs/2026-06-01-228c-conflict-detection-design.md`. Issue #228 (final slice).

---

## File structure

- **Modify** `packages/hub/src/write-hooks.ts` — `baseVersion` + `version` on `WriteEvent`.
- **Modify** `packages/hub/src/collection.ts` — `#priorRecordForHook` → `#priorForHook` (also returns version); set the two new fields at both emit sites; add `_peekCached(id)`.
- **Modify** `packages/hub/src/tab-write-relay.ts` — `baseV`/`v` on `TabWriteMsg`; own-write ledger; conflict rule; optional `reportConflict`.
- **Modify** `packages/hub/src/vault.ts` — `_captureAndConverge(collectionName, docId, action, baseV)`.
- **Modify** `packages/hub/src/types.ts` — `WriteConflict` interface + `'write:conflict'` in `NoydbEventMap`.
- **Modify** `packages/hub/src/noydb.ts` — wire `reportConflict` → `#reportWriteConflict`; add `onWriteConflict`.
- **Modify** `packages/hub/src/index.ts` — export `WriteConflict`.
- **Modify** `features.yaml` — extend the `cross-tab-write-propagation` entry (or add a conflict entry).
- **Tests:** extend `__tests__/write-hooks-integration.test.ts`, `__tests__/tab-write-relay.test.ts`, `__tests__/tab-write-propagation.test.ts`.

---

## Task 1: `baseVersion` + `version` on `WriteEvent`

**Files:** Modify `packages/hub/src/write-hooks.ts`, `packages/hub/src/collection.ts:1106-1135`, `:1686-1692`; Test `packages/hub/__tests__/write-hooks-integration.test.ts`

- [ ] **Step 1: Write the failing test** — append inside `describe('write lifecycle hooks (#230)', ...)`:

```ts
  it('WriteEvent carries baseVersion and version (#228c)', async () => {
    const db = await setup()
    const v = await db.openVault('demo')
    const c = v.collection<Inv>('invoices')
    const events: WriteEvent[] = []
    db.onAfterWrite((e) => { events.push(e) })
    await c.put('i1', { id: 'i1', amount: 1 }) // create
    await c.put('i1', { id: 'i1', amount: 2 }) // update
    expect(events[0]!.baseVersion).toBe(0)
    expect(events[0]!.version).toBe(1)
    expect(events[1]!.baseVersion).toBe(1)
    expect(events[1]!.version).toBe(2)
  })
```

- [ ] **Step 2: Run → fail** (`cd packages/hub && npx vitest run __tests__/write-hooks-integration.test.ts -t "baseVersion"`) — `undefined`.

- [ ] **Step 3a: Add the fields** — `packages/hub/src/write-hooks.ts`, in `WriteEvent` after `after`:

```ts
  readonly after: unknown // the record written; null on 'delete'
  readonly baseVersion: number // #228c — version the writer started from (0 on create)
  readonly version: number // #228c — version the writer wrote (baseVersion + 1)
```

- [ ] **Step 3b: Refactor the prior-record helper** — `packages/hub/src/collection.ts`, replace `#priorRecordForHook` (~line 1127):

```ts
  async #priorForHook(id: string): Promise<{ record: unknown; version: number }> {
    const env = await this.adapter.get(this.vault, this.name, id)
    if (!env) return { record: null, version: 0 }
    return { record: (await this.decryptRecord(env, { skipValidation: true })) as unknown, version: env._v }
  }
```

- [ ] **Step 3c: Update the put emit site** (~line 1106-1113):

```ts
    let event: WriteEvent | undefined
    if (this.#hooksActive()) {
      const prior = await this.#priorForHook(id)
      event = {
        op: prior.record === null ? 'create' : 'update',
        vault: this.vault, collection: this.name, docId: id, before: prior.record, after: record,
        userId: this.keyring.userId, timestamp: Date.now(), txId: this.#txIdForHook(),
        baseVersion: prior.version, version: prior.version + 1,
      }
      await this.writeHooks!.runBefore(event) // throw → aborts the write
    }
```

- [ ] **Step 3d: Update the delete emit site** (~line 1686-1692):

```ts
    let event: WriteEvent | undefined
    if (this.#hooksActive()) {
      const prior = await this.#priorForHook(id)
      event = {
        op: 'delete', vault: this.vault, collection: this.name, docId: id, before: prior.record, after: null,
        userId: this.keyring.userId, timestamp: Date.now(), txId: this.#txIdForHook(),
        baseVersion: prior.version, version: prior.version + 1,
      }
      await this.writeHooks!.runBefore(event)
    }
```

- [ ] **Step 4: Run → pass + typecheck** (`cd packages/hub && npx vitest run __tests__/write-hooks-integration.test.ts && npx tsc --noEmit`). Expected: PASS, clean. (tsc will confirm there are no other `WriteEvent` literals missing the new fields.)

- [ ] **Step 5: Commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/write-hooks.ts packages/hub/src/collection.ts packages/hub/__tests__/write-hooks-integration.test.ts
git commit -m "feat(hub): add baseVersion/version to WriteEvent (#228)"
```

---

## Task 2: relay — own-write ledger + conflict rule

**Files:** Modify `packages/hub/src/tab-write-relay.ts`; Test `packages/hub/__tests__/tab-write-relay.test.ts`

- [ ] **Step 1: Update the unit test** — `packages/hub/__tests__/tab-write-relay.test.ts`. (a) extend `ev()` to set the new fields; (b) update the two broadcast-shape assertions to include `baseV`/`v`; (c) add three conflict-rule tests. Replace the `ev` helper and append the new tests:

Replace the `ev` helper with:
```ts
function ev(partial: Partial<WriteEvent>): WriteEvent {
  return { op: 'update', vault: 'books', collection: 'invoices', docId: 'i1', before: null, after: { id: 'i1' }, userId: 'u', timestamp: 0, txId: 't', baseVersion: 3, version: 4, ...partial }
}
```

In the first test (`broadcasts a tab-write signal...`), change the expected object to:
```ts
    expect(received).toEqual({ kind: 'tab-write', writerId: 'A', vault: 'books', collection: 'invoices', docId: 'i9', action: 'put', baseV: 3, v: 4 })
```

In the second test (`maps op:delete...`) no change is needed (it only checks `received.action`).

Append these tests inside the `describe('CrossTabWriteRelay', ...)` block:
```ts
  it('reports a conflict when a remote write predates this tab\'s own write', async () => {
    const [chA, chB] = makeBus(2)
    const srcA = fakeAfterWrite(); const srcB = fakeAfterWrite()
    const applied: string[] = []; const conflicts: Array<[string, number, number, number]> = []
    const relayA = new CrossTabWriteRelay({ channel: chA!, writerId: 'A', subscribeAfterWrite: srcA.subscribe, applyRemoteWrite: () => {} })
    const relayB = new CrossTabWriteRelay({
      channel: chB!, writerId: 'B', subscribeAfterWrite: srcB.subscribe,
      applyRemoteWrite: (_v, _c, d) => { applied.push(d) },
      reportConflict: (_v, _c, d, _a, baseV, v, ownV) => { conflicts.push([d, baseV, v, ownV]) },
    })
    relayA.start(); relayB.start()
    srcB.fire(ev({ docId: 'i1', baseVersion: 3, version: 4 })) // B writes i1 @v4 → ledger[i1]=4
    srcA.fire(ev({ docId: 'i1', baseVersion: 3, version: 4 })) // A wrote i1 from base 3 too
    await flush()
    expect(conflicts).toEqual([['i1', 3, 4, 4]]) // baseV 3 < ownV 4 → conflict
    expect(applied).toEqual([])                  // conflict path does NOT also apply
    relayA.dispose(); relayB.dispose()
  })

  it('no conflict when the remote incorporated our write (baseV >= ownV)', async () => {
    const [chA, chB] = makeBus(2)
    const srcA = fakeAfterWrite(); const srcB = fakeAfterWrite()
    const applied: string[] = []; let conflictCount = 0
    const relayA = new CrossTabWriteRelay({ channel: chA!, writerId: 'A', subscribeAfterWrite: srcA.subscribe, applyRemoteWrite: () => {} })
    const relayB = new CrossTabWriteRelay({
      channel: chB!, writerId: 'B', subscribeAfterWrite: srcB.subscribe,
      applyRemoteWrite: (_v, _c, d) => { applied.push(d) },
      reportConflict: () => { conflictCount++ },
    })
    relayA.start(); relayB.start()
    srcB.fire(ev({ docId: 'i1', baseVersion: 3, version: 4 }))   // ledger[i1]=4
    srcA.fire(ev({ docId: 'i1', baseVersion: 4, version: 5 }))   // A built on our v4
    await flush()
    expect(conflictCount).toBe(0)
    expect(applied).toEqual(['i1'])
    relayA.dispose(); relayB.dispose()
  })

  it('no conflict for a doc this tab never wrote', async () => {
    const [chA, chB] = makeBus(2)
    const srcA = fakeAfterWrite(); const srcB = fakeAfterWrite()
    const applied: string[] = []; let conflictCount = 0
    const relayA = new CrossTabWriteRelay({ channel: chA!, writerId: 'A', subscribeAfterWrite: srcA.subscribe, applyRemoteWrite: () => {} })
    const relayB = new CrossTabWriteRelay({
      channel: chB!, writerId: 'B', subscribeAfterWrite: srcB.subscribe,
      applyRemoteWrite: (_v, _c, d) => { applied.push(d) },
      reportConflict: () => { conflictCount++ },
    })
    relayA.start(); relayB.start()
    srcA.fire(ev({ docId: 'i2', baseVersion: 3, version: 4 }))   // B never wrote i2
    await flush()
    expect(conflictCount).toBe(0)
    expect(applied).toEqual(['i2'])
    relayA.dispose(); relayB.dispose()
  })
```

- [ ] **Step 2: Run → fail** (`cd packages/hub && npx vitest run __tests__/tab-write-relay.test.ts`) — `baseV`/`v` missing from msg; `reportConflict` not honored.

- [ ] **Step 3: Implement** — edit `packages/hub/src/tab-write-relay.ts`:

(a) `TabWriteMsg` — add the two fields:
```ts
export interface TabWriteMsg {
  readonly kind: 'tab-write'
  readonly writerId: string
  readonly vault: string
  readonly collection: string
  readonly docId: string
  readonly action: 'put' | 'delete'
  readonly baseV: number
  readonly v: number
}
```

(b) `CrossTabWriteRelayOptions` — add:
```ts
  /** Report a detected conflict (host captures + converges + emits). #228c. */
  readonly reportConflict?: (vault: string, collection: string, docId: string, action: 'put' | 'delete', baseV: number, v: number, ownV: number) => void | Promise<void>
```

(c) Fields — add to the class:
```ts
  readonly #reportConflict: CrossTabWriteRelayOptions['reportConflict']
  readonly #ledger = new Map<string, number>()
```
and in the constructor: `this.#reportConflict = opts.reportConflict`.

(d) A key helper (module scope, bottom of file):
```ts
function ledgerKey(vault: string, collection: string, docId: string): string {
  return `${vault} ${collection} ${docId}`
}
```

(e) `#onLocalWrite` — record the ledger and broadcast versions:
```ts
  #onLocalWrite(e: WriteEvent): void {
    if (this.#disposed || !this.#channel.isOpen) return
    this.#ledger.set(ledgerKey(e.vault, e.collection, e.docId), e.version)
    const action: 'put' | 'delete' = e.op === 'delete' ? 'delete' : 'put'
    const msg: TabWriteMsg = { kind: 'tab-write', writerId: this.#writerId, vault: e.vault, collection: e.collection, docId: e.docId, action, baseV: e.baseVersion, v: e.version }
    this.#channel.send(JSON.stringify(msg))
  }
```

(f) `#onMessage` — apply the conflict rule:
```ts
  #onMessage(payload: string): void {
    if (this.#disposed) return
    let msg: unknown
    try { msg = JSON.parse(payload) } catch { return }
    if (!isTabWriteMsg(msg) || msg.writerId === this.#writerId) return
    const key = ledgerKey(msg.vault, msg.collection, msg.docId)
    const ownV = this.#ledger.get(key)
    if (ownV !== undefined && msg.baseV < ownV && this.#reportConflict) {
      void Promise.resolve(this.#reportConflict(msg.vault, msg.collection, msg.docId, msg.action, msg.baseV, msg.v, ownV)).catch((err) => {
        console.warn(`[noy-db] cross-tab conflict report failed for ${msg.collection}/${msg.docId}: ` + (err instanceof Error ? err.message : String(err)))
      })
      return
    }
    if (ownV !== undefined && msg.baseV >= ownV) this.#ledger.set(key, msg.v) // remote incorporated our write → advance
    void Promise.resolve(this.#applyRemoteWrite(msg.vault, msg.collection, msg.docId, msg.action)).catch((err) => {
      console.warn(`[noy-db] cross-tab apply failed for ${msg.collection}/${msg.docId}: ` + (err instanceof Error ? err.message : String(err)))
    })
  }
```

(g) `isTabWriteMsg` — validate the new fields (add to the boolean chain):
```ts
    && (o['action'] === 'put' || o['action'] === 'delete')
    && typeof o['baseV'] === 'number'
    && typeof o['v'] === 'number'
```

- [ ] **Step 4: Run → pass + typecheck + lint** (`cd packages/hub && npx vitest run __tests__/tab-write-relay.test.ts && npx tsc --noEmit && npx eslint src/tab-write-relay.ts`). Expected: all pass; clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/tab-write-relay.ts packages/hub/__tests__/tab-write-relay.test.ts
git commit -m "feat(hub): relay own-write ledger + conflict rule (#228)"
```

---

## Task 3: `Collection._peekCached` + `Vault._captureAndConverge`

**Files:** Modify `packages/hub/src/collection.ts` (after `_applyRemoteChange`), `packages/hub/src/vault.ts` (after `_applyRemoteWrite`); Test `packages/hub/__tests__/tab-write-propagation.test.ts`

- [ ] **Step 1: Write the failing test** — append a describe to `packages/hub/__tests__/tab-write-propagation.test.ts`:

```ts
describe('capture + converge primitive (#228c)', () => {
  it('_captureAndConverge yields local (clobbered), remote (store), base (ancestor)', async () => {
    const { db1, db2, v2, c1, c2 } = await twoTabs() // db1 seeded { seed, amount:0 } @v1
    await c2.get('seed')              // db2 caches seed @v1
    await c1.put('seed', { id: 'seed', amount: 99 }) // db1 overwrites in shared store @v2

    const cap = await v2._captureAndConverge('invoices', 'seed', 'put', 1)
    expect(cap).not.toBeNull()
    expect((cap!.local as { amount: number }).amount).toBe(0)   // db2's pre-converge cache
    expect((cap!.remote as { amount: number }).amount).toBe(99) // store after converge
    expect((cap!.base as { amount: number }).amount).toBe(0)    // ancestor @v1 from history
    db1.close(); db2.close()
  })

  it('_captureAndConverge returns null for an unloaded collection', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: SECRET })
    const v = await db.openVault('books')
    expect(await v._captureAndConverge('not-loaded', 'x', 'put', 0)).toBeNull()
    db.close()
  })
})
```

- [ ] **Step 2: Run → fail** (`cd packages/hub && npx vitest run __tests__/tab-write-propagation.test.ts -t "capture"`) — methods don't exist.

- [ ] **Step 3a: `Collection._peekCached`** — add to `packages/hub/src/collection.ts` immediately after `_applyRemoteChange`:

```ts
  /** @internal #228c — the current in-memory record without a store read (for conflict capture). */
  _peekCached(id: string): T | null {
    const entry = this.lazy && this.lru ? this.lru.get(id) : this.cache.get(id)
    return entry ? entry.record : null
  }
```

- [ ] **Step 3b: `Vault._captureAndConverge`** — add to `packages/hub/src/vault.ts` immediately after `_applyRemoteWrite`:

```ts
  /**
   * #228c — for a detected conflict: capture this tab's clobbered record,
   * read the common ancestor from history, converge the cache to the store's
   * authoritative value (the (b) re-read), and return all three for the
   * WriteConflict payload. Returns null when the collection isn't loaded.
   */
  async _captureAndConverge(
    collectionName: string,
    docId: string,
    action: 'put' | 'delete',
    baseV: number,
  ): Promise<{ local: unknown; remote: unknown; base: unknown } | null> {
    const coll = this.collectionCache.get(collectionName)
    if (!coll) return null
    const local = coll._peekCached(docId)
    let base: unknown = null
    try { base = await coll.getVersion(docId, baseV) } catch { base = null }
    await coll._applyRemoteChange(docId, action)
    const remote = coll._peekCached(docId)
    return { local, remote, base }
  }
```

- [ ] **Step 4: Run → pass + typecheck** (`cd packages/hub && npx vitest run __tests__/tab-write-propagation.test.ts -t "capture" && npx tsc --noEmit`). Expected: 2 pass, clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/collection.ts packages/hub/src/vault.ts packages/hub/__tests__/tab-write-propagation.test.ts
git commit -m "feat(hub): _peekCached + _captureAndConverge for conflict capture (#228)"
```

---

## Task 4: `WriteConflict` type, `noydb` wiring, `onWriteConflict`

**Files:** Modify `packages/hub/src/types.ts`, `packages/hub/src/noydb.ts`, `packages/hub/src/index.ts`; Test `packages/hub/__tests__/tab-write-propagation.test.ts`

- [ ] **Step 1: Write the failing integration test** — append to `packages/hub/__tests__/tab-write-propagation.test.ts`. Add a manual (deferred-delivery) bus + a conflict-counting describe:

```ts
/** A bus that QUEUES sends until deliver() — lets both tabs write before any delivery. */
function makeManualBus(n: number): { chans: TabChannel[]; deliver: () => void } {
  const listeners: Array<((p: string) => void) | null> = []
  const queue: Array<{ from: number; payload: string }> = []
  const chans: TabChannel[] = []
  for (let i = 0; i < n; i++) {
    const idx = i
    chans.push({
      isOpen: true,
      send(payload) { queue.push({ from: idx, payload }) },
      on(event, l) { if (event === 'message') { listeners[idx] = l as (p: string) => void; return () => { listeners[idx] = null } } return () => {} },
      close() { listeners[idx] = null },
    })
  }
  const deliver = () => { const q = queue.splice(0); for (const { from, payload } of q) for (let j = 0; j < listeners.length; j++) if (j !== from && listeners[j]) listeners[j]!(payload) }
  return { chans, deliver }
}

describe('cross-tab conflict detection (#228c)', () => {
  it('concurrent writes: both tabs emit WriteConflict; caches converge', async () => {
    const { db1, db2, c1, c2 } = await twoTabs() // seed 'i1' @v1 in db1
    const { chans: [wA, wB], deliver } = makeManualBus(2)
    db1.enableTabCoordination({ writeChannel: wA!, tabId: 'A' })
    db2.enableTabCoordination({ writeChannel: wB!, tabId: 'B' })
    await c1.get('seed'); await c2.get('seed') // hydrate both

    const seen1: import('../src/types.js').WriteConflict[] = []
    const seen2: import('../src/types.js').WriteConflict[] = []
    db1.onWriteConflict((cf) => seen1.push(cf))
    db2.onWriteConflict((cf) => seen2.push(cf))

    // Concurrent: both write 'seed' from base v1 before any signal is delivered.
    await c1.put('seed', { id: 'seed', amount: 10 }) // db1 → store
    await c2.put('seed', { id: 'seed', amount: 20 }) // db2 → store (wins LWW)
    deliver()
    await settle()

    expect(seen1).toHaveLength(1)
    expect(seen2).toHaveLength(1)
    expect((seen1[0]!.local as { amount: number }).amount).toBe(10)  // db1 (loser) clobbered write
    expect((seen1[0]!.remote as { amount: number }).amount).toBe(20) // store's winner
    expect((seen1[0]!.base as { amount: number }).amount).toBe(0)    // ancestor (seed)
    expect(seen1[0]!.baseVersion).toBe(1)
    expect((await c1.get('seed'))!.amount).toBe(20)                  // db1 converged
    expect((await c2.get('seed'))!.amount).toBe(20)
    db1.close(); db2.close()
  })

  it('a write the other tab has already seen fires no conflict', async () => {
    const { db1, db2, c1, c2 } = await twoTabs()
    const { chans: [wA, wB], deliver } = makeManualBus(2)
    db1.enableTabCoordination({ writeChannel: wA!, tabId: 'A' })
    db2.enableTabCoordination({ writeChannel: wB!, tabId: 'B' })
    await c2.get('seed')
    let conflicts = 0
    db2.onWriteConflict(() => { conflicts++ })

    await c1.put('seed', { id: 'seed', amount: 5 }) // db2 never wrote 'seed'
    deliver()
    await settle()

    expect(conflicts).toBe(0)
    expect((await c2.get('seed'))!.amount).toBe(5) // applied, no conflict
    db1.close(); db2.close()
  })
})
```

- [ ] **Step 2: Run → fail** (`onWriteConflict`/`WriteConflict` don't exist).

- [ ] **Step 3a: `WriteConflict` + event** — `packages/hub/src/types.ts`. Add the interface next to `Conflict` (search `export interface Conflict`):

```ts
/**
 * #228c — a same-device cross-tab write conflict: another tab overwrote a
 * document this tab had written, having diverged from an older base. Records
 * are decrypted (cross-tab handlers reconcile in plaintext). `base` is the
 * common ancestor from history, or null when history is unavailable.
 */
export interface WriteConflict {
  readonly vault: string
  readonly collection: string
  readonly docId: string
  readonly local: unknown
  readonly remote: unknown
  readonly base: unknown | null
  readonly localVersion: number
  readonly remoteVersion: number
  readonly baseVersion: number
}
```

In `NoydbEventMap`, add (next to `'sync:conflict': Conflict`):
```ts
  'write:conflict': WriteConflict
```

- [ ] **Step 3b: noydb wiring** — `packages/hub/src/noydb.ts`.

Import the type (extend the existing `types.js` type import, or add one):
```ts
import type { WriteConflict } from './types.js'
```

In `enableTabCoordination`, add `reportConflict` to the `CrossTabWriteRelay` options (alongside `applyRemoteWrite`):
```ts
          reportConflict: (vault, collection, docId, action, baseV, v, ownV) => this.#reportWriteConflict(vault, collection, docId, action, baseV, v, ownV),
```

Add the reporter beside `#applyRemoteWrite`:
```ts
  async #reportWriteConflict(vaultName: string, collectionName: string, docId: string, action: 'put' | 'delete', baseV: number, v: number, ownV: number): Promise<void> {
    const vault = this.vaultCache.get(vaultName)
    if (!vault) return
    const cap = await vault._captureAndConverge(collectionName, docId, action, baseV)
    if (!cap) return
    const conflict: WriteConflict = {
      vault: vaultName, collection: collectionName, docId,
      local: cap.local, remote: cap.remote, base: cap.base,
      localVersion: ownV, remoteVersion: v, baseVersion: baseV,
    }
    this.emitter.emit('write:conflict', conflict)
  }
```

Add the subscription helper near `onAfterWrite` (~line 1190):
```ts
  /** Subscribe to cross-tab write conflicts (#228c). Returns an unsubscribe. */
  onWriteConflict(fn: (c: WriteConflict) => void): Unsubscribe {
    this.on('write:conflict', fn)
    return () => this.off('write:conflict', fn)
  }
```

- [ ] **Step 3c: export** — `packages/hub/src/index.ts`, in the multi-tab block:
```ts
// Cross-tab write conflict (#228c)
export type { WriteConflict } from './types.js'
```

- [ ] **Step 4: Run → pass + typecheck + lint + full suite**

Run: `cd packages/hub && npx vitest run __tests__/tab-write-propagation.test.ts && npx tsc --noEmit && npx eslint src/noydb.ts src/types.ts && npx vitest run`
Expected: propagation suite passes; tsc + eslint clean; full suite green, clean exit.

- [ ] **Step 5: Commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/types.ts packages/hub/src/noydb.ts packages/hub/src/index.ts packages/hub/__tests__/tab-write-propagation.test.ts
git commit -m "feat(hub): WriteConflict + onWriteConflict — cross-tab conflict detection (#228)"
```

---

## Task 5: register the feature + final verify

**Files:** Modify `features.yaml`

- [ ] **Step 1: Add invariants** — in `features.yaml`, append two invariants to the existing `cross-tab-write-propagation` entry's `invariants:` list (just before its `related:` line):

```yaml
      - 'concurrent same-doc writes are detected: each tab emits a WriteConflict (decrypted local/remote/base + versions) when a remote write diverged from a base older than its own write (#228c)'
      - 'conflict detection converges the cache to the store but never auto-resolves; a tab that never wrote the doc never reports a conflict'
```

- [ ] **Step 2: Validate + full verify**

```bash
cd /Users/vicio/_github/noy-db && node scripts/validate-features.mjs
cd packages/hub && npx vitest run && npx tsc --noEmit && npm run lint && npm run build
```
Expected: validator PASS; full suite PASS (clean exit); tsc + lint + build clean.

- [ ] **Step 3: Commit + clean tree**

```bash
cd /Users/vicio/_github/noy-db && git add features.yaml
git commit -m "chore(hub): register cross-tab conflict-detection invariants (#228)"
git status
```

---

## Self-review checklist (applied)

- **Spec coverage:** `baseV`/`v` signal + `baseVersion`/`version` on `WriteEvent` → Task 1 + Task 2; own-write ledger + `baseV < ownV` rule → Task 2; `WriteConflict` decrypted payload + `base` from history → Task 3 (`_captureAndConverge` via `getVersion`) + Task 4; `onWriteConflict` / `write:conflict` → Task 4; converge-then-notify → Task 3 (`_applyRemoteChange` inside capture) + Task 4 reporter ordering; false-positive guard (no own-write ⇒ no conflict) → Task 2 test 3 + Task 4 test 2; both-tabs-emit → Task 4 test 1; opt-in/no-op inherited from (b) wiring; features.yaml → Task 5.
- **Type consistency:** `WriteEvent.{baseVersion,version}`, `TabWriteMsg.{baseV,v}`, `reportConflict(vault,collection,docId,action,baseV,v,ownV)`, `_captureAndConverge(collectionName,docId,action,baseV) → {local,remote,base}|null`, `_peekCached(id):T|null`, `WriteConflict.{local,remote,base,localVersion,remoteVersion,baseVersion}`, `#reportWriteConflict(...)`, `onWriteConflict→Unsubscribe` — consistent across tasks; the relay's `reportConflict` arg order matches noydb's lambda and `#reportWriteConflict`.
- **Reuse:** `_applyRemoteChange` (b), `getVersion` (history), `_applyRemoteWrite`'s loaded-collection guard, `db.on/off` (events.ts), the `#priorRecordForHook` envelope read (now also yields `_v` at zero extra cost).
- **Determinism:** relay unit uses the in-memory bus + `fakeAfterWrite`; integration uses a **manual deferred-delivery bus** so both tabs write before any signal is delivered (true concurrency), shared `memory()` store + (b)'s seed-write keyring pattern, `settle()` for the async report/apply chains.
- **No placeholders:** every code step shows complete code; every run step states command + expected result.
