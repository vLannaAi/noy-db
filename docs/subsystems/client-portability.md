# Client-initiated portability & withdrawal

`vault.user.*` lets a **non-owner** principal act on **their own** accessible
data: take a portable copy, or withdraw (export-and-dispose). Own-only by
construction — the API never reaches another principal's scope.

Design spec: `docs/superpowers/specs/2026-06-16-client-initiated-portability-withdrawal-design.md`.

## The three operations

| Method | Destructive? | Gate | Notes |
| --- | --- | --- | --- |
| `exportMyAccessibleData(opts)` | no | none (audited) | re-keyed copy of the caller's scope; source untouched |
| `unilateralWithdrawal(opts)` | yes | `client-unilateral-withdraw` (fail-closed) | operator self-serve: export **then** dispose of the source |
| `requestWithdrawal(opts)` | no | `user-request-withdrawal` (enabled, t1) | requester (incl. read-only client/viewer) files a durable request |
| `listWithdrawalRequests({status?})` | no | owner/admin | review the queue |
| `approveWithdrawal(id, {reKey?})` | yes | `approve-user-withdrawal` (t2) + owner/admin | extract-and-dispose under firm authority; returns the bundle |
| `rejectWithdrawal(id, {reason?})` | no | `approve-user-withdrawal` + owner/admin | decline; no data touched |

`approveWithdrawal` reuses the SAME `freezeAndDeleteClosure` primitive as
`unilateralWithdrawal`, so the `disposition` (`delete`/`freeze`) the requester
chose flows through end-to-end. The request body is plaintext metadata and
carries **no passphrase** (supplied by the approver at approval time,
out-of-band) — nothing secret is stored at rest.

### Scope

The caller's **DEK access set**: collections where `hasAccess(keyring, collection)`
(owner/admin/viewer → all; operator/client → `keyring.permissions`), optionally
narrowed by `scope.collections`. A record outside the caller's DEKs is
undecryptable, so it can never enter the bundle — the boundary is cryptographic,
not a runtime allowlist. Re-keying runs before any where-filter, so the export
uses the **allowlist** of accessible collections (not just a predicate).

### Authority (kernel reality)

`hasWritePermission` makes `client`/`viewer` **read-only by construction** — they
can never delete, regardless of an `rw` entry. So self-service *destructive*
withdrawal is the **`operator`** path (per-collection `rw`); owner/admin hold
blanket authority and use `extractPartition`. A read-only role calling
`unilateralWithdrawal` is rejected with `ReadOnlyError` pointing at the two-party
`requestWithdrawal`.

## Source dispositions

- **`delete`** (default) — *delete-closure*: records leave the vault entirely
  (GDPR Art. 17 erasure). The re-keyed bundle is produced **first**, so a crash
  before deletion leaves the source intact; a partial deletion is resumable.
- **`freeze`** — the firm retains a cryptographically-frozen, **write-once**,
  hash-pinned snapshot of the original ciphertext envelopes (already under the
  firm's DEKs — no re-key needed) at `_frozen_snapshots/<withdrawalId>`, then
  delete-closures the live records. `FrozenSnapshotRef = { withdrawalId, sha256,
  recordCount, frozenAt }`; the sha256 is pinned in the tamper-evident ledger.

## The gate

`client-unilateral-withdraw` is a **built-in** gate (built-ins fail closed when
undefined; `app:*` gates default to *allow*, which is wrong for a destructive op).
Default `{ enabled: false }` in both presets; STRICT additionally pins a
two-factor proof + shared-device block for the opt-in case. The firm enables it
per jurisdiction/contract.

## Audit

Every op appends a tamper-evident `op:'lifecycle'` ledger entry with a structured
`reason` (`user-export` / `user-unilateral-withdrawal:<userId>:<disposition>:<legalBasis>`
/ `withdrawal-frozen-snapshot:<id>:<sha256>`). Entries participate in the hash
chain but carry no data payload.
