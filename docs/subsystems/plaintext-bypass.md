# plaintext-bypass

> **Reference: every collection in a noy-db vault that is stored as plaintext JSON, by design.**
>
> **Status:** reference (no implementation surface).
> **Cluster:** disk-format
> **Cross-cuts:** `@noy-db/hub` core, every `@noy-db/to-*` backend, the bundle format, the sync engine.
> **Companion:** [`SPEC.md`](../../SPEC.md) → "Crypto invariants" — invariant-level statement; this doc is the catalog.

## What this doc is

NOYDB's headline invariant is **"Stores only see ciphertext"**. The full statement is more nuanced: *record* data is always ciphertext, but a small set of internal collections necessarily store JSON in cleartext so the sync engine, the bundle reader, and the recovery flows can do their work *without holding any key material*.

This file is the audited list. **Adding a new plaintext bypass is a SPEC change, not a routine refactor.** Removing one (i.e. encrypting a collection that is currently plaintext) is a breaking on-disk format change.

## The discriminator on the wire

Every encrypted-envelope read starts by looking at `_iv`. The convention:

- `_iv` non-empty → the envelope is encrypted with AES-GCM under a DEK; `_data` is ciphertext.
- `_iv: ''` (empty string) → the envelope is a **plaintext bypass**; `_data` is JSON.

The two paths share the same envelope shape (`{ _noydb, _v, _ts, _iv, _data }`) so the sync engine, conformance tests, and `to-*` backends can treat them uniformly. The discriminator is at the envelope level, not the collection level — collections that contain mixed records (rare; see `_meta/handle` below) work without a parallel schema.

## The audited bypass set

Each entry below is a deliberate decision. The "Why" column is load-bearing: a future change that breaks the assumption listed there is a SPEC violation.

| Collection | File | Why it must be plaintext |
|---|---|---|
| `_keyring/<userId>` | `team/keyring.ts` | The keyring **is** the file that carries the wrapped DEKs and salt. Reading it without keys is the entry point for unlock; encrypting it would create a chicken-and-egg. The user-visible fields it carries (`role`, `permissions`, `granted_by`, `expires_at`, `display_name`) are a documented metadata leak — the sync engine must read role + permissions to enforce ACLs without unwrapping. |
| `_meta/policy` | `policy/storage.ts` | The vault policy gates depend on values readable before any vault-level unlock decision (e.g. "this gate requires tier-1 unlock to even attempt"). If policy were encrypted, the engine would need the keyring before it could decide whether the keyring is allowed to open. |
| `_meta/recovery-paper` | `team/recovery.ts` | Each entry contains its own salt + iv + `wrapped_deks` ciphertext. The *wrapping* is the security boundary; the entry document itself is inert without the user's recovery code (PBKDF2 600K + AES-GCM tag). Encrypting the document would require an additional key the recovery flow doesn't have. |
| `_meta/handle` | `vault.ts` (bundle handle) | The ULID handle a `.noydb` bundle uses for cross-store identity. Set at vault creation, immutable, must be readable before the user is authenticated (so a multi-vault picker can label rows). |
| `_meta/public-envelope` | `meta/public-envelope/storage.ts` | Owner-curated label (name, description, icon, locale). Documented as **plaintext by design** — see [`public-envelope.md`](./public-envelope.md). The owner explicitly opts every field in. |
| `_meta/invite-audit-<tokenId>` | `team/magic-link-grant.ts` | Audit document for a magic-link invite. Read by the redeemer's hub session before the redeemer has any keyring; revoking the invite mutates this document. Also the basis of the **revoked-link-shadow-keyring defense** (`InviteAuditMissingError`) — if the audit is missing, the redeemer refuses to proceed even if the link otherwise validates. |
| `_meta/sync-credentials` | `team/sync-credentials.ts` | Per-store sync credentials (`mintedAt`, opaque store-specific tokens). Read by the sync engine to authenticate to its peer **before** any vault unlock — the credential cannot itself be locked behind the credential it's trying to fetch. |
| `_history/_ledger/<…>` | `history/ledger/store.ts` | Hash-chained tamper-evidence ledger entries. Each entry's content is `{ ts, actor, op, recordId, contentHash }` — no plaintext record bodies, only metadata. The ledger MUST be verifiable without the vault key so a third-party auditor can confirm the chain without seeing data. |
| `_consent/<…>` | `consent/consent.ts` | Consent records (`{ ts, scope, grantedBy }`). Same auditor argument as the ledger — consent has to be verifiable without the data scope it grants. |
| `_blob/index/*`, `_blob/chunks/*` (envelope shell) | `blobs/blob-set.ts`, `blobs/attachments.ts`, `blobs/blob-compaction.ts` | Blob index documents and chunk-table envelopes carry routing + content-hash metadata only. Every blob *body* and chunk byte is encrypted independently before it reaches storage; the index entries are read by GC and compaction without keys. |
| `_team/sync` (engine state) | `team/sync.ts` | The sync engine's own bookkeeping (last-pulled cursor, last-pushed timestamp). Must be readable before the next pull — same chicken-and-egg as `_meta/sync-credentials`. |
| `_collection-cap/<…>` | `collection.ts` | Per-collection capability rows. Cross-engine sanity check; must be readable to validate before the engine can decide which DEKs to load. |
| `_meta/directory` | `directory/storage.ts` | Vault-level directory toggle (`{ enabled: boolean }`) flipped via owner-only `db.setDirectoryEnabled`. Read by `listUsersWithEnvelopes` to decide whether non-admin/non-owner callers can enumerate; must be readable from the same plaintext-header layer as `_meta/policy` (the read happens before any DEK is needed). UX flag, not a privacy boundary — see [`user-envelope.md`](./user-envelope.md) → Directory visibility. |
| `_meta/visibility/<keyringId>` | `directory/visibility.ts` | Per-user "hide me from `listUsersWithEnvelopes`" opt-out (`{ hidden: boolean }`), written by `vault.user.setMyVisibility`. Read by the enumeration helper to filter; must work even when the user's envelope cannot be decrypted (legacy keyring, missing `_users` DEK propagation, corrupted ciphertext). UX flag, not a privacy boundary — see [`user-envelope.md`](./user-envelope.md) → Directory visibility. |
| `_meta/adoption` | `bundle/adopt-partition.ts` | Transient marker for an **adopted-but-unowned** transferable partition ([`transferable-partitions.md`](./transferable-partitions.md)). Written by `adoptPartition` on a vault that has **no keyring yet** — there is no DEK to encrypt under, and `createOwnerOnAdoptedPartition` must read it to find the pending adoption. While unowned it carries the `transferSeal` payload (the partition DEK set sealed AES-GCM under the out-of-band 32-byte transfer key); the *sealing* is the security boundary, the document is inert without that key. Once the owner is minted the seal is destroyed: the row is rewritten to `{ sealId, adoptedAt, consumedAt }` only — no key material remains. |

