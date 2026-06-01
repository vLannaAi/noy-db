# Track A — Subsystem Gate Bus (Slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a throw-propagating **gate** capability to `SubsystemBus` — `beforePut` / `beforeDelete` lifecycle points dispatched from `putInternal` / `_doDelete` — that can **abort a write**, proving the primitive that write-gating subsystems (guards, periods) will migrate onto in a later slice.

**Architecture:** Slice 1 added an *observe* bus (`afterPut`, errors warned, fires after the write). This slice adds the complementary *gate* half on the **same** `SubsystemBus` instance (already threaded `Noydb→Vault→Collection`, so no new wiring): a separate `GateEventMap`, `registerGate` / `hasGateHandlers` / `dispatchGate`, where `dispatchGate` runs handlers in order, awaited, and **propagates the first throw** (aborting the write) rather than swallowing it. Gate points dispatch at the *top* of the internal write methods (`putInternal` / `_doDelete`) — the exact methods guards/periods run in today — and respect the delete-path `internal` housekeeping bypass.

**Coverage (verified, not broader than guards).** `putInternal` is called only by single `put()`; `_doDelete` by single `delete()` and (with `internal: true`) by system housekeeping. `putManyAtomic` and the transaction executor run their **own** write loop and do NOT call `putInternal`/`_doDelete` — confirmed by the existing TODO at `collection.ts:1108` ("putManyAtomic / tx-execute / CRDT / blob write paths are not yet [hooked]") and `tx/transaction.ts:282` ("`putManyAtomic` runs its own Phase 2 loop"). Therefore guards/periods **already** do not fire on batch/tx writes, and the gate bus is at **exact parity** with their current coverage — it does NOT extend gating to batch/tx paths. Whether batch/tx paths should also gate is a question for slice 3 (the migration), which should add an explicit decision + tests; this slice neither closes nor widens that gap.

**Scope — read before coding.** This slice builds and proves the gate **primitive** only. It does **NOT** migrate guards/periods off their existing `putInternal`/`_doDelete` branches — those blocks stay exactly as they are (the migration is the next slice, `track-a-migrate-gating`). When no gate handler is registered, behavior is byte-identical (zero-cost). The gate event is shaped now against the two real future consumers (guards need `existing`/`userId`/`role`; periods need `existing`/`existingTs`/`incoming`) so the migration won't have to reshape it. The vault facade guards need is **not** in the event — a migrated guard handler closes over `guardSource.readOnlyVault()` at registration time (matching how it gets the facade today).

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Vitest, pnpm. Package `packages/hub`. Hub stays portable (no Node-only imports; `pnpm check:architecture`).

**Not in this slice:** no subsystem migrated; no removal of the existing guard/period blocks; no public export of the bus; no `afterDelete` observe point (separate follow-on). The depth-based re-entrancy field added in slice 1 is the *observe* guard only; gate dispatch deliberately does NOT touch it (gate handlers are read-only validators). A runtime gate re-entrancy guard is deferred to the migration slice — see follow-on (a).

---

## File Structure

- **Modify** `packages/hub/src/subsystem-bus.ts` — add `GateEventMap`, `GatePutEvent`, `GateDeleteEvent`, `GateHandler`, `registerGate`, `hasGateHandlers`, `dispatchGate`. Single file, same class.
- **Create** `packages/hub/__tests__/subsystem-bus-gate.test.ts` — unit tests for gate semantics (throw propagation).
- **Modify** `packages/hub/src/collection.ts` — dispatch `beforePut` near the top of `putInternal` and `beforeDelete` near the top of `_doDelete` (respecting `internal`), each gated by `hasGateHandlers` for zero cost when unused.
- **Create** `packages/hub/__tests__/subsystem-bus-gate-integration.test.ts` — integration tests: a throwing `beforePut` aborts the write (record not persisted); a passing one proceeds; an internal/system delete does not fire `beforeDelete`.

---

### Task 1: Gate primitive on `SubsystemBus`

**Files:**
- Modify: `packages/hub/src/subsystem-bus.ts`
- Test: `packages/hub/__tests__/subsystem-bus-gate.test.ts`

- [ ] **Step 1: Write the failing unit test**

