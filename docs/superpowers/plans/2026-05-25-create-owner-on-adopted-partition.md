# `createOwnerOnAdoptedPartition` + Seal Cleanup — Implementation Plan (Plan 5, #208 + #209)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `createOwnerOnAdoptedPartition(store, vaultName, { userId, passphrase, transferKey })` (#208) — the recipient mints the first owner keyring on an adopted-but-unowned partition, wrapping the partition's DEKs (recovered from the transfer seal) under a passphrase-derived KEK. On success it destroys the transfer seal (#209). After this the vault opens normally via `createNoydb` and every re-keyed record decrypts. **This closes the extract → adopt → own ceremony end-to-end.**

**Architecture:** A free, store-level function in `packages/hub/src/bundle/adopt-partition.ts` (alongside `adoptPartition` — the whole `_meta/adoption` lifecycle lives together). It reuses the existing `createOwnerKeyring` primitive (KEK derivation + `_users` DEK + canary + keyring write), then merges the unsealed partition DEKs (wrapped under the new KEK) into the keyring file, then clears `_meta/adoption.transferSeal`. No change to `createOwnerKeyring` itself; no `createNoydb` open-path surgery.

**Tech Stack:** TypeScript, Vitest, `@noy-db/hub` (`team/keyring.ts`, `crypto.ts`, `NoydbStore`).

---

## Epic context

