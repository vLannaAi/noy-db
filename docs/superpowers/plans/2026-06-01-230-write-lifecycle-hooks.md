# Write Lifecycle Hooks (#230) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add hub-level `db.onBeforeWrite` / `db.onAfterWrite` lifecycle hooks that fire a `WriteEvent` around every `put`/`delete`, with `beforeWrite` able to abort and `afterWrite` awaited.

**Architecture:** A small `WriteHookRegistry` (mirrors `NoydbEventEmitter`) lives on `Noydb`, exposed via `db.onBeforeWrite`/`db.onAfterWrite` and threaded into each `Collection`. Hooks fire at the **public `Collection.put`/`delete` wrapper** (one uniform chokepoint covering CRDT/normal/delete branches): read the prior record for `before`/`op`, run before-hooks (throw → abort), do the write, run after-hooks (awaited; error → warning). A re-entrancy flag suppresses nested firing so a handler that writes can't loop. `txId` comes from the active `TxContext` (new ULID field) or a fresh ULID.

**Tech Stack:** TypeScript, Vitest, `@noy-db/to-memory`. Package: `packages/hub`. `generateULID` from `./bundle/ulid.js`.

**Spec:** `docs/superpowers/specs/2026-06-01-write-lifecycle-hooks-design.md`. Issue #230. Own PR through CI.

---

## File structure

- **Create** `packages/hub/src/write-hooks.ts` — `WriteHookRegistry` + `WriteHook`/`WriteEvent` types.
- **Modify** `packages/hub/src/tx/transaction.ts` — add `readonly txId` (ULID) to `TxContext`.
- **Modify** `packages/hub/src/noydb.ts` — hold the registry; `db.onBeforeWrite`/`onAfterWrite`; internal accessor.
- **Modify** `packages/hub/src/vault.ts` — thread the registry into `collOpts`.
- **Modify** `packages/hub/src/collection.ts` — accept the registry; fire hooks in the `put`/`delete` wrappers; a `#readPriorRecord` helper.
- **Modify** `packages/hub/src/index.ts` — export `WriteEvent`/`WriteHook`.
- **Create** tests: `write-hooks.test.ts` (unit), `write-hooks-integration.test.ts` (E2E).

---

## Task 1: `WriteHookRegistry` + types

**Files:** Create `packages/hub/src/write-hooks.ts`; Test `packages/hub/__tests__/write-hooks.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { WriteHookRegistry, type WriteEvent } from '../src/write-hooks.js'

const evt = (over: Partial<WriteEvent> = {}): WriteEvent => ({
  op: 'create', collection: 'invoices', docId: 'i1',
  before: null, after: { id: 'i1' }, userId: 'u', timestamp: 0, txId: 't', ...over,
})

describe('WriteHookRegistry', () => {
  it('runBefore is a no-op with no handlers', async () => {
    const r = new WriteHookRegistry()
    await expect(r.runBefore(evt())).resolves.toBeUndefined()
    expect(r.hasHandlers).toBe(false)
  })

  it('fires before-handlers in registration order; unsubscribe removes them', async () => {
    const r = new WriteHookRegistry()
    const seen: number[] = []
    const off1 = r.onBeforeWrite(() => { seen.push(1) })
    r.onBeforeWrite(() => { seen.push(2) })
    await r.runBefore(evt())
    expect(seen).toEqual([1, 2])
    off1()
    await r.runBefore(evt())
    expect(seen).toEqual([1, 2, 2])
  })

  it('a throwing before-handler propagates and short-circuits the rest', async () => {
    const r = new WriteHookRegistry()
    const second = vi.fn()
    r.onBeforeWrite(() => { throw new Error('veto') })
    r.onBeforeWrite(second)
    await expect(r.runBefore(evt())).rejects.toThrow('veto')
    expect(second).not.toHaveBeenCalled()
  })

  it('after-handler errors are swallowed (warned), not thrown', async () => {
    const r = new WriteHookRegistry()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    r.onAfterWrite(() => { throw new Error('boom') })
    const ran = vi.fn()
    r.onAfterWrite(ran)
    await expect(r.runAfter(evt())).resolves.toBeUndefined()
    expect(ran).toHaveBeenCalledOnce() // a throwing handler does not block the others
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('suppressed during handler execution (re-entrancy guard)', async () => {
    const r = new WriteHookRegistry()
    let seenWhileRunning: boolean | undefined
    r.onBeforeWrite(() => { seenWhileRunning = r.suppressed })
    expect(r.suppressed).toBe(false)
    await r.runBefore(evt())
    expect(seenWhileRunning).toBe(true)
    expect(r.suppressed).toBe(false) // cleared afterward
  })

  it('suppressed is cleared even when a before-handler throws', async () => {
    const r = new WriteHookRegistry()
    r.onBeforeWrite(() => { throw new Error('x') })
    await expect(r.runBefore(evt())).rejects.toThrow('x')
    expect(r.suppressed).toBe(false)
  })
})
```

