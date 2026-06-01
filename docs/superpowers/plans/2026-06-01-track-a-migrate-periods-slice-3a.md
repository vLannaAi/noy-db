# Track A — Migrate Periods onto the Gate Bus (Slice 3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the accounting-periods closed-period write guard off the per-`Collection` `periodGuard` callback (+ its two inline `putInternal`/`_doDelete` blocks) and onto the `beforePut`/`beforeDelete` gate bus, registered once per `Noydb` when periods is opted in. First real subsystem migration — proves the gate seam end-to-end on the simple subsystem.

**Architecture:** A single pair of gate handlers is registered on the per-`Noydb` `SubsystemBus` **iff** `periodsStrategy` was supplied. Each handler resolves the *live* vault from `vaultCache` by `event.vault` and delegates to the vault's existing `_assertTsWritable(...)` (which still owns all period logic via `periodsStrategy` + `periodCache`). Resolving the live vault per-dispatch makes vault eviction/re-creation transparent — no per-vault registration, no unsubscribe, no stale-closure leak. The gate event already carries the decrypted prior record, so the migrated path does **one** prior read instead of two.

**Behavior changes (intentional, documented):**
1. **Zero-cost when periods is off.** Today `periodGuard` is installed on every Collection unconditionally and calls a `NO_PERIODS` no-op on every write. After migration, no gate handler is registered when periods isn't opted in → `hasGateHandlers('beforePut')` is false → the write path skips the prior read + dispatch entirely.
2. **Error precedence flips for a doubly-invalid write.** Today `putInternal` runs the guard block (record-lock/freeze) *before* the period block. The gate dispatches at the top of `putInternal`, so the migrated period check runs *before* the (still-in-kernel) guard block. A write that violates **both** a record lock **and** a closed period now surfaces the closed-period error first. Defensible (a closed period is unwritable regardless of locks) and accepted for this slice. Guards migrate next (slice 3b); at that point both live on the gate and registration order restores guard-first if desired.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Vitest, pnpm. Package `packages/hub`. Hub stays portable; `pnpm check:architecture` must pass.

**Scope:** periods only. Guards stay on their kernel block (slice 3b). No public API change. The gate primitive (slice 2) is unchanged.

---

## File Structure

- **Modify** `packages/hub/src/noydb.ts` — register the period `beforePut`/`beforeDelete` gate handlers in the constructor when `this.options.periodsStrategy !== undefined`.
- **Create** `packages/hub/__tests__/periods-gate-migration.test.ts` — proves closed-period writes/deletes are rejected via the gate, and that a no-periods Noydb registers no gate handler.
- **Modify** `packages/hub/src/vault.ts` — remove the `periodGuard:` wiring passed to `Collection` (line ~702).
- **Modify** `packages/hub/src/collection.ts` — remove the `periodGuard` field, ctor option, assignment, and the two inline period blocks (`putInternal` ~1257-1271, `_doDelete` ~1951-1965).

---

### Task 1: Register the per-Noydb period gate handlers (additive — kept redundant with the kernel block so the suite stays green)

**Files:**
- Modify: `packages/hub/src/noydb.ts`
- Test: `packages/hub/__tests__/periods-gate-migration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/periods-gate-migration.test.ts`. Model the Noydb/store setup on an existing periods test — find one with `grep -rln "withPeriods\|closePeriod" packages/hub/__tests__` and copy its `memoryStore()` + `createNoydb({ ..., periodsStrategy: withPeriods() })` + `closePeriod` setup verbatim (the period API — `closePeriod` args, the date field, how a write into a closed period is attempted — must match the real API; do NOT invent it). The test must assert:

```ts
// 1. A no-periods Noydb registers NO period gate handler (zero-cost path).
const plain = await createNoydb({ store: memoryStore(), user: 'owner', secret: 'pw' })
expect(plain._subsystemBus.hasGateHandlers('beforePut')).toBe(false)
expect(plain._subsystemBus.hasGateHandlers('beforeDelete')).toBe(false)

// 2. A withPeriods Noydb DOES register the period gate handlers.
const withP = await createNoydb({ store: memoryStore(), user: 'owner', secret: 'pw', periodsStrategy: withPeriods() })
expect(withP._subsystemBus.hasGateHandlers('beforePut')).toBe(true)
expect(withP._subsystemBus.hasGateHandlers('beforeDelete')).toBe(true)

// 3. A write whose business-date falls in a CLOSED period is rejected.
//    (Reproduce the exact closePeriod + write-into-closed-period flow from
//    the existing periods test you copied; assert it rejects.)
```