## What is NOT in the bypass set (verified encrypted)

- **Every user-data collection.** All record envelopes the consumer puts into `vault.collection<T>(...).put(id, payload)` are AES-GCM-encrypted under a per-collection DEK. The store sees only ciphertext + the `_v` / `_ts` metadata fields.
- **`_meta/user/<keyringId>`** (per-user envelope, [`user-envelope.md`](./user-envelope.md)). Encrypted — verified at `meta/user-envelope/storage.ts:47`. The owner-curated *vault* envelope is plaintext (`public-envelope.md`); the per-user envelope is not.
- **`_history/snapshots/<…>`** — record-version snapshots use the host collection's DEK; only the `_history/_ledger` chain is plaintext.
- **`_idx/<field>/<recordId>`** — query-index side-cars. Encrypted under the host collection's DEK so a leaked index can't reverse-engineer record contents.

## What an attacker with store-only access can learn

A compromise of a store backend (S3 bucket, IndexedDB dump, captured WebDAV session) yields these plaintext fields. Plan threat models around them:

- **From `_keyring/*`:** every user id with access to the vault, their role, their per-collection permissions, their wrapped-DEK count, the granting user, expiry timestamps, salts. **No raw keys.**
- **From `_meta/policy`:** exact factor requirements per gate. Useful intel before attempting policy bypass; does not help the bypass itself.
- **From `_meta/recovery-paper`:** wrapped-DEK blobs offline-attackable against the recovery codes. PBKDF2 600K is the entire defense — short / reused codes lose.
- **From `_meta/public-envelope`:** whatever the owner explicitly published.
- **From the ledger and consent stores:** an audit trail of *which* records changed, *when*, and *who* did it — but never *what* the records contain.
- **From `_meta/adoption` (only while a partition is adopted-but-unowned):** the sealed partition-DEK blob, offline-attackable against the 32-byte transfer key. That key is a 256-bit random delivered out-of-band and never stored, so brute force is infeasible; the leak is the blob plus the `sealId` and adoption timestamp. After `createOwnerOnAdoptedPartition` the blob is gone.

The product invariant "stores see only ciphertext" applies to the data that flows through `Collection<T>.put`. The infrastructure metadata above is a documented, bounded leak.

## Adding or removing a bypass

**Adding** a new `_iv: ''` write site is a SPEC change. The PR must:

1. Document why the new collection cannot be encrypted (chicken-and-egg argument, third-party verifier requirement, etc.).
2. Update this catalog with the new row + rationale.
3. Update the threat-model surface above if the new fields widen what an attacker learns.
4. Consider whether the bypass should be opt-in via `NoydbOptions` rather than always-on.

**Removing** a bypass (encrypting a collection that is currently plaintext) is a breaking on-disk format change. The PR must:

1. Bump `NOYDB_KEYRING_VERSION` or add a new envelope-format version flag.
2. Provide a migration that re-writes every affected envelope.
3. Update every `to-*` package's conformance tests — the read path's `_iv: ''` branch needs to know the collection has moved.

## See also

- [`SPEC.md`](../../SPEC.md) → "Crypto invariants".
- [`public-envelope.md`](./public-envelope.md) — the one bypass that is *consumer-controlled* (owner publishes the fields).
- [`user-envelope.md`](./user-envelope.md) — the encrypted counterpart (per-user, not per-vault).
- [`bundle.md`](./bundle.md) — `.noydb` container format; the `_meta/handle` row is shared with this doc.
- [`session-tiers.md`](./session-tiers.md) — `_meta/policy` is the policy-engine input.