- [ ] **Step 2: Run → fail** (`cd packages/hub && npx vitest run __tests__/write-hooks.test.ts`)

- [ ] **Step 3: Implement** `write-hooks.ts`

```ts
/**
 * Hub-level write lifecycle hooks (#230). `onBeforeWrite` may abort (throw);
 * `onAfterWrite` is awaited and its errors are warned, not thrown. A
 * re-entrancy flag suppresses nested firing so a handler that writes can't
 * loop. Held on the Noydb instance, threaded into every Collection.
 */
export interface WriteEvent {
  readonly op: 'create' | 'update' | 'delete'
  readonly collection: string
  readonly docId: string
  readonly before: unknown | null
  readonly after: unknown | null
  readonly userId: string
  readonly timestamp: number
  readonly txId: string
}

export type WriteHook = (event: WriteEvent) => void | Promise<void>
export type Unsubscribe = () => void

export class WriteHookRegistry {
  readonly #before: WriteHook[] = []
  readonly #after: WriteHook[] = []
  #suppressed = false

  /** True while handlers are running — used by the write path to skip nested firing. */
  get suppressed(): boolean { return this.#suppressed }

  /** True when any hook is registered (cheap gate for the write path). */
  get hasHandlers(): boolean { return this.#before.length > 0 || this.#after.length > 0 }

  onBeforeWrite(handler: WriteHook): Unsubscribe {
    this.#before.push(handler)
    return () => { const i = this.#before.indexOf(handler); if (i >= 0) this.#before.splice(i, 1) }
  }

  onAfterWrite(handler: WriteHook): Unsubscribe {
    this.#after.push(handler)
    return () => { const i = this.#after.indexOf(handler); if (i >= 0) this.#after.splice(i, 1) }
  }

  /** Run before-hooks (awaited, in order). A throw propagates and aborts the write. */
  async runBefore(event: WriteEvent): Promise<void> {
    if (this.#before.length === 0) return
    this.#suppressed = true
    try {
      for (const h of this.#before.slice()) await h(event)
    } finally {
      this.#suppressed = false
    }
  }

  /** Run after-hooks (awaited, in order). Per-handler errors are warned, not thrown. */
  async runAfter(event: WriteEvent): Promise<void> {
    if (this.#after.length === 0) return
    this.#suppressed = true
    try {
      for (const h of this.#after.slice()) {
        try { await h(event) } catch (err) {
          console.warn(
            `[noy-db] onAfterWrite handler failed for ${event.collection}/${event.docId}: ` +
            (err instanceof Error ? err.message : String(err)),
          )
        }
      }
    } finally {
      this.#suppressed = false
    }
  }
}
```

- [ ] **Step 4: Run → pass; commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/write-hooks.ts packages/hub/__tests__/write-hooks.test.ts
git commit -m "feat(hub): WriteHookRegistry + WriteEvent (#230)"
```

---

## Task 2: `TxContext.txId`

**Files:** Modify `packages/hub/src/tx/transaction.ts`; Test `packages/hub/__tests__/tx-txid.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { memory } from '../../to-memory/src/index.js'

