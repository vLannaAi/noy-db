# Client-initiated data portability + withdrawal (#199)

- **Date:** 2026-06-16
- **Status:** Design / in progress
- **Sibling of:** #198 (owner-initiated `extractPartition`/`adoptPartition`)
- **Surfaces:** the "data sovereignty by construction" property of [[sealing-at-dimension-foundation]] §11.11 as first-class API.

## 1. Goal

Three operations a **non-owner** user can perform over the scope they can decrypt,
on `vault.user.*` (own-only by construction — the existing `UserApi`):

1. **`exportMyAccessibleData(opts)`** — non-destructive, re-keyed `.noydb` bundle of the caller's accessible scope. **Always allowed** (§11.11 — the firm cannot deny it) but **audited**.
2. **`requestWithdrawal(opts)`** — durable request → owner reviews → owner approves → atomic extract-and-delete. Conservative.
3. **`unilateralWithdrawal(opts)`** — single-party extract-and-delete of the caller's scope, **gated** by `client-unilateral-withdraw` (default **disabled**; firm opts in). Aggressive variant.

The cryptographic invariant: the caller holds the DEKs for their scope, so export is a *capability*, not a *permission*. The firm can audit and (for unilateral) gate, but cannot prevent (1).

## 2. What already exists (reused, not rebuilt)

| Need | Existing machinery | File |
|---|---|---|
| `.noydb` bundle producer | `writeNoydbBundle(vault, { where, recipients/exportPassphrase, collections })` | `bundle/bundle.ts` |
| Scoped export (skip inaccessible) | `where` plaintext predicate + `hasAccess(keyring, collection)` | `team/keyring.ts` |
| Re-key to a new owner | `exportPassphrase` / `recipients` → `applyRecipientRewrap` (DEKs re-wrapped, ciphertext unchanged) | `bundle/bundle.ts` |
| FK-closure walk + re-key + seal | `walkClosure` / `reKeyClosure` / `sealDeks` | `bundle/{walk-closure,extract-partition}.ts` |
| Owner extract ceremony | `extractPartition` (owner-only, **non-destructive**) | `bundle/extract-partition.ts` |
| Policy gates | `GatePolicy {minTier,factors,enabled}`, `checkGate`, presets | `policy/{types,presets,engine}.ts` |
| Tamper-evident audit | ledger `append({ op, collection, id, version, actor, payloadHash, reason })` | `history/ledger/store.ts` |
| Own-only user API | `UserApi` (writerKeyringId frozen; no `keyringId` param) | `meta/user-envelope/api.ts` |

**The one genuinely new primitive:** *delete-closure* — deleting the caller's extracted records after the bundle is sealed (the withdrawal "delete" side). `extractPartition` is deliberately non-destructive; deletion is single-vault (same vault we read from), so it does NOT need the cross-vault atomicity #198 ruled out — but it must be ordered (seal first, then delete) and crash-safe (idempotent).

## 3. Scope boundary

Scope = **the caller's DEK access set**: collections where `hasAccess(keyring, collection)` (owner/admin/viewer → all; operator/client → `keyring.permissions`). A record outside the caller's DEKs is undecryptable, so it can never be in the bundle — the boundary is cryptographic, not a runtime allowlist.

