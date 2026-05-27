# Managed-Mode Adoption — Implementation Plan (Plan 10, #208 managed follow-up)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.
>
> ⚠️ **Largest remaining slice — multi-subsystem (managed-passphrase + sealing + recovery #195/#196).** Execute as its own focused pass AFTER an advisor review of the recovery-at-create composition (the one real design fork, called out below). Don't rush it.

**Goal:** Let `createOwnerOnAdoptedPartition` mint the recipient owner in **managed mode** — `passphraseMode: 'managed'` with a `SealingKeyProvider` (e.g. `at-*` macOS Keychain) instead of a user passphrase — composing with #195's mandatory strong-recovery rule. This is the capability #198 motivates ("the extracted partition auto-unlocks on Belle's laptop").

**Architecture:** The passphrase half is clean: `resolveManagedSecret(store, vaultName, sealingKey)` mints a random passphrase, seals it under the provider, persists `_meta/sealed-passphrase`, and returns the plaintext — which feeds the existing `createOwnerKeyring` + partition-DEK-merge path unchanged. The recovery half is the design fork: managed mode requires a strong (Shamir) recovery profile (#195), enrolled at creation, which needs an injected recovery provider and must navigate the #195 gate the way `openVaultAndEnrollRecovery` does (`_skipNextManagedRecoveryCheck`).

**Tech Stack:** TypeScript, Vitest, `@noy-db/hub` (`team/managed-passphrase`, recovery/#196 dispatch), `@noy-db/on-shamir` (test recovery provider), bundle subsystem.

## Confirmed facts

- `resolveManagedSecret(store, vault, provider)` (`team/managed-passphrase.ts:311`): first call → generate 256-bit random, seal under provider, persist `_meta/sealed-passphrase`, return base64 passphrase string. Reopen → unseal. **This is the mint+seal primitive.**
- `saveSealedPassphrase` / `loadSealedPassphrase` / `SealingKeyProvider` interface (`:60`) / `MemorySealingKeyProvider` (`:94`, for tests).
- `createOwnerKeyring(store, vault, userId, passphrase)` already wraps DEKs under a passphrase-derived KEK (Plan 5 reuses it). It consumes the managed-minted passphrase identically.
- `#195` gate fires from `bootstrapPolicy` (`noydb.ts:1397`) unless `_skipNextManagedRecoveryCheck`. `openVaultAndEnrollRecovery` (`noydb.ts:1981`) is the create+enroll template: validate ≥1 Shamir, bypass the gate during open, `enrollRecovery` each profile, re-assert.
- `db.enrollRecovery(vault, { profile: 'shamir', k, n } | { profile: 'paper', entries })`. Shamir needs an injected `ShamirRecoveryProvider` (the 0.2 hub↔on-shamir decouple — see [[project_0_2_epic]]).

## THE DESIGN FORK (resolve before Task 1 — advisor review)

`createOwnerOnAdoptedPartition` is a **store-level free function**, but managed recovery enrollment lives on the **`Noydb` instance** (`enrollRecovery`, the #195 bypass). Three ways to compose:

- **(A) Two-phase, caller-driven enrollment.** `createOwnerOnAdoptedPartition({ passphraseMode: 'managed', sealingKey })` mints+seals the passphrase + builds the keyring, and returns. The caller then opens `createNoydb({ store, user, passphraseMode: 'managed', sealingKey })` and calls `openVaultAndEnrollRecovery`. **Problem:** the #195 gate blocks the open until recovery exists — the caller hits the chicken-and-egg unless we expose the bypass publicly. Leaky.
- **(B) `createOwnerOnAdoptedPartition` orchestrates everything**, including recovery, by accepting `recovery` + a `shamirRecovery` provider and driving the enrollment inline (replicating `openVaultAndEnrollRecovery`'s bypass-open-enroll-reassert against the adopted store). Self-contained but pulls recovery + Noydb-construction into the bundle function.
- **(C) Promote managed adoption to a `Noydb` method.** Add `db.adoptPartitionAsManagedOwner(...)` that reuses `openVaultAndEnrollRecovery` directly. Cleanest reuse, but splits the adoption API across a free function (standard) + a method (managed) — inconsistent surface.

**Recommendation to validate with advisor:** (B) — keep one adoption entry point, accept `{ passphraseMode: 'managed', sealingKey, recovery, shamirRecovery }`, and replicate the bypass-open-enroll-reassert window internally. The standard-mode signature is unchanged (discriminated union on `passphraseMode`). But (B) means `createOwnerOnAdoptedPartition` constructs a `Noydb` internally — confirm that's acceptable layering, or whether (C) is cleaner. **This is the decision the advisor should weigh in on first.**

## File structure (assuming approach B — revise after advisor)

- **Modify:** `packages/hub/src/bundle/adopt-partition.ts` — managed branch in `createOwnerOnAdoptedPartition` (discriminated options union).
- **Test:** `packages/hub/__tests__/managed-mode-adoption.test.ts` — uses `MemorySealingKeyProvider` + an injected Shamir provider (`@noy-db/on-shamir`).

---

## Task 1: Managed-passphrase owner (no recovery yet)

**Files:** `adopt-partition.ts`, `__tests__/managed-mode-adoption.test.ts`

- [ ] **Step 1: Write the failing test** — extract (no carryLedger) → adopt → `createOwnerOnAdoptedPartition` with `{ passphraseMode: 'managed', sealingKey: new MemorySealingKeyProvider(), transferKey }` (NO recovery yet — Task 2 adds the #195 gate). Assert: `_meta/sealed-passphrase` exists; the recipient opens via `createNoydb({ store, user, passphraseMode: 'managed', sealingKey })` and reads a re-keyed record.

```ts
import { MemorySealingKeyProvider } from '../src/team/managed-passphrase.js'
// ... extract + adopt ...
await createOwnerOnAdoptedPartition(dest, 'acme', {
  userId: 'belle', passphraseMode: 'managed', sealingKey: provider, transferKey,
})
expect(await dest.get('acme', '_meta', 'sealed-passphrase')).toBeTruthy()
const db = await createNoydb({ store: dest, user: 'belle', passphraseMode: 'managed', sealingKey: provider })
const vault = await db.openVault('acme')
expect(await vault.collection('clients').get('c-1')).toMatchObject({ id: 'c-1' })
```

- [ ] **Step 2: Run — expect FAIL** (options union doesn't accept `passphraseMode`).

- [ ] **Step 3: Implement** — widen the options to a discriminated union:

```ts
type CreateOwnerOpts =
  | { readonly userId: string; readonly passphrase: string; readonly transferKey: Uint8Array }
  | { readonly userId: string; readonly passphraseMode: 'managed'; readonly sealingKey: SealingKeyProvider
      readonly recovery?: RecoveryEnrollmentInput[]; readonly shamirRecovery?: ShamirRecoveryProvider
      readonly transferKey: Uint8Array }
```

In the managed branch, BEFORE `createOwnerKeyring`, derive the passphrase:

```ts
const passphrase = 'passphraseMode' in opts && opts.passphraseMode === 'managed'
  ? await resolveManagedSecret(store, vaultName, opts.sealingKey) // mints + seals + persists envelope
  : opts.passphrase
```

The rest of the existing flow (createOwnerKeyring + partition-DEK merge + seal destroy) is unchanged — it consumes `passphrase` identically. (The #195 strong-recovery gate is enforced at `createNoydb` open time, not here — Task 2 wires the at-create enrollment so opening doesn't fail.)

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit** — `feat(hub): managed-mode owner on adopted partition (passphrase mint+seal) (#208)`

---

## Task 2: Mandatory strong recovery at create (#195 composition)

**Files:** `adopt-partition.ts`, test

> **Implement per the advisor-chosen approach (A/B/C).** Under (B): validate `recovery` includes a Shamir profile; mint the owner (Task 1); then drive `enrollRecovery` against the adopted store using the bypass window (mirror `openVaultAndEnrollRecovery` `noydb.ts:2034-2065`). Re-assert recovery on disk.

- [ ] **Step 1: Failing test** — managed adoption WITHOUT a strong recovery profile throws (`ValidationError`, mirroring `openVaultAndEnrollRecovery`'s message); WITH `recovery: [{ profile: 'shamir', k: 2, n: 3 }]` + an injected `shamirRecovery` provider succeeds, and the recipient can open managed (the #195 gate is satisfied because recovery is enrolled).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the recovery enrollment per the chosen approach. (Shamir provider injected from `@noy-db/on-shamir` in the test.)
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Full verification** — `pnpm typecheck && pnpm exec eslint src/bundle/adopt-partition.ts && pnpm vitest run`; existing standard-mode adoption + create-owner tests must still pass (the options union is additive). Commit.

---

## Task 3: Showcase + docs touch

- [ ] Extend showcase 88 (or a new `89-managed-adoption`) with the macOS-Keychain-style auto-unlock variant (using `MemorySealingKeyProvider` as a stand-in), demonstrating Belle's partition auto-unlocking with no passphrase.
- [ ] Update `docs/subsystems/transferable-partitions.md` "Edge cases & limits" — strike the "standard passphrase mode only" line; document managed adoption + the strong-recovery requirement.
- [ ] `node scripts/validate-features.mjs`; commit.

---

## Out of scope

- **Non-Shamir strong recovery** under managed mode — #195 treats Shamir as the strong profile; paper-only is rejected. Unchanged here.
- **`carryOverUsers`** (the #208 issue's magic-link invitations) — separate.

## Self-review notes

- **The passphrase half is low-risk** — `resolveManagedSecret` is the exact primitive `createNoydb` uses; managed adoption reuses it + the existing keyring/DEK-merge path.
- **The recovery half is the risk** — the #195 gate composition + Shamir provider injection. Hence the advisor-review-first gate and the explicit A/B/C fork.
- **Standard-mode adoption is untouched** — the options become a discriminated union; the existing signature is one arm of it.
- **Spec/docs:** updating `transferable-partitions.md` to drop the "standard mode only" limit is part of the slice, not an afterthought.
```