For assertion 3, reuse the precise closed-period rejection scenario from the existing periods test (same dateField, same close call, same expected error type). The point of THIS test is only that the rejection still happens once periods is gate-registered — the existing periods suite is the broader safety net.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/periods-gate-migration.test.ts`
Expected: FAIL — assertions 1 and 2 fail because no period gate handler is registered yet (`hasGateHandlers('beforePut')` is `false` even with periods). (Assertion 3 already passes via the kernel block — that's fine; 1 & 2 drive the change.)

- [ ] **Step 3: Register the gate handlers in `Noydb`**

In `packages/hub/src/noydb.ts`, in the `Noydb` constructor, AFTER `this.subsystemBus` is constructed (the `private readonly subsystemBus = new SubsystemBus()` field initializer at ~line 164 runs before the constructor body, so place this in the constructor body where `this.vaultCache` and `this.options` are available), add a call to a new private method, and define the method:

```ts
    // Track A — periods migration. Register the closed-period write guard as a
    // gate handler instead of a per-Collection `periodGuard` callback. Resolves
    // the LIVE vault per dispatch (so eviction/re-creation is transparent) and
    // delegates to the vault's `_assertTsWritable`, which still owns all period
    // logic via `periodsStrategy` + `periodCache`. Registered only when periods
    // is opted in, so the write path is zero-cost otherwise.
    this.#registerPeriodGate()
```

And the method (place near other private helpers):

```ts
  #registerPeriodGate(): void {
    if (this.options.periodsStrategy === undefined) return
    this.subsystemBus.registerGate('beforePut', async (e) => {
      const v = this.vaultCache.get(e.vault)
      if (!v) return
      const existing = e.op === 'create'
        ? null
        : { ts: e.existingTs ?? null, record: (e.existing ?? null) as Record<string, unknown> | null }
      await v._assertTsWritable(existing, e.incoming as Record<string, unknown>)
    })
    this.subsystemBus.registerGate('beforeDelete', async (e) => {
      const v = this.vaultCache.get(e.vault)
      if (!v) return
      await v._assertTsWritable(
        { ts: e.existingTs ?? null, record: (e.existing ?? null) as Record<string, unknown> | null },
        null,
      )
    })
  }
```

Notes for the implementer:
- Confirm the private field name is `subsystemBus` and `vaultCache` (read the constructor/fields). Use `this.subsystemBus` (not the `_subsystemBus` accessor) inside the class.
- `_assertTsWritable` is an `@internal` method on `Vault` (`vault.ts` ~2555) with signature `(existing: { ts: string | null; record: Record<string, unknown> | null } | null, incoming: Record<string, unknown> | null) => Promise<void>`. It is accessible from `Noydb` (same package). If TypeScript flags it as not on the public `Vault` type, it is still a real method — keep the call; if needed, the type is the `Vault` class type which includes `_`-prefixed members within the package.
- `op`, `existing`, `existingTs`, `incoming` are fields of `GatePutEvent`; `existing`, `existingTs` of `GateDeleteEvent` (`subsystem-bus.ts`).
- Do NOT remove the kernel period block yet — this step is additive. Periods is now checked at BOTH the gate and the kernel block (redundant but harmless: `_assertTsWritable` is a pure check; the gate throws first on violation, the kernel block re-checks on a clean write). The suite must stay green.

- [ ] **Step 4: Run the new test + full suite**

Run: `cd packages/hub && pnpm vitest run __tests__/periods-gate-migration.test.ts`
Expected: PASS (all 3 assertions).

Run: `cd packages/hub && pnpm typecheck && pnpm vitest run`
Expected: typecheck clean; full suite green (periods now double-checked, behavior unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/noydb.ts packages/hub/__tests__/periods-gate-migration.test.ts
git commit -m "feat(hub): register closed-period guard as a gate-bus handler (Track A slice 3a)"
```

---

### Task 2: Remove the kernel `periodGuard` coupling (gate-only enforcement)

**Files:**
- Modify: `packages/hub/src/vault.ts` (remove `periodGuard:` wiring)
- Modify: `packages/hub/src/collection.ts` (remove field, ctor opt, assignment, two inline blocks)

- [ ] **Step 1: Remove the `periodGuard` wiring in `vault.ts`**

In `packages/hub/src/vault.ts`, in the `collOpts` object passed to `new Collection<T>(...)` (~line 702), delete this line:

```ts
        periodGuard: (existing, incoming) => this._assertTsWritable(existing, incoming),
```

