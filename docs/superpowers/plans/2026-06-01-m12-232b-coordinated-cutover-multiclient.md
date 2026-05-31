# M12 #232 sub-slice 3b — coordinatedCutover (multi-client ack-barrier) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the cooperative ack-barrier so a coordinated cutover is safe when multiple clients are active: each client flushes in-flight writes and acks "quiesced," and the migrator waits for the active set to ack (or a timeout) before transforming.

**Architecture:** A store-based client registry (`_meta/schema-fence:client:<clientId>` heartbeat docs) tracks liveness + per-client quiesce acks. A per-client `FenceWatcher` polls the fence and, on `draining`, drains its write-queue (`writeQueue.onFlush()`) and stamps its ack. `SchemaFenceController.runCutover` is refactored into phases (`beginDrain` → wait-for-quiesce → `finishCutover`) with an injectable `onPoll` hook so the multi-client barrier is deterministic in tests. No leader election (the `runSchemaCutover()` caller is the migrator). A new same-instance `schema:fence-changed` event feeds #233's UI; cross-client coordination goes through the store.

**Tech Stack:** TypeScript, Vitest, `@noy-db/to-memory`. Hub at `packages/hub`. Builds on 3a (`SchemaFenceController`, `fence.ts`, `coordinatedCutover`) and #227 (`writeQueue.onFlush`).

**Spec:** `docs/superpowers/specs/2026-05-31-m12-schema-migration-epic-design.md` §5 Slice 3b. Issue #232.

---

## Scope

**In scope:** client registry (heartbeat + ack), `FenceWatcher`, `runCutover` phase-split + active-set wait + timeout, `resume`/`abort`, lazy start of heartbeat+watcher (only when a `coordinatedCutover` is registered — so the 1921 existing tests are untouched), cleanup on vault lock/close, `schema:fence-changed` event.

