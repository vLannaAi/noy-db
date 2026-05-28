# Source `partition-handed-over` Ledger Entry — Implementation Plan (Plan 8, #226 source slice)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `extractPartition` write a `partition-handed-over:<sealId>` audit entry to the **source** vault's ledger (#226, source slice / spec §4.2 + invariant 4) — the firm's record that a partition was copied out. Introduces a generic `'lifecycle'` ledger op for non-data audit events.

**Architecture:** Add a `'lifecycle'` value to the ledger `op` enum (`entry.ts`); the specific event rides in `reason` (`'partition-handed-over:<sealId>'`) with empty `collection`/`id`. `verifyBackupIntegrity`'s data cross-check skips `'lifecycle'` (no data envelope to verify), exactly as it already skips `'amendment'`. `extractPartition` appends via the source vault's existing `LedgerStore` (`vault._getLedgerOrNull()`), letting `append()` fill `index`/`prevHash`/`actor`. No-op when the source has no history strategy.

**Tech Stack:** TypeScript, Vitest, `@noy-db/hub` (`history/ledger`, bundle subsystem).

---

## Epic context

**Plan 8 of the Transferable Partition Bundles epic.** This is the **source slice of #226** (decided 2026-05-25: generic `'lifecycle'` op, source-only). The destination-side entries (`creation-of-new-owner` / `transfer-seal-consumed` in #208/#209) are deferred — they need a store-level `LedgerStore` and only matter once `carryLedger` gave the partition a chain. Replaces the `TODO(#226)` marker left in `extract-partition.ts` (Plan 3b).

## Decisions (from this turn)

- **Generic `'lifecycle'` op** — one new op value; event detail in `reason`. The planned access-control ops (`grant`/`revoke`/`rotate`, noted in `entry.ts`) can reuse it.
- **Source only** — `partition-handed-over` in `extractPartition`. Destination entries deferred.

## Confirmed facts

- `LedgerEntry.op` is `'put' | 'delete' | 'amendment'` (`entry.ts:86`); `AppendInput.op = LedgerEntry['op']` (`store.ts`).
- `LedgerStore.append` fills `index`/`prevHash`/`ts`, and uses its configured actor when `input.actor === ''` (`store.ts:300`).
- `verifyBackupIntegrity` data cross-check skips `op === 'amendment'` before building the `collection/id` key (`vault.ts:2787`); a new no-data op needs the same skip.
- `vault._getLedgerOrNull()` → `LedgerStore | null` (`vault.ts:1788`); null when no history strategy.
- `extractPartition` already has `seal.sealId` and is owner-gated; the `TODO(#226)` comment marks the insertion point.

## File structure

- **Modify:** `packages/hub/src/history/ledger/entry.ts` — add `'lifecycle'` to `op`.
- **Modify:** `packages/hub/src/vault.ts` — skip `'lifecycle'` in the `verifyBackupIntegrity` data cross-check.
- **Modify:** `packages/hub/src/bundle/extract-partition.ts` — append the entry; remove the `TODO(#226)`.
- **Test:** `packages/hub/__tests__/partition-handed-over-ledger.test.ts`.

---

## Task 1: Add the `'lifecycle'` op + `verifyBackupIntegrity` skip

**Files:**
- Modify: `packages/hub/src/history/ledger/entry.ts`
- Modify: `packages/hub/src/vault.ts`
- Test: `packages/hub/__tests__/partition-handed-over-ledger.test.ts`

- [ ] **Step 1: Write the failing test**

Create the test file with the `memory()` factory (copy from `__tests__/carry-ledger.test.ts`) + `withHistory`.

```ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { withHistory } from '../src/history/index.js'
// ... memory() factory, ConflictError, types ...

describe('lifecycle ledger op', () => {
  it('a lifecycle entry does not break verifyBackupIntegrity', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'pw-1234', historyStrategy: withHistory() })
    const vault = await db.openVault('demo')
    await vault.collection<{ id: string }>('items').put('i-1', { id: 'i-1' })

    // Append a lifecycle audit entry directly through the source ledger.
    const ledger = vault._getLedgerOrNull()!
    await ledger.append({ op: 'lifecycle', collection: '', id: '', version: 0, actor: '', payloadHash: '', reason: 'partition-handed-over:seal-xyz' })

    const result = await vault.verifyBackupIntegrity()
    expect(result.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/partition-handed-over-ledger.test.ts -t "lifecycle entry"`
Expected: FAIL — TypeScript rejects `op: 'lifecycle'` (not in the enum); or at runtime `verifyBackupIntegrity` mis-handles the empty-key entry.

- [ ] **Step 3: Write minimal implementation**

In `entry.ts`, extend the `op` union (and its doc comment):

```ts
  readonly op: 'put' | 'delete' | 'amendment' | 'lifecycle'
```

Add a doc note: `'lifecycle'` records a non-data audit event (e.g. `partition-handed-over`); `collection`/`id` are empty and the event detail is in `reason`. Like `amendment`, it carries no data envelope, so `verifyBackupIntegrity` skips it in the data cross-check.

In `vault.ts`, the data cross-check skip (currently `if (entry.op === 'amendment') continue`):

```ts
      // Amendment + lifecycle entries are non-data audit entries with empty
      // collection/id — skip before the key/seen bookkeeping so they neither
      // tombstone real entries nor enter the latest map.
      if (entry.op === 'amendment' || entry.op === 'lifecycle') continue
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/partition-handed-over-ledger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/history/ledger/entry.ts packages/hub/src/vault.ts packages/hub/__tests__/partition-handed-over-ledger.test.ts
git commit -m "feat(hub): 'lifecycle' ledger op for non-data audit events (#226)"
```

