# Track A — Subsystem Observe Bus (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a generic, per-instance **observe bus** (`SubsystemBus`) and prove it end-to-end by firing one *observe* lifecycle point (`afterPut`) from the collection write path — the seam that Track B's devtools inspector and other observe-class subsystems (audit, sync-dirty notification) subscribe to.

**Architecture:** The bus mirrors the existing per-instance registry pattern (`WriteHookRegistry`, `WriteQueueTracker`, `NoydbEventEmitter`): constructed once on `Noydb`, exposed via an internal `_subsystemBus` accessor, threaded into each `Collection` through `vault.collection()`. Slice 1 is purely **additive** — the bus does nothing unless a handler is registered, so behavior is preserved.

**Scope — read this before coding.** This is an **observe** primitive only: handlers *react* to a write that already succeeded; they cannot abort it (errors are warned, not thrown). It is deliberately a **sibling of the #230 write-hooks** and shares their exact coverage envelope — it fires from the public `put()` and therefore inherits the documented gap (`collection.ts:1103-1105`: `putMany`/tx-execute/CRDT/blob writes are not yet fired through write-hooks). That is acceptable here because the consumers of slice 1 (the inspector, audit, sync-dirty) observe the same surface #230 already observes.

**This slice is explicitly NOT the migration seam for guards / periods / consent.** Those subsystems are write-*gating*: they run at the top of `putInternal` (`collection.ts:1164`, `:1213`), **throw to abort**, and fire on all write paths including delete (`:1833`, `:1885`). Migrating them requires a *different* primitive — a `beforePut`/`beforeDelete` **gate bus** with throw-propagation dispatched from `putInternal` — which is the follow-on `track-a-gate-bus` plan and MUST land before any gating subsystem moves. Do not try to fold gating into this observe bus; the two policies (abort vs. observe) and altitudes (`putInternal` vs. `put()`) are genuinely different.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, pnpm workspace. Package: `packages/hub`. The hub must stay portable (no Node-only imports — `pnpm check:architecture` enforces it).

