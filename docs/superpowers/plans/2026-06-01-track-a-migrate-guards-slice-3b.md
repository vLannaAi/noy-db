# Track A — Migrate Guards onto the Gate Bus (Slice 3b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the guards subsystem (record-lock / field-freeze / `onDelete` / amendment-collect) off the per-`Collection` `guardSource` callback (+ the inline `putInternal`/`_doDelete` guard blocks) onto the `beforePut`/`beforeDelete` gate bus, registered once per `Noydb` when `guardStrategies` is opted in — resolving the live vault's `GuardRegistry` per dispatch (same pattern as periods, slice 3a).

**Architecture:** A guard gate handler pair is registered on the per-`Noydb` `SubsystemBus` iff `guardStrategies` was supplied. Each handler resolves the live vault (`vaultCache.get(e.vault)`), reads its `GuardRegistry` via `_getGuardRegistry()` (null → return) and `ReadOnlyVaultFacade` via `_getReadOnlyFacade()`, and reproduces the kernel block's two-mode logic: **amendment-active** → `registry.collectChange(...)` (a stateful side-effect, no throw); **normal** → `runChecks` + `GuardExecutor.checkFrozenFields` on put / `runOnDelete` on delete (throws to abort). The guard handler is registered **before** the period handler so guard checks run first — restoring the guard-before-period order that slice 3a temporarily flipped.

**Two structural facts that shape this slice:**
1. **Amendment-collect is a side-effect, so register+remove must be ATOMIC.** Unlike periods (`assertTsWritable` is a pure check, safe to run twice), running `collectChange` at both the gate handler AND the still-present kernel block during an amendment would double-collect changes. Therefore Task 2 registers the gate handler AND removes the kernel guard blocks in a single commit — there is no "additive, redundant" intermediate. The existing comprehensive guard + amendment test suite is the safety net; full-suite-green after the atomic swap is the proof.
2. **The delete gate must fire for INTERNAL deletes.** The kernel `_doDelete` guard block runs `collectChange` for system-internal (housekeeping) deletes too — so an amendment invariant sees a derivation/MV tombstone fired mid-amendment. But slice 2's `beforeDelete` gate only dispatches when `!internal`. Task 1 evolves the gate `beforeDelete` to fire for **all** deletes carrying a new `internal: boolean` flag; handlers branch on it (period skips internal; guard collects always but runs `onDelete` only when `!internal`). No internal delete is ever *aborted* (collect doesn't throw; onDelete/period are skipped) — behavior is preserved, just relocated.

**Verified guard-invocation call sites (the safety-net is valid):** A full sweep (`grep -rn "collectChange|isAmendmentActive|runChecks|runOnDelete|checkFrozenFields|consumeChanges"`) confirms:
- Per-write guard logic (`collectChange`/`runChecks`/`runOnDelete`/`checkFrozenFields`) lives ONLY in `collection.ts` `putInternal`/`_doDelete` — the two blocks this slice migrates. `putManyAtomic`/tx-executor do NOT invoke per-write guard logic (consistent with periods). So amendment-`collectChange` fires only through the migrated methods → the amendment/transaction suite genuinely exercises the gate handler after the swap.
- `tx/transaction.ts` holds the amendment LIFECYCLE only (`beginAmendment` to open the window, `consumeChanges`/`consumeMeta` to drain + run invariants at commit) — not per-write collection. Untouched by this slice.
- **`tx/dry-run.ts` is a THIRD, independent guard path** (`runChecks` + `checkFrozenFields`, dry-run.ts:82-85). It resolves the registry directly via `v._getGuardRegistry()` + `v._getReadOnlyFacade()` (NOT via `Collection.guardSource`), so removing `guardSource` does NOT affect it. **Do NOT touch dry-run.ts** — it stays in sync through the unchanged registry API, and its existing `{ existing, vault: facade, userId, role }` ctx shape is the proven template the gate handler mirrors.

