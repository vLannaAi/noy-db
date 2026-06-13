# Core 02 — Encryption

> **Always-on. The non-negotiable trust boundary.**
> Source of truth: `packages/hub/src/crypto.ts`

## What it is

Every record on disk is AES-256-GCM ciphertext. The key hierarchy:

```
Passphrase
   ├─ PBKDF2-SHA256 (600,000 iterations) ──→ KEK (in-memory only)
                                                 │
                                                 └── unwraps DEK per collection (AES-KW, RFC 3394)
                                                       │
                                                       └── encrypts records (AES-256-GCM, fresh 12-byte IV)
```

- **KEK** never persisted; lives only in memory during an active session. `db.close()` zeroes it.
- **DEK** wrapped per user in the keyring file. Rotating a user re-wraps for the remaining members.
- **IV** is a fresh 12-byte random value per encrypt operation. Never reused.

## Envelope format

```json
{
  "_noydb": 1,
  "_v":     3,
  "_ts":    "2026-04-04T10:00:00.000Z",
  "_iv":    "<base64>",
  "_data":  "<base64 ciphertext>"
}
```

`_v` and `_ts` are NOT encrypted — the sync engine needs them without keys. Everything in `_data` IS encrypted.

## Per-record keys (CEK) — opt-in

By default one per-collection DEK encrypts every record body. Opt a collection into per-record content-encryption keys with `vault.collection(name, { perRecordKeys: true })` and each record gets its own AES-256-GCM **CEK**, AES-KW-wrapped under the collection DEK and stored on the envelope's `_cek`:

```json
{
  "_noydb": 1, "_v": 3, "_ts": "…",
  "_iv": "<base64>", "_data": "<base64 ciphertext, encrypted under the CEK>",
  "_cek": "<base64 AES-KW-wrapped CEK, wrapped under the collection/tier DEK>"
}
```

- **Discriminant is `_cek` presence, not the flag.** A record with `_cek` is decrypted by unwrapping the CEK under the collection DEK then decrypting the body under the CEK; a record without it takes the legacy path (body directly under the collection DEK). So a collection without `perRecordKeys` is byte-identical to before, and a mixed vault — or a recipient that never set the flag — reads both kinds.
- **Stable across versions.** Insert mints the CEK; updates and history snapshots reuse it, so every `_history` envelope for a record carries the same `_cek`. A session-scoped LRU caches the unwrapped CEK per `(collection, id)`.
- **`_det` stays DEK-keyed.** Deterministic blind-equality slots remain keyed to the collection DEK (equal plaintext → equal ciphertext across records), explicitly excluded from CEK scope.
- **Tiers compose.** `elevate`/`demote` re-wrap the *same* CEK from the source tier DEK to the target tier DEK; the body key is unchanged.
- **Bundles re-wrap.** Extract/partition re-key (`reKeyClosure`) unwraps each `_cek` under the source DEK and re-wraps it under the fresh destination DEK, so adopted records stay decryptable.
- **Tombstone-tolerant read.** A `get()` on an envelope with no `_data`/`_cek` returns `null` rather than throwing `TamperedError`.

This is the foundation (step 1) for per-record erasure (`forget()` / shred, #304) and record-scoped sealing (#306), which build on top in their own slices. See `docs/superpowers/specs/2026-06-13-per-record-cek-foundation-design.md`.

## GDPR crypto-shred — `withForgetCascade` / `vault.forget()` (#304)

Built on per-record CEKs. Declare which collections carry erasable subject
data and the field naming the data subject:

```ts
import { withForgetCascade } from '@noy-db/hub/forget'

createNoydb({
  secret, user,
  historyStrategy: withHistory(),                       // ledger for the proof
  forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }),
})

const result = await db.vault('main').forget('buyer-123')
// → { subject, recordsShredded, historyVersionsShredded, collections,
//     unmigratedRecords, blobResidueCollections, ledgerEntry }
```

- **Shred = tombstone, not a CEK-only delete.** Each matching record's LIVE
  envelope is rewritten to `{ _noydb, _v, _ts, _by, _iv:'', _data:'' }`
  (dropping `_iv`/`_data`/`_cek`/`_det`) and EVERY `_history` version of the
  record is tombstoned the same way. The body and all prior versions become
  permanently undecryptable; the collection DEK and every other record are
  untouched.
- **Declared collections are forced to `perRecordKeys: true`** — a shred can
  only guarantee erasure of a body keyed off a per-record CEK.
- **Encrypted, portable subject index.** A reserved `_subject_index`
  collection (own DEK) maps `sha256Hex(subjectId) → [{collection,id}]`, so the
  store never sees which records share a subject. Maintained on write
  (onAfterWrite for create/update, an `afterDelete` observer for delete) and
  rebuildable from canonical records with `vault.rebuildSubjectIndex()` (the
  recovery path for the single-writer read-modify-write race — no CAS in v1).
- **Ledger proof without plaintext.** One `op:'forget'` entry is appended with
  empty collection/id, version 0, and `payloadHash = sha256Hex(subjectId)`.
  The hash-chain still `verify()`s — the ledger proves a subject existed and
  was erased on a date without retaining the subject id or any content.
- **Completeness gaps are surfaced, never silently claimed.** `forget()`
  reports `unmigratedRecords` (a legacy body still under the shared collection
  DEK — tombstoned, but pre-shred ciphertext leaked to a backup before
  migration stays decryptable; migrate then re-forget) and
  `blobResidueCollections` (blob attachments are keyed off the separate
  `_blob` DEK and are out of scope for record-CEK shred). `forget()` is
  idempotent: a second call shreds nothing.

See `docs/superpowers/specs/2026-06-08-forget-cascade-design.md`.

## Plaintext mode

`createNoydb({ encrypt: false })` skips the crypto path entirely. Records are stored as raw JSON in `_data`. Use only for testing / debugging — no privacy guarantees.

## Zero crypto dependencies

All cryptography uses the Web Crypto API (`crypto.subtle`). No `npm` crypto packages are or ever will be installed. The library audits cleanly against supply-chain risk for cryptographic primitives.

Available in:
- Node.js 18+
- Bun
- Deno
- Modern browsers
- Cloudflare Workers
- Electron / NW.js
- Mobile WebViews

## Critical invariants

These are the bright lines. Any change to one of them is a security review.

| Invariant | Enforcement |
|---|---|
| **Stores see only ciphertext** | Encryption happens in `Collection.put` *before* the adapter call. No code path puts plaintext into a store. |
| **AES-256-GCM with random 12-byte IV per op** | `crypto.ts` generates IVs via `crypto.getRandomValues(new Uint8Array(12))`. Never deterministic. |
| **PBKDF2-SHA256 600,000 iterations** | `deriveKey()` constant. Lowering this is a breaking security change. |
| **AES-KW for DEK wrapping** | Standard RFC 3394. No custom KDF. |
| **KEK never on disk** | Only `_keyring/<user>` records persist (which carry wrapped DEKs, not the KEK). |
| **Authenticated decryption fails closed** | A modified envelope throws `TamperedError`; no partial-decryption fallback. |
| **Per-record CEK is stable + DEK-scoped** | Under `perRecordKeys`, a record's CEK is reused across all its versions/history and is only ever AES-KW-wrapped under the collection/tier DEK (`crypto.ts` `wrapCek`/`unwrapCek`). `_det` slots are never CEK-keyed. |

## See also

- [Core 03 — Stores](./03-stores.md) — the contract that holds these invariants in place
- `SECURITY.md` — disclosure policy
- [SPEC.md](../../SPEC.md) — placeholder skeleton; full spec deferred per 
