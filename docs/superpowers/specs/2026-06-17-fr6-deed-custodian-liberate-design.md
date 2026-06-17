# FR-6 — Deed / Custodian / Liberate (sovereignty-preserving custody) — Design Spec

**Issue:** #446 (pilot-1 epic #440). **Status:** design — pending review.
**Scope decision:** *pragmatic first cut* (see §7). **Lexicon:** Deed / Custodian / Liberate (spec §7 of the Lobby framework design).

---

## 1. Problem & thesis

A tax firm is a **processor**; the **client owns** the data (PDPA/GDPR). Today the only way to give the firm full operational access is to make it `owner` or `admin` — which also hands it the meta-capabilities (revoke, re-key, extract-and-sever, grant). We want the inverse topology of `#198 reKey` (full handoff): the firm operates at 100% while the **client holds the inalienable root from day one — hidden and flattened** (the client never has to authenticate). This is the embodiment of klum-db's "counterbalance to tech giants holding data hostage."

The model has three parts:
- **(a) Deed** — an auto-generated, *sealed*, *hidden* owner credential established at provisioning. The vault is owned by a principal who never authenticates (latent owner). Owning ≠ operating.
- **(b) Custodian** — a grant that is **100% operational** (full read/write on all collections) yet **provably cannot**: revoke the owner or other grantees, re-key (rotate), extract-and-sever, or grant new parties. The firm.
- **(c) Liberate** — an authorized, audited claim of ownership over a sealed-owner vault (abandonment / contractual handover) — the **inverse of #199 withdrawal** (there the owner severs the host; here the host ascends to owner). Same key-topology family, opposite direction; both audited + evidence-reversible.

## 2. What already exists (reused, not rebuilt)

(From the FR-6 reconnaissance.)
- **Roles** (`hub/src/types.ts:84`): `owner | admin | operator | viewer | client`. `owner` is non-revocable (`team/keyring.ts canRevoke` blocks `owner`). Permission checks: `hasWritePermission`/`hasAccess`/`canGrant`/`canRevoke`.
- **Keyring/key-custody** (`team/keyring.ts`): passphrase → `deriveKey` → **KEK**; per-collection random **DEK** wrapped `AES-KW(DEK, KEK)` in `_keyring/<userId>`. `grant()` wraps the SAME DEKs under a grantee's KEK. `revoke()` removes a keyring. `rotateKeys()` mints fresh DEKs + **strips other users' DEK entries** (the escrow problem).
- **Managed mode / sealed owner** (`noydb.ts`, `bundle/adopt-partition.ts`): `passphraseMode:'managed'` mints a random passphrase, sealed under a **`SealingKeyProvider`** (KMS/keychain); `_meta/sealed-passphrase`; Shamir recovery via `ShamirRecoveryProvider`; `openVaultAndEnrollRecovery` / `recoverManagedPassphrase`.
- **#199 withdrawal** (`bundle/withdraw-accessible.ts`, `bundle/request-withdrawal.ts`): `exportAccessibleData` (non-destructive), `withdrawAccessibleData` (delete/freeze), two-party `requestWithdrawal`/`approveWithdrawal`/`rejectWithdrawal`, `freezeAndDeleteClosure` + hash-pinned `FrozenSnapshotRef`. Surfaced on `vault.user.*`.
- **Lifecycle ledger** (`history/ledger/entry.ts`): `op:'lifecycle'` + a semantic `reason` string (e.g. `partition-handed-over:<sealId>`, `creation-of-new-owner:<userId>`, `user-withdrawal-approved:...`).
- **Lobby** (`lobby/src/index.ts`): thin orchestrator over a `Noydb` + vault-template registry; re-exports the FR-2/3/4/8 interchange surface.

`Deed`, `Custodian`, `Liberate` are **net-new symbols** (verified).

## 3. The key topology (the heart of FR-6)

```
                 ┌─────────────────────────────────────────────┐
   CLIENT  ───►  │ Deed = OWNER keyring (role 'owner')          │
 (latent,        │   KEK_owner  ⇐ sealed passphrase             │
  never auths)   │   sealed under  SealingKeyProvider_client    │  ◄── non-firm trust boundary
                 │   wraps:  AES-KW(DEK_c, KEK_owner)  ∀ c      │
                 └─────────────────────────────────────────────┘
                                     │  (same DEKs, different wrap)
                 ┌─────────────────────────────────────────────┐
   FIRM    ───►  │ Custodian keyring (role 'custodian')         │
 (operates       │   KEK_cust ⇐ firm passphrase / firm sealing  │
  100%)          │   wraps:  AES-KW(DEK_c, KEK_cust)  ∀ c      │
                 │   CANNOT: rotate · revoke · grant · sever    │
                 └─────────────────────────────────────────────┘
```