Create `packages/hub/__tests__/subsystem-bus-gate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SubsystemBus } from '../src/subsystem-bus.js'
import type { GatePutEvent } from '../src/subsystem-bus.js'

function putEv(over: Partial<GatePutEvent> = {}): GatePutEvent {
  return {
    op: 'create', vault: 'v', collection: 'c', docId: 'd',
    incoming: { x: 1 }, existing: null, existingVersion: 0, existingTs: undefined,
    userId: 'u', role: 'owner', ...over,
  }
}

describe('SubsystemBus (gate)', () => {
  it('runs gate handlers in registration order', async () => {
    const bus = new SubsystemBus()
    const order: number[] = []
    bus.registerGate('beforePut', () => { order.push(1) })
    bus.registerGate('beforePut', () => { order.push(2) })
    await bus.dispatchGate('beforePut', putEv())
    expect(order).toEqual([1, 2])
  })

  it('hasGateHandlers reflects registration and unsubscribe', () => {
    const bus = new SubsystemBus()
    expect(bus.hasGateHandlers('beforePut')).toBe(false)
    const off = bus.registerGate('beforePut', () => {})
    expect(bus.hasGateHandlers('beforePut')).toBe(true)
    off()
    expect(bus.hasGateHandlers('beforePut')).toBe(false)
  })

  it('PROPAGATES a handler throw and stops subsequent handlers (gate policy)', async () => {
    const bus = new SubsystemBus()
    const ran: string[] = []
    bus.registerGate('beforePut', () => { ran.push('first') })
    bus.registerGate('beforePut', () => { throw new Error('blocked') })
    bus.registerGate('beforePut', () => { ran.push('third') })
    await expect(bus.dispatchGate('beforePut', putEv())).rejects.toThrow('blocked')
    expect(ran).toEqual(['first']) // third never ran — abort is immediate
  })

  it('awaits async gate handlers and propagates async rejection', async () => {
    const bus = new SubsystemBus()
    bus.registerGate('beforePut', async () => {
      await new Promise((r) => setTimeout(r, 5))
      throw new Error('async-blocked')
    })
    await expect(bus.dispatchGate('beforePut', putEv())).rejects.toThrow('async-blocked')
  })

  it('dispatchGate is a no-op when no gate handler is registered', async () => {
    const bus = new SubsystemBus()
    await expect(bus.dispatchGate('beforePut', putEv())).resolves.toBeUndefined()
  })

  it('observe and gate registries are independent', async () => {
    const bus = new SubsystemBus()
    bus.registerGate('beforePut', () => { throw new Error('gate') })
    // an observe afterPut handler is unaffected by gate registration
    expect(bus.hasHandlers('afterPut')).toBe(false)
    expect(bus.hasGateHandlers('beforePut')).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/subsystem-bus-gate.test.ts`
Expected: FAIL — `registerGate`/`dispatchGate`/`GatePutEvent` do not exist.

- [ ] **Step 3: Add the gate primitive to `subsystem-bus.ts`**

In `packages/hub/src/subsystem-bus.ts`, first update the imports and add the gate types after the existing `LifecycleEventMap` block:

```ts
import type { WriteEvent } from './write-hooks.js'
import type { Role } from './types.js'
```

Add these exported types (place them after the `AnyHandler` type alias, before the class):

```ts
/** Payload for a `beforePut` gate — carries the data guards and periods need to validate or reject a write. */
export interface GatePutEvent {
  readonly op: 'create' | 'update'
  readonly vault: string
  readonly collection: string
  readonly docId: string
  /** The record about to be written (post nothing — pre schema-validation). */
  readonly incoming: unknown
  /** Decrypted prior record, or null on create / when prior is unreadable. */
  readonly existing: unknown
  /** Prior envelope version, or 0 when none. */
  readonly existingVersion: number
  /** Prior envelope timestamp (`_ts`), or undefined when none — periods compares against this. */
  readonly existingTs: number | undefined
  readonly userId: string
  readonly role: Role
}

/** Payload for a `beforeDelete` gate. Like {@link GatePutEvent} without `incoming`. */
export interface GateDeleteEvent {
  readonly vault: string
  readonly collection: string
  readonly docId: string
  readonly existing: unknown
  readonly existingVersion: number
  readonly existingTs: number | undefined
  readonly userId: string
  readonly role: Role
}

/** Typed map of GATE lifecycle point → event payload. Extend by adding keys. */
export interface GateEventMap {
  beforePut: GatePutEvent
  beforeDelete: GateDeleteEvent
}

export type GatePoint = keyof GateEventMap
export type GateHandler<P extends GatePoint> = (event: GateEventMap[P]) => void | Promise<void>
```