**Plan 5 of the Transferable Partition Bundles epic** (spec: `docs/superpowers/specs/2026-05-24-transferable-partition-bundles-design.md`). Plans 1–4 (in PR #225) cover extract + adopt. This plan does owner-creation (#208) + seal cleanup (#209), completing the ceremony. State transition: `ADOPTED, UNOWNED → OWNED` (recipient keyring exists, `_meta/adoption.transferSeal` destroyed, `consumedAt` set).

## Design decisions (deviations from spec — update §4.3 in this PR)

- **Free store-level function, NOT `createNoydb({ expecting: 'adopted-partition' })`.** The spec pinned an `expecting:` flag so `createNoydb` could open an unowned vault. A free function `createOwnerOnAdoptedPartition(store, vaultName, opts)` is simpler, needs no surgery on `createNoydb`'s open path, and preserves the same safety property (an explicit separate call — no silent detection). The recipient flow becomes: `adoptPartition(...)` → `createOwnerOnAdoptedPartition(...)` → `createNoydb({ store, user, secret })` opens normally (a keyring now exists). **Update spec §4.3 + invariants to drop the `expecting:` flag.**
- **`setupNewVaultIdentity` refactor (#201 part 1) is NOT needed.** `createOwnerKeyring` already is the reusable identity-minting primitive. The deferred refactor is dropped.
- **Scope: standard-mode passphrase only.** Recovery enrollment at owner-create (`recovery: [...]`) and `passphraseMode: 'managed'` (the #195/#196/#14 composition the #208 issue sketches) are **deferred**. Standard mode doesn't mandate recovery; the recipient enrolls post-hoc via the existing `db.enrollRecovery({ profile, entries })` (`noydb.ts`). Open follow-up issues for managed-mode adoption + at-create recovery. This keeps Plan 5 bounded.
- **#209 bundled in.** The seal must die the moment the owner exists — same atomic operation, not a separate call.

## Confirmed facts

- `createOwnerKeyring(adapter, vault, userId, passphrase, passphraseOpts?)` → `UnlockedKeyring` ({ kek, deks: Map, ... }); writes `_keyring/<userId>` with a `_users` DEK + canary (`keyring.ts:301`).
- `wrapKey(dek, kek)` → base64 (`crypto.ts`). `KeyringFile.deks` is `Record<collection, base64WrappedDEK>`.
- Keyring file on disk: `_keyring/<userId>` envelope, `_data` = `JSON.stringify(KeyringFile)` (`vault.ts:2619`).
- `unsealDeks(seal, transferKey)` → `Map<collection, CryptoKey>` (Plan 4).
- `_meta/adoption` envelope `_data` = `{ sealId, adoptedAt, needsOwner, transferSeal }` (Plan 4).
- Post-hoc recovery: `db.enrollRecovery({ profile, entries })` exists.

## File structure

- **Modify:** `packages/hub/src/bundle/adopt-partition.ts` — add `createOwnerOnAdoptedPartition`.
- **Modify:** `packages/hub/src/bundle/index.ts` — export it + result type.
- **Modify:** `docs/superpowers/specs/2026-05-24-transferable-partition-bundles-design.md` — §4.3 (drop `expecting:` flag, note standard-mode scope + deferrals).
- **Test:** `packages/hub/__tests__/create-owner-adopted-partition.test.ts`.

---

## Task 1: `createOwnerOnAdoptedPartition` — mint owner + merge DEKs + cleanup seal

**Files:**
- Modify: `packages/hub/src/bundle/adopt-partition.ts`
- Test: `packages/hub/__tests__/create-owner-adopted-partition.test.ts`

- [ ] **Step 1: Write the failing test**

Create the test file. Copy the `memory()` factory from `__tests__/adopt-partition.test.ts`, plus the `makeExtractedBundle()` helper, and an `adopt` step.

```ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { ref } from '../src/refs.js'
import { ConflictError, AdoptionStateError } from '../src/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { extractPartition } from '../src/bundle/extract-partition.js'
import { adoptPartition, createOwnerOnAdoptedPartition } from '../src/bundle/adopt-partition.js'

// ── paste memory() factory ──

interface Client { id: string; name: string; operatorUserId: string }

async function makeExtractedBundle() {
  const db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
  const company = await db.openVault('demo-co')
  const clients = company.collection<Client>('clients')
  const bills = company.collection<{ id: string; clientId: string }>('bills', { refs: { clientId: ref('clients') } })
  await clients.put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })
  await bills.put('b-1', { id: 'b-1', clientId: 'c-1' })
  return extractPartition(company, { seeds: { clients: () => true } })
}

/** Extract + adopt into a fresh store, returning the adopted store + transferKey. */
async function extractAndAdopt() {
  const { bundleBytes, transferKey } = await makeExtractedBundle()
  const dest = memory()
  await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' })
  return { dest, transferKey }
}

describe('createOwnerOnAdoptedPartition', () => {
  it('mints the recipient owner keyring and destroys the transfer seal', async () => {
    const { dest, transferKey } = await extractAndAdopt()

    const result = await createOwnerOnAdoptedPartition(dest, 'acme', {
      userId: 'belle', passphrase: 'belle-hotel-dept-2026', transferKey,
    })
    expect(result).toEqual({ vaultName: 'acme', userId: 'belle' })

    // Owner keyring now exists.
    expect(await dest.list('acme', '_keyring')).toEqual(['belle'])

    // Transfer seal destroyed; sealId + consumedAt retained for audit.
    const adoptionEnv = await dest.get('acme', '_meta', 'adoption')
    const adoption = JSON.parse(adoptionEnv!._data) as { sealId: string; consumedAt?: string; transferSeal?: unknown }
    expect(adoption.transferSeal).toBeUndefined()
    expect(adoption.consumedAt).toBeTruthy()
    expect(adoption.sealId).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/create-owner-adopted-partition.test.ts -t "mints the recipient"`
Expected: FAIL — `createOwnerOnAdoptedPartition` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `adopt-partition.ts`. Add imports:

```ts
import { wrapKey } from '../crypto.js'
import { createOwnerKeyring } from '../team/keyring.js'
import type { KeyringFile } from '../types.js'
```

```ts
export interface CreateOwnerResult {
  readonly vaultName: string
  readonly userId: string
}

/**
 * Mint the first owner keyring on an adopted-but-unowned partition (#208),
 * then destroy the transfer seal (#209). Standard-mode passphrase only —
 * recovery enrollment + managed mode are post-hoc / follow-ups.
 *
 * Reuses `createOwnerKeyring` to derive the KEK + write the base keyring,
 * then wraps the partition's DEKs (recovered from the seal) under that KEK
 * and re-persists the merged keyring file.
 */
export async function createOwnerOnAdoptedPartition(
  store: NoydbStore,
  vaultName: string,
  opts: { readonly userId: string; readonly passphrase: string; readonly transferKey: Uint8Array },
): Promise<CreateOwnerResult> {
  const { userId, passphrase, transferKey } = opts

  // 1. Verify adopted-unowned state.
  const adoptionEnv = await store.get(vaultName, '_meta', 'adoption')
  if (!adoptionEnv) {
    throw new AdoptionStateError(
      `vault "${vaultName}" is not an adopted partition (no _meta/adoption). `
      + `createOwnerOnAdoptedPartition only applies to vaults created via adoptPartition.`,
    )
  }
  const adoption = JSON.parse(adoptionEnv._data) as {
    sealId: string; adoptedAt: string; needsOwner?: boolean
    consumedAt?: string; transferSeal?: TransferSealPayload
  }
  if (adoption.consumedAt !== undefined || adoption.transferSeal === undefined) {
    throw new AdoptionStateError(
      `vault "${vaultName}" already has an owner (transfer seal consumed at ${adoption.consumedAt}).`,
    )
  }
  if ((await store.list(vaultName, '_keyring')).length > 0) {
    throw new AdoptionStateError(`vault "${vaultName}" already has a keyring; cannot create a second owner.`)
  }

  // 2. Recover the partition DEKs from the seal (throws on wrong key).
  const partitionDeks = await unsealDeks(adoption.transferSeal, transferKey)

  // 3. Mint the owner keyring (KEK + _users DEK + canary, written to disk).
  const unlocked = await createOwnerKeyring(store, vaultName, userId, passphrase)

  // 4. Merge the partition DEKs (wrapped under the new KEK) into the keyring.
  const env = await store.get(vaultName, '_keyring', userId)
  if (!env) throw new AdoptionStateError(`keyring write for "${userId}" did not persist`)
  const keyringFile = JSON.parse(env._data) as KeyringFile
  const mergedDeks: Record<string, string> = { ...keyringFile.deks }
  for (const [collection, dek] of partitionDeks) {
    mergedDeks[collection] = await wrapKey(dek, unlocked.kek)
  }
  const mergedFile: KeyringFile = { ...keyringFile, deks: mergedDeks }
  await store.put(vaultName, '_keyring', userId, { ...env, _data: JSON.stringify(mergedFile) })

  // 5. (#209) Destroy the transfer seal; retain sealId + consumedAt for audit.
  const consumed = { sealId: adoption.sealId, adoptedAt: adoption.adoptedAt, consumedAt: new Date().toISOString() }
  await store.put(vaultName, '_meta', 'adoption', { ...adoptionEnv, _data: JSON.stringify(consumed) })

  return { vaultName, userId }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/create-owner-adopted-partition.test.ts -t "mints the recipient"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/adopt-partition.ts packages/hub/__tests__/create-owner-adopted-partition.test.ts
git commit -m "feat(hub): createOwnerOnAdoptedPartition — mint owner + destroy seal (#208/#209)"
```

---

## Task 2: State guards — not-adopted, already-owned, double-create

**Files:**
- Test: `packages/hub/__tests__/create-owner-adopted-partition.test.ts`

- [ ] **Step 1: Write the tests**

```ts
describe('createOwnerOnAdoptedPartition state guards', () => {
  it('rejects a vault that was not adopted (no _meta/adoption)', async () => {
    const store = memory()
    await expect(
      createOwnerOnAdoptedPartition(store, 'nope', {
        userId: 'belle', passphrase: 'p', transferKey: crypto.getRandomValues(new Uint8Array(32)),
      }),
    ).rejects.toThrow(AdoptionStateError)
  })

  it('rejects a second owner-create after the seal is consumed', async () => {
    const { dest, transferKey } = await extractAndAdopt()
    await createOwnerOnAdoptedPartition(dest, 'acme', { userId: 'belle', passphrase: 'p1', transferKey })
    await expect(
      createOwnerOnAdoptedPartition(dest, 'acme', { userId: 'belle', passphrase: 'p2', transferKey }),
    ).rejects.toThrow(AdoptionStateError)
  })

  it('rejects a wrong transfer key before writing any keyring', async () => {
    const { dest } = await extractAndAdopt()
    const wrong = crypto.getRandomValues(new Uint8Array(32))
    await expect(
      createOwnerOnAdoptedPartition(dest, 'acme', { userId: 'belle', passphrase: 'p', transferKey: wrong }),
    ).rejects.toThrow() // TransferSealError from unsealDeks
    // No keyring should have been written (unseal happens before createOwnerKeyring).
    expect(await dest.list('acme', '_keyring')).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests**

Run: `cd packages/hub && pnpm vitest run __tests__/create-owner-adopted-partition.test.ts -t "state guards"`
Expected: PASS — guards implemented in Task 1. Note: the wrong-key test relies on `unsealDeks` running BEFORE `createOwnerKeyring` (Task 1 step 3 order: unseal at step 2, keyring at step 3) so a wrong key writes nothing.

- [ ] **Step 3: (no implementation if Step 2 passed)**

- [ ] **Step 4: Run the file**

Run: `cd packages/hub && pnpm vitest run __tests__/create-owner-adopted-partition.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/__tests__/create-owner-adopted-partition.test.ts
git commit -m "test(hub): createOwnerOnAdoptedPartition state guards (#208)"
```

---

## Task 3: End-to-end — open the owned vault and query a re-keyed record

**Files:**
- Test: `packages/hub/__tests__/create-owner-adopted-partition.test.ts`

The payoff: prove the full ceremony works — after owner-create, the recipient opens the vault with their own passphrase via `createNoydb` and reads a record that originated in the source vault.

- [ ] **Step 1: Write the integration test**

```ts
describe('full ceremony end-to-end', () => {
  it('recipient opens the adopted+owned vault with their passphrase and reads a re-keyed record', async () => {
    const { dest, transferKey } = await extractAndAdopt()
    await createOwnerOnAdoptedPartition(dest, 'acme', {
      userId: 'belle', passphrase: 'belle-hotel-dept-2026', transferKey,
    })

    // Open normally — a keyring now exists, no `expecting` flag needed.
    const recipientDb = await createNoydb({ store: dest, user: 'belle', secret: 'belle-hotel-dept-2026' })
    const vault = await recipientDb.openVault('acme')

    const client = await vault.collection<Client>('clients').get('c-1')
    expect(client).toMatchObject({ id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })

    const bill = await vault.collection<{ id: string; clientId: string }>('bills').get('b-1')
    expect(bill).toMatchObject({ id: 'b-1', clientId: 'c-1' })

    // Wrong passphrase fails (the owner keyring is real, KEK-derived).
    await expect(
      createNoydb({ store: dest, user: 'belle', secret: 'wrong-passphrase' }).then((d) => d.openVault('acme')),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run + full verification**

Run: `cd packages/hub && pnpm vitest run __tests__/create-owner-adopted-partition.test.ts`
Expected: PASS. If the query returns `null` or a decrypt error, the partition-DEK merge (Task 1 step 4) didn't wrap the right collections — verify `mergedDeks` keys match the re-keyed collection names from `unsealDeks`.

Run: `cd packages/hub && pnpm typecheck && pnpm exec eslint src/bundle/adopt-partition.ts && pnpm vitest run`
Expected: typecheck clean, lint clean, full suite green.

- [ ] **Step 3: Commit**

```bash
git add packages/hub/__tests__/create-owner-adopted-partition.test.ts
git commit -m "test(hub): full extract→adopt→own ceremony end-to-end (#208)"
```

---

## Task 4: Export + spec update

**Files:**
- Modify: `packages/hub/src/bundle/index.ts`
- Modify: `docs/superpowers/specs/2026-05-24-transferable-partition-bundles-design.md`
- Test: `packages/hub/__tests__/create-owner-adopted-partition.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('is exported from the @noy-db/hub/bundle subpath', async () => {
  const mod = await import('../src/bundle/index.js')
  expect(typeof mod.createOwnerOnAdoptedPartition).toBe('function')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/create-owner-adopted-partition.test.ts -t "exported from"`
Expected: FAIL.

- [ ] **Step 3: Implement export + spec update**

In `bundle/index.ts`, after the `adoptPartition` exports:

```ts
export { createOwnerOnAdoptedPartition } from './adopt-partition.js'
export type { CreateOwnerResult } from './adopt-partition.js'
```

In the spec `docs/superpowers/specs/2026-05-24-transferable-partition-bundles-design.md`, §4.3, replace the `createNoydb({ expecting: 'adopted-partition' })` description for #208 with: a free store-level `createOwnerOnAdoptedPartition(store, vaultName, { userId, passphrase, transferKey })` that mints the owner keyring (reusing `createOwnerKeyring`), merges the unsealed partition DEKs under the new KEK, and destroys the seal (#209). Note the dropped `expecting:` flag (recipient opens normally afterward) and the standard-mode-only scope (recovery/managed deferred). Update the §2 lifecycle "OWNED" transition note accordingly.

- [ ] **Step 4: Run + full verification**

Run: `cd packages/hub && pnpm vitest run __tests__/create-owner-adopted-partition.test.ts && pnpm vitest run`
Expected: PASS; full suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/index.ts docs/superpowers/specs/2026-05-24-transferable-partition-bundles-design.md packages/hub/__tests__/create-owner-adopted-partition.test.ts
git commit -m "feat(hub): export createOwnerOnAdoptedPartition + spec §4.3 update (#208/#209)"
```

---

## Out of scope (follow-ups)

- **`passphraseMode: 'managed'` adoption** (#14 + #195 mandatory strong-recovery composition) — open a follow-up issue.
- **Recovery enrollment at owner-create** (`recovery: [...]` in the #208 sketch) — deferred; recipient uses `db.enrollRecovery(...)` post-hoc. Open a follow-up issue.
- **`carryOverUsers` magic-link invitations** (#208 issue optional section) — deferred.
- **#226** source ledger append; **#204/#205** carry opt-ins — separate.
- **`creation-of-new-owner` / `transfer-seal-consumed` ledger entries** — the spec mentions these on the adopted vault. The adopted partition starts with an empty ledger (no history strategy), so there's no chain to append to yet; deferred with the #226 ledger work. Flag in the spec.

## Self-review notes

- **Spec coverage (#208/#209):** mints the recipient owner on an adopted-unowned vault; re-wraps the partition DEKs under the recipient KEK (so records decrypt); rejects non-adopted / already-owned; destroys the transfer seal retaining `sealId` + `consumedAt`; subsequent owner-create rejected. The end-to-end test proves the whole ceremony.
- **Deviations owned:** free function (not `expecting:` flag), standard-mode-only, no `setupNewVaultIdentity` refactor — all stated above and reflected in the spec update (Task 4).
- **Ordering safety:** `unsealDeks` (wrong-key throw) runs BEFORE `createOwnerKeyring`, so a bad transfer key leaves no keyring behind (Task 2 asserts this).
- **Type consistency:** reuses `unsealDeks` + `TransferSealPayload` (Plan 4), `createOwnerKeyring` + `KeyringFile` + `wrapKey` (existing). `CreateOwnerResult` = `{ vaultName, userId }`.
```