**One real behavior change (document, do not block):** The kernel guard block gated its `adapter.get`+decrypt behind `guards.length > 0` (collection.ts:1187) — a collection with no guards skipped the prior read. The gate dispatches whenever `hasGateHandlers('beforePut')` is true (any guard registered on the Noydb), builds the event (read+decrypt), and the handler then checks `guardsFor` and returns. So in a guards-enabled vault, a write to a collection that has NO guards now pays one encrypted prior read it previously skipped. Not a correctness issue and no test will fail; periods (3a) didn't have this because its kernel callback was unconditional. Note it; the clean fix (a lazy `existing`/`existingTs` thunk on the gate event, read only if a handler touches it) is a separate follow-on, out of scope for 3b.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Vitest, pnpm. Package `packages/hub`. Hub portable; `pnpm check:architecture` must pass.

**Scope:** guards only (periods already migrated in 3a). No public API change. Builds on slices 1/2/3a (stacked branch).

---

## File Structure

- **Modify** `packages/hub/src/subsystem-bus.ts` — add `readonly internal: boolean` to `GateDeleteEvent`.
- **Modify** `packages/hub/src/collection.ts` — `_doDelete` gate dispatch fires for all deletes (drop the `!internal` precondition), passing `internal`; (Task 2) remove the `guardSource` field/ctor-opt/assignment and the two inline guard blocks.
- **Modify** `packages/hub/src/noydb.ts` — period `beforeDelete` handler early-returns on `e.internal` (Task 1); add `#registerGuardGate()` called before `#registerPeriodGate()` (Task 2).
- **Modify** `packages/hub/src/vault.ts` — (Task 2) remove the `guardSource:` wiring passed to `Collection`.
- **Modify** `packages/hub/__tests__/subsystem-bus-gate.test.ts` — `deleteEv` fixture gains `internal: false`.
- **Modify** `packages/hub/__tests__/subsystem-bus-gate-integration.test.ts` — rewrite the "beforeDelete does not fire for internal" test to the new contract (it fires with `internal: true`; a handler branching on `!e.internal` does not abort).
- **Create** `packages/hub/__tests__/guards-gate-migration.test.ts` — guard enforcement via the gate (lock/freeze/onDelete/amendment) + zero-cost registration check.

---

### Task 1: Evolve gate `beforeDelete` to fire for internal deletes (behavior-preserving)

**Files:** `subsystem-bus.ts`, `collection.ts` (_doDelete dispatch only), `noydb.ts` (period handler), `subsystem-bus-gate.test.ts`, `subsystem-bus-gate-integration.test.ts`.

- [ ] **Step 1: Update the failing test to the new contract**

In `packages/hub/__tests__/subsystem-bus-gate-integration.test.ts`, replace the existing `beforeDelete does NOT fire for internal (system housekeeping) deletes` test with:

```ts
  it('beforeDelete fires for internal deletes carrying internal:true; a handler that branches on !internal does not abort', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'owner', secret: 'pw' })
    const vault = await db.openVault('v1')
    const docs = vault.collection<{ id: string; n: number }>('docs')
    await docs.put('a', { id: 'a', n: 1 })
    const seen: boolean[] = []
    db._subsystemBus.registerGate('beforeDelete', (e) => {
      seen.push(e.internal)
      if (!e.internal) throw new Error('user-delete blocked')
    })
    // Internal/housekeeping delete: handler fires (records internal:true) but does NOT throw.
    await (docs as unknown as { _internalDelete(id: string): Promise<void> })._internalDelete('a')
    expect(seen).toEqual([true])
    expect(await docs.get('a')).toBeNull() // internal delete succeeded (not aborted)
  })
```

> Confirm the `createNoydb`/`openVault` arg shape matches the other tests in this file (e.g. `encrypt`/`secret`) before finalizing; the file already opens DBs this way.

In `packages/hub/__tests__/subsystem-bus-gate.test.ts`, update the `deleteEv` helper to include the new required field:

```ts
function deleteEv(over: Partial<GateDeleteEvent> = {}): GateDeleteEvent {
  return {
    vault: 'v', collection: 'c', docId: 'd',
    existing: { x: 1 }, existingVersion: 1, existingTs: undefined, internal: false,
    userId: 'u', role: 'owner', ...over,
  }
}
```

- [ ] **Step 2: Run to verify failures**

Run: `cd packages/hub && pnpm vitest run __tests__/subsystem-bus-gate-integration.test.ts __tests__/subsystem-bus-gate.test.ts`
Expected: FAIL — `GateDeleteEvent` has no `internal` field (typecheck/compile error in `deleteEv`) and the integration test's internal delete does not yet dispatch `beforeDelete`.

