# M12 Slice 1 — Observable Write-Queue / Flush Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a vault-level observable write-queue (`hub.writeQueue`) that tracks outstanding in-flight logical writes, so the UI can guard `beforeunload`/lock and so the migration drain (Slice 2) can quiesce via `onFlush()`.

**Architecture:** A framework-agnostic `WriteQueueTracker` lives on the `Noydb` instance and is threaded into every `Collection`. `Collection.put`/`delete` run their existing body inside `tracker.track()`, which increments a depth counter on entry and decrements on settle (success or error). `onFlush()` resolves when depth hits 0, or rejects if a write errored during the wait. The hub core exposes a plain emitter/getter (no Vue dependency); `@noy-db/in-vue` wraps it into a `ref` in Slice 3.

**Tech Stack:** TypeScript, Vitest (`vitest run`), `@noy-db/to-memory` adapter for tests. Hub package at `packages/hub`.

**Spec:** `docs/superpowers/specs/2026-05-31-m12-schema-migration-epic-design.md` §5 Slice 1. Issue #227.

---

## Scope (read before starting)

**In scope:** tracking `Collection.put` and `Collection.delete` (the dominant write paths; non-atomic `putMany` delegates to `put` and is covered transitively). The `track()` seam is reusable so other paths can opt in later.

**Explicitly OUT of scope for Slice 1 (documented gap, audited in Slice 2):** atomic `putManyAtomic`, the `transaction()` execute phase if it bypasses `Collection.put`/`delete`, CRDT merge writes, and blob writes. Slice 2 (drain) MUST verify every write path is tracked before relying on `onFlush()` as a complete quiesce barrier. This plan adds a `// TODO(#232-slice2)` note at the two wrap sites to make the boundary explicit.

---

## File structure

- **Create** `packages/hub/src/write-queue.ts` — the `WriteQueueTracker` class + public `WriteQueue` interface. One responsibility: counting in-flight writes and notifying.
- **Create** `packages/hub/__tests__/write-queue.test.ts` — pure unit tests for the tracker (no hub needed).
- **Create** `packages/hub/__tests__/write-queue-integration.test.ts` — end-to-end tests through `createNoydb` + a gated memory adapter.
- **Modify** `packages/hub/src/noydb.ts` — instantiate the tracker, expose `get writeQueue()`, thread it into each `new Collection({...})`.
- **Modify** `packages/hub/src/collection.ts` — accept `writeQueue` in constructor opts; wrap `put`/`delete` bodies via `track()`.
- **Modify** `packages/hub/src/index.ts` — export the public `WriteQueue` type.
- **Modify** `features.yaml` — register the feature (CI "Spec coverage" gate).

---

## Task 1: `WriteQueueTracker` class + public interface

**Files:**
- Create: `packages/hub/src/write-queue.ts`
- Test: `packages/hub/__tests__/write-queue.test.ts`

- [ ] **Step 1: Write the failing unit test**

Create `packages/hub/__tests__/write-queue.test.ts`:

```ts
/**
 * Unit tests for WriteQueueTracker — the framework-agnostic in-flight
 * write counter behind hub.writeQueue (#227, M12 Slice 1).
 */
import { describe, expect, it, vi } from 'vitest'
import { WriteQueueTracker } from '../src/write-queue.js'

describe('WriteQueueTracker', () => {
  it('starts empty', () => {
    const t = new WriteQueueTracker()
    expect(t.depth).toBe(0)
    expect(t.pending).toBe(false)
  })

  it('begin() raises depth and pending; settle() lowers them', () => {
    const t = new WriteQueueTracker()
    t.begin()
    expect(t.depth).toBe(1)
    expect(t.pending).toBe(true)
    t.begin()
    expect(t.depth).toBe(2)
    t.settle()
    expect(t.depth).toBe(1)
    expect(t.pending).toBe(true)
    t.settle()
    expect(t.depth).toBe(0)
    expect(t.pending).toBe(false)
  })

  it('settle() never drives depth below zero', () => {
    const t = new WriteQueueTracker()
    t.settle()
    expect(t.depth).toBe(0)
  })

  it('onChange fires on every begin and settle and unsubscribes', () => {
    const t = new WriteQueueTracker()
    const spy = vi.fn()
    const unsub = t.onChange(spy)
    t.begin()
    t.settle()
    expect(spy).toHaveBeenCalledTimes(2)
    unsub()
    t.begin()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('onFlush() resolves immediately when depth is already 0', async () => {
    const t = new WriteQueueTracker()
    await expect(t.onFlush()).resolves.toBeUndefined()
  })

  it('onFlush() resolves once depth returns to 0', async () => {
    const t = new WriteQueueTracker()
    t.begin()
    let resolved = false
    const flush = t.onFlush().then(() => { resolved = true })
    expect(resolved).toBe(false)
    t.settle()
    await flush
    expect(resolved).toBe(true)
  })

  it('onFlush() rejects when a write settled with an error during the wait', async () => {
    const t = new WriteQueueTracker()
    t.begin()
    const flush = t.onFlush()
    t.settle(new Error('adapter exploded'))
    await expect(flush).rejects.toThrow('adapter exploded')
  })

  it('a fresh onFlush() after an error drain resolves cleanly', async () => {
    const t = new WriteQueueTracker()
    t.begin()
    const first = t.onFlush()
    t.settle(new Error('boom'))
    await expect(first).rejects.toThrow('boom')
    await expect(t.onFlush()).resolves.toBeUndefined()
  })

  it('track() increments around a successful async fn and returns its value', async () => {
    const t = new WriteQueueTracker()
    const result = await t.track(async () => {
      expect(t.depth).toBe(1)
      return 42
    })
    expect(result).toBe(42)
    expect(t.depth).toBe(0)
  })

  it('track() decrements and propagates when the fn throws', async () => {
    const t = new WriteQueueTracker()
    await expect(t.track(async () => { throw new Error('nope') })).rejects.toThrow('nope')
    expect(t.depth).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/write-queue.test.ts`
Expected: FAIL — `Cannot find module '../src/write-queue.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/hub/src/write-queue.ts`:

```ts
/**
 * Observable write-queue (#227, M12 Slice 1).
 *
 * Tracks outstanding in-flight *logical* writes (a full Collection.put /
 * delete, including ledger + cache + derivation + MV dispatch — not just
 * the adapter call). The hub holds one tracker per instance; it is
 * framework-agnostic (no Vue/React dependency). UI layers subscribe via
 * onChange(); the migration drain (Slice 2) quiesces via onFlush().
 */

/** Public, read-only view of the hub's write-queue. */
export interface WriteQueue {
  /** True while one or more writes are in flight (`depth > 0`). */
  readonly pending: boolean
  /** Count of outstanding write operations. */
  readonly depth: number
  /**
   * Subscribe to depth changes (fires on every begin and settle).
   * Returns an unsubscribe function. Intended for reactive wrappers
   * (e.g. `@noy-db/in-vue` turns this into a `ref`).
   */
  onChange(handler: () => void): () => void
  /**
   * Resolves once `depth` reaches 0. If a write settled with an error
   * while this flush was waiting, the returned promise REJECTS with that
   * error instead — so a drain caller surfaces the failure rather than
   * hanging. Resolves immediately when already idle and error-free.
   */
  onFlush(): Promise<void>
}

interface FlushWaiter {
  resolve: () => void
  reject: (error: Error) => void
}

export class WriteQueueTracker implements WriteQueue {
  #depth = 0
  #error: Error | null = null
  readonly #changeHandlers = new Set<() => void>()
  #flushWaiters: FlushWaiter[] = []

  get pending(): boolean {
    return this.#depth > 0
  }

  get depth(): number {
    return this.#depth
  }

  /** Mark one write as started. */
  begin(): void {
    this.#depth++
    this.#emitChange()
  }

  /** Mark one write as finished. Pass the error if it failed. */
  settle(error?: Error): void {
    this.#depth = Math.max(0, this.#depth - 1)
    if (error) this.#error = error
    this.#emitChange()
    if (this.#depth === 0) this.#drainFlush()
  }

  onChange(handler: () => void): () => void {
    this.#changeHandlers.add(handler)
    return () => {
      this.#changeHandlers.delete(handler)
    }
  }

  onFlush(): Promise<void> {
    if (this.#depth === 0) {
      const error = this.#error
      this.#error = null
      return error ? Promise.reject(error) : Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      this.#flushWaiters.push({ resolve, reject })
    })
  }

  /**
   * Run `fn` as a tracked write: depth++ on entry, depth-- on settle
   * (success or failure). The fn's resolved value is returned; a thrown
   * error is re-thrown after the queue is decremented.
   */
  async track<R>(fn: () => Promise<R>): Promise<R> {
    this.begin()
    try {
      const value = await fn()
      this.settle()
      return value
    } catch (error) {
      this.settle(error as Error)
      throw error
    }
  }

  #emitChange(): void {
    for (const handler of this.#changeHandlers) handler()
  }

  #drainFlush(): void {
    const waiters = this.#flushWaiters
    this.#flushWaiters = []
    const error = this.#error
    this.#error = null
    for (const waiter of waiters) {
      if (error) waiter.reject(error)
      else waiter.resolve()
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/write-queue.test.ts`
Expected: PASS — all 11 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/write-queue.ts packages/hub/__tests__/write-queue.test.ts
git commit -m "feat(hub): WriteQueueTracker — in-flight write counter (#227)"
```

---

## Task 2: Export the public `WriteQueue` type

**Files:**
- Modify: `packages/hub/src/index.ts`

- [ ] **Step 1: Find the existing type-export block**

Run: `grep -n "export type" packages/hub/src/index.ts | head -20`
Expected: a list of `export type { ... } from './...js'` lines — note the style and a nearby line to insert after.

- [ ] **Step 2: Add the export**

Add this line alongside the other type exports in `packages/hub/src/index.ts` (place it near the other `./` re-exports; exact neighbour doesn't matter):

```ts
export type { WriteQueue } from './write-queue.js'
```

Do NOT export `WriteQueueTracker` — it is an internal implementation detail. Consumers only see the read-only `WriteQueue` interface via `hub.writeQueue`.

- [ ] **Step 3: Verify it type-checks**

Run: `cd packages/hub && npx tsc --noEmit`
Expected: no new errors referencing `write-queue`.

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/index.ts
git commit -m "feat(hub): export public WriteQueue type (#227)"
```

---

## Task 3: Wire the tracker into `Noydb` and expose `hub.writeQueue`

**Files:**
- Modify: `packages/hub/src/noydb.ts`

- [ ] **Step 1: Import the tracker**

Near the top of `packages/hub/src/noydb.ts`, add to the existing import group:

```ts
import { WriteQueueTracker, type WriteQueue } from './write-queue.js'
```

- [ ] **Step 2: Add the instance field**

In the `Noydb` class field block (next to `private readonly emitter = new NoydbEventEmitter()` at ~line 154), add:

```ts
  private readonly writeQueueTracker = new WriteQueueTracker()
```

- [ ] **Step 3: Expose the public getter**

In the "Events" section of `noydb.ts` (right after the `off<K ...>` method at ~line 1124), add:

```ts
  /**
   * Observable write-queue for this hub instance. Reflects outstanding
   * in-flight writes across all collections. See {@link WriteQueue}.
   *
   * @example
   * window.addEventListener('beforeunload', (e) => {
   *   if (db.writeQueue.pending) { e.preventDefault(); e.returnValue = '' }
   * })
   */
  get writeQueue(): WriteQueue {
    return this.writeQueueTracker
  }
```

- [ ] **Step 4: Thread the tracker into every Collection construction**

There are several `new Collection({ ... emitter: this.emitter, ... })` sites in `noydb.ts` (the `emitter: this.emitter,` lines around 334, 350, 366, 449, 492). For EACH of those construction objects, add the tracker right beside the `emitter:` line:

```ts
        emitter: this.emitter,
        writeQueue: this.writeQueueTracker,
```

Run this to enumerate the exact sites first:

Run: `grep -n "emitter: this.emitter," packages/hub/src/noydb.ts`
Then add `writeQueue: this.writeQueueTracker,` immediately after each one.

- [ ] **Step 5: Verify it type-checks (will fail until Task 4 adds the opt)**