describe('TxContext.txId', () => {
  it('each transaction gets a distinct non-empty txId exposed on the tx handle', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'txid-pass-1234' })
    const id1 = await db.transaction((tx) => (tx as unknown as { txId: string }).txId)
    const id2 = await db.transaction((tx) => (tx as unknown as { txId: string }).txId)
    expect(typeof id1).toBe('string')
    expect(id1.length).toBeGreaterThan(0)
    expect(id1).not.toBe(id2)
  })
})
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement** — in `transaction.ts`, add a `txId` field to `TxContext`. Confirm the import (`grep -n "generateULID" packages/hub/src/tx/transaction.ts`; if absent, add `import { generateULID } from '../bundle/ulid.js'`). In the class body add:

```ts
  /** Stable id for this transaction; shared by all writes it performs (#230). */
  readonly txId: string = generateULID()
```

- [ ] **Step 4: Run → pass; typecheck; commit**

```bash
cd /Users/vicio/_github/noy-db/packages/hub && npx vitest run __tests__/tx-txid.test.ts && npx tsc --noEmit
cd /Users/vicio/_github/noy-db && git add packages/hub/src/tx/transaction.ts packages/hub/__tests__/tx-txid.test.ts
git commit -m "feat(hub): TxContext.txId for grouping writes (#230)"
```

---

## Task 3: Registry on Noydb + public `onBeforeWrite`/`onAfterWrite`

**Files:** Modify `packages/hub/src/noydb.ts`

- [ ] **Step 1: Import + field**

In `noydb.ts`, add the import:
```ts
import { WriteHookRegistry } from './write-hooks.js'
```
Add the field beside `writeQueueTracker`:
```ts
  private readonly writeHooks = new WriteHookRegistry()
```

- [ ] **Step 2: Public API + internal accessor**

In the Events section (next to `get writeQueue()`), add:
```ts
  /**
   * Register a hook that runs before each write (#230). Awaited; a throw
   * aborts the write. Returns an unsubscribe function.
   */
  onBeforeWrite(handler: import('./write-hooks.js').WriteHook): import('./write-hooks.js').Unsubscribe {
    return this.writeHooks.onBeforeWrite(handler)
  }

  /**
   * Register a hook that runs after each committed write (#230). Awaited;
   * a handler error is warned, never rolled back. Returns an unsubscribe fn.
   */
  onAfterWrite(handler: import('./write-hooks.js').WriteHook): import('./write-hooks.js').Unsubscribe {
    return this.writeHooks.onAfterWrite(handler)
  }

  /** @internal The write-hook registry, threaded into each Collection. */
  get _writeHooks(): WriteHookRegistry { return this.writeHooks }
```

- [ ] **Step 3: Typecheck (will fail until Task 4 — Collection opt). Do not commit yet.**

Run: `cd packages/hub && npx tsc --noEmit`
Expected: clean for `noydb.ts` itself; the wiring in Task 4 consumes `_writeHooks`. Proceed to Task 4 and commit 3+4 together.

---

## Task 4: Thread into Vault + fire hooks in Collection

**Files:** Modify `packages/hub/src/vault.ts`, `packages/hub/src/collection.ts`

- [ ] **Step 1: Thread the registry into `collOpts`** (vault.ts, beside `writeQueue:`):

```ts
        writeHooks: this.noydb._writeHooks,
```

- [ ] **Step 2: Collection — import + opt + field + assignment**

Import:
```ts
import type { WriteHookRegistry, WriteEvent } from './write-hooks.js'
```
Constructor opts (beside `schemaFence?`):
```ts
    /** #230 — hub-level write-hook registry; fired around put/delete. */
    writeHooks?: WriteHookRegistry | undefined
```
Field + assignment (beside `schemaFence`):
```ts
  private readonly writeHooks: WriteHookRegistry | undefined
```
```ts
    this.writeHooks = opts.writeHooks
```

- [ ] **Step 3: Add the prior-record helper + event builder** (private methods on Collection):