(`_assertTsWritable` itself STAYS — it's now called by the Noydb gate handler.)

- [ ] **Step 2: Remove the `periodGuard` field, ctor option, and assignment in `collection.ts`**

(a) Delete the `periodGuard` private field (~lines 373-380):

```ts
  private readonly periodGuard:
    | ((
        existing: { ts: string | null; record: Record<string, unknown> | null } | null,
        incoming: Record<string, unknown> | null,
      ) => Promise<void>)
    | undefined
```

(b) Delete the ctor option (~lines 739-742):

```ts
    periodGuard?: (
      existing: { ts: string | null; record: Record<string, unknown> | null } | null,
      incoming: Record<string, unknown> | null,
    ) => Promise<void>
```

(c) Delete the assignment (~line 838): `this.periodGuard = opts.periodGuard`

- [ ] **Step 3: Remove the two inline period blocks in `collection.ts`**

(a) In `putInternal`, delete the period block (the comment + the `if (this.periodGuard !== undefined) { ... }`, ~lines 1255-1271 — keep the surrounding schema-validation code that follows):

```ts
    if (this.periodGuard !== undefined) {
      const existingEnv = await this.adapter.get(this.vault, this.name, id)
      let priorRecord: Record<string, unknown> | null = null
      if (existingEnv) {
        try {
          priorRecord = (await this.decryptRecord(existingEnv, { skipValidation: true })) as unknown as Record<string, unknown>
        } catch {
          priorRecord = null
        }
      }
      await this.periodGuard(
        existingEnv ? { ts: existingEnv._ts, record: priorRecord } : null,
        record as unknown as Record<string, unknown>,
      )
    }
```

Also remove the now-orphaned leading comment that introduces it (the "accounting-period guard … For first-time inserts the prior is null." comment block immediately above it).

(b) In `_doDelete`, delete the period block (~lines 1951-1965):

```ts
    if (!internal && this.periodGuard !== undefined) {
      const existingEnv = await this.adapter.get(this.vault, this.name, id)
      let priorRecord: Record<string, unknown> | null = null
      if (existingEnv) {
        try {
          priorRecord = (await this.decryptRecord(existingEnv, { skipValidation: true })) as unknown as Record<string, unknown>
        } catch {
          priorRecord = null
        }
      }
      await this.periodGuard(
        existingEnv ? { ts: existingEnv._ts, record: priorRecord } : null,
        null,
      )
    }
```

Also remove its leading explanatory comment.

- [ ] **Step 4: Typecheck — confirm no dangling `periodGuard` references**

Run: `cd packages/hub && pnpm typecheck`
Expected: clean. If it flags an unused import or a remaining `periodGuard` reference, remove it. Run `grep -n "periodGuard" packages/hub/src/collection.ts packages/hub/src/vault.ts` — only `_assertTsWritable` (the vault method) should remain; zero `periodGuard` references.

- [ ] **Step 5: Full suite + architecture check — this is the proof the gate fully covers periods**

Run: `cd packages/hub && pnpm vitest run && cd ../.. && pnpm check:architecture`
Expected: ALL hub tests green (periods now enforced ONLY via the gate) and architecture OK. If a test that combines guards + periods asserts a specific error precedence (guard-before-period), it will fail here — that is the documented precedence flip; update that test to expect the period error first (intentional) and note it in the commit. If the suite is fully green, no precedence test existed.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/collection.ts packages/hub/src/vault.ts
git commit -m "refactor(hub): remove kernel periodGuard block — periods enforced via gate bus (Track A slice 3a)"
```

---

## Self-Review

**Spec coverage:**
- Period closed-period guard moved to `beforePut`/`beforeDelete` gate, registered per-Noydb when periods active, resolving live vault → Task 1. ✅
- Per-Collection `periodGuard` field + inline blocks + vault wiring removed → Task 2. ✅
- Zero-cost when periods off (no handler registered) → Task 1 test assertions 1-2. ✅
- Read-dedup (handler uses event's `existing`/`existingTs`, no re-read) → inherent in the handler design. ✅
- Behavior preserved (closed-period rejection) → existing periods suite + Task 1 assertion 3 + Task 2 Step 5 full-suite gate. ✅
- Precedence flip documented + handled → Task 2 Step 5. ✅

**Placeholder scan:** none. The Task 1 Step 1 instruction to copy the existing periods test's exact API setup is a concrete locator (`grep`), not a placeholder — the period API (`closePeriod` shape, dateField) must match the real one, which only the existing test reliably encodes.

**Type consistency:** `_assertTsWritable` signature matches the handler call args; `GatePutEvent`/`GateDeleteEvent` field names (`op`/`existing`/`existingTs`/`incoming`) used as defined in `subsystem-bus.ts`; `hasGateHandlers` is the slice-2 method. ✅

---

## Follow-on

- **`track-a-migrate-guards` (slice 3b)** — migrate guards (normal `runChecks`/`checkFrozenFields` → throw; amendment `collectChange` → stateful side-effect; `onDelete`) onto the gate. The handler closes over the per-vault `GuardRegistry` (resolved via the live vault, same pattern as periods) and branches on `registry.isAmendmentActive()`. Remove `guardSource` field + the kernel guard blocks. This is where the amendment complexity lives; the gate handler must NOT add a blanket re-entrancy guard (amendment-collect relies on nested writes firing). Restore guard-before-period registration order if any precedence test demands it.
- Then: keyring→team split, lazy→subsystem split, kernel-surface CI gate, `afterDelete` observe point.