**Not in this slice:** no public API export of the bus (it stays internal until a real subsystem validates its shape — see roadmap's API-stability gate); no `beforePut`/gate path; no subsystem migrated off its kernel branch; no kernel-surface CI gate. Each is a named follow-on plan at the end.

---

## File Structure

- **Create** `packages/hub/src/subsystem-bus.ts` — the `SubsystemBus` class + its typed lifecycle map. Single responsibility: ordered registration + dispatch of *observe* lifecycle handlers.
- **Create** `packages/hub/__tests__/subsystem-bus.test.ts` — unit tests for the bus in isolation.
- **Create** `packages/hub/__tests__/subsystem-bus-integration.test.ts` — integration test: a bus handler fires on `collection.put()` with no write-hooks present (proves decoupling from #230).
- **Modify** `packages/hub/src/noydb.ts` — construct the bus (near line 162) and expose `_subsystemBus` accessor (near line 1274).
- **Modify** `packages/hub/src/vault.ts` — pass `subsystemBus` into the `Collection` options object (near lines 677–679).
- **Modify** `packages/hub/src/collection.ts` — accept + store `subsystemBus` (ctor opts ~516, field ~137, assign ~808); broaden the `event`-build gate and dispatch `afterPut` in `put()` (~1106–1119).

> The bus type is referenced internally only. Tests import it directly from `../src/subsystem-bus.js` and reach the instance via the internal `db._subsystemBus` accessor — no package-root export is added.

---

### Task 1: `SubsystemBus` class (observe primitive)

**Files:**
- Create: `packages/hub/src/subsystem-bus.ts`
- Test: `packages/hub/__tests__/subsystem-bus.test.ts`

- [ ] **Step 1: Write the failing unit test**

Create `packages/hub/__tests__/subsystem-bus.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SubsystemBus } from '../src/subsystem-bus.js'
import type { WriteEvent } from '../src/write-hooks.js'

function ev(over: Partial<WriteEvent> = {}): WriteEvent {
  return {
    op: 'create', vault: 'v', collection: 'c', docId: 'd',
    before: null, after: { x: 1 }, baseVersion: 0, version: 1,
    userId: 'u', timestamp: 0, txId: 't', ...over,
  }
}

describe('SubsystemBus (observe)', () => {
  it('dispatches handlers in registration order', async () => {
    const bus = new SubsystemBus()
    const order: number[] = []
    bus.register('afterPut', () => { order.push(1) })
    bus.register('afterPut', () => { order.push(2) })
    await bus.dispatch('afterPut', ev())
    expect(order).toEqual([1, 2])
  })

  it('hasHandlers reflects registration and unsubscribe', async () => {
    const bus = new SubsystemBus()
    expect(bus.hasHandlers('afterPut')).toBe(false)
    const off = bus.register('afterPut', () => {})
    expect(bus.hasHandlers('afterPut')).toBe(true)
    off()
    expect(bus.hasHandlers('afterPut')).toBe(false)
  })

  it('awaits async handlers', async () => {
    const bus = new SubsystemBus()
    let done = false
    bus.register('afterPut', async () => {
      await new Promise((r) => setTimeout(r, 5))
      done = true
    })
    await bus.dispatch('afterPut', ev())
    expect(done).toBe(true)
  })

  it('isolates a throwing handler — others still run, dispatch never rejects (observe policy)', async () => {
    const bus = new SubsystemBus()
    const ran: string[] = []
    bus.register('afterPut', () => { throw new Error('boom') })
    bus.register('afterPut', () => { ran.push('second') })
    await expect(bus.dispatch('afterPut', ev())).resolves.toBeUndefined()
    expect(ran).toEqual(['second'])
  })

  it('dispatch is a no-op when no handler is registered', async () => {
    const bus = new SubsystemBus()
    await expect(bus.dispatch('afterPut', ev())).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/subsystem-bus.test.ts`
Expected: FAIL — `Cannot find module '../src/subsystem-bus.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/hub/src/subsystem-bus.ts`:

```ts
/**
 * Generic per-instance **observe** bus (Track A, slice 1). Observe-class
 * subsystems (devtools inspector, audit, sync-dirty notification) register
 * handlers against named lifecycle points instead of the kernel naming each
 * subsystem. Mirrors the registry pattern of {@link WriteHookRegistry} but is
 * internal and keyed by lifecycle point.
 *
 * OBSERVE SEMANTICS: handlers react to a write that already happened. A
 * handler throw is warned, not propagated — it can never abort a write. Write-
 * *gating* subsystems (guards, periods) need the separate throw-propagating
 * gate bus (`beforePut`/`beforeDelete`, dispatched from `putInternal`); that is
 * NOT this primitive. Add observe points by extending {@link LifecycleEventMap}.
 *
 * @module
 */
import type { WriteEvent } from './write-hooks.js'

/** Typed map of OBSERVE lifecycle point → event payload. Extend by adding keys. */
export interface LifecycleEventMap {
  afterPut: WriteEvent
}

export type LifecyclePoint = keyof LifecycleEventMap
export type BusHandler<P extends LifecyclePoint> = (event: LifecycleEventMap[P]) => void | Promise<void>
export type Unsubscribe = () => void

type AnyHandler = (event: unknown) => void | Promise<void>

export class SubsystemBus {
  readonly #handlers = new Map<LifecyclePoint, AnyHandler[]>()

  /** Register a handler for an observe point. Returns an unsubscribe fn. */
  register<P extends LifecyclePoint>(point: P, handler: BusHandler<P>): Unsubscribe {
    let arr = this.#handlers.get(point)
    if (!arr) { arr = []; this.#handlers.set(point, arr) }
    arr.push(handler as AnyHandler)
    return () => {
      const a = this.#handlers.get(point)
      if (!a) return
      const i = a.indexOf(handler as AnyHandler)
      if (i >= 0) a.splice(i, 1)
    }
  }

  /** Cheap gate for the write path — true when any handler is registered for the point. */
  hasHandlers(point: LifecyclePoint): boolean {
    const a = this.#handlers.get(point)
    return a !== undefined && a.length > 0
  }

  /**
   * Dispatch in registration order, awaited. Per-handler errors are warned, not
   * thrown — an observe handler must never abort a completed write.
   */
  async dispatch<P extends LifecyclePoint>(point: P, event: LifecycleEventMap[P]): Promise<void> {
    const a = this.#handlers.get(point)
    if (!a || a.length === 0) return
    for (const h of a.slice()) {
      try {
        await h(event)
      } catch (err) {
        console.warn(
          `[noy-db] subsystem observe handler failed at ${point} for ${event.collection}/${event.docId}: ` +
          (err instanceof Error ? err.message : String(err)),
        )
      }
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/subsystem-bus.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/subsystem-bus.ts packages/hub/__tests__/subsystem-bus.test.ts
git commit -m "feat(hub): SubsystemBus — internal observe-lifecycle dispatch (Track A slice 1)"
```

---

### Task 2: Thread the bus through construction

**Files:**
- Modify: `packages/hub/src/noydb.ts` (construct + accessor)
- Modify: `packages/hub/src/vault.ts` (pass into Collection opts)
- Modify: `packages/hub/src/collection.ts` (ctor opts + field + assign)

- [ ] **Step 1: Construct the bus on `Noydb`**

In `packages/hub/src/noydb.ts`, add the import near the existing registry imports (lines ~79–81):

```ts
import { SubsystemBus } from './subsystem-bus.js'
```

Then, next to the existing per-instance registries (lines ~160–162, where `emitter`, `writeQueueTracker`, `writeHooks` are constructed), add:

```ts
  private readonly subsystemBus = new SubsystemBus()
```

- [ ] **Step 2: Expose the internal accessor**

In `packages/hub/src/noydb.ts`, next to the existing `get _writeHooks()` accessor (near line 1274), add:

```ts
  /** @internal Track A — the observe bus, threaded into every Collection. */
  get _subsystemBus(): SubsystemBus {
    return this.subsystemBus
  }
```

- [ ] **Step 3: Pass the bus into Collection options in `vault.ts`**

In `packages/hub/src/vault.ts`, in the `collOpts` object that is passed to `new Collection<T>(collOpts)` (the block near lines 677–679 that already sets `emitter`, `writeQueue`, `writeHooks`), add:

```ts
        subsystemBus: this.noydb._subsystemBus,
```

- [ ] **Step 4: Accept + store the bus on `Collection`**

In `packages/hub/src/collection.ts`:

(a) Add the import near the other registry imports at the top of the file:

```ts
import type { SubsystemBus } from './subsystem-bus.js'
```

(b) Add the private field next to `writeHooks` (near line 137):

```ts
  private readonly subsystemBus: SubsystemBus | undefined
```

(c) Add to the constructor `opts` type next to `writeHooks?` (near line 516):

```ts
    subsystemBus?: SubsystemBus | undefined
```

(d) Assign it next to `this.writeHooks = opts.writeHooks` (near line 808):

```ts
    this.subsystemBus = opts.subsystemBus
```

- [ ] **Step 5: Run typecheck + full hub test suite to verify nothing broke**

Run: `cd packages/hub && pnpm typecheck && pnpm vitest run`
Expected: PASS — typecheck clean, all existing hub tests still green (the bus is threaded but never dispatched yet, so behavior is unchanged).

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/noydb.ts packages/hub/src/vault.ts packages/hub/src/collection.ts
git commit -m "feat(hub): thread SubsystemBus through Noydb→Vault→Collection (Track A slice 1)"
```

---

### Task 3: Fire `afterPut` from the write path (decoupled from write-hooks)

**Files:**
- Test: `packages/hub/__tests__/subsystem-bus-integration.test.ts`
- Modify: `packages/hub/src/collection.ts` (the `put()` method, lines ~1106–1119)

- [ ] **Step 1: Write the failing integration test**

Create `packages/hub/__tests__/subsystem-bus-integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, WriteEvent } from '../src/index.js'

function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = getColl(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = data.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll() {},
  }
}