```ts
  /** @internal #230 — read + decrypt the current record for a hook's `before`, or null. */
  async #priorRecordForHook(id: string): Promise<unknown | null> {
    const env = await this.adapter.get(this.vault, this.name, id)
    if (!env) return null
    return this.decryptRecord(env, { skipValidation: true }) as unknown
  }

  /** @internal #230 — true when hooks should fire for this write (handlers exist, not re-entrant). */
  #hooksActive(): boolean {
    return this.writeHooks !== undefined && this.writeHooks.hasHandlers && !this.writeHooks.suppressed
  }

  #txId(): string {
    return this.noydb._activeTxContextOrNull?.txId ?? generateULID()
  }
```
(Confirm `generateULID` is imported in collection.ts — `grep -n "generateULID" packages/hub/src/collection.ts` shows it is, from `./bundle/ulid.js`. Confirm `this.noydb` exists on Collection — `grep -n "this.noydb\|noydb:" packages/hub/src/collection.ts`; if Collection lacks a `noydb` ref, thread `activeTxId?: () => string | null` via opts from the vault instead and use that. Resolve at implementation time.)

- [ ] **Step 4: Fire hooks in the public `put` wrapper**

Replace the `put` wrapper body so hooks bracket the tracked write:

```ts
  async put(id: string, record: T, options?: { readonly reason?: string }): Promise<void> {
    await this.schemaUpdateGate?.assertWritable() // #245
    await this.schemaFence?.assertWritable(this.name) // #232
    // TODO(#230-followup): putManyAtomic / tx-execute / CRDT-merge / blob paths are not hooked yet.
    let event: WriteEvent | undefined
    if (this.#hooksActive()) {
      const before = await this.#priorRecordForHook(id)
      event = {
        op: before === null ? 'create' : 'update',
        collection: this.name, docId: id, before, after: record,
        userId: this.keyring.userId, timestamp: Date.now(), txId: this.#txId(),
      }
      await this.writeHooks!.runBefore(event) // throw → aborts the write
    }
    if (this.writeQueue) await this.writeQueue.track(() => this.putInternal(id, record, options))
    else await this.putInternal(id, record, options)
    if (event) await this.writeHooks!.runAfter(event)
  }
```

- [ ] **Step 5: Fire hooks in the public `delete` wrapper**

```ts
  async delete(id: string): Promise<void> {
    await this.schemaUpdateGate?.assertWritable() // #245
    await this.schemaFence?.assertWritable(this.name) // #232
    let event: WriteEvent | undefined
    if (this.#hooksActive()) {
      const before = await this.#priorRecordForHook(id)
      event = {
        op: 'delete', collection: this.name, docId: id, before, after: null,
        userId: this.keyring.userId, timestamp: Date.now(), txId: this.#txId(),
      }
      await this.writeHooks!.runBefore(event)
    }
    if (this.writeQueue) await this.writeQueue.track(() => this.deleteInternal(id))
    else await this.deleteInternal(id)
    if (event) await this.writeHooks!.runAfter(event)
  }
```

- [ ] **Step 6: Typecheck + run touched suites**

Run: `cd packages/hub && npx tsc --noEmit && npx vitest run __tests__/write-hooks.test.ts __tests__/write-queue.test.ts __tests__/write-queue-integration.test.ts __tests__/schema-update/`
Expected: PASS (the gate/fence/queue ordering is unchanged; hooks bracket them).

- [ ] **Step 7: Commit Tasks 3 + 4**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/noydb.ts packages/hub/src/vault.ts packages/hub/src/collection.ts
git commit -m "feat(hub): fire onBeforeWrite/onAfterWrite around put/delete (#230)"
```

---

## Task 5: Export public types

**Files:** Modify `packages/hub/src/index.ts`

- [ ] **Step 1: Add the export** (near the WriteQueue export):
```ts
// Write lifecycle hooks (#230)
export type { WriteEvent, WriteHook } from './write-hooks.js'
```

- [ ] **Step 2: Typecheck + commit**

```bash
cd /Users/vicio/_github/noy-db/packages/hub && npx tsc --noEmit
cd /Users/vicio/_github/noy-db && git add packages/hub/src/index.ts
git commit -m "feat(hub): export WriteEvent/WriteHook (#230)"
```

---

## Task 6: Integration tests + features.yaml + final verify

**Files:** Create `packages/hub/__tests__/write-hooks-integration.test.ts`; Modify `features.yaml`

- [ ] **Step 1: Write the E2E test**

```ts
/** E2E for hub write lifecycle hooks (#230). */
import { describe, expect, it } from 'vitest'
import { createNoydb, type Noydb, type WriteEvent } from '../src/noydb.js'
import { memory } from '../../to-memory/src/index.js'

