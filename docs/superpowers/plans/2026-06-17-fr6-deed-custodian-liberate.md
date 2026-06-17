# FR-6 — Deed / Custodian / Liberate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **This touches the security-critical keyring core — every Role comparison site must be audited (a missed branch is a privilege-escalation bug).**

**Goal:** Sovereignty-preserving custody: a sealed/hidden owner (**Deed**), a 100%-operational-but-non-owning **Custodian** role, and an audited **Liberate** ceremony — per the design spec `docs/superpowers/specs/2026-06-17-fr6-deed-custodian-liberate-design.md`.

**Architecture:** Pure `@noy-db/hub` (custody is a vault-level concern; the keyring/sealing/ledger primitives all live in hub). The `custodian` role is added to the `Role` union; Deed provisioning reuses managed-mode sealing; Liberate reuses `freezeAndDeleteClosure` + owner-keyring minting. Surface on a new `vault.custody.*` namespace mirroring `vault.user.*`. `@klum-db/lobby` re-exports the custody types (no lobby logic in slice 1).

**Tech stack:** TypeScript, vitest, pnpm. Scope = pragmatic first cut (see spec §7): defer rotation-escrow, auto-abandonment, raw-store-bypass hardening of operational ops.

**Security invariants (the acceptance):**
1. Custodian operates fully (rw all collections) but is **provably unable** to grant / revoke / rotate / extract-and-sever.
2. The owner (sealed credential) can revoke the custodian + `extractPartition` **without the custodian's cooperation**.
3. Liberate claims ownership of a sealed-owner vault under an audited event; withdrawal **and** liberation both appear in the lifecycle ledger.
4. Inalienability is **cryptographic**: the custodian can never reach `KEK_owner` (sealed under a non-firm `SealingKeyProvider`).

---

## File structure

- **Modify** `packages/hub/src/types.ts` — widen `Role`; (gates live in policy/types).
- **Modify** `packages/hub/src/team/keyring.ts` — permission funcs handle `custodian`; block rotate.
- **Modify** `packages/hub/src/noydb.ts` — `ROLE_RANK`; `grantCustodian`/`revokeCustodian`.
- **Modify** `packages/hub/src/policy/types.ts` — add gate names.
- **Modify** `packages/hub/src/bundle/withdraw-accessible.ts`, `bundle/extract-partition.ts` — block custodian.
- **Create** `packages/hub/src/team/deed.ts` — Deed marker + provisioning.
- **Create** `packages/hub/src/custody/liberate.ts` + `packages/hub/src/custody/index.ts` (CustodyApi).
- **Modify** `packages/hub/src/vault.ts` — `vault.custody` wiring.
- **Modify** `packages/hub/src/index.ts`, `packages/lobby/src/index.ts` — exports.
- **Modify** `features.yaml`, `scripts/check-architecture.mjs` (ceiling bumps).

---

## Task 1 — `custodian` role: union + capabilities + gate names (hub kernel — RISKIEST) (TDD)

**Files:** `packages/hub/src/types.ts` (Role ~84), `packages/hub/src/team/keyring.ts` (50-81, 443, 558, 1244-1254), `packages/hub/src/noydb.ts` (ROLE_RANK ~141), `packages/hub/src/policy/types.ts` (BuiltInGateName ~93). Test `packages/hub/__tests__/custodian-role.test.ts`.

**Capabilities:** custodian = `admin`-level **rw + access on all collections**, but **`canGrant(custodian,*) = false`** and **`canRevoke(custodian,*) = false`**, and **NOT grantable by admin** (only owner can grant a custodian).

