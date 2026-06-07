# `openVault` No-Self-Provision — Design (#313)

- **Date:** 2026-06-08
- **Issue:** #313 (split from #312, custodial multi-tenant federation)
- **Status:** Design approved (pending spec review)
- **Release:** dedicated **`0.2.0-pre.11`** — security fix, off `main`
- **Severity:** key-custody / data-integrity hole — an un-granted identity self-provisions owner access into another principal's vault

## Goal

Close a hub-wide hole: opening a vault you lack a grant to **silently mints a fresh owner
keyring (new DEKs) into that vault** instead of failing. Make `openVault` create a keyring
**only for a genuinely-new vault** (no `_keyring/*` at all); opening a populated vault you are
not a member of **fails closed** (`NoAccessError`, nothing written). Introduce an additive
`openVault({ create?: boolean })` flag (also consumed by the federation slice).

## Background — the hole

`loadKeyring` (`team/keyring.ts`) throws `NoAccessError` whenever **this** identity's
`_keyring/<userId>` envelope is absent — it does **not** check whether *other* principals'
keyrings exist. `getKeyringInternal` (`noydb.ts`) catches `NoAccessError` and treats it as
"first boot — create owner keyring":

```ts
if (err instanceof NoAccessError) {
  // "No keyring on disk — first boot or cleared store."
  keyring = await createOwnerKeyring(...)   // mints a fresh OWNER keyring + new DEKs, writes it into the vault
}
```

So any identity that opens an **existing, populated** vault it lacks a grant to:
1. self-provisions a stray owner keyring (new DEKs) into that vault, and
2. reads **zero records** (the new DEKs can't decrypt the real owner's ciphertext) — **no error**.

It never bit the single-tenant model (you only open vaults you own). It surfaces under scoped,
multi-principal access (the #312 custodial adopter: advisors, insight executors, drill-down,
bundle adopt, recovery — many paths `openVault` by name).

## Blast radius (verified)

The implicit create-on-open is **one branch** — `getKeyringInternal`'s `NoAccessError` catch.
Everything else is already safe:

- **`getKeyring` callback path** (WebAuthn / OIDC / Shamir): documented "no automatic
  `NoAccessError` → `createOwnerKeyring` fallback — the callback owns open-vs-create." Untouched.
- **`onInvalidKey: 'reset'` branch**: a *different* scenario — the caller's **own** keyring exists
  but is stale (`InvalidKeyError`); reset deletes and recreates the caller's own row. Orthogonal,
  untouched.
- **`adoptPartition`** (the only other `createOwnerKeyring` caller): calls it **directly** (not via
  `openVault`) and **already guards** on `store.list(vault,'_keyring')` for existing owners.
  Untouched.
- **Internal `openVault` callers** — `queryAcross` and `openVaultAndEnrollRecovery` (first-owner
  enroll on a *new* vault): fine under the gate.
- **Plaintext mode** (`encrypt:false`): returns a plaintext keyring early — no create path.

So the *only* behavior that changes is create-on-open of a **populated vault by a non-member** —
which is always the bug. Every legitimate create-on-open (first-owner, recovery enroll, fixtures,
plaintext→encrypted migration) acts on a genuinely-empty vault and is preserved.

## The fix

### 1. Pre-gate — *before* any vault write (`getKeyringInternal`, `noydb.ts`)

**Placement matters.** `getKeyringInternal` runs `resolveManagedSecret` *before* `loadKeyring`, and
on first open `resolveManagedSecret` **mints + seals + persists `_meta/sealed-passphrase` into the
vault** (`team/managed-passphrase.ts:24-25`). A gate in the `loadKeyring` catch would fire **after**
that write — so in **managed-passphrase mode** (the custodial adopter's mode: KMS-backed server,
shared sealing key) a non-member opening a populated vault would already have written a sealed-secret
artifact before failing. The gate therefore sits **before `resolveManagedSecret`**, on the encrypted
path, after the `getKeyring`-callback short-circuit:

```ts
// encrypted path, after the getKeyring-callback return, BEFORE resolveManagedSecret:
const keyringUsers = await this.options.store.list(vault, '_keyring')
const callerIsMember = keyringUsers.includes(this.options.user)
if (!callerIsMember) {
  // The caller has no keyring in this vault.
  if (opts.create === false) throw new NoAccessError(/* strict open-existing */)
  if (keyringUsers.length > 0) throw new NoAccessError(/* populated by other principals → fail closed, no self-provision */)
  // else: genuinely-new vault (no _keyring/* at all) → fall through to the normal mint+create path
}
```

- **`callerIsMember`** → fall through: `resolveManagedSecret` (if managed) + `loadKeyring` load the
  caller's existing keyring as today.
