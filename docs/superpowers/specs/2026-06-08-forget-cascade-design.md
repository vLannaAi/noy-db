# withForgetCascade — DEK crypto-shred for right-to-erasure (DESIGN ONLY)

**Issue:** #304 · **Layer:** Store / crypto · **Status:** design spec — **not implemented**. This is a security-critical change to the core encryption path and warrants a dedicated, reviewed effort. This document resolves the two open questions the Dim-11 spec flagged and scopes the build.

## Problem

GDPR right-to-erasure in an encrypted-by-default store: overwriting PII does not erase it (copies, backups, and `_history` retain prior ciphertext). The clean resolution is **crypto-shred** — destroy the key so the ciphertext is permanently undecryptable everywhere it exists.

## The blocker (why this is not a small feature)

**The DEK is per-collection** (`getDEK(collectionName)` — every record body and every `_history` envelope in a collection encrypts under one key). Shredding that key would erase the **entire collection**, not one data subject. Selective per-subject erasure is therefore impossible on the current architecture; it requires finer key granularity.

## Design: per-record content-encryption keys (CEK)

Introduce a **per-record CEK**:

1. On write, generate a random CEK; encrypt the record body (and each history version) under it.
2. **Wrap** the CEK under the collection DEK (AES-KW, as DEKs are wrapped under the KEK today); store the wrapped CEK alongside the envelope (a new `_cek` field, or a sibling `_ceks/<collection>/<id>` record).
3. Decryption: unwrap the CEK with the collection DEK, then decrypt the body.

Crypto-shred is then: **delete the wrapped CEK.** The body ciphertext (and all history versions under the same CEK) becomes permanently undecryptable — across every store and backup that doesn't hold the CEK — while the collection DEK (and thus every *other* record) is untouched.

## Open question 1 — expressing "all records of subject X" portably

Resolved with a **declared subject field + an encrypted subject index**:

```ts
withForgetCascade({ subjectField: 'buyerId' })   // per collection, or vault-wide map
```

- On write, extract `record[subjectField]` and maintain an **encrypted** index `subject → [{collection, id}]` (a reserved `_subject_index` collection, encrypted under its own DEK). The index travels with the vault/bundle, so erasure is portable.
- **Rejected alternative:** an unencrypted subject tag in the envelope metadata (findable without decrypting) — it leaks subject-equivalence (which records share a subject), violating the non-correlation invariant. The encrypted index avoids the leak at the cost of write-time maintenance.

`vault.forget(subjectId)` consults the index, then shreds each record's CEK.

## Open question 2 — composition with withHistory

Each record's **entire version chain shares the record's CEK** (every `_history` envelope for that record is encrypted under it). So a single CEK delete makes the current value **and all prior versions** unrecoverable in one operation — exactly the audit-vs-erasure resolution:

- The **ledger hash-chain stays intact** — it stores `payloadHash` (a hash of former plaintext) and `prevHash` links, never plaintext. Chain `verify()` still passes after a shred.
- `forget()` appends an **erasure ledger entry** (`op: 'forget'`, subject-hash, count, ts, actor) — so the ledger *proves* "subject X's data existed and was erased on date D" without retaining the data.

## API (proposed)

```ts
createNoydb({ /* … */ forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId', … } }) })

const result = await vault.forget('buyer-123')
// → { subject, recordsShredded, historyVersionsShredded, collections, ledgerEntry }
```

## Build scope & risks (why a dedicated effort)

- **Core-crypto path change:** every write generates + wraps a CEK; every read unwraps it. Touches the hottest path; needs careful performance review (per-record AES-KW wrap/unwrap, key caching).
- **Migration:** existing records (body under the collection DEK) are not shreddable; a migration re-encrypts them under per-record CEKs. Until migrated, `forget` cannot guarantee erasure of legacy records — must be surfaced explicitly.
- **Backup/copy semantics:** shred guarantees unrecoverability only for ciphertext whose CEK you control. A plaintext copy already exfiltrated is out of scope (true of any crypto-erasure) — document the boundary.
- **Index integrity:** the subject index is correctness-critical (a missed record = incomplete erasure). It must be transactionally maintained with writes and rebuildable by a scan.
- **Tier/deterministic-field interplay:** deterministic-encryption fields (`_det`) are keyed off the collection DEK for blind-equality; per-record CEKs change that — those fields may need exclusion from CEK scope or their own shred semantics.

## Recommended sequencing

1. CEK envelope format + wrap/unwrap + read/write path (behind a flag), with migration of existing records.
2. Subject index + `withForgetCascade` declaration.
3. `vault.forget()` + erasure ledger entry + post-shred chain-verify.
4. Interplay passes: history, deterministic fields, tiers, bundles/backups, blobs (blob CEKs).

## Acceptance (from #304)

- [ ] predicate/subject-scoped CEK shred (record bodies + history unrecoverable)
- [ ] ledger hash-chain still verifies after a shred
- [ ] portable expression of "all records of subject X" (the encrypted subject index)
