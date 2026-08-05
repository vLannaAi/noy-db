# WS-2 governance ceremonies — boundary decision record

**Status:** decision (approved 2026-06-20) — no code relocation; durable rationale
**Type:** architecture decision record (ADR). Workstream #2 of the "orchestration → klum-db" boundary epic.
**Repos examined:** `vLannaAi/noy-db` (`@noy-db/hub`) and `vLannaAi/klum-db` (`@klum-db/lobby`).
**Outcome:** custody, two-party withdrawal, and managed transfer/adopt **stay in `@noy-db/hub`**. WS-2 ships this record + a sharpened boundary law, not a relocation.

## The question

The boundary epic's working hypothesis (from `project_boundary_epic` memory) was that "governance ceremonies — custody (Deed/Custodian/Liberate), two-party withdrawal, managed transfer/adopt — are façades over hub crypto and belong in klum." WS-2 was to relocate them like WS-1 relocated the multivault bundle. This record tests that hypothesis against the actual code and **rejects it**.

## What we mapped (2026-06-20)

Two read-only surveys across both repos produced the per-cluster facts below.

| Cluster | Source / tests (LOC) | Public surface | Wired into the `Vault`/`Noydb` class? | Boundary it crosses |
|---|---|---|---|---|
| **A — Custody** (Deed/Custodian/Liberate) | `custody/index.ts` 73, `custody/liberate.ts` 150, `team/deed.ts` 192 / 947 test | root `@noy-db/hub` (`CustodyApi`, `liberateVault`, `createDeedOwner`, `loadDeedMarker`, `isDeedVault`, `DEED_RECORD_ID` + types) | **Yes** — `vault.custody.*`, `Noydb.grantCustodian/revokeCustodian` | party, **within one vault's keyring** |
| **B — Two-party withdrawal** | `bundle/request-withdrawal.ts` 225, `bundle/withdraw-accessible.ts` 200 / 207 test | root + `/bundle` (`requestWithdrawal`, `approveWithdrawal`, `rejectWithdrawal`, `withdrawAccessibleData`, …) | **Yes** — `vault.user.requestWithdrawal/approve/reject` | party, **within one vault** |
| **C — Managed transfer / adopt** | `bundle/adopt-partition.ts` 359 / 566 test | `/bundle` only (`adoptPartition`, `createOwnerOnAdoptedPartition`, `unsealDeks`) + root errors | No — external/offline, no `Vault` instance until post-adoption | **vault/store** (sender → recipient) |

## The decisive finding: these are crypto *primitives*, not orchestration façades

WS-1 (multivault bundle) relocated cleanly because `multi-bundle.ts` touched **zero crypto** — it only composed already-public single-vault read/write functions. All three governance clusters are the opposite: **they perform the DEK re-wrapping themselves**, binding to hub crypto internals that are deliberately *not* on the published seam:

- **A (custody/liberate):** `wrapKey()` (AES-KW) from `../crypto.js`, `createOwnerKeyring()` from `../team/keyring.js`, `resolveManagedSecret()` + `SealingKeyProvider` from `../team/managed-passphrase.js`, `freezeSnapshotOnly()` from `../bundle/withdraw-accessible.js`.
- **B (withdrawal):** `wrapKey()`, `base64ToBuffer()` from `../crypto.js`, `buildAccessibleBundle()`/`resolveAccessibleCollections()`, `freezeAndDeleteClosure()`, ledger append.
- **C (adopt):** `wrapKey()`, `base64ToBuffer()`, `createOwnerKeyring()`, `resolveManagedSecret()`, `LedgerStore`, transfer-seal decode + bundle deserialization.

The stable contract klum binds to — `@noy-db/hub/kernel` — exposes only `generateULID`, `sha256Hex`, 8 error classes, and **type-only** `Vault`/`Collection`/`Noydb`/`Query`. It is explicitly "additive-only; removals are breaking." Relocating any ceremony would force `wrapKey`/`createOwnerKeyring`/`resolveManagedSecret` onto that contract — exposing hub's crown-jewel crypto, breaching its encapsulation, and contradicting klum's own CLAUDE.md rule: *"binds only to the stable `@noy-db/hub/kernel` subpath, never hub internals… keep single-vault primitives in hub."* The `no-outbound-klum-import` guard (absolute, no allowlist) isn't merely blocking the move — it is correctly reporting that this work does not cross the boundary.

