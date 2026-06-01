# Cross-tab write propagation (#228 sub-slice b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a write commits in one same-origin tab, every other tab that has the collection loaded refreshes its in-memory view of that document — no reload — via a ciphertext-blind signal over a `BroadcastChannel` plus a local re-read.

**Architecture:** A self-contained `CrossTabWriteRelay` (own `noydb:tab-writes` channel) subscribes to `onAfterWrite` (#230) and broadcasts `{vault, collection, docId, action}`; receiving tabs resolve the loaded vault→collection and call a new `Collection._applyRemoteChange`, which re-reads the encrypted envelope from the shared store (`_invalidateCacheEntry`) and emits a `change` event. Role-agnostic; folded into `db.enableTabCoordination({ propagateWrites })`.

**Tech Stack:** TypeScript, Vitest. Package: `packages/hub`. Reuses (a)'s `TabChannel`/`defaultChannel`. Browser `BroadcastChannel` via the existing `window`-gated `defaultChannel`.

**Spec:** `docs/superpowers/specs/2026-06-01-228b-cross-tab-write-propagation-design.md`. Issue #228.

---

## File structure

- **Modify** `packages/hub/src/write-hooks.ts` — add `readonly vault: string` to `WriteEvent`.
- **Modify** `packages/hub/src/collection.ts` — set `vault` at both `WriteEvent` build sites (put ~1109, delete ~1689); add `_applyRemoteChange(id, action)`.
- **Create** `packages/hub/src/tab-write-relay.ts` — `TabWriteMsg`, `CrossTabWriteRelayOptions`, `CrossTabWriteRelay`.
- **Modify** `packages/hub/src/vault.ts` — add `_applyRemoteWrite(collectionName, docId, action)`.
- **Modify** `packages/hub/src/noydb.ts` — `propagateWrites`/`writeChannel` in `TabCoordinationOptions`; build/teardown the relay in `enableTabCoordination`/`disableTabCoordination`; `#applyRemoteWrite` resolver.
- **Modify** `features.yaml` — `cross-tab-write-propagation` feature entry.
- **Create** `packages/hub/__tests__/tab-write-relay.test.ts` (unit) + `packages/hub/__tests__/tab-write-propagation.test.ts` (integration).

---

## Task 1: `vault` on `WriteEvent`

**Files:** Modify `packages/hub/src/write-hooks.ts`, `packages/hub/src/collection.ts:1109`, `:1689`; Test `packages/hub/__tests__/write-hooks-integration.test.ts`

- [ ] **Step 1: Write the failing test** — append inside the `describe('write lifecycle hooks (#230)', ...)` block in `packages/hub/__tests__/write-hooks-integration.test.ts`:

```ts
  it('WriteEvent carries the vault name (#228b)', async () => {
    const db = await setup()
    const v = await db.openVault('demo')
    const c = v.collection<Inv>('invoices')
    const events: WriteEvent[] = []
    db.onAfterWrite((e) => { events.push(e) })
    await c.put('i1', { id: 'i1', amount: 1 })
    expect(events).toHaveLength(1)
    expect(events[0]!.vault).toBe('demo')
    expect(events[0]!.collection).toBe('invoices')
  })
```

- [ ] **Step 2: Run → fail** (`vault` is `undefined` / type error)

Run: `cd packages/hub && npx vitest run __tests__/write-hooks-integration.test.ts -t "carries the vault"`
Expected: FAIL (`expected undefined to be "demo"`).

- [ ] **Step 3: Add the field** — in `packages/hub/src/write-hooks.ts`, add `vault` to the `WriteEvent` interface (right after `op`):

```ts
export interface WriteEvent {
  readonly op: 'create' | 'update' | 'delete'
  readonly vault: string
  readonly collection: string
  readonly docId: string
  readonly before: unknown // decrypted prior record; null on 'create'
  readonly after: unknown // the record written; null on 'delete'
  readonly userId: string
  readonly timestamp: number
  readonly txId: string
}
```

- [ ] **Step 4: Populate it at both emit sites** — in `packages/hub/src/collection.ts`.

Put site (~line 1109), add `vault: this.vault,`:
```ts
      event = {
        op: before === null ? 'create' : 'update',
        vault: this.vault, collection: this.name, docId: id, before, after: record,
        userId: this.keyring.userId, timestamp: Date.now(), txId: this.#txIdForHook(),
      }
```

Delete site (~line 1689), add `vault: this.vault,`:
```ts
      event = {
        op: 'delete', vault: this.vault, collection: this.name, docId: id, before, after: null,
        userId: this.keyring.userId, timestamp: Date.now(), txId: this.#txIdForHook(),
      }
```

- [ ] **Step 5: Run → pass + typecheck**

Run: `cd packages/hub && npx vitest run __tests__/write-hooks-integration.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/write-hooks.ts packages/hub/src/collection.ts packages/hub/__tests__/write-hooks-integration.test.ts
git commit -m "feat(hub): add vault to WriteEvent (#228)"
```

---

## Task 2: `CrossTabWriteRelay`

**Files:** Create `packages/hub/src/tab-write-relay.ts`; Test `packages/hub/__tests__/tab-write-relay.test.ts`

> Design note: the relay always has a channel (it's only constructed when one exists — see Task 4). The "no channel ⇒ inert" no-op from the spec lives at the wiring layer (Task 4's no-op test), not here.

- [ ] **Step 1: Write the failing test** — `packages/hub/__tests__/tab-write-relay.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CrossTabWriteRelay } from '../src/tab-write-relay.js'
import type { TabChannel } from '../src/tab-coordination.js'
import type { WriteEvent } from '../src/write-hooks.js'

/** In-memory broadcast bus: each channel's send() reaches all OTHER channels. */
function makeBus(n: number): TabChannel[] {
  const listeners: Array<((p: string) => void) | null> = []
  const chans: TabChannel[] = []
  for (let i = 0; i < n; i++) {
    const idx = i
    chans.push({
      isOpen: true,
      send(payload) { for (let j = 0; j < listeners.length; j++) if (j !== idx && listeners[j]) queueMicrotask(() => listeners[j]!(payload)) },
      on(event, l) { if (event === 'message') { listeners[idx] = l as (p: string) => void; return () => { listeners[idx] = null } } return () => {} },
      close() { listeners[idx] = null },
    })
  }
  return chans
}

const flush = () => new Promise((r) => setTimeout(r, 0))

/** A controllable onAfterWrite source: returns a subscribe fn + a fire fn. */
function fakeAfterWrite() {
  const handlers = new Set<(e: WriteEvent) => void>()
  return {
    subscribe: (h: (e: WriteEvent) => void) => { handlers.add(h); return () => handlers.delete(h) },
    fire: (e: WriteEvent) => { for (const h of handlers) h(e) },
  }
}

function ev(partial: Partial<WriteEvent>): WriteEvent {
  return { op: 'update', vault: 'books', collection: 'invoices', docId: 'i1', before: null, after: { id: 'i1' }, userId: 'u', timestamp: 0, txId: 't', ...partial }
}

describe('CrossTabWriteRelay', () => {
  it('broadcasts a tab-write signal on a local committed write', async () => {
    const [chA, chB] = makeBus(2)
    const srcA = fakeAfterWrite()
    let received: unknown
    const relayA = new CrossTabWriteRelay({ channel: chA!, writerId: 'A', subscribeAfterWrite: srcA.subscribe, applyRemoteWrite: () => {} })
    chB!.on('message', (p) => { received = JSON.parse(p) })
    relayA.start()
    srcA.fire(ev({ op: 'create', docId: 'i9' }))
    await flush()
    expect(received).toEqual({ kind: 'tab-write', writerId: 'A', vault: 'books', collection: 'invoices', docId: 'i9', action: 'put' })
    relayA.dispose()
  })

  it('maps op:delete to action:delete', async () => {
    const [chA, chB] = makeBus(2)
    const srcA = fakeAfterWrite()
    let received: { action?: string } = {}
    const relayA = new CrossTabWriteRelay({ channel: chA!, writerId: 'A', subscribeAfterWrite: srcA.subscribe, applyRemoteWrite: () => {} })
    chB!.on('message', (p) => { received = JSON.parse(p) })
    relayA.start()
    srcA.fire(ev({ op: 'delete', after: null }))
    await flush()
    expect(received.action).toBe('delete')
    relayA.dispose()
  })

  it('applies a foreign tab-write; ignores its own', async () => {
    const [chA, chB] = makeBus(2)
    const srcA = fakeAfterWrite(); const srcB = fakeAfterWrite()
    const applied: Array<[string, string, string, string]> = []
    const relayA = new CrossTabWriteRelay({ channel: chA!, writerId: 'A', subscribeAfterWrite: srcA.subscribe, applyRemoteWrite: () => {} })
    const relayB = new CrossTabWriteRelay({ channel: chB!, writerId: 'B', subscribeAfterWrite: srcB.subscribe, applyRemoteWrite: (v, c, d, a) => { applied.push([v, c, d, a]) } })
    relayA.start(); relayB.start()
    srcA.fire(ev({ docId: 'i1' }))   // A writes → B should apply
    await flush()
    srcB.fire(ev({ docId: 'i2' }))   // B writes → B must NOT apply its own
    await flush()
    expect(applied).toEqual([['books', 'invoices', 'i1', 'put']])
    relayA.dispose(); relayB.dispose()
  })

  it('does not broadcast or apply after dispose', async () => {
    const [chA, chB] = makeBus(2)
    const srcA = fakeAfterWrite()
    let count = 0
    const relayA = new CrossTabWriteRelay({ channel: chA!, writerId: 'A', subscribeAfterWrite: srcA.subscribe, applyRemoteWrite: () => {} })
    chB!.on('message', () => { count++ })
    relayA.start()
    relayA.dispose()
    srcA.fire(ev({ docId: 'i1' }))
    await flush()
    expect(count).toBe(0)
  })
})
```

- [ ] **Step 2: Run → fail** (`cd packages/hub && npx vitest run __tests__/tab-write-relay.test.ts`) — module not found.

- [ ] **Step 3: Implement** `packages/hub/src/tab-write-relay.ts`:

```ts
/**
 * Cross-tab write propagation (#228b). A role-agnostic relay: it broadcasts
 * a ciphertext-blind signal ({vault, collection, docId, action}) for every
 * locally-committed write (via onAfterWrite, #230), and on receiving a peer
 * tab's signal it asks the host to refresh that document's in-memory view by
 * re-reading the shared encrypted store. Nothing decrypted crosses the wire.
 */
import type { TabChannel, Unsubscribe } from './tab-coordination.js'
import type { WriteEvent } from './write-hooks.js'

export interface TabWriteMsg {
  readonly kind: 'tab-write'
  readonly writerId: string
  readonly vault: string
  readonly collection: string
  readonly docId: string
  readonly action: 'put' | 'delete'
}

export interface CrossTabWriteRelayOptions {
  /** The broadcast channel (its own — distinct from the presence channel). */
  readonly channel: TabChannel
  /** This tab's id — outgoing signals carry it; incoming self-signals are ignored. */
  readonly writerId: string
  /** Subscribe to committed writes (the host's onAfterWrite). */
  readonly subscribeAfterWrite: (handler: (e: WriteEvent) => void) => Unsubscribe
  /** Refresh a document's in-memory view from the shared store. */
  readonly applyRemoteWrite: (vault: string, collection: string, docId: string, action: 'put' | 'delete') => void | Promise<void>
  /** Close the channel on dispose (only when the relay created it). Default false. */
  readonly closeChannelOnDispose?: boolean
}

export class CrossTabWriteRelay {
  readonly #channel: TabChannel
  readonly #writerId: string
  readonly #subscribeAfterWrite: (handler: (e: WriteEvent) => void) => Unsubscribe
  readonly #applyRemoteWrite: (vault: string, collection: string, docId: string, action: 'put' | 'delete') => void | Promise<void>
  readonly #ownsChannel: boolean
  #unsubMsg: Unsubscribe | undefined
  #unsubWrite: Unsubscribe | undefined
  #started = false
  #disposed = false

  constructor(opts: CrossTabWriteRelayOptions) {
    this.#channel = opts.channel
    this.#writerId = opts.writerId
    this.#subscribeAfterWrite = opts.subscribeAfterWrite
    this.#applyRemoteWrite = opts.applyRemoteWrite
    this.#ownsChannel = opts.closeChannelOnDispose ?? false
  }

  start(): void {
    if (this.#started || this.#disposed) return
    this.#started = true
    this.#unsubMsg = this.#channel.on('message', (p) => this.#onMessage(p))
    this.#unsubWrite = this.#subscribeAfterWrite((e) => this.#onLocalWrite(e))
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#unsubWrite?.()
    this.#unsubMsg?.()
    if (this.#ownsChannel) this.#channel.close()
  }

  #onLocalWrite(e: WriteEvent): void {
    if (this.#disposed || !this.#channel.isOpen) return
    const action: 'put' | 'delete' = e.op === 'delete' ? 'delete' : 'put'
    const msg: TabWriteMsg = { kind: 'tab-write', writerId: this.#writerId, vault: e.vault, collection: e.collection, docId: e.docId, action }
    this.#channel.send(JSON.stringify(msg))
  }

  #onMessage(payload: string): void {
    if (this.#disposed) return
    let msg: unknown
    try { msg = JSON.parse(payload) } catch { return }
    if (!isTabWriteMsg(msg) || msg.writerId === this.#writerId) return
    void Promise.resolve(this.#applyRemoteWrite(msg.vault, msg.collection, msg.docId, msg.action)).catch((err) => {
      console.warn(`[noy-db] cross-tab apply failed for ${msg.collection}/${msg.docId}: ` + (err instanceof Error ? err.message : String(err)))
    })
  }
}

function isTabWriteMsg(x: unknown): x is TabWriteMsg {
  if (x === null || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return o['kind'] === 'tab-write'
    && typeof o['writerId'] === 'string'
    && typeof o['vault'] === 'string'
    && typeof o['collection'] === 'string'
    && typeof o['docId'] === 'string'
    && (o['action'] === 'put' || o['action'] === 'delete')
}
```

- [ ] **Step 4: Run → pass + typecheck**

Run: `cd packages/hub && npx vitest run __tests__/tab-write-relay.test.ts && npx tsc --noEmit && npx eslint src/tab-write-relay.ts`
Expected: 4 tests pass, tsc + eslint clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/tab-write-relay.ts packages/hub/__tests__/tab-write-relay.test.ts
git commit -m "feat(hub): CrossTabWriteRelay — broadcast/apply committed-write signals (#228)"
```

---

## Task 3: apply primitives — `Collection._applyRemoteChange` + `Vault._applyRemoteWrite`

**Files:** Modify `packages/hub/src/collection.ts` (near `_invalidateCacheEntry`, ~line 2781), `packages/hub/src/vault.ts` (near `#runCutoverTransform`, ~line 844); Test `packages/hub/__tests__/tab-write-propagation.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/hub/__tests__/tab-write-propagation.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { memory } from '../../to-memory/src/index.js'

interface Inv extends Record<string, unknown> { id: string; amount: number }
const SECRET = 'tab-prop-pass-1234'

describe('apply primitives (#228b)', () => {
  it('_applyRemoteChange refreshes the cache from the shared store and emits change', async () => {
    const store = memory()
    const db1 = await createNoydb({ store, user: 'alice', secret: SECRET })
    const db2 = await createNoydb({ store, user: 'alice', secret: SECRET })
    const v1 = await db1.openVault('books'); const c1 = v1.collection<Inv>('invoices')
    const v2 = await db2.openVault('books'); const c2 = v2.collection<Inv>('invoices')

    await c2.get('i1') // hydrate db2's eager cache (currently empty)
    let changed = 0
    db2.on('change', (e) => { if (e.id === 'i1') changed++ })

    await c1.put('i1', { id: 'i1', amount: 7 })       // db1 persists to the shared store
    expect(await c2.get('i1')).toBeNull()              // db2 hasn't seen it yet (stale cache)

    await v2._applyRemoteWrite('invoices', 'i1', 'put') // simulate the relay's apply
    expect(await c2.get('i1')).toMatchObject({ amount: 7 })
    expect(changed).toBe(1)
  })

  it('_applyRemoteWrite is a no-op for an unloaded collection', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const v = await db.openVault('books')
    await expect(v._applyRemoteWrite('not-loaded', 'x', 'put')).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run → fail** (`_applyRemoteWrite` / `_applyRemoteChange` don't exist)

Run: `cd packages/hub && npx vitest run __tests__/tab-write-propagation.test.ts -t "apply primitives"`
Expected: FAIL (type error / not a function).

- [ ] **Step 3a: Implement `Collection._applyRemoteChange`** — add to `packages/hub/src/collection.ts` immediately after `_invalidateCacheEntry` (the method ending ~line 2797):

```ts
  /**
   * #228b — apply a peer tab's committed write to THIS tab's in-memory view:
   * re-read the (already-persisted) envelope from the shared store + refresh
   * cache/indexes, then emit a `change` event so reactive consumers re-render.
   * Never writes to the store and never fires write hooks, so it cannot loop.
   */
  async _applyRemoteChange(id: string, action: 'put' | 'delete'): Promise<void> {
    await this._invalidateCacheEntry(id)
    this.emitter.emit('change', { vault: this.vault, collection: this.name, id, action })
  }
```

- [ ] **Step 3b: Implement `Vault._applyRemoteWrite`** — add to `packages/hub/src/vault.ts` right after `#runCutoverTransform` (~line 848):

```ts
  /**
   * #228b — refresh a loaded collection's view of one document from a peer
   * tab's broadcast. No-op when the collection isn't loaded in this tab
   * (it will read fresh on next open). Mirrors #runCutoverTransform's guard.
   */
  async _applyRemoteWrite(collectionName: string, docId: string, action: 'put' | 'delete'): Promise<void> {
    const coll = this.collectionCache.get(collectionName)
    if (!coll) return
    await coll._applyRemoteChange(docId, action)
  }
```

- [ ] **Step 4: Run → pass + typecheck**

Run: `cd packages/hub && npx vitest run __tests__/tab-write-propagation.test.ts -t "apply primitives" && npx tsc --noEmit`
Expected: 2 tests pass, tsc clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/collection.ts packages/hub/src/vault.ts packages/hub/__tests__/tab-write-propagation.test.ts
git commit -m "feat(hub): _applyRemoteChange / _applyRemoteWrite apply primitives (#228)"
```

---

## Task 4: wire the relay into `enableTabCoordination`

**Files:** Modify `packages/hub/src/tab-coordination.ts` (options), `packages/hub/src/noydb.ts`; Test `packages/hub/__tests__/tab-write-propagation.test.ts` (add an end-to-end describe)

- [ ] **Step 1: Write the failing test** — append a new describe to `packages/hub/__tests__/tab-write-propagation.test.ts`:

```ts
import type { TabChannel } from '../src/tab-coordination.js'

/** In-memory broadcast bus (each send reaches all OTHER channels). */
function makeBus(n: number): TabChannel[] {
  const listeners: Array<((p: string) => void) | null> = []
  const chans: TabChannel[] = []
  for (let i = 0; i < n; i++) {
    const idx = i
    chans.push({
      isOpen: true,
      send(payload) { for (let j = 0; j < listeners.length; j++) if (j !== idx && listeners[j]) queueMicrotask(() => listeners[j]!(payload)) },
      on(event, l) { if (event === 'message') { listeners[idx] = l as (p: string) => void; return () => { listeners[idx] = null } } return () => {} },
      close() { listeners[idx] = null },
    })
  }
  return chans
}
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)) }

describe('end-to-end cross-tab propagation (#228b)', () => {
  it('a put in one tab refreshes the other; delete removes it', async () => {
    const store = memory()
    const db1 = await createNoydb({ store, user: 'alice', secret: SECRET })
    const db2 = await createNoydb({ store, user: 'alice', secret: SECRET })
    const [wA, wB] = makeBus(2) // shared write-bus
    db1.enableTabCoordination({ writeChannel: wA!, tabId: 'A' })
    db2.enableTabCoordination({ writeChannel: wB!, tabId: 'B' })

    const c1 = (await db1.openVault('books')).collection<Inv>('invoices')
    const c2 = (await db2.openVault('books')).collection<Inv>('invoices')
    await c2.get('i1') // hydrate db2

    await c1.put('i1', { id: 'i1', amount: 5 })
    await settle()
    expect(await c2.get('i1')).toMatchObject({ amount: 5 }) // propagated put

    await c1.delete('i1')
    await settle()
    expect(await c2.get('i1')).toBeNull() // propagated delete

    db1.close(); db2.close()
  })

  it('propagateWrites:false disables it; and it no-ops with no channel', async () => {
    const store = memory()
    const db1 = await createNoydb({ store, user: 'alice', secret: SECRET })
    const db2 = await createNoydb({ store, user: 'alice', secret: SECRET })
    const [wA, wB] = makeBus(2)
    db1.enableTabCoordination({ writeChannel: wA!, tabId: 'A' })
    db2.enableTabCoordination({ writeChannel: wB!, tabId: 'B', propagateWrites: false })

    const c1 = (await db1.openVault('books')).collection<Inv>('invoices')
    const c2 = (await db2.openVault('books')).collection<Inv>('invoices')
    await c2.get('i1')
    await c1.put('i1', { id: 'i1', amount: 9 })
    await settle()
    expect(await c2.get('i1')).toBeNull() // db2 opted out → no refresh

    // no channel at all (node default) → enabling is a safe no-op, no throw
    const db3 = await createNoydb({ store: memory(), user: 'bob', secret: SECRET })
    expect(() => db3.enableTabCoordination()).not.toThrow()
    db1.close(); db2.close(); db3.close()
  })
})
```

- [ ] **Step 2: Run → fail** (`writeChannel`/`propagateWrites` options don't exist; no relay wired → propagation doesn't happen)

Run: `cd packages/hub && npx vitest run __tests__/tab-write-propagation.test.ts -t "end-to-end"`
Expected: FAIL (db2 doesn't see the put).

- [ ] **Step 3a: Add options** — in `packages/hub/src/tab-coordination.ts`, extend `TabCoordinationOptions` (after `closeChannelOnDispose`):

```ts
  /**
   * Also propagate committed writes to other tabs (#228b). Default true:
   * when tab coordination is enabled and a channel is available, a write in
   * one tab refreshes that document in every other tab. Set false to opt out.
   */
  readonly propagateWrites?: boolean
  /**
   * Channel for write propagation (#228b) — distinct from the presence
   * channel. Default: an inline BroadcastChannel on `noydb:tab-writes`.
   */
  readonly writeChannel?: TabChannel
```

- [ ] **Step 3b: Import the relay** — in `packages/hub/src/noydb.ts`, add near the tab-coordination import (line ~81):

```ts
import { CrossTabWriteRelay } from './tab-write-relay.js'
```

- [ ] **Step 3c: Add the field** — beside `private tabCoordinator` (line ~195):

```ts
  /** Cross-tab write relay (#228b); created on `enableTabCoordination()`. */
  private writeRelay: CrossTabWriteRelay | undefined
```

- [ ] **Step 3d: Build the relay** — in `enableTabCoordination` (line ~1200), after `c.start()` and before the `return`:

```ts
    if (opts.propagateWrites !== false) {
      const writeChannel = opts.writeChannel ?? defaultChannel('noydb:tab-writes')
      if (writeChannel) {
        const relay = new CrossTabWriteRelay({
          channel: writeChannel,
          writerId: c.tabId,
          subscribeAfterWrite: (h) => this.onAfterWrite(h),
          applyRemoteWrite: (vault, collection, docId, action) => this.#applyRemoteWrite(vault, collection, docId, action),
          closeChannelOnDispose: opts.writeChannel === undefined && writeChannel !== undefined,
        })
        this.writeRelay = relay
        relay.start()
      }
    }
```

- [ ] **Step 3e: Add the resolver + teardown** — add the private method beside `disableTabCoordination` (line ~1214), and a teardown line inside `disableTabCoordination`:

```ts
  #applyRemoteWrite(vaultName: string, collectionName: string, docId: string, action: 'put' | 'delete'): Promise<void> {
    const v = this.vaultCache.get(vaultName)
    if (!v) return Promise.resolve()
    return v._applyRemoteWrite(collectionName, docId, action)
  }
```

In `disableTabCoordination`, add the relay teardown:
```ts
  private disableTabCoordination(): void {
    this.tabCoordinator?.dispose()
    this.tabCoordinator = undefined
    this.writeRelay?.dispose()
    this.writeRelay = undefined
  }
```

(`close()` already calls `disableTabCoordination()` — no extra change there.)

- [ ] **Step 4: Run → pass + typecheck + lint + full suite**

Run: `cd packages/hub && npx vitest run __tests__/tab-write-propagation.test.ts && npx tsc --noEmit && npx eslint src/noydb.ts src/tab-coordination.ts && npx vitest run`
Expected: propagation tests pass; tsc + eslint clean; full suite green with a clean (non-hanging) exit.

- [ ] **Step 5: Commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/tab-coordination.ts packages/hub/src/noydb.ts packages/hub/__tests__/tab-write-propagation.test.ts
git commit -m "feat(hub): wire CrossTabWriteRelay into enableTabCoordination (#228)"
```

---

## Task 5: register the feature + final verify

**Files:** Modify `features.yaml`

- [ ] **Step 1: Add the feature entry** — in `features.yaml`, immediately after the `tab-coordination` entry (its `related: [vault-and-collections]` line), add:

```yaml
  - id: cross-tab-write-propagation
    name: Cross-tab write propagation
    cluster: core
    spec: docs/superpowers/specs/2026-06-01-228b-cross-tab-write-propagation-design.md
    subsystem_doc: docs/superpowers/specs/2026-06-01-228b-cross-tab-write-propagation-design.md
    package: '@noy-db/hub'
    factory: null
    status: preview
    showcases: []
    recipes: []
    playground_pages: []
    diagrams: []
    invariants:
      - 'a committed write in one tab refreshes that document in every other tab that has the collection loaded (cache + change event), no reload'
      - 'only {vault, collection, docId, action} cross the channel — nothing decrypted; receivers re-read the shared encrypted store'
      - 'applied remote writes never re-persist or re-fire write hooks, so they cannot loop'
      - 'opt-in via db.enableTabCoordination({ propagateWrites }) (default true); graceful no-op outside browsers'
    related: [tab-coordination, write-lifecycle-hooks]
```

> If the validator rejects an unknown id in `related` (`write-lifecycle-hooks`), grep `features.yaml` for the actual #230 feature id (`grep -n "id: .*write" features.yaml`) and use that, or drop it to `related: [tab-coordination]`.

- [ ] **Step 2: Validate + full verify**

```bash
cd /Users/vicio/_github/noy-db && node scripts/validate-features.mjs
cd packages/hub && npx vitest run && npx tsc --noEmit && npm run lint && npm run build
```
Expected: validator PASS; full suite PASS (clean exit); tsc + lint + build clean.

- [ ] **Step 3: Commit + clean tree**

```bash
cd /Users/vicio/_github/noy-db && git add features.yaml
git commit -m "chore(hub): register cross-tab-write-propagation feature (#228)"
git status
```

---

## Self-review checklist (applied)

- **Spec coverage:** signal+re-read → Task 2 relay + Task 3 `_invalidateCacheEntry` reuse; role-agnostic broadcast → Task 2; `vault` on `WriteEvent` → Task 1; `_applyRemoteChange`/`_applyRemoteWrite` → Task 3; `enableTabCoordination({ propagateWrites })` wiring + teardown + no-op → Task 4; no-loop (apply skips put/hooks) → Task 3 method + Task 2 self-filter; put & delete propagation + unopened-vault ignored → Task 3/Task 4 tests; ciphertext-blind signal → `TabWriteMsg` shape (Task 2); features.yaml → Task 5.
- **Type consistency:** `TabWriteMsg{kind,writerId,vault,collection,docId,action}`, `action:'put'|'delete'`, `CrossTabWriteRelayOptions{channel,writerId,subscribeAfterWrite,applyRemoteWrite,closeChannelOnDispose}`, `WriteEvent.vault`, `Collection._applyRemoteChange(id,action)`, `Vault._applyRemoteWrite(collectionName,docId,action)`, `Noydb.#applyRemoteWrite(vaultName,collectionName,docId,action)`, options `propagateWrites`/`writeChannel` — all consistent across tasks.
- **Reuse, not reinvention:** apply path reuses `_invalidateCacheEntry` (verified collection.ts:2781) + the `change` emit shape (verified types.ts `ChangeEvent`); `_applyRemoteWrite` mirrors `#runCutoverTransform`'s loaded-collection guard (verified vault.ts:844); own-channel teardown mirrors (a)'s `closeChannelOnDispose`.
- **Determinism:** in-memory bus + fake onAfterWrite (unit); shared `memory()` store + same user/secret + injected write-bus + `settle()` (integration). No real `BroadcastChannel`/timers.
- **No placeholders:** every code step shows complete code; every run step states command + expected result. The one conditional (`related` id fallback in Task 5) gives the exact grep + both resolutions.