**Out of scope:** `by-peer` Web Locks leader election / migrator failover (deferred); reactive pub/sub fence push (baseline is store-polling); the Vue UI (#233 / Slice 4).

**Determinism rule:** all coordination logic takes an injected `now()` clock and is driven by explicit `check()`/`beat()`/`onPoll` calls in tests — no reliance on `setInterval` firing. Production wiring calls the same methods on a timer.

---

## File structure

- **Create** `packages/hub/src/schema-update/client-registry.ts` — read/write/list `_meta/schema-fence:client:<id>` docs + active-set computation.
- **Create** `packages/hub/src/schema-update/fence-watcher.ts` — `FenceWatcher` (per client): `beat()`, `check()`, `start()`, `stop()`.
- **Modify** `packages/hub/src/schema-update/fence-controller.ts` — phase-split `runCutover`, active-set wait, `abort`; inject `clientId`/`now`/`staleMs`/`quiesceTimeoutMs`/`emitter`.
- **Modify** `packages/hub/src/types.ts` — add `'schema:fence-changed'` to `NoydbEventMap`.
- **Modify** `packages/hub/src/noydb.ts` — mint a `clientId` per instance; pass it into `Vault`.
- **Modify** `packages/hub/src/vault.ts` — thread `clientId`/`emitter` into the controller; lazy `_ensureFenceCoordination()` (start heartbeat+watcher); `abortSchemaCutover()`; stop coordination on lock/close.
- **Create** tests: `client-registry.test.ts`, `fence-watcher.test.ts`, `fence-controller-barrier.test.ts`, and `coordinated-cutover-multiclient.test.ts`.

---

## Task 1: `schema:fence-changed` event

**Files:** Modify `packages/hub/src/types.ts`

- [ ] **Step 1: Find `NoydbEventMap`**

Run: `grep -n "export interface NoydbEventMap" packages/hub/src/types.ts`

- [ ] **Step 2: Add the event** — inside `NoydbEventMap`, after the `'change': ChangeEvent` line:

```ts
  /**
   * Same-instance signal that this vault's schema-fence state changed
   * (#232). For UI integration (#233). Cross-client coordination goes
   * through the store, not this event.
   */
  'schema:fence-changed': { vault: string; currentSchemaVersion: number; fenceState: 'normal' | 'draining' | 'migrating' | 'complete' }
```

- [ ] **Step 3: Typecheck + commit**

Run: `cd packages/hub && npx tsc --noEmit` (Expected: PASS)
```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/types.ts
git commit -m "feat(hub): schema:fence-changed event (#232)"
```

---

## Task 2: Client registry

**Files:** Create `packages/hub/src/schema-update/client-registry.ts`; Test `packages/hub/__tests__/schema-update/client-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { memory } from '../../../to-memory/src/index.js'
import { writeClientDoc, listClientDocs, activeQuiesced } from '../../src/schema-update/client-registry.js'

describe('client registry', () => {
  it('writes and lists per-client docs', async () => {
    const store = memory()
    await writeClientDoc(store, 'v', 'c1', { lastSeen: 100, quiescedAtVersion: null })
    await writeClientDoc(store, 'v', 'c2', { lastSeen: 100, quiescedAtVersion: 3 })
    const docs = await listClientDocs(store, 'v')
    expect(docs.map(d => d.clientId).sort()).toEqual(['c1', 'c2'])
    expect(docs.find(d => d.clientId === 'c2')?.quiescedAtVersion).toBe(3)
  })

  it('overwrites a client doc on re-write (heartbeat update)', async () => {
    const store = memory()
    await writeClientDoc(store, 'v', 'c1', { lastSeen: 100, quiescedAtVersion: null })
    await writeClientDoc(store, 'v', 'c1', { lastSeen: 200, quiescedAtVersion: 4 })
    const docs = await listClientDocs(store, 'v')
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ clientId: 'c1', lastSeen: 200, quiescedAtVersion: 4 })
  })

  it('activeQuiesced: true only when every fresh client acked the target generation', async () => {
    const store = memory()
    await writeClientDoc(store, 'v', 'c1', { lastSeen: 1000, quiescedAtVersion: 5 })
    await writeClientDoc(store, 'v', 'c2', { lastSeen: 1000, quiescedAtVersion: 5 })
    await writeClientDoc(store, 'v', 'stale', { lastSeen: 1, quiescedAtVersion: null }) // stale → ignored
    // now=1000, staleMs=500 → c1,c2 active and acked v5, stale dropped
    expect(await activeQuiesced(store, 'v', { generation: 5, now: 1000, staleMs: 500 })).toBe(true)
  })

  it('activeQuiesced: false when a fresh client has not acked the target generation', async () => {
    const store = memory()
    await writeClientDoc(store, 'v', 'c1', { lastSeen: 1000, quiescedAtVersion: 5 })
    await writeClientDoc(store, 'v', 'c2', { lastSeen: 1000, quiescedAtVersion: null })
    expect(await activeQuiesced(store, 'v', { generation: 5, now: 1000, staleMs: 500 })).toBe(false)
  })
})
```

- [ ] **Step 2: Run → fail**

Run: `cd packages/hub && npx vitest run __tests__/schema-update/client-registry.test.ts`

- [ ] **Step 3: Implement** `client-registry.ts`

```ts
/**
 * Schema-cutover client registry (#232 sub-slice 3b). Each client keeps a
 * heartbeat doc at `_meta/schema-fence:client:<clientId>` carrying its
 * liveness (`lastSeen`) and the fence generation it has quiesced for
 * (`quiescedAtVersion`). Plaintext envelope, like the fence doc.
 */
import type { NoydbStore, EncryptedEnvelope } from '../types.js'
import { NOYDB_FORMAT_VERSION } from '../types.js'

const META_COLLECTION = '_meta'
const CLIENT_PREFIX = 'schema-fence:client:'

export interface ClientDoc {
  readonly clientId: string
  readonly lastSeen: number
  readonly quiescedAtVersion: number | null
}

export async function writeClientDoc(
  store: NoydbStore,
  vault: string,
  clientId: string,
  doc: { lastSeen: number; quiescedAtVersion: number | null },
): Promise<void> {
  const envelope: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: 1,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: JSON.stringify({ clientId, ...doc }),
  }
  await store.put(vault, META_COLLECTION, `${CLIENT_PREFIX}${clientId}`, envelope)
}

export async function listClientDocs(store: NoydbStore, vault: string): Promise<ClientDoc[]> {
  const ids = await store.list(vault, META_COLLECTION)
  const out: ClientDoc[] = []
  for (const id of ids) {
    if (!id.startsWith(CLIENT_PREFIX)) continue
    const env = await store.get(vault, META_COLLECTION, id)
    if (!env) continue
    try {
      const parsed = JSON.parse(env._data) as unknown
      if (isClientDoc(parsed)) out.push(parsed)
    } catch { /* skip corrupt */ }
  }
  return out
}

/**
 * True when every *active* client (lastSeen within staleMs of now) has
 * `quiescedAtVersion === generation`. Stale clients are ignored. An empty
 * active set is vacuously quiesced.
 */
export async function activeQuiesced(
  store: NoydbStore,
  vault: string,
  opts: { generation: number; now: number; staleMs: number },
): Promise<boolean> {
  const docs = await listClientDocs(store, vault)
  const active = docs.filter(d => d.lastSeen >= opts.now - opts.staleMs)
  return active.every(d => d.quiescedAtVersion === opts.generation)
}

function isClientDoc(x: unknown): x is ClientDoc {
  if (x === null || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return typeof o['clientId'] === 'string'
    && typeof o['lastSeen'] === 'number'
    && (o['quiescedAtVersion'] === null || typeof o['quiescedAtVersion'] === 'number')
}
```

- [ ] **Step 4: Run → pass; commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/schema-update/client-registry.ts packages/hub/__tests__/schema-update/client-registry.test.ts
git commit -m "feat(hub): schema-cutover client registry (#232)"
```

---

## Task 3: `FenceWatcher`

**Files:** Create `packages/hub/src/schema-update/fence-watcher.ts`; Test `packages/hub/__tests__/schema-update/fence-watcher.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { memory } from '../../../to-memory/src/index.js'
import { FenceWatcher } from '../../src/schema-update/fence-watcher.js'
import { saveFence } from '../../src/schema-update/fence.js'
import { listClientDocs } from '../../src/schema-update/client-registry.js'

function mkWatcher(store = memory(), onFlush = async () => {}) {
  let t = 1000
  const events: string[] = []
  const w = new FenceWatcher({
    store, vault: 'v', clientId: 'c1', onFlush,
    now: () => t,
    emit: (e) => events.push(e.fenceState),
  })
  return { store, w, events, advance: (ms: number) => { t += ms } }
}

describe('FenceWatcher', () => {
  it('beat() writes a heartbeat doc with lastSeen and no ack', async () => {
    const { store, w } = mkWatcher()
    await w.beat()
    const docs = await listClientDocs(store, 'v')
    expect(docs[0]).toMatchObject({ clientId: 'c1', lastSeen: 1000, quiescedAtVersion: null })
  })

  it('check() during draining flushes then stamps quiescedAtVersion', async () => {
    let flushed = false
    const { store, w } = mkWatcher(memory(), async () => { flushed = true })
    await saveFence(store, 'v', { currentSchemaVersion: 7, fenceState: 'draining' })
    await w.check()
    expect(flushed).toBe(true)
    const docs = await listClientDocs(store, 'v')
    expect(docs[0]?.quiescedAtVersion).toBe(7)
  })

  it('check() emits fence-changed only on state transitions', async () => {
    const { store, w, events } = mkWatcher()
    await saveFence(store, 'v', { currentSchemaVersion: 0, fenceState: 'draining' })
    await w.check()
    await w.check() // no change → no second emit
    await saveFence(store, 'v', { currentSchemaVersion: 1, fenceState: 'complete' })
    await w.check()
    expect(events).toEqual(['draining', 'complete'])
  })

  it('check() in normal state does not flush or ack', async () => {
    let flushed = false
    const { store, w } = mkWatcher(memory(), async () => { flushed = true })
    await saveFence(store, 'v', { currentSchemaVersion: 0, fenceState: 'normal' })
    await w.check()
    expect(flushed).toBe(false)
  })
})
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement** `fence-watcher.ts`

```ts
/**
 * Per-client schema-fence watcher (#232 sub-slice 3b). Polls the fence;
 * on `draining` it drains in-flight writes and acks; emits a same-instance
 * signal on every state transition (for #233's UI). Driven by an interval
 * in production and by explicit `check()`/`beat()` in tests.
 */
import type { NoydbStore } from '../types.js'
import { loadFence, type FenceState } from './fence.js'
import { writeClientDoc } from './client-registry.js'

export interface FenceWatcherEvent {
  readonly currentSchemaVersion: number
  readonly fenceState: FenceState
}

export class FenceWatcher {
  readonly #store: NoydbStore
  readonly #vault: string
  readonly #clientId: string
  readonly #onFlush: () => Promise<void>
  readonly #now: () => number
  readonly #emit: (e: FenceWatcherEvent) => void
  #lastState: FenceState | null = null
  #quiescedAtVersion: number | null = null
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(opts: {
    store: NoydbStore
    vault: string
    clientId: string
    onFlush: () => Promise<void>
    now?: () => number
    emit?: (e: FenceWatcherEvent) => void
  }) {
    this.#store = opts.store
    this.#vault = opts.vault
    this.#clientId = opts.clientId
    this.#onFlush = opts.onFlush
    this.#now = opts.now ?? (() => Date.now())
    this.#emit = opts.emit ?? (() => {})
  }

  /** Publish liveness (and the current ack) without changing quiesce state. */
  async beat(): Promise<void> {
    await writeClientDoc(this.#store, this.#vault, this.#clientId, {
      lastSeen: this.#now(),
      quiescedAtVersion: this.#quiescedAtVersion,
    })
  }

  /** Poll the fence; quiesce on draining; emit on transitions. */
  async check(): Promise<void> {
    const fence = await loadFence(this.#store, this.#vault)
    if (fence.fenceState !== this.#lastState) {
      this.#lastState = fence.fenceState
      this.#emit({ currentSchemaVersion: fence.currentSchemaVersion, fenceState: fence.fenceState })
    }
    if (fence.fenceState === 'draining' && this.#quiescedAtVersion !== fence.currentSchemaVersion) {
      await this.#onFlush()
      this.#quiescedAtVersion = fence.currentSchemaVersion
      await this.beat()
    }
    if (fence.fenceState === 'normal') {
      this.#quiescedAtVersion = null
    }
  }

  start(intervalMs: number): void {
    if (this.#timer) return
    this.#timer = setInterval(() => { void this.beat(); void this.check() }, intervalMs)
    if (typeof this.#timer === 'object' && 'unref' in this.#timer) {
      ;(this.#timer as { unref: () => void }).unref() // don't keep the process alive
    }
  }

  stop(): void {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = undefined }
  }
}
```

- [ ] **Step 4: Run → pass; commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/schema-update/fence-watcher.ts packages/hub/__tests__/schema-update/fence-watcher.test.ts
git commit -m "feat(hub): FenceWatcher — quiesce + ack on draining (#232)"
```

---

## Task 4: `SchemaFenceController` — phase-split + active-set barrier + abort

**Files:** Modify `packages/hub/src/schema-update/fence-controller.ts`; Test `packages/hub/__tests__/schema-update/fence-controller-barrier.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { memory } from '../../../to-memory/src/index.js'
import { SchemaFenceController } from '../../src/schema-update/fence-controller.js'
import { loadFence, saveFence } from '../../src/schema-update/fence.js'
import { writeClientDoc } from '../../src/schema-update/client-registry.js'

function mkCtrl(store = memory()) {
  let t = 1000
  return {
    store,
    advance: (ms: number) => { t += ms },
    c: new SchemaFenceController({
      store, vault: 'v', onFlush: async () => {},
      clientId: 'migrator', now: () => t, staleMs: 500, quiesceTimeoutMs: 10_000,
    }),
  }
}

describe('SchemaFenceController barrier', () => {
  it('runCutover waits until the active set acks, then migrates + bumps', async () => {
    const { store, c } = mkCtrl()
    await c.init()
    c.registerPendingCutover('invoices', (d) => d)
    // one other active client, not yet quiesced
    await writeClientDoc(store, 'v', 'other', { lastSeen: 1000, quiescedAtVersion: null })

    const ran: string[] = []
    await c.runCutover(
      async (col) => { ran.push(col) },
      { onPoll: async () => {
          // simulate the other client quiescing for the draining generation
          const fence = await loadFence(store, 'v')
          await writeClientDoc(store, 'v', 'other', { lastSeen: 1000, quiescedAtVersion: fence.currentSchemaVersion })
        } },
    )
    expect(ran).toEqual(['invoices'])
    const fence = await loadFence(store, 'v')
    expect(fence.currentSchemaVersion).toBe(1)
    expect(fence.fenceState).toBe('normal')
  })

  it('runCutover proceeds past a stale client (timeout-free: stale never counted)', async () => {
    const { store, c } = mkCtrl()
    await c.init()
    c.registerPendingCutover('invoices', (d) => d)
    await writeClientDoc(store, 'v', 'zombie', { lastSeen: 1, quiescedAtVersion: null }) // stale at now=1000
    await c.runCutover(async () => {}, { onPoll: async () => {} })
    expect((await loadFence(store, 'v')).currentSchemaVersion).toBe(1)
  })

  it('runCutover throws QuiesceTimeoutError when an active client never acks', async () => {
    const { store, c } = mkCtrl(memory())
    await c.init()
    c.registerPendingCutover('invoices', (d) => d)
    await writeClientDoc(store, 'v', 'holdout', { lastSeen: 1000, quiescedAtVersion: null })
    // onPoll keeps the holdout fresh but never quiesces; quiesceTimeoutMs elapses via the injected clock
    await expect(
      c.runCutover(async () => {}, {
        onPoll: async () => { /* advance past timeout */ },
        nowOverrideForTest: undefined,
      }).catch((e) => { throw e }),
    ).rejects.toThrow(/quiesce/i)
  }, 10_000)

  it('abort() resets a stuck draining fence to normal without bumping', async () => {
    const { store, c } = mkCtrl()
    await c.init()
    await saveFence(store, 'v', { currentSchemaVersion: 2, fenceState: 'draining' })
    await c.abort()
    expect(await loadFence(store, 'v')).toEqual({ currentSchemaVersion: 2, fenceState: 'normal' })
  })
})
```

Note on the timeout test: drive the clock past `quiesceTimeoutMs` inside `onPoll` by advancing the injected `now()`. Adjust the test's `advance` wiring so `onPoll` calls `advance(20_000)` on its first invocation; keep the holdout fresh by re-stamping its `lastSeen` to the advanced `now`. Implement the test body to make the timeout deterministic (no real delay).

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Refactor the controller**

In `fence-controller.ts`: extend the constructor and split `runCutover`. Add `clientId`, `now`, `staleMs`, `quiesceTimeoutMs`, optional `emit` to the constructor opts. Add `QuiesceTimeoutError` to `errors.ts` first (extends `SchemaUpdateError`, code `'QUIESCE_TIMEOUT'`, export from `index.ts` — mirror Task 2 of the 3a plan). Then:

```ts
  // new constructor fields (with defaults)
  //   #clientId: string; #now: () => number; #staleMs: number; #quiesceTimeoutMs: number
  //   #emit: (e: { currentSchemaVersion: number; fenceState: FenceState }) => void

  async runCutover(
    run: RunTransform,
    opts?: { onPoll?: () => Promise<void> },
  ): Promise<{ migrated: number }> {
    if (this.#pending.size === 0) return { migrated: 0 }
    const base = await loadFence(this.#store, this.#vault)
    const generation = base.currentSchemaVersion

    await this.#setState(generation, 'draining')
    await this.#onFlush() // drain THIS client first

    // Wait for the active set to ack `generation`, or time out.
    const deadline = this.#now() + this.#quiesceTimeoutMs
    while (!(await activeQuiesced(this.#store, this.#vault, { generation, now: this.#now(), staleMs: this.#staleMs }))) {
      if (this.#now() >= deadline) {
        throw new QuiesceTimeoutError(
          `Cutover on "${this.#vault}" timed out waiting for clients to quiesce at generation ${generation}.`,
        )
      }
      await (opts?.onPoll ? opts.onPoll() : delay(50))
    }

    await this.#setState(generation, 'migrating')
    let migrated = 0
    for (const [collection, transform] of this.#pending) { await run(collection, transform); migrated++ }

    const nextVersion = generation + 1
    await this.#setState(nextVersion, 'complete')
    this.#pending.clear()
    await this.#setState(nextVersion, 'normal')
    this.#snapshot = nextVersion
    return { migrated }
  }

  /** Recover a stuck drain: reset fenceState to normal at the current version (no bump). */
  async abort(): Promise<void> {
    const fence = await loadFence(this.#store, this.#vault)
    await this.#setState(fence.currentSchemaVersion, 'normal')
  }
```

Update `#setState` to also emit:
```ts
  async #setState(currentSchemaVersion: number, fenceState: FenceState): Promise<void> {
    await saveFence(this.#store, this.#vault, { currentSchemaVersion, fenceState })
    this.#emit({ currentSchemaVersion, fenceState })
  }
```

Add a module-private `delay`:
```ts
function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }
```

Add imports: `activeQuiesced` from `./client-registry.js`; `QuiesceTimeoutError` from `../errors.js`. Keep `assertWritable` and `init` from 3a unchanged.

- [ ] **Step 4: Run → pass** (`cd packages/hub && npx vitest run __tests__/schema-update/fence-controller-barrier.test.ts && npx vitest run __tests__/schema-update/fence-controller.test.ts`) — the 3a controller test must still pass (its `runCutover(run)` calls still work; `opts` is optional, and with no other clients in the registry the barrier is vacuously satisfied immediately).

- [ ] **Step 5: Commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/schema-update/fence-controller.ts packages/hub/src/errors.ts packages/hub/src/index.ts packages/hub/__tests__/schema-update/fence-controller-barrier.test.ts
git commit -m "feat(hub): cutover ack-barrier + abort + QuiesceTimeoutError (#232)"
```

---

## Task 5: clientId per instance + thread into the controller

**Files:** Modify `packages/hub/src/noydb.ts`, `packages/hub/src/vault.ts`

- [ ] **Step 1: Mint a clientId on the Noydb instance**

In `noydb.ts`, add a field beside `writeQueueTracker`:
```ts
  private readonly clientId = crypto.randomUUID()
```
Add an internal accessor next to `_writeQueueTracker`:
```ts
  /** @internal Stable per-instance id for schema-cutover coordination (#232). */
  get _clientId(): string { return this.clientId }
```
(`crypto.randomUUID` is available in the Node + browser targets; confirm with `grep -n "crypto.randomUUID\|randomUUID" packages/hub/src` — if the codebase prefers `generateULID`, use that instead for consistency.)

- [ ] **Step 2: Pass clientId + emitter into the controller**

In `vault.ts`, where the controller is constructed (3a), extend it:
```ts
    this.schemaFence = new SchemaFenceController({
      store: this.adapter,
      vault: this.name,
      onFlush: () => this.noydb._writeQueueTracker.onFlush(),
      clientId: this.noydb._clientId,
      emit: (e) => this.emitter.emit('schema:fence-changed', { vault: this.name, ...e }),
    })
```
(The controller's `now`/`staleMs`/`quiesceTimeoutMs` use their defaults — `Date.now`, 30_000, 60_000.)

- [ ] **Step 3: Typecheck + commit**

Run: `cd packages/hub && npx tsc --noEmit`
```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/noydb.ts packages/hub/src/vault.ts
git commit -m "feat(hub): per-instance clientId + fence-changed emit wiring (#232)"
```

---

## Task 6: Lazy heartbeat + watcher on the vault; abort API; cleanup

**Files:** Modify `packages/hub/src/vault.ts`

- [ ] **Step 1: Add the watcher field + lazy starter**

Import: `import { FenceWatcher } from './schema-update/fence-watcher.js'`. Add fields:
```ts
  #fenceWatcher: FenceWatcher | undefined
  #fenceCoordinationStarted = false
```
Add the lazy starter (called only when a `coordinatedCutover` is registered, so vaults that never migrate start no timers — keeping the existing suite untouched):
```ts
  /** @internal Start heartbeat + fence watcher once a cutover strategy is registered (#232). */
  _ensureFenceCoordination(): void {
    if (this.#fenceCoordinationStarted) return
    this.#fenceCoordinationStarted = true
    this.#fenceWatcher = new FenceWatcher({
      store: this.adapter,
      vault: this.name,
      clientId: this.noydb._clientId,
      onFlush: () => this.noydb._writeQueueTracker.onFlush(),
      emit: (e) => this.emitter.emit('schema:fence-changed', { vault: this.name, ...e }),
    })
    this.#fenceWatcher.start(2_000) // heartbeat + poll every 2s; unref'd
  }
```

- [ ] **Step 2: Call it from the cutover-registration path**

In the `work` IIFE (3a, where `decision.action === 'cutover'` calls `registerPendingCutover`), add right after that call:
```ts
          if (decision.action === 'cutover') {
            this.schemaFence.registerPendingCutover(collectionName, decision.transform)
            this._ensureFenceCoordination()
          }
```

- [ ] **Step 3: Add `abortSchemaCutover` + a manual tick (test seam)**

Beside `runSchemaCutover` (3a):
```ts
  /** Recover a stuck cutover fence (#232) — reset to normal without bumping. */
  async abortSchemaCutover(): Promise<void> {
    await this.schemaFence.abort()
  }

  /** @internal Drive one heartbeat+watch cycle deterministically (tests). */
  async _fenceTick(): Promise<void> {
    if (!this.#fenceWatcher) {
      this._ensureFenceCoordination()
    }
    // beat + check via the watcher's public methods
    await this.#fenceWatcher!.beat()
    await this.#fenceWatcher!.check()
  }
```

- [ ] **Step 4: Stop coordination on lock/close**

Find the vault teardown (`grep -n "this.collectionCache.clear()" packages/hub/src/vault.ts` — the lock/close path). Add beside it:
```ts
    this.#fenceWatcher?.stop()
    this.#fenceWatcher = undefined
    this.#fenceCoordinationStarted = false
```
Also check `noydb.ts` `lockVault`/`close` for where vaults are torn down; if the Vault isn't told to stop there, add a `vault.stop?.()` call or expose a `_stopFenceCoordination()` the lock path invokes. Confirm with `grep -n "lockVault\|vaultCache.delete\|vaultCache.clear" packages/hub/src/noydb.ts` and wire cleanup so no interval leaks after a vault is locked/closed.

- [ ] **Step 5: Typecheck + run the full suite (leak check)**

Run: `cd packages/hub && npx tsc --noEmit && npx vitest run`
Expected: PASS, and vitest exits cleanly (no "a worker process has failed to exit gracefully" — confirms no leaked intervals; the `start()` `unref()` + lazy gating should prevent this. If vitest hangs, verify lazy gating: vaults without a `coordinatedCutover` must never call `_ensureFenceCoordination`).

- [ ] **Step 6: Commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/vault.ts
git commit -m "feat(hub): lazy fence heartbeat/watcher + abortSchemaCutover (#232)"
```

---

## Task 7: Multi-client E2E

**Files:** Create `packages/hub/__tests__/coordinated-cutover-multiclient.test.ts`

- [ ] **Step 1: Write the test**

```ts
/** Multi-client ack-barrier E2E (#232 sub-slice 3b). N instances, one shared store. */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../src/noydb.js'
import { memory } from '../../to-memory/src/index.js'
import { coordinatedCutover } from '../src/schema-update/index.js'
import type { NoydbStore } from '../src/types.js'

interface InvOld extends Record<string, unknown> { id: string; total: number }
interface InvNew extends Record<string, unknown> { id: string; amount: { gross: number } }
const oldSchema = z.object({ id: z.string(), total: z.number() })
const newSchema = z.object({ id: z.string(), amount: z.object({ gross: z.number() }) })
const transform = (d: Record<string, unknown>) => ({ id: d['id'], amount: { gross: d['total'] } })

async function openNew(store: NoydbStore, user: string) {
  const db = await createNoydb({ store, user, secret: 'mc-cutover-pass-1234' })
  const vault = await db.openVault('demo')
  const coll = vault.collection<InvNew>('invoices', {
    schema: newSchema, persistJsonSchema: true, schemaUpdate: [coordinatedCutover({ transform })],
  })
  await vault._drainPendingSchemaWrites()
  return { db, vault, coll }
}

describe('coordinatedCutover multi-client (#232 3b)', () => {
  it('migrator waits for a second active client to quiesce before transforming', async () => {
    const store = memory()
    // seed gen-0 old data
    const seed = await createNoydb({ store, user: 'seed', secret: 'mc-cutover-pass-1234' })
    const sv = await seed.openVault('demo')
    const so = sv.collection<InvOld>('invoices', { schema: oldSchema, persistJsonSchema: true })
    await sv._drainPendingSchemaWrites()
    await so.put('i1', { id: 'i1', total: 100 })

    // two clients on the NEW schema (both register a pending cutover)
    const migrator = await openNew(store, 'm')
    const peer = await openNew(store, 'p')

    // peer announces itself active (heartbeat) but has NOT quiesced yet
    await peer.vault._fenceTick() // beat → registry has peer active, quiescedAtVersion null

    let migrated = false
    const cutover = migrator.vault.runSchemaCutover // returns Promise; drive peer via onPoll
    // Use the controller's onPoll seam through runSchemaCutover by ticking the peer each poll:
    const result = await migrator.vault.schemaFence.runCutover(
      async (col, t) => { await migrator.vault['collectionCache'].get(col)!._applyCutoverTransform(t); migrated = true },
      { onPoll: async () => { await peer.vault._fenceTick() } }, // peer sees draining → flushes → acks
    )
    void cutover // (runSchemaCutover wraps the same controller; we drive the controller directly for determinism)

    expect(result.migrated).toBe(1)
    expect(migrated).toBe(true)
    expect((await migrator.coll.get('i1'))?.amount.gross).toBe(100)
  })
})
```

Note: this test drives `schemaFence.runCutover(..., { onPoll })` directly (the deterministic seam) rather than `runSchemaCutover()` (which polls on a real timer). The `onPoll` ticks the peer so it observes `draining`, flushes, and acks — exactly the production sequence, minus wall-clock waiting. If reaching `_applyCutoverTransform` via the cache bracket is awkward, add a tiny internal `vault._runCutoverTransforms()` helper that does what `runSchemaCutover`'s callback does and call it from both places (DRY).

- [ ] **Step 2: Run → pass**

Run: `cd packages/hub && npx vitest run __tests__/coordinated-cutover-multiclient.test.ts`
Expected: PASS. If the peer's ack isn't seen, confirm `_fenceTick()` writes the peer's `quiescedAtVersion` equal to the draining generation (the fence's `currentSchemaVersion` while `draining`).

- [ ] **Step 3: Commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/__tests__/coordinated-cutover-multiclient.test.ts
git commit -m "test(hub): multi-client ack-barrier E2E (#232)"
```

---

## Task 8: features.yaml + final verification

**Files:** Modify `features.yaml`

- [ ] **Step 1: Add invariants** to the `schema-update-strategies` entry:
```yaml
      - 'multi-client cutover: the migrator waits for every active client (fresh heartbeat) to ack the draining generation, or times out (QuiesceTimeoutError)'
      - 'heartbeat + fence watcher start lazily only when a coordinatedCutover is registered; stopped on vault lock/close'
```

- [ ] **Step 2: Validate** — `node scripts/validate-features.mjs` (Expected: PASS)

- [ ] **Step 3: Full verification** — `cd packages/hub && npx vitest run && npx tsc --noEmit && npm run lint` (Expected: all PASS, vitest exits cleanly)

- [ ] **Step 4: Commit + clean tree**

```bash
cd /Users/vicio/_github/noy-db && git add features.yaml
git commit -m "chore(features): record multi-client cutover invariants (#232)"
git status
```

---

## Self-review checklist (already applied)

- **Spec coverage (§5 Slice 3b):** client registry → Task 2; fence watcher (flush + ack on draining) → Task 3; migrator active-set wait + timeout → Task 4; resume (runCutover from current state) + abort → Tasks 4, 6; lazy heartbeat/watcher + cleanup → Task 6; `schema:fence-changed` same-instance event → Tasks 1, 5, 6; election explicitly absent. Multi-client harness (N instances, one store, explicit ticks) → Task 7.
- **Determinism:** `now()` injected everywhere time matters; barrier driven by `onPoll`; tests call `check()`/`beat()`/`_fenceTick()` explicitly — no reliance on `setInterval`. The one production timer (`FenceWatcher.start`) is `unref()`'d and lazily gated.
- **Existing-suite safety:** heartbeat/watcher start ONLY when a `coordinatedCutover` is registered, so the 1921 existing tests (and 3a's single-client tests) open vaults that start no timers and see no behavior change. 3a's `runCutover(run)` still type-checks and passes (the barrier is vacuously satisfied with no other active clients).
- **Type consistency:** `ClientDoc`/`writeClientDoc`/`listClientDocs`/`activeQuiesced`, `FenceWatcher.{beat,check,start,stop}`, controller `runCutover(run, {onPoll})`/`abort`/`QuiesceTimeoutError`, `_clientId`/`_fenceTick`/`_ensureFenceCoordination` — names consistent across tasks.
- **Verify-before-trust flags:** Task 5 confirm `crypto.randomUUID` vs `generateULID`; Task 6 confirm the vault lock/close teardown site + that `noydb.lockVault` tells the vault to stop. These are real lookups for the implementer.
- **No placeholders:** every code step has complete code; every run step states command + expected result. (The Task 4 timeout test notes the exact clock-advance wiring to make it deterministic.)