Add a second handler map field next to `#handlers`:

```ts
  readonly #gateHandlers = new Map<GatePoint, AnyHandler[]>()
```

Add these three methods to the class (after `dispatch`):

```ts
  /** Register a write-gating handler. A throw from the handler ABORTS the write. Returns an unsubscribe fn. */
  registerGate<P extends GatePoint>(point: P, handler: GateHandler<P>): Unsubscribe {
    let arr = this.#gateHandlers.get(point)
    if (!arr) { arr = []; this.#gateHandlers.set(point, arr) }
    arr.push(handler as AnyHandler)
    return () => {
      const a = this.#gateHandlers.get(point)
      if (!a) return
      const i = a.indexOf(handler as AnyHandler)
      if (i >= 0) a.splice(i, 1)
    }
  }

  /** Cheap gate for the write path — true when any gate handler is registered for the point. */
  hasGateHandlers(point: GatePoint): boolean {
    const a = this.#gateHandlers.get(point)
    return a !== undefined && a.length > 0
  }

  /**
   * Run gate handlers in registration order, awaited. Unlike {@link dispatch}
   * (observe), a handler throw is NOT swallowed — it PROPAGATES, aborting the
   * write before it reaches the store. The first throw stops the remaining
   * handlers (fail-fast). This is the seam guards/periods migrate onto.
   */
  async dispatchGate<P extends GatePoint>(point: P, event: GateEventMap[P]): Promise<void> {
    const a = this.#gateHandlers.get(point)
    if (!a || a.length === 0) return
    for (const h of a.slice()) {
      await h(event) // throw propagates → aborts the write
    }
  }
```

> Note: gate dispatch does NOT touch `#depth` (that counter is the observe re-entrancy guard). Gate handlers are validators that read, not write; a gate handler that writes back into the same collection would re-enter `putInternal` and re-dispatch `beforePut`, but since this slice registers gate handlers only in tests (no production consumer yet), loop-suppression for gate handlers is deferred to the migration slice, which will document the contract that gate handlers must not perform writes that re-trigger their own point. Capture this as a one-line comment above `dispatchGate`.

Also update the module-doc's parenthetical so it no longer says the gate bus is "NOT this primitive" — it now lives here. Change the `OBSERVE SEMANTICS` paragraph's final sentence to: "Write-*gating* subsystems use the sibling gate API on this same class (`registerGate`/`dispatchGate`, throw-propagating); see {@link GateEventMap}."

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/subsystem-bus-gate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `cd packages/hub && pnpm typecheck` → clean.

```bash
git add packages/hub/src/subsystem-bus.ts packages/hub/__tests__/subsystem-bus-gate.test.ts
git commit -m "feat(hub): SubsystemBus gate primitive — throw-propagating beforePut/beforeDelete dispatch (Track A slice 2)"
```

---

### Task 2: Dispatch `beforePut` / `beforeDelete` from the internal write methods

**Files:**
- Test: `packages/hub/__tests__/subsystem-bus-gate-integration.test.ts`
- Modify: `packages/hub/src/collection.ts` (`putInternal` ~after the permission check at line 1156; `_doDelete` ~after the permission check at line 1832)

- [ ] **Step 1: Write the failing integration test**