- [ ] **Step 3: Add `internal` to `GateDeleteEvent`**

In `packages/hub/src/subsystem-bus.ts`, add to the `GateDeleteEvent` interface (after `docId`):

```ts
  /** True for system-internal (housekeeping) deletes — handlers branch on this. */
  readonly internal: boolean
```

- [ ] **Step 4: Fire `beforeDelete` for all deletes, passing `internal`**

In `packages/hub/src/collection.ts` `_doDelete`, change the gate dispatch block. Replace:

```ts
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

with (drop the `!internal` precondition; add `internal` to the payload; update the comment):

```ts
    // Gate bus (Track A) — fires for ALL deletes (carrying `internal`), so a
    // gate handler can collect amendment changes on system-internal deletes
    // while branching off `onDelete`/period checks for them. Delete-of-absent
    // (no envelope) does not fire.
    if (this.subsystemBus?.hasGateHandlers('beforeDelete')) {
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
          internal,
          userId: this.keyring.userId,
          role: this.keyring.role,
        })
      }
    }
```

- [ ] **Step 5: Period handler must skip internal deletes**

In `packages/hub/src/noydb.ts`, in `#registerPeriodGate`, the `beforeDelete` handler currently relied on the gate's `!internal` gating. Add an early return at the top of that handler body so periods still skips internal deletes:

```ts
    this.subsystemBus.registerGate('beforeDelete', async (e) => {
      if (e.internal) return
      const v = this.vaultCache.get(e.vault)
      if (!v) return
      await v._assertTsWritable(
        { ts: e.existingTs ?? null, record: (e.existing ?? null) as Record<string, unknown> | null },
        null,
      )
    })
```

- [ ] **Step 6: Run the updated tests + full suite**

Run: `cd packages/hub && pnpm vitest run __tests__/subsystem-bus-gate-integration.test.ts __tests__/subsystem-bus-gate.test.ts`
Expected: PASS.

Run: `cd packages/hub && pnpm typecheck && pnpm vitest run`
Expected: typecheck clean; full suite green (periods still skips internal; no guard handler yet, so the only behavior change is the gate now dispatching beforeDelete on internal deletes to handlers that all early-return for internal — net no behavior change).

- [ ] **Step 7: Commit**

```bash
git add packages/hub/src/subsystem-bus.ts packages/hub/src/collection.ts packages/hub/src/noydb.ts packages/hub/__tests__/subsystem-bus-gate.test.ts packages/hub/__tests__/subsystem-bus-gate-integration.test.ts
git commit -m "feat(hub): gate beforeDelete fires for internal deletes with an internal flag (Track A slice 3b)"
```

---

### Task 2: Register guard gate handlers AND remove the kernel guard blocks (atomic)

**Files:** `noydb.ts` (register), `collection.ts` (remove field/opt/assignment + 2 blocks), `vault.ts` (remove wiring), new `guards-gate-migration.test.ts`.

> ATOMIC: register + remove in one commit. The amendment `collectChange` side-effect must not run at both the gate and the kernel block (double-collect), so we never leave both in place.

- [ ] **Step 1: Write the new guard-gate test**