**Why inalienability is cryptographic, not a soft check:**
The Deed (owner) credential is sealed under a `SealingKeyProvider` that the **Custodian/firm does not control** (client-held KMS, or a neutral escrow named at provisioning). The Custodian holds the DEKs (so it operates fully) but can **never obtain `KEK_owner`** → can never act *as* the owner. The owner can always unseal (via the client boundary), revoke the Custodian, and `extractPartition` **without the Custodian's cooperation** (acceptance #2). The operational constraints on the Custodian (no rotate/grant/revoke/sever) are enforced **structurally in the role matrix** (acceptance #1); the *inalienability of ownership itself* is the crypto floor above.

**Trust-boundary honesty (documented, not hand-waved):** in the pragmatic first cut the no-rotate/no-grant/no-revoke constraints are enforced at the API + role layer. A Custodian with **raw `NoydbStore` access** that bypasses the API is out of scope for slice 1 (same posture as today's `canRevoke`); the **ownership anchor** (custodian can't unseal `KEK_owner`) still holds against raw access because it is cryptographic. Closing the raw-access gap on the operational ops is a Phase-2 follow-up (see §7).

## 4. The `custodian` role

Add `'custodian'` to the `Role` union. Semantics = `admin`-level **operation** minus the meta-capabilities:

| Capability | owner | admin | **custodian** | operator |
|---|---|---|---|---|
| rw on all collections | ✓ | ✓ | **✓** | explicit only |
| grant roles | all | ≤admin | **✗** | ✗ |
| revoke roles | all | ≤admin | **✗** | ✗ |
| rotate keys | ✓ | ✓ | **✗** | ✗ |
| extract-and-sever (withdraw destructive) | ✓ | ✓ | **✗** | self only |
| export accessible (non-destructive copy) | ✓ | ✓ | **✓** | self scope |

Enforced in: `hasWritePermission` (custodian → true, like admin), `hasAccess` (custodian → true), `canGrant(custodian, *) → false`, `canRevoke(custodian, *) → false`, and a guard in `rotateKeys` / the destructive `withdraw` path rejecting `role==='custodian'`. New policy gates back the ceremonies (§6).

## 5. On-disk markers & audit