Two further nails:
- **A and B are literal `Vault` instance methods** (`vault.custody.liberate()`, `vault.user.requestWithdrawal()`). klum does not own the `Vault` class, so it could not surface them as vault methods even if the crypto were exposed.
- **Custody is already correctly split:** the primitive lives in hub; klum merely re-exports it and calls `createDeedOwner` in `dock/graduate.ts`. There is nothing to move.

## The sharpened boundary law

The epic's original test said "multiple parties who must agree → klum." The seam proves that is **necessary but not sufficient**:

> **A capability is klum's only when coordination spans multiple vaults/stores AND can be expressed as choreography over *public* (hub root / `/bundle` / kernel) primitives. Cross-party coordination contained within a single vault's keyring — even when the parties are distinct principals who must agree — is a vault primitive and stays in noy, because its crypto is inherently that one vault's.**

Applying it:
- **A — custody:** cross-party, but the custodian and owner are principals in the **same** vault's keyring; liberation re-wraps that vault's own DEKs. → **noy.**
- **B — withdrawal:** cross-party (requester/approver), but single-vault; disposition is the vault's own data-governance. → **noy.**
- **C — adopt/transfer:** genuinely crosses the vault/store boundary (sender→recipient), **but** the crypto (transfer-seal decode, owner mint, DEK re-wrap) is unavoidable per-vault crypto bound to hub internals. The **primitive stays in noy.** Only a *not-yet-existing* orchestration veneer over the public primitives could be klum's (see "Deferred").

## Decisions

1. **No relocation.** Custody (A), two-party withdrawal (B), and managed transfer/adopt (C) remain in `@noy-db/hub`. The `features.yaml` entries are unchanged: `sovereign-custody` (`package: @noy-db/hub`), `client-portability` (`package: @noy-db/hub/bundle`), and `transferable-partition` (`package: @noy-db/hub/bundle`). The `client-portability` invariants independently corroborate the call — *"own-only by construction: vault.user.* acts on the caller scope only"* and *"two-party ceremony (P3)"* are single-vault, intra-keyring.
2. **Keep klum's pass-through custody re-export.** `@klum-db/lobby`'s barrel re-exports `CustodyApi`/`liberateVault`/`createDeedOwner`/`loadDeedMarker`/`isDeedVault` (+ types) from `@noy-db/hub`. This is **intentional outward-API ergonomics**, not leakage: custody is an onboarding/graduation concern, `Lobby.graduate()` already seals a Deed via `createDeedOwner`, and klum already surfaces other noy primitives (e.g. `diffVault`) the same way. Re-exporting a published noy symbol does not violate the boundary — *implementing* one would.
3. **No code change in WS-2.** The deliverable is this record + the memory refresh. Nothing in either repo is edited.

## What WS-2 does NOT do

- It does **not** move any ceremony, expose any crypto primitive on the kernel, or touch `features.yaml`.
- It does **not** build the cross-vault transfer orchestrator (deferred below).

## Deferred — the one genuinely-klum capability the analysis surfaced

A **net-new** `Lobby`-level managed-transfer orchestrator could choreograph the existing **public** primitives — `extractPartition` → `adoptPartition` → `createOwnerOnAdoptedPartition` → destroy seal — to move a partition between two vaults in a group, all crypto staying in hub. This is *build-new* (cross-vault coordination over public primitives — squarely klum by the sharpened law), justified only by a real federation-transfer scenario, not by relocation. Park it under the federation/tooling track; revisit if/when a fleet needs partition handoff between shards.

## Follow-ups (optional, non-blocking)

- **`noydb._store` naming wart:** `klum-db/src/dock/graduate.ts` calls `createDeedOwner(noydb._store, …)`. `_store` is a **public getter** (`noydb.ts:1327`), so this is legitimate — but the underscore signals "internal contract," and klum (a separate package) binds it as stable. Optional hygiene: have `createDeedOwner` accept the public `Noydb`/`Vault` instead of the raw store, or expose an un-underscored accessor. Breaking; defer unless we revisit the dock/graduate seam.

## Consequences

- **WS-3 (tooling federation-awareness) is de-risked.** The sharpened law confirms the WS-3 instinct: don't relocate vault-bound behavior; make tool *contracts* vault-shape-agnostic so a `VaultGroup` conforms without hub importing klum. Same principle, different surface.
- **The boundary epic now has a precedent for "examined → stays."** Not every candidate moves; the seam is the arbiter. This record exists so governance placement is not re-litigated.