---

## Task 2: `extractPartition` appends `partition-handed-over` to the source ledger

**Files:**
- Modify: `packages/hub/src/bundle/extract-partition.ts`
- Test: `packages/hub/__tests__/partition-handed-over-ledger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { extractPartition } from '../src/bundle/extract-partition.js'
import { ref } from '../src/refs.js'

interface Client { id: string; name: string; operatorUserId: string }

describe('extractPartition source ledger audit', () => {
  it('appends partition-handed-over:<sealId> to the source ledger', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'pw-1234', historyStrategy: withHistory() })
    const company = await db.openVault('demo-co')
    await company.collection<Client>('clients').put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })

    const { sealId } = await extractPartition(company, { seeds: { clients: () => true } })

    // The source ledger now carries a lifecycle entry naming the handover.
    const ledger = company._getLedgerOrNull()!
    const entries = await ledger.loadAllEntries()
    const handover = entries.find((e) => e.op === 'lifecycle' && e.reason === `partition-handed-over:${sealId}`)
    expect(handover).toBeTruthy()

    // Source chain still verifies (the append is a normal chain entry).
    expect((await company.verifyBackupIntegrity()).ok).toBe(true)
    // Source records are untouched (non-destructive).
    expect(await company.collection<Client>('clients').get('c-1')).toMatchObject({ id: 'c-1' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/partition-handed-over-ledger.test.ts -t "appends partition-handed-over"`
Expected: FAIL — no lifecycle entry (extractPartition still has the TODO).

- [ ] **Step 3: Write minimal implementation**

In `extract-partition.ts`, replace the `TODO(#226)` comment block (after `const { seal, transferKey } = await sealDeks(deks)`) with the append:

```ts
  // Source-side audit (#226 / spec §4.2 / invariant 4): record that a
  // partition was handed over. Non-destructive — an audit append, no record
  // touched. No-op when the source vault has no history strategy.
  await vault._getLedgerOrNull()?.append({
    op: 'lifecycle',
    collection: '',
    id: '',
    version: 0,
    actor: '', // append() fills the source ledger's configured actor (the owner)
    payloadHash: '',
    reason: `partition-handed-over:${seal.sealId}`,
  })
```

(Confirm `vault._getLedgerOrNull()` is the public-internal accessor — `grep -n "_getLedgerOrNull" packages/hub/src/vault.ts`. If the method is named differently, use that.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/partition-handed-over-ledger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/extract-partition.ts packages/hub/__tests__/partition-handed-over-ledger.test.ts
git commit -m "feat(hub): extractPartition writes partition-handed-over to source ledger (#226)"
```

---

## Task 3: No-history source is a clean no-op + full verification

**Files:**
- Test: `packages/hub/__tests__/partition-handed-over-ledger.test.ts`

- [ ] **Step 1: Write the test**

```ts
it('is a no-op when the source vault has no history strategy', async () => {
  // No historyStrategy → no ledger → nothing to append, no throw.
  const db = await createNoydb({ store: memory(), user: 'alice', secret: 'pw-1234' })
  const company = await db.openVault('demo-co')
  await company.collection<Client>('clients').put('c-1', { id: 'c-1', name: 'A', operatorUserId: 'belle' })

  const result = await extractPartition(company, { seeds: { clients: () => true } })
  expect(result.sealId.length).toBeGreaterThan(0) // succeeded
  expect(company._getLedgerOrNull()).toBeNull()    // still no ledger
})
```

- [ ] **Step 2: Run + full verification**

Run: `cd packages/hub && pnpm vitest run __tests__/partition-handed-over-ledger.test.ts`
Expected: PASS (all). The no-history case exercises the `?.` short-circuit.

Run: `cd packages/hub && pnpm typecheck && pnpm exec eslint src/bundle/extract-partition.ts src/history/ledger/entry.ts src/vault.ts && pnpm vitest run`
Expected: typecheck clean, lint clean, full suite green. In particular, existing ledger + verifyBackupIntegrity + history tests must still pass (the op-enum widening + skip is additive).

- [ ] **Step 3: Commit**

```bash
git add packages/hub/__tests__/partition-handed-over-ledger.test.ts
git commit -m "test(hub): extractPartition source-ledger append is a no-op without history (#226)"
```

---

## Out of scope (follow-ups)

- **Destination entries** `creation-of-new-owner` (#208) + `transfer-seal-consumed` (#209) — need a store-level `LedgerStore` in `createOwnerOnAdoptedPartition`; deferred. Track on #226.
- **Access-control ops** (`grant`/`revoke`/`rotate`) — the other planned non-data ops; may reuse `'lifecycle'` or get dedicated values. Separate.
- **Spec §4.2 note** — update to say the source append is implemented (source slice) while destination entries remain deferred.

## Self-review notes

- **Spec coverage (#226 source slice):** `extractPartition` appends `partition-handed-over:<sealId>` to the source ledger when history is on; the chain still verifies; records are untouched (non-destructive). No-history is a clean no-op.
- **Contract change:** one op value (`'lifecycle'`) + one verify skip line — additive, back-compatible (old bundles never carry lifecycle entries; the skip only affects new ones).
- **Type consistency:** `AppendInput.op` is `LedgerEntry['op']`, so widening the enum flows through automatically. `actor: ''` defers to the ledger's configured actor (no need to thread the owner's userId into `extractPartition`).
- **Honesty:** `partition-handed-over` is a real chain entry (counts in `verify`'s chain walk), so it can't be silently dropped — it's a durable, tamper-evident audit signal, which is the point.
```