- [ ] **Step 1: Failing test** — create `custodian-role.test.ts` mirroring `access-control.test.ts` (inline-memory adapter, `createNoydb`, `grant`). Assert: (a) an owner can `grant({role:'custodian', permissions?})` and the custodian can read+write ALL collections; (b) the custodian **cannot** `grant(...)` (→ PermissionDeniedError); (c) the custodian **cannot** `revoke(...)`; (d) an **admin cannot** grant a custodian (only owner can). (Gate-name + provisioning tests come in later tasks.)

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.**
  1. `types.ts:84`: `export type Role = 'owner' | 'admin' | 'custodian' | 'operator' | 'viewer' | 'client'`. Update the doc-comment role matrix above it to describe custodian (rw-all, no grant/revoke/rotate/sever).
  2. `noydb.ts:141` `ROLE_RANK`: add `custodian: 4` (operationally admin-rank; owner stays 5). This is the exhaustive `Record<Role,number>` TS will flag — must update.
  3. `keyring.ts` `hasWritePermission` (1244): add `|| keyring.role === 'custodian'` to the all-true branch (custodian writes all).
  4. `keyring.ts` `hasAccess` (1251): add `|| keyring.role === 'custodian'` to the all-true branch.
  5. `keyring.ts` `canGrant` (52): custodian falls through to `return false` (already does — owner/admin are the only true branches; custodian returns false). **Verify** no change needed, but add an explicit early `if (callerRole === 'custodian') return false` for clarity + a comment.
  6. `keyring.ts` `canRevoke` (58): same — explicit `if (callerRole === 'custodian') return false`.
  7. `keyring.ts` `ADMIN_GRANTABLE_TARGETS` (50): do NOT add `'custodian'` (admin cannot grant custodian — only owner). Add a comment. Since `canGrant(admin, 'custodian')` → `ADMIN_GRANTABLE_TARGETS.includes('custodian')` → false. Good — verify.
  8. `keyring.ts:443` (grant DEK propagation — the branch where `owner|admin|viewer` get ALL DEKs): add `'custodian'` so a granted custodian receives all collection DEKs (operational). **Critical** — without this the custodian can't operate.
  9. `keyring.ts:558` (`findAdminDescendants` skip `kf.role !== 'admin'`): leave as-is (custodian is not an admin-descendant cascade root) — but add a comment confirming custodian is intentionally excluded from admin cascade.

- [ ] **Step 4: Run → pass.** Then **audit every other Role comparison site** the recon flagged (`team/tiers.ts:63` assertTierAccess — custodian should pass tiers like admin; `collection.ts:4640` canAmend — custodian = admin; `team/sync-credentials.ts:79` — custodian must NOT issue sync creds: block it). For each: decide custodian's behavior, implement, and add a one-line test or assertion. Full `pnpm --filter @noy-db/hub test` (no regression), typecheck (catches ROLE_RANK), lint, `pnpm check:architecture`.

- [ ] **Step 5: Commit** — `git commit -am "feat(hub): custodian role — rw-all operations, no grant/revoke (FR-6 Task 1)"`

**Also in this task (gate names, self-contained):** add `'grant-custodian'` and `'liberate-vault'` to `BuiltInGateName` (`policy/types.ts:93`). Add a quick test asserting both fail-closed by default (no policy → `checkGate` throws `disabled`) and pass when `{enabled:true,minTier:1}`. (Mirror a `client-unilateral-withdraw` gate test.)

---

## Task 2 — Block custodian from rotate / sever / extract (hub security boundary) (TDD)

**Files:** `packages/hub/src/team/keyring.ts` (top of `rotateKeys` ~756), `packages/hub/src/bundle/withdraw-accessible.ts` (role guard ~126), `packages/hub/src/bundle/extract-partition.ts` (owner check ~255). Test: extend `custodian-role.test.ts`.

- [ ] **Step 1: Failing tests** — append: a custodian (a) cannot `db.rotate(...)` (→ PermissionDeniedError); (b) cannot `vault.user.unilateralWithdrawal(...)` destructive sever (→ ReadOnlyError/PermissionDeniedError, redirected to liberate); (c) cannot `extractPartition(vault, ...)` (→ PermissionDeniedError). These prove invariant #1's "re-key / extract / sever" half.

- [ ] **Step 2: Run → fail** (custodian currently treated as admin in some paths).