- **`_meta/deed`** — records the Deed at provisioning: `{ ownerUserId, sealedUnder: <provider descriptor / 'client-kms' | 'neutral-escrow'>, issuedAt, latent: true }`. Marks the owner keyring as Deed-inalienable.
- **Lifecycle ledger** (`op:'lifecycle'`, reused) reasons:
  - `deed-issued:<ownerUserId>`
  - `custodian-granted:<custodianUserId>`
  - `custodian-revoked:<custodianUserId>`
  - `liberation-claimed:<newOwnerUserId>:<legalBasis>` (+ a `FrozenSnapshotRef` of the pre-liberation state, mirroring withdrawal's frozen snapshot for evidence-reversibility).

Every FR-6 ceremony writes a ledger entry; withdrawal **and** liberation therefore both appear in the lifecycle ledger (acceptance #3).

## 6. Ceremonies / API surface

Custody is **per-vault** (a Deed belongs to one client vault); the `Lobby` may later offer fleet-wide wrappers (a firm holding Custodian grants over many client shards) — not in this slice. Surface attaches on the vault (mirroring `vault.user.*`), under a new **`vault.custody.*`** namespace, with hub functions in a new `hub/src/custody/` module.

1. **Provision with Deed** — extend vault creation / a `provisionWithDeed(...)`:
   - mint the owner keyring (role `owner`) with a random passphrase **sealed under the supplied non-firm `SealingKeyProvider`** (reuse managed-mode sealing); write `_meta/deed`; ledger `deed-issued`. The client is latent (never authenticates).
2. **`vault.custody.grantCustodian({ custodianUserId, passphrase | sealing })`** — owner-gated; mints a `custodian`-role keyring wrapping the existing DEK set under the custodian's KEK; ledger `custodian-granted`. Gate: `grant-custodian`.
3. **`vault.custody.revokeCustodian({ custodianUserId })`** — owner-only (the owner can do this without the custodian's cooperation, via the sealed credential); removes the custodian keyring; ledger `custodian-revoked`. (Reuses `revoke()`.)
4. **`vault.custody.liberate({ legalBasis, newOwner })`** — the manual audited claim. The de-facto authority (custodian, who holds the DEKs) claims ownership: freeze a pre-liberation snapshot (`freezeAndDeleteClosure` disposition `freeze` → `FrozenSnapshotRef`), mint a **new** owner keyring (re-wrap the DEKs under the new owner's KEK — the original sealed owner is NOT unsealed, preserving the inalienability floor; liberation MINTS a new owner, it does not impersonate the old one), ledger `liberation-claimed`. Gate: `liberate-vault` (default-off, requires `legalBasis`). Evidence-reversible via the frozen snapshot + ledger.

## 7. Scope: in / deferred

**In this slice (meets all of #446 acceptance):**
- `custodian` role + the meta-capability constraints (rotate/grant/revoke/sever blocked).
- Deed provisioning = sealed-owner under a **non-firm** `SealingKeyProvider` + `_meta/deed` + crypto-anchored inalienability.
- `grantCustodian` / `revokeCustodian` (owner can revoke + `extractPartition` without custodian cooperation).
- `liberate` = manual audited ceremony (freeze snapshot + mint new owner + ledger); withdrawal & liberation both in the lifecycle ledger.
- Policy gates: `grant-custodian`, `liberate-vault`.

**Deferred (documented limitations + follow-up issues):**
- **Custodian survives key rotation (the escrow problem).** Today `rotateKeys` strips non-rotating users' DEKs. In slice 1 the **owner** is blocked from rotating away the custodian by gating, and the custodian cannot rotate at all; a *deliberate* owner rotation that re-grants the custodian afterward is the supported path. KMS-escrow (custodian DEKs always re-wrapped under a firm KMS key at rotation) is Phase 2.
- **Auto-abandonment detection** for Liberate (time-lock / quorum staleness) — slice 1 is manual/contractual only.
- **Raw-`NoydbStore`-bypass hardening** of the operational constraints (the ownership anchor is already crypto-enforced; the operational ops are API-enforced in slice 1).
- **Recovery-quorum Liberate** (no-custodian, Shamir quorum reclaims) — slice 1's liberate is the custodian-ascends path; the recovery path leans on existing `recoverManagedPassphrase`.

## 8. Security model summary

- **Inalienability:** cryptographic — the Custodian cannot reach `KEK_owner` (sealed under a non-firm boundary). ✓
- **Operational constraint:** structural — `custodian` role blocks grant/revoke/rotate/sever. ✓ (API-layer for slice 1; raw-access hardening deferred.)
- **Owner autonomy:** the owner can revoke the custodian + extract without custodian cooperation (it unseals its own credential). ✓
- **Liberation:** gated (default-off), requires `legalBasis`, freezes an evidence snapshot, mints a new owner (never impersonates the sealed owner), audited in the ledger. ✓
- **Reversibility:** every ceremony leaves an indelible ledger entry; liberation + withdrawal both pin a frozen snapshot. ✓

## 9. Testing strategy (acceptance → tests)

- **Deed:** provision a vault with a sealed/auto-owner under a test `SealingKeyProvider`; assert the owner is latent (no interactive passphrase) and `_meta/deed` records the non-firm boundary.
- **Custodian operates fully:** custodian reads/writes all collections; **provably cannot** grant / revoke / rotate / destructive-withdraw (each throws a permission/gate error).
- **Owner autonomy:** the sealed owner (recovered via the provider) revokes the custodian + `extractPartition` succeeds with the custodian offline.
- **Liberate:** an audited `liberate({legalBasis})` mints a new owner, freezes a snapshot, and writes `liberation-claimed`; assert both a prior withdrawal and the liberation appear in the lifecycle ledger; assert the new owner can operate and the old sealed owner credential is orphaned (not impersonated).

## 10. Open questions for review

1. Should `provisionWithDeed` be a new `vault.custody.*` entry, an option on the existing managed-mode vault creation, or a `Lobby` method? (Proposed: a hub `custody/` function surfaced as `vault.custody.provisionDeed`, with a `Lobby` convenience later.)
2. Is the `custodian` role addition to the public `Role` union acceptable as a breaking-ish surface change (it widens a public union; pre-1.0 so low cost)? (Proposed: yes.)
3. For slice-1 Liberate, is the **custodian-ascends** path (firm claims ownership, holding the DEKs) the right primary, with recovery-quorum deferred? (Proposed: yes.)