Optional narrowing (v1): `scope.collections?: string[]` (sub-allowlist of the accessible set). **Deferred:** `scope.entity` / `scope.subject` (needs the #304 `_subject_index` DEK + an entity-tag model) — documented as future, not built in v1.

## 4. Operation 1 — `exportMyAccessibleData` (slice 1, conservative)

```ts
await vault.user.exportMyAccessibleData({
  reKey: { newOwner: { userId, passphrase } },  // bundle is independently openable by the new owner
  scope?: { collections?: string[] },
}): Promise<Uint8Array>   // a .noydb bundle
```

- Builds a `where` predicate = `hasAccess(keyring, collection)` (∩ `scope.collections` if given).
- Calls `writeNoydbBundle(vault, { where, exportPassphrase|recipients: newOwner, compression:'auto' })` → re-keyed, access-scoped bundle. **Non-destructive** (source untouched).
- **No gate** — always allowed (§11.11). **Audited:** one ledger entry `op:'lifecycle'`, `reason: 'user-export:<userId>'` (+ scope/recordCount in reason JSON).
- Zero-knowledge preserved: the `where` filter decrypts inside the unlocked vault; survivors keep their original ciphertext; only the keyring wrapping is re-done.

## 5. Operation 2 — `requestWithdrawal` (two-party)

```ts
await vault.user.requestWithdrawal({ scope?, expiresIn? }): Promise<{ requestId, expiresAt }>
// owner side (Noydb / db, owner authority):
await db.approveWithdrawal(vaultName, requestId, factors?): Promise<{ bundleBytes }>
await db.rejectWithdrawal(vaultName, requestId, reason?): Promise<void>
```

- Spans calendar time → **durable request record** in `_user_withdrawal_requests` (encrypted), NOT a transaction.
- `requestWithdrawal`: gate `user-request-withdrawal` (default enabled, tier 1); writes the request + audit (`reason:'user-withdrawal-request:<id>'`).
- `approveWithdrawal` (owner): gate `approve-user-withdrawal` (tier 2); extract the requester's closure (owner authority) → seal bundle → **delete-closure** → audit (`user-withdrawal-approved`). Returns the bundle to hand back.
- `rejectWithdrawal`: marks the request rejected + audit.

## 6. Operation 3 — `unilateralWithdrawal` (gated)

```ts
await vault.user.unilateralWithdrawal({ legalBasis, reKey }): Promise<Uint8Array>
```

- Gate `client-unilateral-withdraw` — **default `{ enabled: false }`** (fail-closed). Disabled → `PolicyDeniedError` pointing the caller at `requestWithdrawal`. The firm enables it at vault creation (`policy.gates`) for jurisdictions/contracts that require it (e.g. GDPR Art. 17).
- When enabled: export the caller's accessible closure (re-keyed) → **delete-closure** → audit (`user-unilateral-withdrawal`, `reason` carries `legalBasis`).

## 7. Gates (added to presets)

```ts
// policy/presets.ts (all presets)
'user-request-withdrawal':   { minTier: 1, enabled: true },
'approve-user-withdrawal':   { minTier: 2, enabled: true },
'client-unilateral-withdraw':{ minTier: 1, enabled: false },  // fail-closed; firm opts in
```
`exportMyAccessibleData` has **no** gate (§11.11 always-allowed) — audited only.

## 8. Audit

All ops append a tamper-evident ledger entry reusing `op:'lifecycle'` (no op-union change) with a structured `reason`:
`user-export` / `user-withdrawal-request` / `user-withdrawal-approved` / `user-withdrawal-rejected` / `user-unilateral-withdrawal`, each carrying `{ userId, scope, recordCount?, legalBasis?, ts }`. Entries participate in the hash chain (tamper-evident) but carry no data payload (`payloadHash:''`), matching the existing `partition-handed-over` lifecycle audit.

## 9. delete-closure (the new primitive)

Single-vault deletion of the closure records after the bundle is sealed:
1. Produce + seal the bundle (so the data is safely exported BEFORE anything is destroyed).
2. Delete each closure record (`collection.delete` / tombstone). Run inside `withTransactions` when available for an all-or-nothing batch; otherwise best-effort + idempotent (re-deleting an absent record is a no-op).
3. Audit AFTER deletion completes.
Ordering guarantees no data loss on crash: a crash before step 2 leaves the source intact; a partial step 2 is resumable (the bundle already exists; re-running deletes the remainder).

## 10. Phasing

- **P1 (slice 1):** `exportMyAccessibleData` — conservative, non-destructive, always-allowed, audited. Reuses `writeNoydbBundle` + `where` + re-key. **No new destructive code.** ← build first.
- **P2:** the gate additions + `unilateralWithdrawal` + the `delete-closure` primitive (the destructive core, behind the default-off gate).
- **P3:** `requestWithdrawal` / `approveWithdrawal` / `rejectWithdrawal` two-party ceremony (durable request collection).
- **Deferred:** `scope.entity` / `scope.subject` sub-scoping (needs entity-tag model / #304 subject-index access).

## 11. Open questions

1. `reKey` shape — single `exportPassphrase` vs full `recipients` (multi-slot, managed-mode sealing per #197)? v1: single new-owner; managed/multi later.
2. Should `approveWithdrawal` deliver the bundle to the requester in-band (a `_user_withdrawal_bundles` drop) or return it to the owner to hand off out-of-band? v1: return to owner.
3. delete-closure when the caller is a non-owner: do they have delete rights on their accessible collections? (operator/client `rw` vs `ro` — unilateral withdrawal of `ro` scope must still delete; confirm the delete authority model.)