describe('SubsystemBus integration — afterPut fires from put()', () => {
  it('fires with no write-hooks registered (proves decoupling from #230)', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const seen: WriteEvent[] = []
    db._subsystemBus.register('afterPut', (e) => { seen.push(e) })

    const docs = db.collection<{ id: string; n: number }>('docs')
    await docs.put('a', { id: 'a', n: 1 })

    expect(seen).toHaveLength(1)
    expect(seen[0].op).toBe('create')
    expect(seen[0].collection).toBe('docs')
    expect(seen[0].docId).toBe('a')
    expect(seen[0].after).toEqual({ id: 'a', n: 1 })
  })

  it('does not fire when no handler is registered (zero-cost path)', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const docs = db.collection<{ id: string; n: number }>('docs')
    await expect(docs.put('a', { id: 'a', n: 1 })).resolves.toBeUndefined()
  })
})
```

> NOTE: confirm the no-arg `db.collection(...)` accessor and the `createNoydb({ store, secret, user })` shape match the version under test by glancing at an existing `__tests__/*.test.ts` (e.g. `hierarchical-tiers.test.ts`). If a vault must be opened explicitly in this version, replace the two `db.collection(...)` lines with the open-vault form used there; the bus assertions are unchanged.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/subsystem-bus-integration.test.ts`
Expected: FAIL — first test gets `seen.length === 0` (the write path does not yet dispatch to the bus).

- [ ] **Step 3: Broaden the event gate and dispatch `afterPut`**

In `packages/hub/src/collection.ts`, replace the body of `put()` from the `let event` line through the `runAfter` line (currently lines ~1106–1119):

Replace this:

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
    if (this.writeQueue) await this.writeQueue.track(() => this.putInternal(id, record, options))
    else await this.putInternal(id, record, options)
    if (event) await this.writeHooks!.runAfter(event)
```

With this:

```ts
    // #230 user write-hooks AND the Track A observe bus both need the
    // WriteEvent. Build it if EITHER consumer is active so the bus is not
    // coupled to write-hooks being present.
    const hooksActive = this.#hooksActive()
    const busAfterPut = this.subsystemBus?.hasHandlers('afterPut') ?? false
    let event: WriteEvent | undefined
    if (hooksActive || busAfterPut) {
      const prior = await this.#priorForHook(id)
      event = {
        op: prior.record === null ? 'create' : 'update',
        vault: this.vault, collection: this.name, docId: id, before: prior.record, after: record,
        userId: this.keyring.userId, timestamp: Date.now(), txId: this.#txIdForHook(),
        baseVersion: prior.version, version: prior.version + 1,
      }
      if (hooksActive) await this.writeHooks!.runBefore(event) // throw → aborts the write
    }
    if (this.writeQueue) await this.writeQueue.track(() => this.putInternal(id, record, options))
    else await this.putInternal(id, record, options)
    if (event) {
      // Ordering: user afterWrite hooks run BEFORE observe-bus dispatch in
      // slice 1. Revisit when internal observe subsystems (e.g. MV-refresh
      // notification) need to settle before user hooks observe state —
      // tracked for the gate-bus / migration slices.
      if (hooksActive) await this.writeHooks!.runAfter(event)
      if (busAfterPut) await this.subsystemBus!.dispatch('afterPut', event)
    }
```

> Rationale: the original gated `event` on `#hooksActive()` alone, then relied on `event` truthiness to call `runAfter`. Because `event` can now exist for the bus when write-hooks are absent (`this.writeHooks` undefined), `runAfter` MUST be re-guarded with the captured `hooksActive` boolean — otherwise `this.writeHooks!` would throw. Capturing `hooksActive` once preserves the original single-evaluation semantics. The bus deliberately shares this `put()` altitude with #230, so it inherits the documented `putMany`/tx/CRDT/blob coverage gap (`collection.ts:1103-1105`); closing that gap for both #230 and the bus is a joint follow-on.

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/subsystem-bus-integration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full hub suite + architecture check to verify no regression**

Run: `cd packages/hub && pnpm vitest run && cd ../.. && pnpm check:architecture`
Expected: PASS — all existing hub tests green (write-hook behavior unchanged when no bus handler is registered) and architecture invariants hold (no Node-only import introduced; `subsystem-bus.ts` imports only a type from `write-hooks.js`).

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/collection.ts packages/hub/__tests__/subsystem-bus-integration.test.ts
git commit -m "feat(hub): dispatch afterPut through observe bus, decoupled from write-hooks (Track A slice 1)"
```

---

## Self-Review

**Spec coverage (against the proposal's Track A, honestly scoped):**
- "Extension-point bus generalizing the three plumbing seeds" → Tasks 1–3 build `SubsystemBus` for the **observe** half and wire it via the same per-instance pattern as `WriteHookRegistry`. ✅
- "Seam for observe-class subsystems + Track B inspector" → slice 1 delivers exactly this (`afterPut`), at the same coverage envelope as #230. ✅
- "Migrate guards / periods / consent onto the bus" → **explicitly OUT and re-sequenced.** Validation (`collection.ts:1164/1213/1833/1885`) showed these are throw-to-abort gating dispatched from `putInternal` across all write paths — they need the `track-a-gate-bus` (`beforePut`/`beforeDelete`) primitive first. Listed as a prerequisite follow-on. ✅ (corrected after design review — slice 1 does not claim to be this seam.)
- "keyring-grant → team", "lazy-mode → subsystem", "kernel-surface CI gate" → named follow-on plans. ✅
- "Behavior-preserving" → bus is inert until a handler registers; Task 2 Step 5 and Task 3 Step 5 run the full hub suite. ✅
- "No premature public API" → the bus is NOT exported from the package root (removed after review, per the roadmap API-stability gate); tests use the internal `_subsystemBus` accessor. ✅

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". The one NOTE in Task 3 Step 1 is a concrete version-shape verification with a concrete fallback. ✅

**Type consistency:** `SubsystemBus`, `register`, `hasHandlers`, `dispatch`, `LifecyclePoint`, `LifecycleEventMap`, `BusHandler`, `Unsubscribe`, `_subsystemBus`, `subsystemBus` (opt + field) used identically across Tasks 1–3. The `afterPut` payload is `WriteEvent` (type-imported from `write-hooks.js`) everywhere. ✅

---

## Follow-on plans (not in this slice), in dependency order

1. **`track-a-gate-bus`** — add `beforePut`/`beforeDelete` **gate** points with throw-propagation, dispatched from `putInternal` (and the internal delete method) so they cover all write paths. This is the prerequisite for migrating any write-gating subsystem. Distinct primitive from slice 1's observe bus.
2. **`track-a-migrate-consent`** — move consent (~194 LOC) onto the appropriate point (observe-bus for its audit append; confirm whether any consent check must gate); remove its hard-coded kernel branch.
3. **`track-a-migrate-gating`** — periods, guards onto the gate bus; remove their `putInternal` branches; one per commit, each green before the next, full showcase suite as the net.
4. **`track-a-coverage-unification`** — close the documented `put()`-level coverage gap (`collection.ts:1103-1105`) for #230 write-hooks AND the observe bus by dispatching from `putInternal`, so observe events fire on `putMany`/tx/CRDT/blob writes too. Also settle internal-vs-user hook ordering.
5. **`track-a-public-surface`** — once migrations validate the bus shape, decide and export the stable public registration surface (if any) behind the API-extractor gate.
6. **`track-a-keyring-split`** — multi-user grant/revoke/rotate out of core into `team`.
7. **`track-a-lazy-split`** — promote lazy-mode out of `routing` into its own subsystem.
8. **`track-a-kernel-ci-gate`** — fail CI when the always-on root grows past a declared ceiling or a subsystem adds a hard-coded `collection.ts`/`vault.ts` reference.