Run: `cd packages/hub && npx tsc --noEmit`
Expected: errors that `writeQueue` is not a known property of the Collection constructor opts. This is expected — Task 4 adds it. Do NOT commit yet; proceed to Task 4 and commit them together so the tree never holds a type error.

---

## Task 4: Wrap `Collection.put`/`delete` via `track()`

**Files:**
- Modify: `packages/hub/src/collection.ts`

- [ ] **Step 1: Import the tracker type**

Add to the imports in `packages/hub/src/collection.ts`:

```ts
import type { WriteQueueTracker } from './write-queue.js'
```

- [ ] **Step 2: Add the constructor opt and field**

In the constructor opts type (the `constructor(opts: { ... })` block starting ~line 488), add beside the `emitter: NoydbEventEmitter` entry:

```ts
    emitter: NoydbEventEmitter
    /**
     * Vault-level in-flight write tracker (#227). When present,
     * `put`/`delete` run inside `writeQueue.track()` so `hub.writeQueue`
     * reflects outstanding writes. Optional so direct Collection
     * construction in tests still works untracked.
     */
    writeQueue?: WriteQueueTracker | undefined
```

In the class field block (next to `private readonly emitter: NoydbEventEmitter` at ~line 129), add:

```ts
  private readonly writeQueue: WriteQueueTracker | undefined
```

In the constructor body, where fields are assigned from `opts` (find `this.emitter = opts.emitter`), add:

```ts
    this.writeQueue = opts.writeQueue
```

Run: `grep -n "this.emitter = opts.emitter" packages/hub/src/collection.ts` to locate the assignment block.

- [ ] **Step 3: Rename the put body and add the tracked wrapper**

Find the `async put(id: string, record: T, options?: { readonly reason?: string }): Promise<void> {` declaration (~line 1067). Rename ONLY that declaration line to a private method:

```ts
  private async putInternal(id: string, record: T, options?: { readonly reason?: string }): Promise<void> {
```

Leave the entire method body unchanged. Then add a new public `put` immediately ABOVE `putInternal` (just before its doc comment / declaration):

```ts
  /**
   * Create or update a record. Runs inside the hub's write-queue tracker
   * (#227) so `hub.writeQueue.pending` reflects this write.
   *
   * @param id      Record identifier.
   * @param record  The record body (validated by the collection's schema).
   * @param options `reason` is stamped onto the resulting ledger entry.
   */
  async put(id: string, record: T, options?: { readonly reason?: string }): Promise<void> {
    // TODO(#232-slice2): audit putManyAtomic / tx-execute / CRDT / blob
    // write paths for tracking before drain relies on onFlush() as a
    // complete quiesce barrier.
    if (!this.writeQueue) return this.putInternal(id, record, options)
    return this.writeQueue.track(() => this.putInternal(id, record, options))
  }
```

Note: the original `put` already has a doc comment above it (~line 1057). Move that original doc comment down so it stays attached to `putInternal`, or delete it (the new public `put` carries the doc). Simplest: delete the original doc block above `putInternal` since the new `put` documents the public surface and `putInternal` is `@internal` by being private.

- [ ] **Step 4: Rename the delete body and add the tracked wrapper**

Find `async delete(id: string): Promise<void> {` (~line 1609). Rename ONLY that line:

```ts
  private async deleteInternal(id: string): Promise<void> {
```

Leave the body unchanged. Add a new public `delete` immediately above it:

```ts
  /**
   * Delete a record. Runs inside the hub's write-queue tracker (#227).
   */
  async delete(id: string): Promise<void> {
    if (!this.writeQueue) return this.deleteInternal(id)
    return this.writeQueue.track(() => this.deleteInternal(id))
  }
```

- [ ] **Step 5: Verify the whole hub type-checks**

Run: `cd packages/hub && npx tsc --noEmit`
Expected: PASS — no errors. (This resolves the Task 3 errors.)

- [ ] **Step 6: Run the existing hub suite to confirm no regression**

Run: `cd packages/hub && npx vitest run`
Expected: PASS — the full existing suite stays green (put/delete behaviour is unchanged; only the method is now wrapped).

- [ ] **Step 7: Commit Tasks 3 + 4 together**