Create `packages/hub/__tests__/guards-gate-migration.test.ts`. Model store/`createNoydb`/`withGuard` setup on an existing guards test — find one: `grep -rln "withGuard\|guardStrategies" packages/hub/__tests__` and READ it to copy the exact `createNoydb({ ..., guardStrategies: [withGuard(...)] })` shape, the lock/freeze/onDelete/amendment APIs, and how a locked-record write is attempted + its error type. Do NOT invent the guard API. Assert at least:
- A no-guards Noydb registers no guard gate handler: `expect(plain._subsystemBus.hasGateHandlers('beforePut')).toBe(false)` (and `beforeDelete`) — only when NEITHER guards nor periods are configured.
- A `guardStrategies` Noydb: `hasGateHandlers('beforePut')` is true.
- A record-locked write is rejected (reuse the existing test's lock scenario + expected error).
- (If the existing suite already covers freeze/onDelete/amendment thoroughly, this new test can be a thin "still enforced via gate" check — the existing guard + amendment suite is the real safety net.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/guards-gate-migration.test.ts`
Expected: FAIL — `hasGateHandlers('beforePut')` is false even with `guardStrategies` (no guard handler registered yet).

- [ ] **Step 3: Register the guard gate handlers in `Noydb` (before the period handler)**

In `packages/hub/src/noydb.ts`, in the constructor, call `this.#registerGuardGate()` IMMEDIATELY BEFORE the existing `this.#registerPeriodGate()` call (so guard checks dispatch before period checks — restoring guard-before-period order). Define the method:

```ts
  // Track A — guards migration. Registers record-lock / field-freeze / onDelete
  // / amendment-collect as gate-bus handlers (only when guards are opted in, so
  // the write path is zero-cost otherwise). Resolves the live vault's
  // GuardRegistry per dispatch. Registered BEFORE the period gate so guard
  // checks run first. The amendment branch is a side-effect (collectChange),
  // NOT a throw — and runs even for internal deletes (an amendment invariant
  // must see system housekeeping tombstones); onDelete/checks run only for
  // user (non-internal) operations.
  #registerGuardGate(): void {
    if (this.options.guardStrategies === undefined) return
    this.subsystemBus.registerGate('beforePut', async (e) => {
      const v = this.vaultCache.get(e.vault)
      if (!v) return
      const registry = v._getGuardRegistry()
      if (!registry) return
      const guards = registry.guardsFor(e.collection)
      if (guards.length === 0) return
      const existing = (e.existing ?? null) as Record<string, unknown> | null
      const incoming = e.incoming as Record<string, unknown>
      if (registry.isAmendmentActive()) {
        registry.collectChange(e.collection, e.docId, existing, incoming, e.existingVersion, e.existingVersion + 1)
        return
      }
      const facade = v._getReadOnlyFacade()
      if (!facade) return
      const ctx = { existing, vault: facade, userId: e.userId, role: e.role }
      await registry.runChecks(e.collection, incoming, ctx)
      const { GuardExecutor } = await import('./guards/executor.js')
      for (const g of guards) {
        await GuardExecutor.checkFrozenFields(g, e.docId, existing, incoming)
      }
    })
    this.subsystemBus.registerGate('beforeDelete', async (e) => {
      const v = this.vaultCache.get(e.vault)
      if (!v) return
      const registry = v._getGuardRegistry()
      if (!registry) return
      const guards = registry.guardsFor(e.collection)
      if (guards.length === 0) return
      const existing = (e.existing ?? null) as Record<string, unknown> | null
      if (registry.isAmendmentActive()) {
        // Fires for BOTH user and system-internal deletes (matches the kernel block).
        registry.collectChange(e.collection, e.docId, existing, null as unknown as Record<string, unknown>, e.existingVersion, e.existingVersion)
        return
      }
      if (e.internal) return // housekeeping deletes don't run onDelete
      const facade = v._getReadOnlyFacade()
      if (!facade) return
      const ctx = { existing, vault: facade, userId: e.userId, role: e.role }
      await registry.runOnDelete(e.collection, existing ?? {}, ctx)
    })
  }
```

> Match the exact signatures by reading the kernel guard blocks (`collection.ts` ~1184 and ~1850) and `guards/registry.ts`: `runChecks(collection, incoming, ctx)`, `collectChange(collection, id, before, after, vBefore, vAfter)`, `runOnDelete(collection, existing, ctx)`, `guardsFor(collection)`, `isAmendmentActive()`. `GuardExecutor.checkFrozenFields(guard, id, existing, incoming)` is dynamic-imported from `./guards/executor.js`. `_getGuardRegistry()` (`vault.ts:1749`) and `_getReadOnlyFacade()` (`vault.ts:2002`) are the accessors. The `ctx` shape `{ existing, vault, userId, role }` mirrors the kernel exactly.

- [ ] **Step 4: Remove the kernel guard blocks + `guardSource` (same commit)**

(a) `packages/hub/src/vault.ts`: remove the `guardSource:` property from the `collOpts` passed to `new Collection(...)` (the conditional `...(this.guardRegistry !== null ? { guardSource: { registry: ..., readOnlyVault: ... } } : {})` spread around line 708). Keep `guardRegistry`, `_getGuardRegistry`, `_getReadOnlyFacade`, and `readOnlyFacade` — the gate handler uses them.

(b) `packages/hub/src/collection.ts`: delete the `guardSource` private field (~line 375, including its JSDoc), the ctor option (~line 726), and the assignment `this.guardSource = opts.guardSource` (~line 815).

(c) `packages/hub/src/collection.ts`: delete the entire `putInternal` guard block (`if (this.guardSource) { ... }`, lines ~1184-1223) and the entire `_doDelete` guard block (`if (this.guardSource) { ... }`, lines ~1850-1898), along with their leading explanatory comments. Leave surrounding code (the gate dispatch above, schema validation / ref enforcement below) intact.

- [ ] **Step 5: Typecheck + grep**

Run: `cd packages/hub && pnpm typecheck`
Expected: clean. Then `grep -n "guardSource" packages/hub/src/collection.ts packages/hub/src/vault.ts` → ZERO matches. `grep -n "GuardExecutorType\|GuardExecutor" packages/hub/src/collection.ts` → if the `GuardExecutorType` type-only import is now unused in collection.ts (it was only used by the removed block), remove that import.

- [ ] **Step 6: Full suite + architecture — the proof (esp. guard + amendment tests)**

Run: `cd packages/hub && pnpm vitest run && cd ../.. && pnpm check:architecture`
Expected: ALL hub tests green — critically the guards suite (lock/freeze/onDelete) AND the amendment/transaction tests (the amendment-collect path now runs via the gate; a double-collect or missing-collect would fail these). Architecture OK.
IF an amendment test fails on collected-change COUNT or ordering: investigate — the gate handler's `collectChange` must fire exactly once per write (no kernel block remains) and for internal deletes during amendments. If a guards+periods precedence test now expects period-first (from slice 3a), it should now get guard-first again (restored) — update if needed and note it.
IF a pure guard/amendment regression appears (enforcement lost): STOP, report BLOCKED with the failing test.

- [ ] **Step 7: Commit**

```bash
git add packages/hub/src/noydb.ts packages/hub/src/collection.ts packages/hub/src/vault.ts packages/hub/__tests__/guards-gate-migration.test.ts
git commit -m "refactor(hub): migrate guards (lock/freeze/onDelete/amendment) onto the gate bus (Track A slice 3b)"
```

---

## Self-Review

**Spec coverage:**
- Gate `beforeDelete` fires for internal deletes with `internal` flag; period handler skips internal → Task 1. ✅
- Guard gate handlers (amendment-collect side-effect + normal runChecks/checkFrozenFields/onDelete), registered per-Noydb when `guardStrategies` set, before periods → Task 2 Step 3. ✅
- Kernel guard blocks + `guardSource` removed atomically with registration (no double-collect window) → Task 2 Step 4. ✅
- Guard-before-period order restored → guard handler registered before period handler. ✅
- Zero-cost when no guards → handler registered only when `guardStrategies` set. ✅
- Behavior preserved → existing guards + amendment suite green after the atomic swap (Task 2 Step 6). ✅

**Placeholder scan:** none. The "copy the existing guards test setup" instruction is a concrete `grep` locator (the guard API must match the real one).

**Type consistency:** `collectChange(collection, id, before, after, vBefore, vAfter)`, `runChecks(collection, incoming, ctx)`, `runOnDelete(collection, existing, ctx)`, `guardsFor`, `isAmendmentActive`, `_getGuardRegistry`, `_getReadOnlyFacade`, `GuardExecutor.checkFrozenFields` — all used as defined in `guards/registry.ts` / `guards/executor.ts` / `vault.ts`. `GateDeleteEvent.internal` used consistently in the event, dispatch site, and both handlers. ✅

---

## Follow-on (Track A remaining, after 3b)

- **Lazy gate-event prior read** — make the gate event's `existing`/`existingTs` a thunk so the `adapter.get`+decrypt only runs if a handler actually reads it. Removes the extra read this slice introduces for non-guarded collections in a guards-enabled vault (documented above), and benefits periods too.
- `afterDelete` observe point (symmetry with `afterPut`) for the inspector/audit.
- keyring-grant → `team` split; lazy-mode → own subsystem.
- Kernel-surface CI gate (fail when always-on root grows or a subsystem adds a hard-coded `collection.ts`/`vault.ts` reference) — now enforceable since guards + periods no longer hard-code into the kernel.
- Then Track B (devtools inspector) consuming the observe bus.