Create `packages/hub/__tests__/subsystem-bus-gate-integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'

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

describe('SubsystemBus gate integration — beforePut/beforeDelete', () => {
  it('a throwing beforePut handler aborts the write (record not persisted)', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const vault = await db.openVault('v1')
    db._subsystemBus.registerGate('beforePut', (e) => {
      if ((e.incoming as { n: number }).n > 10) throw new Error('too big')
    })
    const docs = vault.collection<{ id: string; n: number }>('docs')
    await expect(docs.put('a', { id: 'a', n: 99 })).rejects.toThrow('too big')
    expect(await docs.get('a')).toBeNull() // never persisted
  })

  it('a passing beforePut handler lets the write proceed, with correct event shape', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const vault = await db.openVault('v1')
    const seen: Array<{ op: string; existing: unknown; existingVersion: number }> = []
    db._subsystemBus.registerGate('beforePut', (e) => {
      seen.push({ op: e.op, existing: e.existing, existingVersion: e.existingVersion })
    })
    const docs = vault.collection<{ id: string; n: number }>('docs')
    await docs.put('a', { id: 'a', n: 1 })            // create
    await docs.put('a', { id: 'a', n: 2 })            // update
    // create: no prior — existing is null, version 0.
    expect(seen[0]).toEqual({ op: 'create', existing: null, existingVersion: 0 })
    // update: the prior record is visible; assert the READ happened (existing.n)
    // and that a prior version exists. Use a loose version check rather than a
    // guessed exact number so a TDD failure points at the gate, not an off-by-one.
    expect(seen[1].op).toBe('update')
    expect((seen[1].existing as { n: number }).n).toBe(1)
    expect(seen[1].existingVersion).toBeGreaterThanOrEqual(1)
  })

  it('a throwing beforeDelete handler aborts the delete', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const vault = await db.openVault('v1')
    const docs = vault.collection<{ id: string; n: number }>('docs')
    await docs.put('a', { id: 'a', n: 1 })
    db._subsystemBus.registerGate('beforeDelete', () => { throw new Error('locked') })
    await expect(docs.delete('a')).rejects.toThrow('locked')
    expect(await docs.get('a')).not.toBeNull() // still there
  })

  it('zero-cost: no gate handler → put/delete behave exactly as before', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const vault = await db.openVault('v1')
    const docs = vault.collection<{ id: string; n: number }>('docs')
    await expect(docs.put('a', { id: 'a', n: 1 })).resolves.toBeUndefined()
    await expect(docs.delete('a')).resolves.toBeUndefined()
  })
})
```

> NOTE: confirm the `createNoydb({ store, secret, user })` + `openVault`/`collection` API shape against `__tests__/subsystem-bus-integration.test.ts` (the slice-1 integration test, which already uses this exact shape). The role on a single-owner vault is `'owner'`; if the event's `role` differs in this version, adjust the assertion — the abort/persist assertions are the load-bearing ones.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/subsystem-bus-gate-integration.test.ts`
Expected: FAIL — the gate is not yet dispatched, so the throwing handler never runs and the write is NOT aborted.

- [ ] **Step 3: Dispatch `beforePut` in `putInternal`**

In `packages/hub/src/collection.ts`, in `putInternal`, immediately AFTER the permission check (the `if (!hasWritePermission(this.keyring, this.name)) { throw new ReadOnlyError() }` block ending at line 1156) and BEFORE the existing guard block at line 1164, insert:

```ts
    // Gate bus (Track A) — write-gating subsystems can abort here, before any
    // guard/period/schema/i18n/history work, at the same altitude guards run.
    // A throwing gate handler propagates and aborts the write. Zero-cost when
    // no gate handler is registered. The existing guard/period blocks below are
    // NOT yet migrated onto this seam — that is a later slice.
    if (this.subsystemBus?.hasGateHandlers('beforePut')) {
      const existingEnv = await this.adapter.get(this.vault, this.name, id)
      let existingRecord: unknown = null
      if (existingEnv) {
        try {
          existingRecord = await this.decryptRecord(existingEnv, { skipValidation: true })
        } catch {
          existingRecord = null
        }
      }
      await this.subsystemBus.dispatchGate('beforePut', {
        op: existingEnv ? 'update' : 'create',
        vault: this.vault, collection: this.name, docId: id,
        incoming: record,
        existing: existingRecord,
        existingVersion: existingEnv?._v ?? 0,
        existingTs: existingEnv?._ts,
        userId: this.keyring.userId,
        role: this.keyring.role,
      })
    }
```

> The `_v` / `_ts` field names and `decryptRecord(env, { skipValidation: true })` signature are taken from the existing guard/period blocks at lines 1168-1185 / 1214-1222 — match them exactly. `this.keyring.role` / `this.keyring.userId` are used identically in those blocks.

- [ ] **Step 4: Dispatch `beforeDelete` in `_doDelete`**

In `packages/hub/src/collection.ts`, in `_doDelete`, immediately AFTER its permission check (the `if (!hasWritePermission(...)) { throw new ReadOnlyError() }` ending at line 1832) and BEFORE the guard block at line 1850, insert — note the `!internal` guard so system housekeeping deletes bypass the gate exactly as they bypass guards/periods:

```ts
    // Gate bus (Track A) — symmetric to putInternal. Skipped for internal
    // (system housekeeping) deletes, matching the guard/period bypass below.
    if (!internal && this.subsystemBus?.hasGateHandlers('beforeDelete')) {
      const existingEnv = await this.adapter.get(this.vault, this.name, id)
      if (existingEnv) {
        let existingRecord: unknown = null
        try {
          existingRecord = await this.decryptRecord(existingEnv, { skipValidation: true })
        } catch {
          existingRecord = null
        }
        await this.subsystemBus.dispatchGate('beforeDelete', {
          vault: this.vault, collection: this.name, docId: id,
          existing: existingRecord,
          existingVersion: existingEnv._v,
          existingTs: existingEnv._ts,
          userId: this.keyring.userId,
          role: this.keyring.role,
        })
      }
    }
```

> Delete-of-absent (existingEnv null) does not fire the gate — matching the guard block's "delete-of-absent is a no-op" contract at lines 1838-1840.

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/subsystem-bus-gate-integration.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Full suite + typecheck + architecture check**

Run: `cd packages/hub && pnpm typecheck && pnpm vitest run && cd ../.. && pnpm check:architecture`
Expected: typecheck clean; ALL hub tests green (no gate handler registered in existing tests → behavior unchanged); architecture invariants OK.

- [ ] **Step 7: Commit**

```bash
git add packages/hub/src/collection.ts packages/hub/__tests__/subsystem-bus-gate-integration.test.ts
git commit -m "feat(hub): dispatch beforePut/beforeDelete gate points from internal write paths (Track A slice 2)"
```

---

## Self-Review

**Spec coverage:**
- Gate primitive with throw-propagation → Task 1 (`registerGate`/`hasGateHandlers`/`dispatchGate`). ✅
- Dispatched at `putInternal`/`_doDelete` altitude — covers single `put`/`delete` (parity with guards); `putManyAtomic`/tx are NOT covered (see the Coverage section — guards don't cover them either); respects the delete `internal` bypass → Task 2. ✅
- Event shaped against real consumers (guards: existing/userId/role; periods: existing/existingTs/incoming) → `GatePutEvent`/`GateDeleteEvent`. ✅
- No subsystem migrated; existing guard/period blocks untouched; behavior-identical when no gate handler → Tasks state this; Task 2 Step 6 runs full suite. ✅
- Zero-cost path (read+event only when `hasGateHandlers`) → both insertions gated. ✅

**Placeholder scan:** none. The two NOTEs are concrete verification instructions with fallbacks. ✅

**Type consistency:** `registerGate`/`hasGateHandlers`/`dispatchGate`/`GatePutEvent`/`GateDeleteEvent`/`GateEventMap`/`GatePoint`/`GateHandler` used identically across Tasks 1–2. Field names (`_v`, `_ts`, `op`, `existing`, `existingVersion`, `existingTs`) consistent between the event types and the dispatch sites. `Role` imported from `./types.js`. ✅

---

## Follow-on (after this slice)

1. **`track-a-migrate-gating`** — move periods (`assertTsWritable`) and guards (record-lock/field-freeze/onDelete/amendment) onto `beforePut`/`beforeDelete`; remove the hard-coded `putInternal`/`_doDelete` branches; full showcase suite as the net. **MUST include** (deferred from slice 2, do not lose): (a) **first verify** whether any migrating guard-family behavior (record-lock / field-freeze / **onDelete** / **amendment**) writes back into the write path; if so, add a **runtime** gate re-entrancy guard to `dispatchGate` (a depth counter symmetric to the observe `#depth`, read by the write-path gate) — a prose-only "handlers must not re-trigger their point" contract is NOT sufficient once a write-back consumer is wired, or it infinite-loops silently; (b) an explicit decision + tests on whether batch (`putManyAtomic`) / tx writes should also gate, since neither guards nor the gate bus cover them today; (c) **collapse the duplicate prior-envelope reads** — once guards/periods move onto the gate, `putInternal` should do ONE `adapter.get`+decrypt of the prior record and pass it through the gate event, instead of today's pattern where the gate block, the guard block, and the period block each read independently (a 3-read TOCTOU window where a concurrent tab can advance the envelope between reads).
2. **`track-a-afterdelete`** — add the `afterDelete` observe point (symmetry with `afterPut`) for the inspector/audit.
3. Remaining Track A: keyring→team split, lazy→subsystem split, kernel-surface CI gate, public surface decision.