```bash
git add packages/hub/src/noydb.ts packages/hub/src/collection.ts
git commit -m "feat(hub): track in-flight writes; expose hub.writeQueue (#227)"
```

---

## Task 5: End-to-end integration tests through the hub

**Files:**
- Create: `packages/hub/__tests__/write-queue-integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `packages/hub/__tests__/write-queue-integration.test.ts`:

```ts
/**
 * Integration tests for hub.writeQueue (#227, M12 Slice 1) — exercised
 * through createNoydb with a gated memory adapter so we can hold a write
 * in flight and observe depth/pending/onFlush deterministically.
 */
import { describe, expect, it } from 'vitest'
import { createNoydb, type Noydb } from '../src/noydb.js'
import { memory } from '../../to-memory/src/index.js'
import type { NoydbStore } from '../src/types.js'

interface Invoice extends Record<string, unknown> {
  id: string
  amount: number
}

/**
 * Wrap a memory store so its `put` blocks on a gate the test controls.
 * memory() returns an object of closures, so spread + override is safe.
 */
function gatedMemory(): {
  store: NoydbStore
  block: () => void
  release: () => void
} {
  const base = memory()
  let gate: Promise<void> = Promise.resolve()
  let open: () => void = () => {}
  return {
    store: {
      ...base,
      async put(...args: Parameters<NoydbStore['put']>) {
        await gate
        return base.put(...args)
      },
    },
    block() {
      gate = new Promise<void>((resolve) => {
        open = resolve
      })
    },
    release() {
      open()
      gate = Promise.resolve()
    },
  }
}

async function setup(store: NoydbStore): Promise<Noydb> {
  return createNoydb({
    store,
    user: 'alice',
    secret: 'write-queue-test-passphrase-1234',
  })
}