- **not a member, `create: false`** → throw immediately (strict open-existing; federation reads/drill-down).
- **not a member, others exist** → throw (fail closed) — **nothing written** (we're before `resolveManagedSecret`).
- **not a member, no keyrings at all** → genuinely-new → fall through; the existing `loadKeyring`
  `NoAccessError` → `createOwnerKeyring` path mints the first-owner keyring as today.

One `store.list(vault, '_keyring')` (capability-free; the same call `_shardVaultProvisioned`
uses at `noydb.ts:1026`). The existing `NoAccessError` → `createOwnerKeyring` branch in the
`loadKeyring` catch is now reached **only** for the genuinely-new case the pre-gate let through, so
its `createOwnerKeyring` stays as-is (single decision point = the pre-gate).

### 2. Additive `create` flag

```ts
async openVault(name: string, opts?: { locale?: string; create?: boolean }): Promise<Vault>
private async getKeyringInternal(vault: string, opts: { create: boolean } = { create: true }): Promise<UnlockedKeyring>
```
- `create` default `true` → create **iff** the vault has no `_keyring/*` (the new safe default).
- `create: false` → never create; a missing grant throws `NoAccessError`.
- **No force option** — there is no way to create into a populated vault you are not a member of.
  No current caller needs it (verified); add later only if a real need appears.

`openVault` threads `opts?.create` into `getKeyringInternal({ create: opts?.create !== false })`.
`queryAcross` gains `create?: boolean` in `QueryAcrossOptions` (`types.ts`) and threads it into its
internal `openVault(vaultId, { create: options.create !== false })`.

## Interaction with the federation slice (#312)

The cross-vault-live slice's plan (Phase 1, Task 2) introduced this same flag. **#313 owns and
lands it first** on `main`; the federation slice then only **consumes** it (`create: false` on the
read fan-out + `openShard`). After #313 merges, trim the cross-vault plan's Task 2 to "pass
`create: false`" and rebase the federation branches. (`createShard` keeps the default — it only
ever creates genuinely-new shards, which the gate permits.)

**Re-confirm at trim time:** once this pre-gate is on `main`, a non-granted shard open fails closed
**regardless** of the `create` flag (populated shard → other principals exist → `NoAccessError`),
and the provisioning guard already filters empty shards out of the fan-out. So federation's
`create: false` likely becomes **belt-and-suspenders** (explicit intent) rather than the
load-bearing safety property — which now comes from #313. When trimming Task 2, state it as intent,
not as the thing that closes the hole, so the federation plan doesn't claim a safety guarantee that
actually lives here.

## Error handling
- Populated vault, non-member → `NoAccessError` (nothing written). The fail-closed signal.
- `create: false` on any not-yet-accessible vault → `NoAccessError`.
- All other `loadKeyring` errors (`KeyringCorruptError`, `InvalidKeyError` without reset) → propagate
  unchanged (`else throw err`).

## Testing

**Step 0 (front-load the blast radius — the release framing depends on it):** the change is ~5
lines; prototype it and run the **full hub suite first**, before writing the rest. The owner's
theory is "no *legitimate* create-into-populated caller exists," so any breakage is expected to be
a test that relied on the hole — but confirm *what* breaks and *why* before committing to the
"dedicated security release" narrative. Each genuine break is fixed by granting the second identity
first (the correct pattern, per `cross-vault.test.ts`).

`packages/hub/__tests__/no-self-provision.test.ts` (new; reuse the inline `memory()` adapter from
`__tests__/cross-vault.test.ts`; add a `storeKeys(adapter)` helper that snapshots all `(compartment,
collection, id)` triples):
1. **Fail-closed, nothing written (default mode):** alice creates+populates `v`; snapshot store keys;
   bob `openVault('v')` → rejects `NoAccessError`; assert the store-key set is **byte-for-byte
   unchanged** (not just `_keyring/bob` absent — **no** `_meta/*` or any artifact appeared).
2. **Fail-closed, nothing written (MANAGED mode):** same as #1 but bob's `Noydb` is
   `passphraseMode: 'managed'` with a sealing provider → rejects `NoAccessError` and asserts **no
   `_meta/sealed-passphrase`** (or anything) was written into `v` (this is the case the pre-gate
   placement exists for; a gate-in-the-catch would fail this test).
3. **New-vault create preserved:** alice `openVault('fresh')` → succeeds; `_keyring/alice` written;
   write+read round-trips.
4. **`create: false` never creates:** even on a fresh vault → rejects `NoAccessError`; no keyring.
5. **Granted member opens fine:** alice grants bob on `v`; bob `openVault('v')` → succeeds, reads
   alice's records.

## Files
- Modify `packages/hub/src/noydb.ts` — `openVault` opts, `getKeyringInternal` signature + gated
  `NoAccessError` branch, `queryAcross` threading.
- Modify `packages/hub/src/types.ts` — `QueryAcrossOptions.create?`.
- Create `packages/hub/__tests__/no-self-provision.test.ts`.
- Modify `packages/hub/CHANGELOG.md` — **SECURITY** entry; lockstep bump to `0.2.0-pre.11`.

## Release
Dedicated **`0.2.0-pre.11`** off `main`, lockstep bump (all packages), **SECURITY** CHANGELOG note:
"`openVault` no longer self-provisions an owner keyring into a vault held by other principals —
opening a populated vault you lack a grant to now fails closed with `NoAccessError`. New
(genuinely-empty) vaults still open-or-create as before. New opt-in `openVault({ create: false })`
forces strict open-existing." Behavior change is a security fix (the prior behavior was a hole);
not a breaking API change (the signature is additive).

## Relationship to existing work
| Prior work | Relationship |
|---|---|
| #312 / cross-vault slice | Introduced the `create` flag for the fan-out; #313 owns it + the global semantics, lands first |
| `adoptPartition` (`bundle/adopt-partition.ts`) | Already guards `store.list('_keyring')`; unaffected reference for the same pattern |
| `_shardVaultProvisioned` (`noydb.ts:1026`) | Same `store.list(vault,'_keyring').length` check, reused as the genuinely-new discriminator |
| `getKeyring` callback / `onInvalidKey:'reset'` | Out of scope — both already avoid the implicit create |
