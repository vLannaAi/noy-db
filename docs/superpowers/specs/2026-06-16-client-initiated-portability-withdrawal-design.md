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
await vault.user.unilateralWithdrawal({
  legalBasis, reKey,
  disposition?: 'delete' | 'freeze',   // default 'delete'
}): Promise<{ bundle: Uint8Array; snapshot?: FrozenSnapshotRef }>
```

- Gate `client-unilateral-withdraw` — **default `{ enabled: false }`** (fail-closed). Disabled → `PolicyDeniedError` pointing the caller at `requestWithdrawal`. The firm enables it at vault creation (`policy.gates`) for jurisdictions/contracts that require it (e.g. GDPR Art. 17).
- When enabled: produce the caller's re-keyed export bundle → apply the **source disposition** (§9) → audit (`user-unilateral-withdrawal`, `reason` carries `legalBasis` + disposition).

### Source disposition (what happens to the source records)

- **`delete`** (default) — *delete-closure*: the records leave the source vault entirely. Maximum data-minimization (GDPR Art. 17 erasure).
- **`freeze`** — the firm retains a **cryptographically-frozen, read-only last snapshot** while the **live** records are removed. For regulated retention: the client departs with their portable copy; the firm keeps an immutable, provably-unaltered record. See §9b.

`exportMyAccessibleData` (P1) is the third, non-withdrawal disposition (`leave-in-place`).

## 7. Gates (added to presets)

```ts
// policy/presets.ts (all presets)
'user-request-withdrawal':   { minTier: 1, enabled: true },
'approve-user-withdrawal':   { minTier: 2, enabled: true },
'client-unilateral-withdraw':{ minTier: 1, enabled: false },  // fail-closed; firm opts in
```
`client-unilateral-withdraw` is a **built-in** gate (added to `BuiltInGateName`), not an `app:*` gate — built-ins fail closed when undefined, whereas `app:*` gates default to *allow* (informational). A destructive op must default-deny, so it must be built-in. Shipped in P2 (PERSONAL + STRICT presets, both `enabled:false`); STRICT additionally pins a two-factor proof + shared-device block for the opt-in case. The `user-request-withdrawal` / `approve-user-withdrawal` gates land with the P3 two-party ceremony.

`exportMyAccessibleData` has **no** gate (§11.11 always-allowed) — audited only.

## 8. Audit

All ops append a tamper-evident ledger entry reusing `op:'lifecycle'` (no op-union change) with a structured `reason`:
`user-export` / `user-withdrawal-request` / `user-withdrawal-approved` / `user-withdrawal-rejected` / `user-unilateral-withdrawal`, each carrying `{ userId, scope, recordCount?, legalBasis?, ts }`. Entries participate in the hash chain (tamper-evident) but carry no data payload (`payloadHash:''`), matching the existing `partition-handed-over` lifecycle audit.

## 9. delete-closure (the new destructive primitive)

Single-vault deletion of the closure records, ALWAYS after the export (and the
freeze snapshot, if any) is durably produced:
1. Produce + seal the export bundle (data is safely out BEFORE anything is destroyed).
2. (freeze only) write the frozen snapshot (§9b).
3. Delete each closure record (`collection.delete` → tombstone). Best-effort + idempotent (re-deleting an absent record is a no-op); transaction-wrapped all-or-nothing is a future hardening (the ordering below already gives crash safety, so it is not required for correctness).
4. Audit AFTER deletion completes.
Crash safety by ordering: a crash before step 3 leaves the source intact; a partial step 3 is resumable (the bundle + snapshot already exist; re-running with the same `withdrawalId` deletes the remainder — the write-once snapshot put is a no-op on the second pass).

**Scope:** the caller's accessible **collections** (∩ `scope.collections`). Row-level (per-entity/subject) withdrawal in a *shared* collection is deferred (needs the entity/subject model) — so withdrawal is collection-scoped, matching the per-client-vault model (#271) where a client's vault *is* their data.

**Authority (kernel reality):** `hasWritePermission` (keyring.ts) makes `client` and `viewer` roles **read-only by construction** — they can never delete, regardless of any `rw` entry. So the self-service destructive path is the **`operator`** role (per-collection `rw`); owner/admin hold blanket authority and use `extractPartition` instead. A `client`/`viewer` calling `unilateralWithdrawal` is rejected with `ReadOnlyError` pointing at the two-party `requestWithdrawal`, where owner authority executes the delete. Confirmed in implementation (`withdraw-accessible.ts`).

## 9b. freeze — cryptographically-frozen read-only snapshot

The firm's retained copy for `disposition:'freeze'`. The caller is an **operator without the firm KEK**, so the snapshot cannot be a *re-keyed* `.noydb` bundle (the operator can't seal to the firm). Instead it **copies the existing ciphertext envelopes verbatim** — they are already under the vault's firm-owned DEKs, so the firm reopens them with the keys it already holds:
1. For each closure record, read its stored `EncryptedEnvelope` and collect `{ collection: { id: envelope } }`.
2. Serialize `{ withdrawalId, frozenAt, by, collections }` to JSON and store it immutably at `_frozen_snapshots/<withdrawalId>` (a reserved, write-once namespace — the put uses `expectedVersion: 0` so re-writing an existing id is rejected).
3. **Hash-pin** it: `sha256` over the serialized body, appended to the ledger as `reason:'withdrawal-frozen-snapshot:<withdrawalId>:<sha256>'`. The hash-chained ledger makes the snapshot tamper-evident — any later alteration diverges the recorded sha256.
4. Then delete-closure the live records (§9). Net: live data gone; the firm holds a sealed, read-only, provably-unaltered point-in-time snapshot of the original envelopes; the client holds their portable re-keyed copy.

`FrozenSnapshotRef = { withdrawalId, sha256, recordCount, frozenAt }`. Reading it back = parse the stored record's `_data` JSON and decrypt each envelope with the firm's DEKs; verifying frozenness = recompute sha256 over `_data` and compare to the ledger entry.

## 10. Phasing

- **P1 (slice 1):** `exportMyAccessibleData` — conservative, non-destructive, always-allowed, audited. ✅ shipped.
- **P2:** gate additions + `unilateralWithdrawal` with **both** dispositions — the `delete-closure` primitive (§9) AND the `freeze` snapshot (§9b) — behind the default-off gate.
- **P3:** `requestWithdrawal` / `approveWithdrawal` / `rejectWithdrawal` two-party ceremony (durable request collection); approve supports the same `disposition`.
- **Deferred:** `scope.entity` / `scope.subject` row-level sub-scoping (needs entity-tag model / #304 subject-index access); managed-mode/multi-recipient re-key.

## 11. Open questions

1. `reKey` shape — single `exportPassphrase` vs full `recipients` (multi-slot, managed-mode sealing per #197)? v1: single new-owner; managed/multi later.
2. Should `approveWithdrawal` deliver the bundle to the requester in-band (a `_user_withdrawal_bundles` drop) or return it to the owner to hand off out-of-band? v1: return to owner.
3. delete-closure when the caller is a non-owner: do they have delete rights on their accessible collections? (operator/client `rw` vs `ro` — unilateral withdrawal of `ro` scope must still delete; confirm the delete authority model.)
