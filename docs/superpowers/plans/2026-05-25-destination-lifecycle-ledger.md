# Destination Lifecycle Ledger Entries — Implementation Plan (Plan 9, #226 destination slice)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `createOwnerOnAdoptedPartition` records two lifecycle audit entries on the adopted partition's ledger — `creation-of-new-owner:<userId>` (#208) and `transfer-seal-consumed:<sealId>` (#209) — completing #226. Only when the partition carried an audit chain (`carryLedger`); a clean no-op otherwise.

**Architecture:** `createOwnerOnAdoptedPartition` already holds the unsealed `partitionDeks` in memory — which includes the `_ledger` DEK iff `carryLedger` sealed it. When present, construct a `LedgerStore` over the destination store (`getDEK` returns the in-memory `_ledger` DEK, `actor` = the new owner) and `append()` two `'lifecycle'` entries (the op added in Plan 8). `append()` loads the carried chain's head and extends it; `verifyBackupIntegrity` skips lifecycle entries in its data cross-check, so the chain stays valid.

**Tech Stack:** TypeScript, Vitest, `@noy-db/hub` (`history/ledger`, bundle subsystem).

## Confirmed facts

- `LedgerStore` exported from `history/ledger/store.js`; constructor `{ adapter, vault, encrypted, getDEK, actor }`.
- `'lifecycle'` op + `verify`/`time-machine` skips already exist (Plan 8).
- `partitionDeks` (from `unsealDeks`) holds `_ledger` DEK iff `carryLedger` was used (Plan 7 seals it).
- `LEDGER_COLLECTION = '_ledger'` (`history/ledger/constants.js`).

## File structure

- **Modify:** `packages/hub/src/bundle/adopt-partition.ts` — append the two entries in `createOwnerOnAdoptedPartition`.
- **Test:** `packages/hub/__tests__/destination-lifecycle-ledger.test.ts`.

---

## Task 1: Append `creation-of-new-owner` + `transfer-seal-consumed`

**Files:**
- Modify: `packages/hub/src/bundle/adopt-partition.ts`
- Test: `packages/hub/__tests__/destination-lifecycle-ledger.test.ts`

- [ ] **Step 1: Write the failing test**

Create the test file (copy `memory()` from `__tests__/carry-ledger.test.ts`, `withHistory`, `ref`).

```ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { withHistory } from '../src/history/index.js'
import { ref } from '../src/refs.js'
import { ConflictError } from '../src/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { extractPartition } from '../src/bundle/extract-partition.js'
import { adoptPartition, createOwnerOnAdoptedPartition } from '../src/bundle/adopt-partition.js'

// ── paste memory() ──
interface Client { id: string; name: string; operatorUserId: string }

async function srcVault() {
  const db = await createNoydb({ store: memory(), user: 'alice', secret: 'pw-1234', historyStrategy: withHistory() })
  const c = await db.openVault('demo-co')
  await c.collection<Client>('clients').put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })
  return c
}

describe('destination lifecycle ledger entries (#226)', () => {
  it('records creation-of-new-owner + transfer-seal-consumed when the partition carried a ledger', async () => {
    const company = await srcVault()
    const { bundleBytes, transferKey, sealId } = await extractPartition(company, { seeds: { clients: () => true }, carryLedger: true })

    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' })
    await createOwnerOnAdoptedPartition(dest, 'acme', { userId: 'belle', passphrase: 'belle-2026', transferKey })

    const db = await createNoydb({ store: dest, user: 'belle', secret: 'belle-2026', historyStrategy: withHistory() })
    const vault = await db.openVault('acme')
    const entries = await vault._getLedgerOrNull()!.loadAllEntries()

    expect(entries.some((e) => e.op === 'lifecycle' && e.reason === 'creation-of-new-owner:belle')).toBe(true)
    expect(entries.some((e) => e.op === 'lifecycle' && e.reason === `transfer-seal-consumed:${sealId}`)).toBe(true)
    // The extended chain still verifies over re-keyed data.
    expect((await vault.verifyBackupIntegrity()).ok).toBe(true)
  })

  it('is a no-op when the partition carried no ledger (carryLedger off)', async () => {
    const company = await srcVault()
    const { bundleBytes, transferKey } = await extractPartition(company, { seeds: { clients: () => true } }) // no carryLedger
    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' })
    // Must not throw despite there being no _ledger DEK / chain.
    await createOwnerOnAdoptedPartition(dest, 'acme', { userId: 'belle', passphrase: 'belle-2026', transferKey })
    expect(await dest.list('acme', '_ledger')).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/destination-lifecycle-ledger.test.ts -t "records creation-of-new-owner"`
Expected: FAIL — no lifecycle entries on the destination chain.

- [ ] **Step 3: Write minimal implementation**

In `adopt-partition.ts`, add imports:

```ts
import { LedgerStore } from '../history/ledger/store.js'
import { LEDGER_COLLECTION } from '../history/ledger/constants.js'
```

In `createOwnerOnAdoptedPartition`, after the keyring DEK-merge (step 4) and BEFORE destroying the seal (step 5), add:

```ts
  // (#226 destination) If the partition carried an audit chain (carryLedger),
  // record the ownership transition on it. No-op otherwise — no _ledger DEK,
  // no chain to extend.
  const ledgerDek = partitionDeks.get(LEDGER_COLLECTION)
  if (ledgerDek) {
    const ledger = new LedgerStore({
      adapter: store,
      vault: vaultName,
      encrypted: true,
      getDEK: async () => ledgerDek,
      actor: userId,
    })
    await ledger.append({ op: 'lifecycle', collection: '', id: '', version: 0, actor: '', payloadHash: '', reason: `creation-of-new-owner:${userId}` })
    await ledger.append({ op: 'lifecycle', collection: '', id: '', version: 0, actor: '', payloadHash: '', reason: `transfer-seal-consumed:${adoption.sealId}` })
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/destination-lifecycle-ledger.test.ts`
Expected: PASS (both). If `verifyBackupIntegrity` fails `kind: 'chain'`, the appends didn't extend the carried head — confirm the `LedgerStore` reads the existing chain (it does on first `append` via the head cache, using the same `_ledger` DEK).

- [ ] **Step 5: Full verification + commit**

Run: `cd packages/hub && pnpm typecheck && pnpm exec eslint src/bundle/adopt-partition.ts && pnpm vitest run`
Expected: typecheck clean, lint clean, full suite green (existing carry-ledger + create-owner tests unaffected).

```bash
git add packages/hub/src/bundle/adopt-partition.ts packages/hub/__tests__/destination-lifecycle-ledger.test.ts
git commit -m "feat(hub): destination creation-of-new-owner + transfer-seal-consumed ledger entries (#226)"
```

---

## Out of scope

- **Destination entries WITHOUT carryLedger** — would require minting a fresh `_ledger` DEK + genesis chain on an otherwise no-history partition. Deferred; the no-op is the right default (no chain ⇒ nothing to audit against).

## Self-review notes

- **Spec coverage (#226 destination):** both entries recorded on the carried chain; chain still verifies; no-op without a carried ledger. With Plan 8 (source), #226 is complete modulo the no-carryLedger genesis case (intentionally out of scope).
- **Reuses** the `'lifecycle'` op (Plan 8) + the in-memory `partitionDeks` (Plan 5) — no new op, no new DEK plumbing.
- **Ordering:** appends happen after the owner keyring exists (so `verifyBackupIntegrity` has a coherent vault) and before/independent of the seal-field destruction.
```