interface Inv extends Record<string, unknown> { id: string; amount: number }

async function setup(): Promise<Noydb> {
  return createNoydb({ store: memory(), user: 'alice', secret: 'write-hooks-pass-1234' })
}

describe('write lifecycle hooks (#230)', () => {
  it('onBeforeWrite sees create then update; onAfterWrite fires post-commit', async () => {
    const db = await setup()
    const v = await db.openVault('demo')
    const c = v.collection<Inv>('invoices')
    const events: WriteEvent[] = []
    db.onBeforeWrite((e) => { events.push(e) })

    await c.put('i1', { id: 'i1', amount: 1 })
    await c.put('i1', { id: 'i1', amount: 2 })

    expect(events.map(e => e.op)).toEqual(['create', 'update'])
    expect(events[0]!.before).toBeNull()
    expect(events[1]!.before).toMatchObject({ amount: 1 })
    expect(events[1]!.after).toMatchObject({ amount: 2 })
    expect(events[0]!.userId).toBe('alice')
  })

  it('a throwing onBeforeWrite aborts the write', async () => {
    const db = await setup()
    const v = await db.openVault('demo')
    const c = v.collection<Inv>('invoices')
    db.onBeforeWrite(() => { throw new Error('veto') })
    await expect(c.put('i1', { id: 'i1', amount: 1 })).rejects.toThrow('veto')
    expect(await c.get('i1')).toBeNull() // not written
  })

  it('onAfterWrite is awaited and an afterWrite that writes does not recurse', async () => {
    const db = await setup()
    const v = await db.openVault('demo')
    const c = v.collection<Inv>('invoices')
    const audit = v.collection<{ id: string; op: string }>('_audit')
    let afterCalls = 0
    db.onAfterWrite(async (e) => {
      afterCalls++
      if (e.collection !== '_audit') {
        await audit.put(`log-${e.docId}`, { id: `log-${e.docId}`, op: e.op }) // nested write: must NOT re-fire
      }
    })
    await c.put('i1', { id: 'i1', amount: 1 })
    expect(afterCalls).toBe(1) // the nested _audit write did not re-trigger the hook
    expect((await audit.get('log-i1'))?.op).toBe('create')
  })

  it('delete fires op:delete with before set, after null', async () => {
    const db = await setup()
    const v = await db.openVault('demo')
    const c = v.collection<Inv>('invoices')
    await c.put('i1', { id: 'i1', amount: 9 })
    const events: WriteEvent[] = []
    db.onAfterWrite((e) => { events.push(e) })
    await c.delete('i1')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ op: 'delete', after: null })
    expect(events[0]!.before).toMatchObject({ amount: 9 })
  })

  it('txId is shared within one transaction and distinct across standalone writes', async () => {
    const db = await setup()
    const v = await db.openVault('demo')
    const c = v.collection<Inv>('invoices')
    const ids: string[] = []
    db.onAfterWrite((e) => { ids.push(e.txId) })

    await db.transaction(async (tx) => {
      await tx.collection<Inv>('demo', 'invoices').put('a', { id: 'a', amount: 1 })
      await tx.collection<Inv>('demo', 'invoices').put('b', { id: 'b', amount: 2 })
    })
    await c.put('c', { id: 'c', amount: 3 })

    expect(ids).toHaveLength(3)
    expect(ids[0]).toBe(ids[1])       // same transaction → same txId
    expect(ids[2]).not.toBe(ids[0])   // standalone write → different txId
  })
})
```

Note: confirm the in-transaction collection-write API (`grep -n "collection" packages/hub/src/tx/transaction.ts`) — the `tx` handle's collection accessor signature may be `tx.collection(name)` (vault implied) rather than `tx.collection(vault, name)`. Adjust the transaction test's write calls to the real `TxContext` API; the assertion (shared vs distinct `txId`) is what matters. If the tx write path bypasses the public `Collection.put` wrapper (raw execute), the hook may not fire inside `transaction()` — if so, this `txId`-grouping test moves to documenting that transaction-execute hooking is part of the `TODO(#230-followup)` scope, and the standalone-write `txId` is still asserted. Resolve against the real tx execute path at implementation time.

- [ ] **Step 2: Run → pass** (`cd packages/hub && npx vitest run __tests__/write-hooks-integration.test.ts`)

- [ ] **Step 3: Register in features.yaml** — add a feature entry (mirror `observable-write-queue`'s shape):

```yaml
  - id: write-lifecycle-hooks
    name: Write lifecycle hooks
    cluster: core
    spec: docs/superpowers/specs/2026-06-01-write-lifecycle-hooks-design.md
    subsystem_doc: docs/superpowers/specs/2026-06-01-write-lifecycle-hooks-design.md
    package: '@noy-db/hub'
    factory: null
    status: preview
    showcases: []
    recipes: []
    playground_pages: []
    diagrams: []
    invariants:
      - 'onBeforeWrite is awaited; a throw aborts the write (no adapter write, no ledger entry)'
      - 'onAfterWrite is awaited; a handler error is warned, never rolled back'
      - 'writes performed inside a hook do not re-fire the hooks (re-entrancy guard)'
    related: [vault-and-collections, observable-write-queue]
```
(If the `spec`/`subsystem_doc` validator requires an anchor or rejects a non-`docs/subsystems` path, run the validator and adjust; the existing `observable-write-queue` entry points at a `docs/superpowers/specs/...md#anchor` and validates, so this shape is known-good.)

- [ ] **Step 4: Validate + full verify**

```bash
cd /Users/vicio/_github/noy-db && node scripts/validate-features.mjs
cd packages/hub && npx vitest run && npx tsc --noEmit && npm run lint
```
Expected: validator PASS; full suite PASS; typecheck + lint clean.

- [ ] **Step 5: Commit + clean tree**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/__tests__/write-hooks-integration.test.ts features.yaml
git commit -m "test(hub): E2E write hooks; chore(features): register write-lifecycle-hooks (#230)"
git status
```

---

## Self-review checklist (already applied)

- **Spec coverage:** `onBeforeWrite`/`onAfterWrite` + `WriteEvent` → Tasks 1,3,4; awaited semantics + before-throw-aborts + after-error-warns → Tasks 1,4 + E2E; `op`/`before`/`after`/`userId`/`timestamp`/`txId` → Task 4 builder + Task 2; re-entrancy guard → Task 1 (`suppressed`) + Task 4 (`#hooksActive`) + E2E test 3; hub-level registration → Task 3; cheap no-handler gate → `hasHandlers`/`#hooksActive`; export → Task 5; features.yaml → Task 6.
- **Type consistency:** `WriteHookRegistry`/`WriteHook`/`WriteEvent`/`Unsubscribe`, `runBefore`/`runAfter`/`suppressed`/`hasHandlers`, `_writeHooks`, `writeHooks` opt, `#hooksActive`/`#priorRecordForHook`/`#txId` — consistent across tasks.
- **Verify-before-trust flags:** Task 4 confirms `this.noydb` ref + `generateULID` import on Collection; Task 6 confirms the `tx.collection(...)` API and whether `transaction()` execute fires the public `put` wrapper (if not, transaction-hooking is `TODO(#230-followup)` and the test adapts). These are real lookups.
- **Out-of-scope honesty:** `TODO(#230-followup)` at the `put` wrapper marks `putManyAtomic`/tx-execute/CRDT-merge/blob paths, consistent with #227's boundary.
- **Existing-suite safety:** with no hooks registered, `#hooksActive()` is false → zero extra reads, no behaviour change → the existing suite is untouched.
- **No placeholders:** every code step shows complete code; every run step states command + expected result.