- [ ] **Step 3: Implement.**
  - `keyring.ts` `rotateKeys` (~756, top): `if (callerKeyring.role === 'custodian') throw new PermissionDeniedError('custodian cannot rotate keys (FR-6: re-key is an owner meta-capability)')`. (Confirm the param name holding the caller keyring + the PermissionDeniedError import.)
  - `withdraw-accessible.ts` (~126): extend the `owner|admin` rejection (or add a dedicated branch) so `role === 'custodian'` throws with a message pointing to `liberateVault` — the custodian must not destructively sever; it liberates via the audited ceremony.
  - `extract-partition.ts` (~255): the owner-only guard — confirm custodian is rejected (it's not owner, so likely already throws; make the message explicit and add the assertion).

- [ ] **Step 4: Run → pass.** Full hub test (no regression — ensure existing owner/admin/operator paths unchanged), typecheck, lint, architecture.

- [ ] **Step 5: Commit** — `git commit -am "feat(hub): block custodian from rotate/sever/extract (FR-6 Task 2)"`

---

## Task 3 — Deed marker + provisioning (hub, managed-mode seam) (TDD)

**Files:** Create `packages/hub/src/team/deed.ts`. Test `packages/hub/__tests__/deed.test.ts`.

**Context:** Deed = a sealed owner under a **non-firm** `SealingKeyProvider` + a `_meta/deed` marker. Reuses `resolveManagedSecret` (managed-passphrase.ts:523) + `createOwnerKeyring`. `SealingKeyProvider` = `{ id, seal(Uint8Array)→Uint8Array, unseal(Uint8Array)→Uint8Array }` (managed-passphrase.ts:72). `MemorySealingKeyProvider` exists for tests.

- [ ] **Step 1: Failing test** — `deed.test.ts`: with a `MemorySealingKeyProvider` ('client-kms'), `createDeedOwner(store, vault, 'client-01', provider)` → the vault has a latent owner sealed under that provider; `loadDeedMarker(store, vault)` returns `{ ownerUserId:'client-01', sealedUnder:'client-kms', latent:true, issuedAt }`; `isDeedVault(store, vault)` → true; a fresh vault → false. Then assert the owner can be re-opened via the SAME provider (managed unseal) — proving the latent owner needs no interactive passphrase.

- [ ] **Step 2: Run → fail** (module missing).

- [ ] **Step 3: Implement** `deed.ts`:
  - `DEED_RECORD_ID = 'deed'`; `DeedMarker` interface `{ ownerUserId; sealedUnder: string; latent: true; issuedAt: string; liberatedAt?: string }`.
  - `async createDeedOwner(store, vault, ownerUserId, sealing: SealingKeyProvider): Promise<UnlockedKeyring>` — call `resolveManagedSecret(store, vault, sealing)` to mint+seal the passphrase (writes `_meta/sealed-passphrase`), then `createOwnerKeyring(store, vault, ownerUserId, <resolved passphrase>)`, then write the `_meta/deed` marker (`store.put(vault, '_meta', DEED_RECORD_ID, env)` — mirror `saveSealedPassphrase`'s envelope shape; the marker is plaintext metadata). Return the unlocked owner keyring.
  - `async loadDeedMarker(store, vault): Promise<DeedMarker | null>`; `async isDeedVault(store, vault): Promise<boolean>`.
  - Read `managed-passphrase.ts` to use `resolveManagedSecret`'s real signature; if it's not exported, export it or use the public managed-mode entry the test harness uses.

- [ ] **Step 4: Run → pass.** typecheck + lint + full hub test. (New file — exempt from kernel ceilings.)

- [ ] **Step 5: Commit** — `git commit -am "feat(hub): Deed marker + sealed-owner provisioning (FR-6 Task 3)"`

---

## Task 4 — `grantCustodian` / `revokeCustodian` on Noydb (TDD)

**Files:** `packages/hub/src/noydb.ts` (near `grant`/`revoke` ~714/734). Test: extend `custodian-role.test.ts` or a new `custodian-grant.test.ts`.

- [ ] **Step 1: Failing test** — owner provisions a Deed vault (Task 3), then `db.grantCustodian(vault, { userId:'firm-01', displayName, passphrase })` (gate `'grant-custodian'` enabled in policy); the firm opens + operates fully; `db.revokeCustodian(vault, { userId:'firm-01' })` (as owner) removes it. Assert grantCustodian throws when the `'grant-custodian'` gate is disabled (fail-closed) and when the caller is not owner.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** two methods (mirror `grant`/`revoke` at 714/734):
```ts
async grantCustodian(vault: string, options: Omit<GrantOptions,'role'>, factors?: FactorProofBundle): Promise<void> {
  this.checkPolicyOperation(vault, 'grant')
  await this.checkGate(vault, 'grant-custodian', factors)
  const keyring = await this.getKeyringInternal(vault)
  if (keyring.role !== 'owner') throw new PermissionDeniedError('only the Deed owner can grant a custodian')
  await keyringGrant(this.options.store, vault, keyring, { ...options, role: 'custodian' })
}
async revokeCustodian(vault: string, options: RevokeOptions, factors?: FactorProofBundle): Promise<void> {
  this.checkPolicyOperation(vault, 'revoke')
  await this.checkGate(vault, 'revoke-user', factors)
  const keyring = await this.getKeyringInternal(vault)
  if (keyring.role !== 'owner') throw new PermissionDeniedError('only the Deed owner can revoke a custodian')
  await keyringRevoke(this.options.store, vault, keyring, options)
}
```
  - **Ceiling:** `noydb.ts` ceiling is 3095 — bump to 3140 in `scripts/check-architecture.mjs` with justification ("FR-6 custody API: genuinely-core grant/revoke surface").

- [ ] **Step 4: Run → pass.** Full hub test, typecheck, lint, architecture.

- [ ] **Step 5: Commit** — `git commit -am "feat(hub): grantCustodian/revokeCustodian (FR-6 Task 4)"`

---

## Task 5 — `liberateVault` ceremony (TDD)

**Files:** Create `packages/hub/src/custody/liberate.ts`. Test `packages/hub/__tests__/liberate.test.ts`.

**Context:** Manual audited claim. The custodian (holds the DEKs) claims ownership: freeze a pre-liberation snapshot, mint a NEW owner keyring re-wrapping the incumbent DEKs under a new KEK (NOT unsealing the old owner — preserves the inalienability floor), ledger-audit. Reuses `freezeAndDeleteClosure` (withdraw-accessible.ts:68, disposition `'freeze'`) + `createOwnerKeyring` + the DEK re-wrap from `adopt-partition.ts:297-302` + `vault._getLedgerOrNull()?.append`.

- [ ] **Step 1: Failing test** — `liberate.test.ts`: a Deed vault with a granted custodian; the custodian calls `liberateVault(vault, { newOwnerId:'firm-01', newOwnerPassphrase, legalBasis:'contractual-handover' })` (gate `'liberate-vault'` enabled). Assert: returns `{ snapshot: FrozenSnapshotRef }` with a 64-hex sha256; a `liberation-claimed:firm-01:contractual-handover` lifecycle ledger entry exists; the new owner can operate; the OLD sealed-owner credential is orphaned (not impersonated). Also: gate disabled → throws; caller not custodian → throws.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `liberate.ts`:
```ts
export interface LiberateOptions {
  readonly newOwnerId: string
  readonly newOwnerPassphrase: string
  readonly legalBasis: string
  readonly factors?: FactorProofBundle
}
export interface LiberateResult { readonly snapshot: FrozenSnapshotRef }

export async function liberateVault(vault: Vault, opts: LiberateOptions): Promise<LiberateResult> {
  // 1. gate
  await vault.noydb.checkGate(vault.name, 'liberate-vault', opts.factors)
  // 2. caller must be the custodian (de-facto authority holding the DEKs)
  const keyring = vault.keyring // confirm accessor; else vault._introspectState()
  if (keyring.role !== 'custodian') throw new PermissionDeniedError('liberation is claimed by the custodian')
  // 3. freeze a pre-liberation evidence snapshot of all collections
  const collections = /* all collection names — reuse the helper withdraw uses (resolveAccessibleCollections / vault collection list) */
  const snapshot = await freezeAndDeleteClosure(vault, collections, { disposition: 'freeze', actorUserId: keyring.userId })
  // 4. mint a NEW owner keyring, re-wrapping the incumbent DEKs under the new owner KEK
  //    (mirror adopt-partition.ts:297-302; source DEKs = keyring.deks)
  const newOwner = await createOwnerKeyring(adapter, vault.name, opts.newOwnerId, opts.newOwnerPassphrase)
  // re-wrap each DEK from keyring.deks under newOwner.kek, write _keyring/<newOwnerId>
  // 5. ledger audit
  await vault._getLedgerOrNull()?.append({ op:'lifecycle', collection:'', id:'', version:0,
    actor: opts.newOwnerId, payloadHash:'', reason:`liberation-claimed:${opts.newOwnerId}:${opts.legalBasis}` })
  // 6. update _meta/deed marker → liberatedAt
  return { snapshot: snapshot! }
}
```
  - Read `withdraw-accessible.ts` for `freezeAndDeleteClosure`'s exact signature + how it lists collections; read `adopt-partition.ts:270-302` for the precise re-wrap (`wrapKey(dek, kek)` + KeyringFile write). Confirm `vault.keyring`/`vault.adapter`/`vault.noydb.checkGate`/`vault._getLedgerOrNull` accessors (use `_introspectState()` if `keyring`/`adapter` aren't public).
  - **Note on freeze semantics:** `freezeAndDeleteClosure` with `disposition:'freeze'` writes a hash-pinned snapshot then DELETES live records. For liberation we want the data PRESERVED for the new owner, not deleted. **Decide:** either (a) use `disposition:'freeze'` for the evidence snapshot but the new owner re-adopts from it, or (b) snapshot WITHOUT delete (a read-only hash-pin) so the live data stays for the new owner. **Prefer (b)** — liberation transfers operation continuity; add a snapshot-only helper or pass a flag. Confirm against the freeze code and pick the path that leaves live data intact for the new owner. Document the choice in the test.

- [ ] **Step 4: Run → pass.** Full hub test, typecheck, lint, architecture. (New file — ceiling-exempt.)

- [ ] **Step 5: Commit** — `git commit -am "feat(hub): liberateVault audited ceremony (FR-6 Task 5)"`

---

## Task 6 — `vault.custody.*` surface + exports (TDD)

**Files:** Create `packages/hub/src/custody/index.ts` (CustodyApi); `packages/hub/src/vault.ts` (`public readonly custody` + wiring ~583); `packages/hub/src/index.ts` + `packages/lobby/src/index.ts` (exports). Test `packages/hub/__tests__/custody-api.test.ts` (the end-to-end acceptance scenarios).

- [ ] **Step 1: Failing test** — `custody-api.test.ts`: the FULL acceptance walkthrough via `vault.custody.*`:
  - provision a Deed vault; `vault.custody.grantCustodian({...})`; custodian operates fully but `vault.custody`/grant/rotate/sever all denied;
  - owner (re-opened via the sealing provider) `revokeCustodian` + `extractPartition` with custodian offline;
  - custodian `vault.custody.liberate({legalBasis})` mints a new owner; ledger shows a prior withdrawal AND the liberation.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.**
  - `custody/index.ts`: `CustodyApi` class mirroring `UserApi` (api.ts:123) — constructor takes injected callbacks `(grantCustodian, revokeCustodian, liberate, provisionDeed?)`; methods delegate.
  - `vault.ts`: `public readonly custody: CustodyApi` (declare ~282), wire in the constructor (~583) mirroring `this.user = new UserApi(...)` — inject closures calling `this.noydb.grantCustodian(this.name, ...)`, `revokeCustodian`, and `liberateVault(this, ...)`. **Ceiling:** bump `vault.ts` 4520→4545 in check-architecture.mjs (justified: custody surface field + wiring).
  - `hub/src/index.ts`: export `CustodyApi`, `liberateVault`, `createDeedOwner`/`loadDeedMarker`/`isDeedVault`, `DeedMarker`, `LiberateOptions`/`LiberateResult`.
  - `lobby/src/index.ts`: re-export the custody types (no lobby logic in slice 1).

- [ ] **Step 4: Run → pass.** Full hub + lobby test, typecheck, lint, architecture.

- [ ] **Step 5: Commit** — `git commit -am "feat(hub): vault.custody.* surface + exports (FR-6 Task 6)"`

---

## Task 7 — features.yaml + full verification

**Files:** `features.yaml`.

- [ ] **Step 1: features.yaml** — add a `sovereign-custody` (or `deed-custodian-liberate`) entry mirroring a sibling hub feature: artefacts `packages/hub/src/custody/`, `packages/hub/src/team/deed.ts`; spec the FR-6 design spec; package `@noy-db/hub`; status `preview`. Invariants summarizing the 4 security invariants. `node scripts/validate-features.mjs` passes.
- [ ] **Step 2: Full verification:**
```bash
pnpm --filter @noy-db/hub build && pnpm --filter @klum-db/lobby build
pnpm --filter @noy-db/hub test && pnpm --filter @klum-db/lobby test
pnpm lint && pnpm typecheck
node scripts/validate-features.mjs
pnpm check:architecture
```
All green.
- [ ] **Step 3: Commit** — `git commit -am "feat: register sovereign-custody feature + verify (FR-6)"`

---

## Self-Review

**Spec coverage (issue #446 + design spec):**
- (a) sealed/auto-owner → Task 3; custodian operates fully but cannot grant/revoke/rotate/extract/sever → Tasks 1+2 (proven by denial tests).
- (b) owner revokes custodian + extracts without cooperation → Task 4 (revokeCustodian, owner-only) + Task 6 acceptance test (custodian offline).
- (c) liberation claims ownership under an audited event; withdrawal + liberation both in ledger → Task 5 + Task 6 acceptance test.
- inalienability cryptographic → Task 3 (non-firm sealing) — custodian never holds `KEK_owner`.

**Placeholder scan:** every task cites exact files/lines from the recon; the two genuine implementation decisions are called out explicitly (Task 5's freeze-vs-snapshot-only for liberation continuity; Task 1's audit of all 15+ Role sites). Implementers must read the cited code to confirm accessors before writing.

**Risk notes:** Task 1 is the riskiest (Role union widening → privilege-escalation if a comparison site is missed; the recon enumerated all 15+ sites — audit each). TS flags only `ROLE_RANK`; the rest are manual. Deferred (spec §7): rotation-escrow, auto-abandonment, raw-store-bypass hardening of operational ops — documented, not silently dropped. New files (deed.ts, custody/*) are ceiling-exempt; noydb.ts (3095→3140) + vault.ts (4520→4545) bumped first (raise-first playbook). The final whole-FR review must specifically probe: can a custodian reach owner via ANY path (grant-self-owner, rotate-then-strip, direct extract)?