describe('hub.writeQueue (#227)', () => {
  it('is idle on a fresh hub', async () => {
    const db = await setup(memory())
    expect(db.writeQueue.pending).toBe(false)
    expect(db.writeQueue.depth).toBe(0)
  })

  it('reports pending while a write is in flight and clears after', async () => {
    const gated = gatedMemory()
    const db = await setup(gated.store)
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices')

    gated.block()
    const writePromise = invoices.put('i1', { id: 'i1', amount: 100 })
    // Let the put reach the gated adapter call.
    await Promise.resolve()
    expect(db.writeQueue.pending).toBe(true)
    expect(db.writeQueue.depth).toBe(1)

    gated.release()
    await writePromise
    expect(db.writeQueue.pending).toBe(false)
    expect(db.writeQueue.depth).toBe(0)
  })

  it('onChange fires as writes start and finish', async () => {
    const gated = gatedMemory()
    const db = await setup(gated.store)
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices')

    const depths: number[] = []
    db.writeQueue.onChange(() => depths.push(db.writeQueue.depth))

    gated.block()
    const p = invoices.put('i1', { id: 'i1', amount: 1 })
    await Promise.resolve()
    gated.release()
    await p

    expect(depths).toContain(1) // saw the rise
    expect(depths[depths.length - 1]).toBe(0) // ended idle
  })

  it('onFlush() resolves once the in-flight write commits', async () => {
    const gated = gatedMemory()
    const db = await setup(gated.store)
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices')

    gated.block()
    const writePromise = invoices.put('i1', { id: 'i1', amount: 100 })
    await Promise.resolve()

    let flushed = false
    const flush = db.writeQueue.onFlush().then(() => { flushed = true })
    expect(flushed).toBe(false)

    gated.release()
    await writePromise
    await flush
    expect(flushed).toBe(true)
  })

  it('aggregates concurrent writes across collections', async () => {
    const gated = gatedMemory()
    const db = await setup(gated.store)
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices')
    const payments = vault.collection<Invoice>('payments')

    gated.block()
    const p1 = invoices.put('i1', { id: 'i1', amount: 1 })
    const p2 = payments.put('p1', { id: 'p1', amount: 2 })
    await Promise.resolve()
    expect(db.writeQueue.depth).toBe(2)

    gated.release()
    await Promise.all([p1, p2])
    expect(db.writeQueue.depth).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/write-queue-integration.test.ts`
Expected: PASS — all 5 tests green.

If the "reports pending" test flakes because the put resolves before the assertion (the gate not yet awaited), increase the settle to two microtask ticks: replace the single `await Promise.resolve()` with `await Promise.resolve(); await Promise.resolve()`. The gate guarantees the adapter `put` cannot complete until `release()`, so depth stays at 1 deterministically.

- [ ] **Step 3: Commit**

```bash
git add packages/hub/__tests__/write-queue-integration.test.ts
git commit -m "test(hub): integration coverage for hub.writeQueue (#227)"
```

---

## Task 6: Register the feature in `features.yaml`

**Files:**
- Modify: `features.yaml`

- [ ] **Step 1: Inspect the schema and an existing core feature entry**

Run: `sed -n '1,80p' features.yaml` and `cat scripts/feature-schema.json`
Note the required fields for a `features[]` entry (id, name, cluster, spec, package, factory, status, showcases, recipes, playground_pages, diagrams, invariants, related) and which are allowed to be empty arrays.

- [ ] **Step 2: Add the feature entry**

Add to the `features:` list in `features.yaml` (match the field set the schema requires; `factory: null` because `writeQueue` is an always-on getter, not a `with*()` strategy):

```yaml
  - id: observable-write-queue
    name: Observable write-queue
    cluster: core
    spec: docs/superpowers/specs/2026-05-31-m12-schema-migration-epic-design.md#5-slice-plan
    package: '@noy-db/hub'
    factory: null
    status: stable
    showcases: []
    recipes: []
    playground_pages: []
    diagrams: []
    invariants:
      - 'hub.writeQueue.pending is true while any Collection.put/delete is in flight'
      - 'onFlush() rejects if a write errored during the wait, never silently resolves'
    related: [vault-and-collections]
```

If `scripts/feature-schema.json` requires a `subsystem_doc` field (the core entries have one), either add `subsystem_doc: docs/superpowers/specs/2026-05-31-m12-schema-migration-epic-design.md` or omit it if the schema marks it optional — let the validator in Step 3 decide.

- [ ] **Step 3: Run the spec-coverage validator**

Run: `node scripts/validate-features.mjs`
Expected: PASS — no dangling references, schema valid. If it reports a missing required field, add it per the error and re-run.

- [ ] **Step 4: Commit**

```bash
git add features.yaml
git commit -m "chore(features): register observable-write-queue (#227)"
```

---

## Task 7: Final verification

- [ ] **Step 1: Full hub test suite**

Run: `cd packages/hub && npx vitest run`
Expected: PASS — entire suite green, including the two new test files.

- [ ] **Step 2: Type-check + lint the hub**

Run: `cd packages/hub && npx tsc --noEmit && npm run lint`
Expected: no type errors, no lint errors in `write-queue.ts`, `noydb.ts`, `collection.ts`.

- [ ] **Step 3: Confirm the public surface**

Run: `grep -n "writeQueue\|WriteQueue" packages/hub/src/index.ts`
Expected: the `export type { WriteQueue }` line is present (Task 2).

- [ ] **Step 4: Confirm clean tree**

Run: `git status`
Expected: clean working tree; all changes committed across Tasks 1–6.

---

## Self-review checklist (already applied)

- **Spec coverage:** §5 Slice 1 API (`pending`, `depth`, `onChange`, `onFlush`) → Tasks 1–4; error-rejects-onFlush semantic → Task 1 tests + Task 5; framework-agnostic (no Vue) → `write-queue.ts` has zero Vue imports; `features.yaml` requirement → Task 6; standalone `beforeunload` value → documented in the `hub.writeQueue` getter example (Task 3).
- **Out-of-scope honesty:** the `TODO(#232-slice2)` note at the `put` wrap marks the untracked write paths the drain barrier must audit before depending on `onFlush()`.
- **Type consistency:** `WriteQueueTracker` (internal) vs `WriteQueue` (public interface) used consistently; `track()`, `begin()`, `settle()`, `onFlush()`, `onChange()` names match across class, tests, and wrappers; `putInternal`/`deleteInternal` private names match their wrappers.
- **No placeholders:** every code step shows complete code; every run step states the exact command and expected result.
