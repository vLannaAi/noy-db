# NOYDB — None Of Your Damn Business

> Your data. Your device. Your keys. Not your DB's business.

A zero-knowledge, offline-first, encrypted document store with pluggable backends and multi-user access control.

---

## Table of Contents

- [Origin Story](#origin-story)
- [Problem Statement](#problem-statement)
- [Design Principles](#design-principles)
- [Architecture Overview](#architecture-overview)
- [Core Concepts](#core-concepts)
- [Encryption Model](#encryption-model)
- [Multi-User Access Control](#multi-user-access-control)
- [Sync Engine](#sync-engine)
- [Adapters](#adapters)
- [API Specification](#api-specification)
- [Data Formats](#data-formats)
- [Package Structure](#package-structure)
- [Security Model](#security-model)
- [Implementation Notes](#implementation-notes)
- [First Consumer](#first-consumer)
- [Appendix](#appendix)

---

## Origin Story

noy-db was born from a real-world problem at an **established regional accounting firm** managing ~30 SME clients. The firm needed a storage layer for their web-based financial management platform that could:

1. **Work on a USB stick** — accountants carry client data between office and home on removable media
2. **Sync to AWS DynamoDB** — for cloud access when online
3. **Encrypt everything** — accounting data for 30 companies must be unreadable by anyone without authorization, whether on the USB stick, in DynamoDB, or intercepted in transit
4. **Support multiple users** — an owner, operators, and auditors each with their own credentials and different access levels
5. **Handle rare conflicts** — two users occasionally editing the same company's data

The research phase evaluated every existing solution:

| Library | Why it didn't fit |
|---------|-------------------|
| AWS Amplify DataStore | Mandatory AppSync middleman, no file backend, no zero-knowledge encryption |
| RxDB | No DynamoDB adapter, premium encryption plugin (paid), no file backend |
| PouchDB | Syncs to CouchDB only, aging project, no DynamoDB path |
| TinyBase | No DynamoDB persister, no Vue bindings, no encryption |
| Replicache | BSL license (paid), browser-only, no file backend |
| PowerSync/ElectricSQL | PostgreSQL only, no DynamoDB |
| Dexie | Browser-only (IndexedDB), no server-side, no DynamoDB |
| LowDB | No sync, no encryption, no multi-user |

**The gap:** No library combines encrypted-at-rest storage, pluggable backends (file + DynamoDB), offline-first sync, and multi-user access control with per-collection permissions. NOYDB fills this gap.

The name "None Of Your Damn Business" captures the philosophy: backends store data they cannot read. DynamoDB admins, USB stick finders, cloud operators — they all see ciphertext. Only holders of the correct passphrase or enrolled biometric can decrypt.

---

## Problem Statement

Many applications deal with small, sensitive datasets that need to work across multiple storage environments:

- **Small clinics** — patient records on a local machine, synced to cloud
- **Accounting firms** — client financial data carried on USB, accessed from office and home
- **Field surveys** — data collected offline, synced when connectivity returns
- **Personal finance** — private data that should never be readable by the storage provider
- **Any app** where data fits in memory (~1K-50K records) and privacy is non-negotiable

These apps share common requirements:

1. Data fits entirely in memory (no need for query engines, indexes, or pagination)
2. Must work offline (local-first, not cloud-first)
3. Must sync to cloud when available (but cloud is optional, not required)
4. Data must be encrypted at rest on every backend
5. Multiple users need different access levels
6. Data must be portable (export, backup, restore, carry on USB)
7. No vendor lock-in (swap backends without changing application code)

---

## Design Principles

### 1. Memory-First
All data is loaded into memory on open. Queries are `Array.filter()` and `Array.find()`. No query engine, no indexes, no cursor pagination. This keeps the core tiny and the API familiar.

**Target scale:** 1,000-50,000 records per compartment. Above this, NOYDB is not the right tool.

### 2. Zero-Knowledge Storage
Backends never see plaintext. Encryption happens in the core before data reaches any adapter. A DynamoDB table admin, an S3 bucket owner, someone who finds the USB stick — they see only ciphertext. The encryption key exists only in the user's memory (passphrase) or device (biometric secure enclave).

#### What zero-knowledge does and does not promise

NOYDB's zero-knowledge guarantee is **scoped specifically to adapters**. The library guarantees that no plaintext record, no plaintext key, no decrypted DEK, and no derived KEK is ever passed to an adapter method. That guarantee is the entire reason a USB stick lost on a train, an S3 bucket leaked publicly, or a DynamoDB table compromised by a database admin reveals nothing about the records they hold.

The zero-knowledge guarantee is **not** a guarantee that plaintext never leaves the library's process. Plaintext exits the library through several deliberate, documented mechanisms, each of which the consumer opts into explicitly:

- **Portable-artefact export packages (`@noy-db/as-*`).** The `as-*` family is the fourth main package pillar (alongside `to-`, `in-`, `on-`) and holds every package that extracts data from a vault as a discrete artefact the consumer subsequently holds. Unlike `plaintextTranslator` or schema validators, which a consumer can enable unilaterally in their own code, **every `as-*` invocation is gated by a hub-enforced authorization check** on the invoking keyring, plus (optionally) a just-in-time re-authentication requirement via `SessionPolicy.requireReAuthFor: 'export'`. The family splits into two authorization tiers:
  - **Plaintext tier** — covers both structured record formatters (`as-csv`, `as-xml`, `as-xlsx`, `as-json`, `as-ndjson`, `as-sql`, `as-pdf`) and document/blob extractors (`as-blob` for single-attachment native-MIME export, `as-zip` for composite record-plus-attachments archives). Crosses the plaintext boundary regardless of whether the bytes are a spreadsheet or a PDF. Gated by `canExportPlaintext` on the keyring, **off by default for every role**; only `owner` or `admin` can grant it. One gate covers both sub-families because the plaintext boundary is the same boundary either way. The core `exportJSON()` / `exportStream()` helpers and any future `vault.exportBlobs()` primitive on `Vault` honour the same capability check.
  - **Encrypted tier** — `as-noydb` (wrapping the `.noydb` container format). Zero-knowledge preserved — bytes out are ciphertext. Gated by `canExportBundle`, **on by default for `owner` and `admin`**, off for `operator` / `viewer` / `client`. The asymmetric default reflects the asymmetric risk: a bundle is inert without the KEK, so the owner backing up their own vault does not need the friction of an explicit grant; a non-admin role producing a bundle to hand to an external party does, because that artefact outlives keyring revocation.

  Safety is provided by **enforcement**, not by naming convention: installing an `as-*` package into `package.json` does not unlock anything; the owner's grant of the relevant capability bit does. Each package carries a tier-appropriate warning in its README, JSDoc, and npm description. See `docs/patterns/as-exports.md` for the full policy, decision tree, and audit-ledger schema.
- **The `plaintextTranslator` hook (v0.8+).** Consumers can opt individual schema fields into auto-translation by configuring a `plaintextTranslator` function on the `Noydb` instance. The library calls that function with the field's plaintext, sends it wherever the consumer's implementation sends it (DeepL, Argos, a self-hosted LLM, a human review queue), and writes the returned translation back. NOYDB ships **no built-in translator**, ships **no translator SDKs as dependencies**, and will reject any PR that adds either. Opt-in is per-field at schema-construction time and visible in the schema source — there is no runtime path that can opt a field in without an explicit schema declaration.
- **Schema validators that call out.** Consumer-supplied Standard Schema validators receive plaintext during the validate step. A validator that calls a remote service (uncommon but possible) sends plaintext over the wire on the consumer's behalf. Same opt-in principle: the validator is consumer-written code, and noy-db does not police what it does.

Every plaintext-exit mechanism shares three properties: **(1) it requires explicit action** — consumer action for `plaintextTranslator` and schema validators; owner-granted capability plus consumer invocation for `as-*` exports — **(2) it never lives inside a default code path** — opting in (or being opted in by the owner) is always a positive choice, and **(3) it is reflected in the audit ledger** by metadata only — never by content.

The audit-ledger entries for these exits record `{ field, collection, mechanism, timestamp }` and **deliberately do not record plaintext content or plaintext content hashes**. Logging a content hash would create a fingerprint that could allow later correlation of identical phrases across the audit trail — a subtle leak that the audit logging is meant to prevent.

#### What this means in practice

> **The library guarantees the encryption boundary at the adapter layer. The library does not, and cannot, guarantee what happens to plaintext after a consumer hands it to a function the consumer themselves provided.**

A consumer who wants the strongest possible plaintext-isolation discipline can achieve it by: (a) the vault owner declining to grant `canExportPlaintext` to any keyring (and/or not installing any plaintext-tier `@noy-db/as-*` package), (b) not configuring a `plaintextTranslator`, and (c) auditing their schema validators to confirm none of them call out. With that discipline, plaintext lives only in the application's own runtime memory while a session is active, and nowhere else. Encrypted `as-noydb` bundles remain available to the owner for legitimate backup and migration without compromising this — the bytes never leave ciphertext form. The library's APIs neither force nor prevent any discipline above — the choice is the owner's, by design.

### 3. Offline-First
The local adapter is the primary store. Cloud sync is an optional enhancement, not a requirement. The app works fully without internet. When connectivity returns, the sync engine pushes local changes and pulls remote updates.

### 4. Portable Data
Data files are self-contained. Copy a compartment directory to another USB stick, email it, back it up — permissions and encrypted data travel together. No external ACL database, no server-side permission store.

### 5. Zero Crypto Dependencies
All cryptography uses the **Web Crypto API** (`crypto.subtle`), which is built into every modern browser and Node.js 18+. No npm dependencies for crypto operations.

### 6. Pluggable Backends
The adapter interface is 6 methods. Any storage that can implement `get`, `put`, `delete`, `list`, `loadAll`, `saveAll` works with NOYDB. Built-in adapters cover the common cases; custom adapters handle the rest.

### 7. Minimal API Surface
The library should be learnable in 10 minutes. The core API is: `createNoydb()`, `compartment()`, `collection()`, `get()`, `put()`, `delete()`, `list()`, `query()`, `dump()`, `load()`, `push()`, `pull()`, `grant()`, `revoke()`.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  @noydb/core                                                 │
│                                                              │
│  ┌─ Auth ───────────────────────────────────────────────┐   │
│  │  Passphrase → PBKDF2 → KEK (Key Encryption Key)      │   │
│  │  Biometric  → WebAuthn → unwrap KEK from secure store │   │
│  │  KEK → unwrap DEKs from user's keyring                │   │
│  └──────────────────────────┬────────────────────────────┘   │
│                              │                                │
│  ┌─ Store (in-memory) ──────▼────────────────────────────┐   │
│  │                                                        │   │
│  │  Noydb                                                 │   │
│  │    └─ Compartment ('C101')                             │   │
│  │         ├─ Collection<Invoice>('invoices')              │   │
│  │         │    .get() .put() .delete() .list() .query()  │   │
│  │         ├─ Collection<Payment>('payments')              │   │
│  │         └─ Collection<Disbursement>('disbursements')    │   │
│  │                                                        │   │
│  └──────────────────────────┬────────────────────────────┘   │
│                              │                                │
│  ┌─ Permission Check ───────▼────────────────────────────┐   │
│  │  Does this user's keyring include this collection?     │   │
│  │  Is the permission 'rw' or 'ro'?                       │   │
│  │  Can this role grant/revoke/export?                    │   │
│  └──────────────────────────┬────────────────────────────┘   │
│                              │                                │
│  ┌─ Crypto Layer ───────────▼────────────────────────────┐   │
│  │  encrypt(record, DEK) → { _iv, _data }                │   │
│  │  decrypt({ _iv, _data }, DEK) → record                │   │
│  │  AES-256-GCM, random IV per write, Web Crypto API     │   │
│  └──────────────────────────┬────────────────────────────┘   │
│                              │                                │
│  ┌─ Sync Engine (optional) ─▼────────────────────────────┐   │
│  │  Dirty tracking (local changes since last sync)        │   │
│  │  Push: send dirty records to remote adapter            │   │
│  │  Pull: fetch latest from remote adapter                │   │
│  │  Conflict: version mismatch → surface to caller        │   │
│  │  Operates on encrypted blobs — no key needed           │   │
│  └──────────────────────────┬────────────────────────────┘   │
│                              │                                │
│  ┌─ Store Interface ────────▼────────────────────────────┐   │
│  │  6 methods: get, put, delete, list, loadAll, saveAll   │   │
│  │                                                        │   │
│  │  @noy-db/to-file          → JSON files (USB/disk)   │   │
│  │  @noy-db/to-aws-dynamo    → AWS DynamoDB            │   │
│  │  @noy-db/to-aws-s3        → AWS S3 (JSON objects)   │   │
│  │  @noy-db/to-memory        → in-memory (testing)     │   │
│  │  @noy-db/to-browser-local → localStorage            │   │
│  │  @noy-db/to-browser-idb   → IndexedDB (atomic CAS)  │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Backup / Restore ───────────────────────────────────┐   │
│  │  .dump()         → encrypted JSON (safe to transport)  │   │
│  │  .load()         → restore from encrypted backup       │   │
│  │  .exportStream() → decrypted async iterator (ACL-scoped) │ │
│  │  .exportJSON()   → decrypted JSON string (ACL-scoped)   │  │
│  └───────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## Core Concepts

### Noydb Instance
The top-level object returned by `createNoydb()`. Holds the authenticated user context, adapter references, and crypto keys in memory. One instance per authenticated session.

### Vault
A logical namespace for isolating tenants, companies, or projects (formerly `Compartment`). Each vault has its own set of collections and its own keyring (access control). Maps to a directory (to-file), a partition key (to-aws-dynamo), or a key prefix (to-aws-s3/to-browser-local). Opened via `openVault()`; listed via `listVaults()`. Backup type is `VaultBackup`; snapshot type is `VaultSnapshot`.

### Collection
A typed set of records within a compartment. Each collection has its own Data Encryption Key (DEK). Maps to a subdirectory (file adapter), a sort key prefix (DynamoDB), or a sub-prefix (S3).

### Record
A single JSON document within a collection, identified by a string ID. Each record is independently encrypted with the collection's DEK and a unique random IV. Records carry a `_version` number for optimistic concurrency.

### Keyring
A per-user, per-compartment file containing the user's role, permissions, and wrapped (encrypted) DEKs. The keyring is the sole mechanism for access control. It travels with the data.

### DEK (Data Encryption Key)
A random AES-256 key that encrypts/decrypts records in one collection. Generated when the collection is created. Wrapped (encrypted) with each authorized user's KEK and stored in their keyring.

### KEK (Key Encryption Key)
Derived from the user's passphrase via PBKDF2, or unwrapped from the secure enclave via WebAuthn (biometric). Used to unwrap DEKs from the keyring. Never stored — exists only in memory during an active session.

---

## Encryption Model

### Algorithms

| Purpose | Algorithm | Key Size | Notes |
|---------|-----------|----------|-------|
| Data encryption | AES-256-GCM | 256-bit | Authenticated encryption (confidentiality + integrity) |
| Key derivation | PBKDF2-SHA256 | 256-bit output | 600,000 iterations (OWASP 2025 minimum) |
| Key wrapping | AES-KW | 256-bit | RFC 3394 key wrap, used to encrypt DEKs with KEK |
| IV generation | CSPRNG | 96-bit (12 bytes) | Fresh random IV per encrypt operation |
| Biometric key storage | WebAuthn / FIDO2 | Platform-dependent | Secure enclave (Touch ID, Face ID, Windows Hello) |

All operations use the **Web Crypto API** (`crypto.subtle`). Zero npm dependencies.

### Encryption Flow (Write)

```
Application calls: collection.put('inv-001', { amount: 5000, status: 'draft' })

1. Permission check: does user's keyring include this collection with 'rw'?
2. Unwrap DEK for this collection from keyring (using user's KEK)
3. Generate random 12-byte IV
4. Serialize record to JSON string
5. Encrypt: AES-256-GCM(plaintext, DEK, IV) → ciphertext + auth tag
6. Build envelope: { _noydb: 1, _v: next_version, _ts: now, _iv: base64(IV), _data: base64(ciphertext) }
7. Pass envelope to adapter.put() — adapter sees only ciphertext
```

### Decryption Flow (Read)

```
Application calls: collection.get('inv-001')

1. Permission check: does user's keyring include this collection?
2. Adapter.get() returns envelope: { _iv, _data, _v, _ts }
3. Unwrap DEK for this collection from keyring
4. Decrypt: AES-256-GCM(ciphertext, DEK, IV) → plaintext
5. If auth tag validation fails → throw TAMPERED error
6. Parse JSON → return record
```

### Key Hierarchy

```
User Passphrase (known only to user)
    │
    ▼ PBKDF2 (600K iterations, per-user salt)
    │
  KEK (Key Encryption Key) — in memory only, never persisted
    │
    ▼ AES-KW unwrap (from keyring file)
    │
  DEK_invoices ─────→ encrypts/decrypts all records in 'invoices' collection
  DEK_payments ─────→ encrypts/decrypts all records in 'payments' collection
  DEK_clients  ─────→ encrypts/decrypts all records in 'clients' collection
  ...
```

### Biometric Flow

Biometrics do not replace encryption — they protect access to the KEK via the platform's secure hardware.

**Enrollment (one-time, after passphrase unlock):**
```
1. User enters passphrase → derive KEK
2. Export KEK as raw bytes
3. Create WebAuthn credential (triggers biometric prompt)
   - authenticatorAttachment: 'platform' (Touch ID / Face ID / Windows Hello)
   - userVerification: 'required'
4. Derive a wrapping key from the WebAuthn credential
5. Wrap KEK with the wrapping key → wrapped_kek
6. Store in browser: { credential_id, wrapped_kek, salt } (safe — encrypted)
```

**Unlock (subsequent sessions):**
```
1. Retrieve { credential_id, wrapped_kek } from browser storage
2. navigator.credentials.get() → triggers biometric prompt
3. Platform authenticator releases the private key (from secure enclave)
4. Derive the wrapping key from the assertion
5. Unwrap KEK from wrapped_kek
6. KEK is now in memory → proceed to unwrap DEKs from keyring
```

**Recovery path:** If the device is lost or biometric fails, the user can always fall back to their passphrase.

---

## Multi-User Access Control

### Roles

| Role | Default Permissions | Can Grant | Can Revoke | Can Export | Description |
|------|-------------------|:---------:|:----------:|:----------:|-------------|
| `owner` | `*: rw` | Yes (all roles) | Yes (all except owner) | Yes | Data owner. One per compartment. Cannot be revoked. |
| `admin` | `*: rw` | Yes (admin, operator, viewer, client) | Yes (same, plus cascade) | Yes | Full access. Manages team. Multiple allowed. |
| `operator` | Explicit collections: `rw` | No | No | ACL-scoped | Day-to-day work on assigned collections. |
| `viewer` | `*: ro` | No | No | Yes | Read-only access to all collections. For auditors. |
| `client` | Explicit collections: `ro` | No | No | ACL-scoped | Limited read-only. For external stakeholders. |

Roles are defaults — the `permissions` field in the keyring can override on a per-collection basis.

**Admin-grants-admin (bounded lateral delegation).** Admins can grant and revoke other admins, which means new admin onboarding does not bottleneck through the single `owner` principal. Two guardrails apply:

1. **No privilege escalation.** A grant cannot widen access beyond what the grantor holds. Enforced in `grant()` by checking that every DEK wrapped into the new keyring comes from the grantor's own DEK set. Throws `PrivilegeEscalationError`. Structurally trivially true today (admin grants always inherit the full caller DEK set) but wired in so future per-collection admin scoping cannot accidentally bypass it.

2. **Cascade on revoke.** When an admin is revoked, every admin they (transitively) granted is either revoked too (`cascade: 'strict'`, default) or left in place with a `console.warn` listing the orphans (`cascade: 'warn'`). The walk uses the `granted_by` field on each keyring file as the parent pointer. A single key-rotation pass at the end covers the union of affected collections — cost is O(records in affected collections), not O(records × cascade depth).

**Plaintext export is ACL-scoped.** Every role that can read collections can export what they can read via `Compartment.exportStream()` / `Compartment.exportJSON()`. Operators and clients see only their explicitly-permitted collections; viewers and admins see everything.

**Cross-vault role-scoped queries.** Two top-level Noydb methods enable consolidated views across the vaults a single principal can unwrap:

- `Noydb.listAccessibleVaults({ minRole? })` enumerates every vault where the calling principal can unwrap a keyring at the requested minimum role. Existence-leak guarantee: vaults the caller cannot unwrap are silently dropped from the return value.
- `Noydb.queryAcross(ids, fn, { concurrency? })` runs a per-vault callback against the supplied list and returns results tagged by vault id. Per-vault errors are captured into the result slot and do not abort the fan-out.

These methods require an optional 7th store capability — `NoydbStore.listVaults?(): Promise<string[]>` — to enumerate the vault universe before filtering. The to-memory and to-file stores implement it; cloud stores (to-aws-dynamo, to-aws-s3) and browser stores do not, because cloud enumeration needs a GSI or list-bucket permission configured by the consumer. Calling `listAccessibleVaults()` against a store without the capability throws `StoreCapabilityError` with a clear message naming the missing capability and the calling API.

### Keyring File Format

Each user has one keyring file per compartment, stored at `{compartment}/_keyring/{userId}.json`:

```json
{
  "_noydb_keyring": 1,
  "user_id": "operator-somchai",
  "display_name": "สมชาย (Operator)",
  "role": "operator",
  "permissions": {
    "invoices": "rw",
    "disbursements": "rw"
  },
  "deks": {
    "invoices": "<base64: DEK_invoices wrapped with this user's KEK>",
    "disbursements": "<base64: DEK_disbursements wrapped with this user's KEK>"
  },
  "salt": "<base64: 32-byte random salt for this user's PBKDF2>",
  "created_at": "2026-04-04T10:00:00Z",
  "granted_by": "owner-01"
}
```

The keyring file is **not encrypted** as a whole — it contains only wrapped (encrypted) DEKs. Without the user's passphrase (to derive the KEK that unwraps the DEKs), the wrapped DEKs are useless. The keyring is safe to store alongside the data on any backend.

### Access Resolution

```
User opens compartment 'C101':
  1. Load user's keyring: C101/_keyring/{userId}.json
  2. If no keyring → NO_ACCESS error
  3. Derive KEK from passphrase (or unwrap via biometric)
  4. For each collection in keyring.deks:
     - Unwrap DEK using KEK
     - Store DEK in memory, tagged with permission (rw/ro)
  5. User can now access collections they have DEKs for
     - get/list/query: requires DEK (any permission)
     - put/delete: requires DEK + 'rw' permission
     - Collections not in keyring: invisible and inaccessible
```

### Grant Flow

```
Owner/Admin is authenticated → has all DEKs in memory

grant('C101', {
  userId: 'new-operator',
  displayName: 'น้องใหม่',
  role: 'operator',
  passphrase: '<temporary passphrase given to user out-of-band>',
  permissions: { invoices: 'rw', disbursements: 'rw' }
})

Steps:
  1. Verify caller has canGrant privilege
  2. Derive new user's KEK from their passphrase + fresh random salt
  3. For each permitted collection:
     - Wrap the collection's DEK with the new user's KEK
  4. Write keyring file: C101/_keyring/new-operator.json
  5. New user can now unlock with their passphrase
```

### Revoke Flow

```
revoke('C101', { userId: 'operator-somchai', rotateKeys: true })

Steps:
  1. Verify caller has canRevoke privilege
  2. Delete keyring file: C101/_keyring/operator-somchai.json
  3. If rotateKeys:
     a. For each collection the revoked user had access to:
        - Generate NEW random DEK
        - Re-encrypt all records in that collection with the new DEK
        - For each REMAINING user who has access to this collection:
          - Re-wrap the new DEK with their KEK
          - Update their keyring file
     b. Old DEKs are discarded — revoked user's wrapped copies decrypt nothing
```

**Why rotate keys?** Without rotation, a revoked user who saved a copy of their keyring could still decrypt old data from a backup. Rotation ensures that even cached keyrings become useless. Since all data fits in memory, re-encryption of ~500-1000 records takes under a second.

### Change Passphrase

```
changeSecret('old-passphrase', 'new-passphrase')

Steps:
  1. Derive old KEK from old passphrase
  2. Unwrap all DEKs using old KEK
  3. Derive new KEK from new passphrase + fresh salt
  4. Re-wrap all DEKs with new KEK
  5. Update own keyring file with new wrapped DEKs and new salt
  
No data re-encryption needed — only the envelope changes.
```

---

## Sync Engine

### Design

The sync engine is **optional** (opt-in). When configured, it provides:

- **Dirty tracking** — records modified locally since last sync
- **Push** — send dirty records to the remote adapter
- **Pull** — fetch latest from the remote adapter
- **Conflict detection** — version mismatch triggers a callback or policy handler
- **Auto-sync** — push/pull when online status changes
- **Partial sync (v0.9)** — filter push/pull by collection name or `modifiedSince` timestamp
- **CRDT conflict resolution (v0.9)** — per-collection `crdt` or `conflictPolicy` option for automatic, deterministic merges
- **Sync transactions (v0.9)** — `db.transaction(comp)` for atomic multi-record local write + filtered push

The sync engine operates on **encrypted blobs**. It does not need the encryption key. Metadata (`_v`, `_ts`, compartment, collection, id) is unencrypted and sufficient for sync operations.

### Dirty Tracking

Every `put()` and `delete()` appends to a dirty log:

```ts
interface DirtyEntry {
  compartment: string
  collection: string
  id: string
  action: 'put' | 'delete'
  version: number           // the version after this local change
  timestamp: string         // ISO 8601
}
```

The dirty log is persisted to the local adapter (e.g., `_sync/dirty.json`) so it survives app restarts.

### Push

```
For each entry in dirty log:
  1. Read the encrypted record from local adapter
  2. PUT to remote adapter with expectedVersion = entry.version - 1
  3. If success (200): remove from dirty log
  4. If conflict (409):
     - Remote has a newer version
     - Add to conflicts list
     - Call onConflict handler
  5. If network error: skip, retry on next push
```

### Pull

```
1. Fetch all records from remote adapter for this compartment
   (or fetch only records with _ts > lastPullTimestamp for efficiency)
2. For each remote record:
   - If local doesn't have it: save to local adapter
   - If local has older version: update local
   - If local has same version: skip
   - If local has newer version (local change not yet pushed): skip (push will handle)
   - If versions diverge (both changed): add to conflicts
3. Update lastPullTimestamp
```

### Conflict Resolution

```ts
interface Conflict {
  compartment: string
  collection: string
  id: string
  local: EncryptedEnvelope     // what we have locally
  remote: EncryptedEnvelope    // what the remote has
  localVersion: number
  remoteVersion: number
}

// User-provided handler:
onConflict: (conflict: Conflict) => 'local' | 'remote' | 'merge'

// Default strategies:
'local-wins'    // always keep local version
'remote-wins'   // always accept remote version
'version'       // higher version wins (default)
'manual'        // surface to user for resolution
```

### Auto-Sync

```ts
// Browser: listen for online/offline events
window.addEventListener('online', () => sync())
window.addEventListener('offline', () => { /* queue continues locally */ })

// Optional: periodic sync
setInterval(() => {
  if (navigator.onLine) sync()
}, syncIntervalMs)  // default: 30 seconds
```

---

## Stores

### Interface

```ts
interface NoydbStore {  // formerly NoydbAdapter
  /**
   * Get a single record by vault/collection/id.
   * Returns the encrypted envelope or null if not found.
   */
  get(vault: string, collection: string, id: string): Promise<EncryptedEnvelope | null>

  /**
   * Put a record. If expectedVersion is provided and doesn't match
   * the current version, throw a ConflictError (409).
   */
  put(
    vault: string,
    collection: string,
    id: string,
    envelope: EncryptedEnvelope,
    expectedVersion?: number
  ): Promise<void>

  /**
   * Delete a record by vault/collection/id.
   */
  delete(vault: string, collection: string, id: string): Promise<void>

  /**
   * List all record IDs in a collection.
   */
  list(vault: string, collection: string): Promise<string[]>

  /**
   * Load all records across all collections for a vault.
   * Used for initial hydration on open.
   */
  loadAll(vault: string): Promise<VaultSnapshot>

  /**
   * Save all records for a vault (bulk write).
   * Used for restore and key rotation.
   */
  saveAll(vault: string, data: VaultSnapshot): Promise<void>
}

interface StoreCapabilities {  // formerly AdapterCapabilities
  casAtomic: boolean   // true = atomic CAS at the storage layer
  auth: StoreAuth      // authentication kind/flow metadata
}
```

### @noy-db/to-file — JSON File Store

Maps the hierarchy to the filesystem:

```
{baseDir}/
  {vault}/
    _keyring/
      {userId}.json
    _sync/
      dirty.json
      meta.json
    {collection}/
      {recordId}.json
```

- One JSON file per record
- Directories created on first write
- Optimistic concurrency: read `_v` from file, compare, write (TOCTOU race — `casAtomic: false`)
- Works on any mounted filesystem: local disk, USB stick, network drive, SD card

**Configuration:**
```ts
jsonFile({
  dir: '/Volumes/USB/noydb-data',   // base directory
  pretty: true,                      // indent JSON (default: true, costs ~20% space)
})
```

### @noy-db/to-aws-dynamo — DynamoDB Store

Maps the hierarchy to a single DynamoDB table:

| Attribute | Type | Value | Example |
|-----------|------|-------|---------|
| `pk` | String (partition key) | `{compartment}` | `C101` |
| `sk` | String (sort key) | `{collection}#{id}` | `inv#inv-001` |
| `_v` | Number | Version | `3` |
| `_ts` | String | ISO 8601 timestamp | `2026-04-04T10:00:00Z` |
| `_iv` | String | Base64 IV | `a3f2b8c1d4e5f607...` |
| `_data` | String | Base64 ciphertext | `U2FsdGVkX1+8m3k7...` |

Special items:
- Keyrings: `sk = _keyring#{userId}`
- Sync metadata: `sk = _sync#meta`

**Optimistic concurrency** via `ConditionExpression` (`casAtomic: true`):
```
PutItem ... ConditionExpression: '#v = :expected OR attribute_not_exists(pk)'
```

**Configuration:**
```ts
dynamo({
  table: 'noydb-prod',                // DynamoDB table name
  region: 'ap-southeast-1',           // AWS region
  endpoint: 'http://localhost:8000',   // optional: local DynamoDB
})
```

### @noy-db/to-aws-s3 — S3 Store

Maps the hierarchy to S3 object keys:

```
s3://{bucket}/{vault}/{collection}/{recordId}.json
s3://{bucket}/{vault}/_keyring/{userId}.json
```

Uses S3 ETags for optimistic concurrency (`If-Match` header). `casAtomic: false` (two separate HTTP calls). Uses `@aws-sdk/client-s3` directly (no `MinimalS3Client` shim).

### @noy-db/to-memory — In-Memory Store (Testing)

Stores everything in a `Map`. No persistence. Used for unit tests. `casAtomic: true` (JS single-threaded).

### @noy-db/to-browser-local — localStorage Store

`localStorage`-backed store. `casAtomic: true` (synchronous localStorage). Used for small datasets in browser apps.

### @noy-db/to-browser-idb — IndexedDB Store

IndexedDB-backed store. `casAtomic: true` — CAS atomicity implemented via a single `readwrite` IDB transaction (fix #139). Used as a cache layer in browser-based apps for instant hydration on page load.

### Optional store extensions (v0.9)

```ts
interface NoydbStore {
  // ... 6 core methods above ...

  // v0.9 #133 — partial sync: server-side timestamp filter (optional)
  listSince?(vault: string, collection: string, since: Date): Promise<string[]>

  // v0.9 #134 — presence pub/sub transport (optional; storage-poll fallback used if absent)
  presencePublish?(channel: string, payload: string): Promise<void>
  presenceSubscribe?(channel: string, callback: (payload: string) => void): () => void

  // v0.5 #63 — vault enumeration (optional; used by listVaults / listAccessibleVaults)
  listVaults?(): Promise<string[]>
}
```

### Store Routing (v0.12)

`routeStore()` multiplexes operations across multiple backends based on collection type, record size, record age, collection name, or vault name. Returns a standard `NoydbStore` — transparent to the rest of the API.

```ts
import { routeStore } from '@noy-db/hub'

const db = await createNoydb({
  store: routeStore({
    default: dynamo({ table: 'myapp' }),        // records, keyrings, metadata
    blobs: s3Store({ bucket: 'myapp-blobs' }),   // blob chunks → S3
    age: { cold: s3Store({ bucket: 'archive' }), coldAfterDays: 90 },
    routes: { invoices: postgres({ ... }) },     // per-collection routing
    vaultRoutes: { 'EU-': dynamo({ region: 'eu-west-1' }) },
  }),
})
```

**Routing dimensions (resolution order):**

1. Runtime override/suspend (`store.override()` / `store.suspend()`)
2. Vault-based geographic routing (`vaultRoutes`)
3. Per-collection routing (`routes`)
4. Blob chunk routing (`blobs` — simple prefix or size-tiered)
5. Quota-aware overflow (`overflow`)
6. Default store

**Runtime ephemeral routing:** `store.override('default', memory())` switches to in-memory for shared devices. `store.suspend('blobs')` pauses I/O to unreachable stores with optional write-behind queue (`{ queue: true }`).

### NoydbBundleStore (v0.12)

Second store shape for backends that operate on whole-vault bundles (Drive, WebDAV, iCloud). Implements `readBundle` / `writeBundle` with optimistic concurrency via version tokens instead of the 6-method KV contract. `wrapBundleStore()` converts to a standard `NoydbStore`.

### Encrypted Binary Blob Store (v0.12)

`collection.blob(id)` returns a `BlobSet` for binary attachments:

- **Content-addressed** — `eTag = HMAC-SHA-256(blobDEK, plaintext)` (opaque to store)
- **Deduplicated** — identical bytes share chunks across records via `refCount`
- **Chunked** — AES-256-GCM per chunk with AAD binding (`eTag:index:count`)
- **Versioned** — `publish(slot, label)` creates named snapshots (amendment workflow)
- **MIME-detected** — 55 magic-byte rules, auto-skips gzip for pre-compressed formats
- **HTTP-ready** — `response(slot)` returns a native `Response` with full headers

### Store Middleware (v0.12)

`wrapStore(store, ...middlewares)` composes interceptors around any store:

```ts
const resilient = wrapStore(dynamo({ ... }),
  withRetry({ maxRetries: 3, backoffMs: 500 }),
  withCircuitBreaker({ failureThreshold: 5 }),
  withCache({ maxEntries: 500, ttlMs: 60_000 }),
  withHealthCheck({ checkIntervalMs: 30_000 }),
)
```

### Custom Stores

Implement the `NoydbStore` interface (6 required methods). Example skeleton:

```ts
import { createStore } from '@noy-db/hub'  // formerly defineAdapter

export const myStore = createStore((options: MyOptions) => ({
  name: 'my-backend',
  async get(vault, collection, id) { /* ... */ },
  async put(vault, collection, id, envelope, expectedVersion) { /* ... */ },
  async delete(vault, collection, id) { /* ... */ },
  async list(vault, collection) { /* ... */ },
  async loadAll(vault) { /* ... */ },
  async saveAll(vault, data) { /* ... */ },
}))
```

---

## API Specification

### Creating an Instance

```ts
import { createNoydb } from '@noy-db/hub'
import { jsonFile } from '@noy-db/to-file'

// Minimal — local only, passphrase auth
const db = await createNoydb({
  store: jsonFile({ dir: './data' }),   // formerly 'adapter'
  user: 'owner-01',
  secret: 'my-passphrase',
})

// With sync — offline-first with cloud backup
const db = await createNoydb({
  store: jsonFile({ dir: './data' }),        // primary (local)
  sync: dynamo({ table: 'myapp' }),          // secondary (cloud)
  user: 'owner-01',
  secret: 'my-passphrase',
  conflict: 'version',                       // or 'local-wins', 'remote-wins', custom fn
  autoSync: true,                            // sync on online/offline events
  syncInterval: 30_000,                      // periodic sync (ms)
})

// Biometric auth (browser only)
const db = await createNoydb({
  store: jsonFile({ dir: './data' }),
  user: 'owner-01',
  auth: 'biometric',                         // triggers Touch ID / Face ID
})

// Unencrypted mode (development/testing)
const db = await createNoydb({
  store: memory(),
  user: 'dev',
  encrypt: false,                            // plaintext — NEVER use in production
})
```

### Vaults and Collections

```ts
// Open a vault (formerly compartment)
const company = db.openVault('C101')

// Open a typed collection
const invoices = company.collection<Invoice>('invoices')
const payments = company.collection<Payment>('payments')

// List available vaults
const vaults: string[] = await db.listVaults()

// List collections in a vault
const collections: string[] = await company.collections()
```

### CRUD Operations

```ts
// Put (create or update)
await invoices.put('inv-001', {
  amount: 5000,
  status: 'draft',
  client_id: 'client-abc',
})
// Throws READ_ONLY if user has 'ro' permission
// Throws NO_ACCESS if user doesn't have collection DEK

// Get
const inv = await invoices.get('inv-001')
// Returns Invoice | null
// Throws NO_ACCESS if no DEK

// Delete
await invoices.delete('inv-001')
// Throws READ_ONLY if 'ro' permission

// List all records
const all: Invoice[] = await invoices.list()

// Query (in-memory filter)
const drafts = invoices.query(i => i.status === 'draft')
const large = invoices.query(i => i.amount > 10000)

// Count
const count: number = await invoices.count()
```

### Query DSL — builder chain (v0.3+)

The reactive, chainable builder is the preferred surface for anything
beyond a trivial `query(fn)`. Terminal methods are `.toArray()`,
`.first()`, `.count()`, `.subscribe(cb)`, `.live()`, `.aggregate(spec)`,
and `.groupBy(field)`.

```ts
// Filter + order + limit
const opens = invoices.query()
  .where('status', '==', 'open')
  .orderBy('amount', 'desc')
  .limit(10)
  .toArray()

// v0.6 #73 — eager single-FK join via ref() declaration
const withClients = invoices.query()
  .join<'client', Client>('clientId', { as: 'client' })
  .toArray()
// Two planner strategies (auto-selected):
//   - nested-loop via source.lookupById() — O(1) per left row
//   - hash join from source.snapshot() — O(N) once, O(1) per row
// Hard row ceiling 50,000 per side (JoinTooLargeError), override
// via { maxRows }. Warn at 80% on the existing warn channel.

// v0.6 #75 — multi-FK chaining; each leg picks its own strategy + ref mode
invoices.query()
  .join<'client', Client>('clientId', { as: 'client' })
  .join<'category', Category>('categoryId', { as: 'category' })
  .toArray()

// v0.6 #74 — reactive primitive with merged change streams
const live = invoices.query()
  .where('status', '==', 'open')
  .join<'client', Client>('clientId', { as: 'client' })
  .live()
live.subscribe(() => render(live.value))
// Later:
live.stop()
// LiveQuery<T>: { value, error, subscribe(cb), stop() }
// Re-run errors stored in live.error (previous value preserved).

// v0.6 #97 — aggregation reducers
import { count, sum, avg, min, max } from '@noy-db/hub'
const { total, n, mean } = invoices.query()
  .where('status', '==', 'open')
  .aggregate({ total: sum('amount'), n: count(), mean: avg('amount') })
  .run()
// .aggregate() returns an Aggregation<R> wrapper with .run() / .live()

// v0.6 #98 — groupBy with cardinality caps
const byClient = invoices.query()
  .groupBy('clientId')
  .aggregate({ total: sum('amount'), n: count() })
  .run()
// → [{ clientId: 'c1', total: 5250, n: 3 }, ...]
// Warns at 10,000 groups; throws GroupCardinalityError at 100,000.

// v0.6 #99 — streaming aggregation over scan()
// Memory: O(reducers), not O(records)
const { total } = await invoices.scan({ pageSize: 1000 })
  .where('year', '==', 2025)
  .aggregate({ total: sum('amount'), n: count() })

// v0.6 #76 — streaming joins over scan()
for await (const inv of invoices.scan()
  .join<'client', Client>('clientId', { as: 'client' })
) {
  await processInvoice(inv) // inv.client is attached
}
```

**Ref-mode semantics on dangling refs** (same for `.query().join()` and `.scan().join()`):

| Mode | Behavior |
|---|---|
| `strict` | Throws `DanglingReferenceError` with field/target/refId context |
| `warn` | Attaches `null` + one-shot warning per unique dangling pair, deduped across the iteration |
| `cascade` | Attaches `null` silently; cascade is a delete-time mode so dangling refs at read time are mid-flight or pre-existing orphans |

Left records with `null`/`undefined` FK values always attach `null` regardless of mode — matches the write-time `enforceRefsOnPut` policy.

**Reducer protocol:** `{ init(seed?), step(state, record), remove?(state, record), finalize(state) }` with separate internal state `S` and result type `R`. The `seed` parameter is plumbed through every factory (load-bearing for #87 partition-awareness seam, unused by the v0.6 executor). The optional `remove()` hook is the seam for future O(1) incremental live-aggregation maintenance.

**`Collection.scan()` return type** narrowed from `AsyncIterableIterator<T>` to `ScanBuilder<T>` in v0.6. Backward-compatible for every `for await (const rec of collection.scan())` call because `ScanBuilder` implements `[Symbol.asyncIterator]`. Direct `.next()` / `.return()` / `.throw()` calls on the iterator are no longer supported — not idiomatic, zero call sites in the repo or any first-party consumer.

### i18n & Dictionaries (v0.8+)

#### dictKey — normalized dictionary keys

Bounded enum-like fields where the stored value is a stable key and reads optionally resolve to a locale label.

```ts
// Define a dictionary
const statusDict = company.dictionary('status')
await statusDict.putAll({
  draft: { en: 'Draft', th: 'ฉบับร่าง' },
  open:  { en: 'Open',  th: 'เปิด' },
  paid:  { en: 'Paid',  th: 'ชำระแล้ว' },
})

// Use dictKey in collection schema
import { dictKey } from '@noy-db/hub'
const invoices = company.collection<Invoice>('invoices', {
  dictKeyFields: {
    status: dictKey('status', ['draft', 'open', 'paid'] as const),
  },
})

// Read with locale resolution
const inv = await invoices.get('inv-1', { locale: 'th' })
// → { id: 'inv-1', status: 'paid', statusLabel: 'ชำระแล้ว' }

// Join a dictKey field to get the full labels object
const rows = invoices.query()
  .where('status', '==', 'paid')
  .join('status', { as: 'statusInfo' })
  .toArray()
// → [{ ..., statusInfo: { key: 'paid', en: 'Paid', th: 'ชำระแล้ว' } }]

// groupBy uses stable key (never locale label — type-enforced)
const grouped = invoices.query()
  .groupBy('status')
  .aggregate({ total: sum('amount'), n: count() })
  .run()
// → [{ status: 'open', total: ..., n: ... }, ...]

// runAsync adds <field>Label to each bucket row
const withLabels = await invoices.query()
  .groupBy('status')
  .aggregate({ total: sum('amount') })
  .runAsync({ locale: 'th' })
// → [{ status: 'open', statusLabel: 'เปิด', total: ... }, ...]

// Dictionary CRUD
await statusDict.put('closed', { en: 'Closed', th: 'ปิด' })
await statusDict.rename('open', 'active')   // cascade-rewrites all invoice records
await statusDict.delete('draft')            // throws DictKeyInUseError if any record references it
const label = await statusDict.resolveLabel('paid', 'th')  // → 'ชำระแล้ว'
```

**Invariants:**
- Dictionaries stored in reserved `_dict_<name>/` collections — same DEK, inherit ACL and backup.
- `rename()` cascade-rewrites all registered collection records atomically.
- `delete()` is `strict` by default — throws `DictKeyInUseError` if any record references the key.
- `groupBy(dictKeyField)` always uses stable key. Type-level enforcement prevents grouping by label.
- `DictionaryHandle` maintains a write-through sync cache for O(1) join snapshot access.

#### i18nText — multi-language content fields

Per-record prose fields where each record carries its own value in N languages.

```ts
import { i18nText } from '@noy-db/hub'

const lineItems = company.collection<LineItem>('line-items', {
  i18nFields: {
    description: i18nText({
      languages: ['en', 'th'],
      required: 'all',           // 'all' | 'any' | ['en', 'th']
      autoTranslate: true,       // requires plaintextTranslator on db
    }),
  },
})

// put() validates required locales; autoTranslate fills missing ones
await lineItems.put('li-1', { id: 'li-1', description: { en: 'Consulting' } })
// → translator called; 'th' filled automatically

// Read with locale resolution
const li = await lineItems.get('li-1', { locale: 'th', fallback: 'en' })
// → { id: 'li-1', description: 'ที่ปรึกษา' }

// Raw map — all languages at once
const raw = await lineItems.get('li-1', { locale: 'raw' })
// → { id: 'li-1', description: { en: 'Consulting', th: 'ที่ปรึกษา' } }
```

#### plaintextTranslator hook

```ts
const db = await createNoydb({
  store: ...,
  user: 'alice',
  secret: '...',
  plaintextTranslator: async ({ text, from, to, field, collection }) => {
    return await myDeepLClient.translate(text, { sourceLang: from, targetLang: to })
  },
  plaintextTranslatorName: 'deepl-prod',   // optional; appears in audit log
})

// Audit log — never contains content, never contains content hashes
const log = db.translatorAuditLog()
// → [{ type: 'translator-invocation', field, collection, fromLocale, toLocale,
//       translatorName, timestamp, cached? }]

db.close()  // clears translator cache and audit log alongside KEK/DEKs
```

**Invariants:**
- `plaintextTranslator` is named deliberately — the word "plaintext" forces acknowledgement of the boundary being crossed.
- NOYDB ships **no built-in translator** and **no translator SDKs**. PRs adding either are rejected.
- The cache key is the content hash; the cache holds plaintext. Both are cleared on `db.close()`.
- Audit entries **never** include `contentHash` — a hash would fingerprint identical phrases across records.
- `TranslatorNotConfiguredError` when `autoTranslate: true` but no translator is supplied.

#### exportStream with dictionary snapshot (v0.8 #84)

```ts
for await (const chunk of company.exportStream()) {
  // chunk.collection, chunk.schema, chunk.refs, chunk.records
  // chunk.dictionaries — present for collections with dictKey fields
  // chunk.dictionaries['status']['paid']['en'] === 'Paid'
}

// exportJSON embeds _dictionaries at top level
const json = JSON.parse(await company.exportJSON())
// json._dictionaries['invoices']['status']['paid']['th'] === 'ชำระแล้ว'

// resolveLabels omits _dictionaries (labels are inlined into records instead)
const resolved = JSON.parse(await company.exportJSON({ resolveLabels: 'th' }))
// json._dictionaries → undefined; records have statusLabel fields
```

**Dictionary snapshot captured atomically before first yield** — concurrent mutations during streaming do not affect the snapshot.

### CRDT mode (v0.9 #132)

Per-collection option for deterministic, commutative conflict resolution without manual intervention.

```ts
// LWW-Map: field-level last-writer-wins by timestamp
const notes = company.collection<Record<string, string>>('notes', { crdt: 'lww-map' })
await notes.put('note-1', { title: 'Meeting notes', body: 'Discussed Q2 targets.' })
// get() returns the resolved snapshot (latest field values)
const note = await notes.get('note-1')
// getRaw() returns the LwwMapState register (fields × { v, ts })
const raw = await notes.getRaw('note-1')
// → { _crdt: 'lww-map', fields: { title: { v: 'Meeting notes', ts: '...' }, body: { ... } } }

// RGA: stable-identity array with tombstoning
const items = company.collection<string[]>('todos', { crdt: 'rga' })
await items.put('list-1', ['Buy milk', 'Call dentist'])
// get() returns the resolved array (tombstones filtered)
// getRaw() returns RgaState: { _crdt: 'rga', items: [{ nid, value, tombstoned }], tombstones: string[] }

// Yjs: delegates Y.Doc merging to the application layer via @noy-db/in-yjs
const docs = company.collection<string>('documents', { crdt: 'yjs' })
```

**Conflict resolution:** When the sync engine detects a conflict on a CRDT collection, it automatically calls `mergeCrdtStates(local, remote)` from `crdt.ts`, re-encrypts the merged state, and resolves without surfacing to the caller. `conflictPolicy` and `crdt` are mutually exclusive per collection.

### Presence and live cursors (v0.9 #134)

```ts
// Get a presence handle for a collection
const presence = invoices.presence<{ cursor: string; name: string }>()

// Announce yourself (or update your position)
await presence.update({ cursor: 'inv-001', name: 'Somchai' })

// Subscribe to active peers (filtered: not-self, not-stale)
const unsub = presence.subscribe((peers) => {
  // peers: Array<{ userId: string, payload: { cursor, name }, lastSeen: string }>
  renderCursors(peers)
})

// Clean up
unsub()           // remove this subscriber (stops polling when no subscribers remain)
presence.stop()   // release all resources immediately

// Options
const presence = invoices.presence<P>({
  staleMs: 30_000,      // peer considered stale after N ms (default: 30_000)
  pollIntervalMs: 5_000, // storage-poll fallback interval (default: 5_000)
})
```

**Encryption:** Presence payloads are encrypted with `HKDF(DEK, salt='noydb-presence', info=collectionName)` — a key derived from the collection DEK but distinct from it. The sync adapter never sees user identities in plaintext. Presence rotates automatically when the DEK rotates (revoked users cannot participate after key rotation).

**Transport:** Pub/sub path preferred (when the sync adapter implements `presencePublish`/`presenceSubscribe`). Storage-poll fallback writes to `_presence_<collection>` reserved collection on the sync adapter, polled at `pollIntervalMs`.

### Pluggable conflict policies (v0.9 #131)

```ts
// Built-in strategies
const invoices = company.collection<Invoice>('invoices', {
  conflictPolicy: 'last-writer-wins',   // higher _v wins (default sync engine behavior)
})
const invoices = company.collection<Invoice>('invoices', {
  conflictPolicy: 'first-writer-wins',  // lower _v wins
})

// Manual — surface to the user for resolution
const invoices = company.collection<Invoice>('invoices', {
  conflictPolicy: 'manual',
})
db.on('sync:conflict', ({ id, local, remote, resolve }) => {
  // local, remote are decrypted records
  resolve(local)   // or resolve(remote), or resolve({ ...local, ...remote })
})

// Custom merge function
const invoices = company.collection<Invoice>('invoices', {
  conflictPolicy: async (id, local, remote) => {
    // merge field-by-field, return the winning record
    return { ...remote, notes: [local.notes, remote.notes].join('\n') }
  },
})
```

### Partial sync (v0.9 #133)

```ts
// Push only specific collections
await db.push(comp, { collections: ['invoices', 'payments'] })

// Pull with timestamp filter
await db.pull(comp, { modifiedSince: new Date('2026-04-01') })

// Pull specific collections since a timestamp
await db.pull(comp, {
  collections: ['invoices'],
  modifiedSince: new Date('2026-04-01'),
})

// Bidirectional filtered sync
await db.sync(comp, {
  push: { collections: ['invoices'] },
  pull: { collections: ['invoices'], modifiedSince: lastPull },
})
```

Adapters may implement `listSince?(compartment, collection, since): Promise<string[]>` for server-side timestamp filtering (optional — core falls back to full-list filtering if absent).

### Sync transactions (v0.9 #135)

```ts
// Atomic multi-record write + sync
await db.transaction(company)
  .put(invoices, 'inv-001', { amount: 5000, status: 'paid' })
  .put(payments, 'pay-001', { amount: 5000, invoiceId: 'inv-001' })
  .delete(drafts, 'draft-001')
  .commit()

// commit() is two-phase:
// 1. Local writes: put/delete through each collection (permissions, crypto, ledger, dirty tracking)
// 2. Filtered push: sync only the transacted records to the remote adapter
```

### `@noy-db/in-yjs` — Yjs interop (v0.9 #136)

```ts
import { yjsCollection, yText, yMap, yArray } from '@noy-db/in-yjs'
import * as Y from 'yjs'

// Create a Yjs-backed collection
const docs = yjsCollection(company, 'documents', {
  yFields: {
    title: yText(),
    metadata: yMap<{ author: string; tags: string[] }>(),
    comments: yArray<string>(),
  },
})

// Get a live Y.Doc (creates new, applies stored update if exists)
const doc = await docs.getYDoc('doc-1')
const title = doc.getText('title')
title.insert(0, 'Hello world')

// Persist the Y.Doc back (encodes Y.encodeStateAsUpdate → base64 → encrypted)
await docs.putYDoc('doc-1', doc)

// Apply an incoming update (e.g., from a WebSocket)
await docs.applyUpdate('doc-1', incomingUpdateBytes)

// Access the underlying crdt: 'yjs' collection for standard operations
const raw = await docs.coll.getRaw('doc-1')
// → { _crdt: 'yjs', update: '<base64 Yjs state vector>' }
```

**Storage model:** `Y.encodeStateAsUpdate(doc)` is base64-encoded and stored as the `crdt: 'yjs'` payload in core's encrypted envelope. The sync engine's conflict resolver for `crdt: 'yjs'` falls back to LWW (higher `_v` wins) — proper `Y.mergeUpdates` merge is the caller's responsibility via `applyUpdate`. `@noy-db/in-yjs` has peer deps on `@noy-db/hub` and `yjs >=13`.

### Sync Operations
// Returns: { pushed: number, conflicts: Conflict[], errors: Error[] }

// Pull remote changes to local
const pullResult = await db.pull()
// Returns: { pulled: number, conflicts: Conflict[], errors: Error[] }

// Bidirectional sync (pull then push)
const syncResult = await db.sync()

// Check sync status
const status = db.syncStatus()
// Returns: { dirty: number, lastPush: string | null, lastPull: string | null, online: boolean }

// Manual conflict resolution
db.resolveConflict(conflict, 'local')   // keep local version
db.resolveConflict(conflict, 'remote')  // accept remote version
```

### Backup and Restore

```ts
// Dump compartment as encrypted JSON blob
const backup: string = await company.dump()
// Returns JSON string containing all encrypted envelopes + keyrings
// Safe to email, upload, store anywhere — it's all ciphertext

// Restore compartment from encrypted backup
await company.load(backup)
// Requires user's passphrase to be correct (must be in the backup's keyrings)

// Export as decrypted JSON (ACL-scoped)
const plaintext: string = await company.exportJSON()
// Silently skips collections the caller cannot read (same rule as Collection.list).
// WARNING: output is unencrypted — handle with care.

// Streaming variant for large compartments or format-aware serializers
for await (const chunk of company.exportStream()) {
  // chunk.collection, chunk.schema, chunk.refs, chunk.records
}

// Dump to file (convenience)
await company.dumpToFile('/path/to/backup.noydb.json')
await company.loadFromFile('/path/to/backup.noydb.json')
```

### Access Control

```ts
// Grant access (owner/admin only)
await db.grant('C101', {
  userId: 'operator-somchai',
  displayName: 'สมชาย',
  role: 'operator',
  passphrase: 'temporary-passphrase-given-out-of-band',
  permissions: {
    invoices: 'rw',
    disbursements: 'rw',
  },
})

// Revoke access (owner/admin only)
await db.revoke('C101', {
  userId: 'operator-somchai',
  rotateKeys: true,               // re-encrypt affected collections (recommended)
})

// List users with access to a compartment
const users = await db.listUsers('C101')
// Returns: [{ userId, displayName, role, permissions, createdAt, grantedBy }]

// Change own passphrase
await db.changeSecret('old-passphrase', 'new-passphrase')

// Enroll biometric (browser only)
await db.enrollBiometric()

// Remove biometric enrollment
await db.removeBiometric()
```

### Session tokens (v0.7 #109)

```ts
import { createSession, resolveSession, revokeSession } from '@noy-db/hub'

// After unlocking, create a session (DEK map encrypted under non-extractable session key)
const { token, expiresAt } = await createSession(keyring, { ttlMs: 15 * 60_000 })

// Restore an in-memory keyring from a serialised session token (e.g. on route change)
const keyring = await resolveSession(token)    // throws SessionExpiredError if stale

// Explicit revoke (logout)
revokeSession(token)
revokeAllSessions()   // log out everywhere in the tab
```

### Magic-link unlock (v0.7 #113)

```ts
import { createMagicLinkToken, deriveMagicLinkKEK, isMagicLinkValid } from '@noy-db/hub'

// Server: generate a one-time link token
const linkToken = createMagicLinkToken(compartmentId, { ttlMs: 24 * 60 * 60_000 })

// Server + Client: derive the viewer KEK (deterministic — same key both sides)
const viewerKEK = await deriveMagicLinkKEK(serverSecret, linkToken.token, compartmentId)

// Validate expiry before granting access
if (!isMagicLinkValid(linkToken)) throw new Error('Link expired')
```

### Sync credentials (v0.7 #110)

```ts
import { putCredential, getCredential, deleteCredential, listCredentials } from '@noy-db/hub'

// Store / overwrite an OAuth token for an adapter
await putCredential(adapter, compartment, keyring, {
  adapterId: 'google-drive',
  tokenType: 'Bearer',
  accessToken: '...',
  refreshToken: '...',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
})

// Load token (owner/admin only)
const cred = await getCredential(adapter, compartment, keyring, 'google-drive')

// Check whether the stored token is still valid
const { exists, expired } = await credentialStatus(adapter, compartment, keyring, 'google-drive')
```

### Session policies (v0.7 #114)

```ts
const db = await createNoydb({
  store: ...,
  user: 'alice',
  secret: '...',
  sessionPolicy: {
    idleTimeoutMs: 15 * 60_000,          // revoke after 15 min idle
    absoluteTimeoutMs: 8 * 60 * 60_000, // revoke after 8 h regardless
    requireReAuthFor: ['export', 'grant', 'revoke', 'rotate', 'changeSecret'],
    lockOnBackground: true,              // revoke when tab goes to background
    onRevoke: () => router.push('/login'),
  },
})
```

### Dev-mode persistent unlock (v0.7 #119)

```ts
import { enableDevUnlock, loadDevUnlock, clearDevUnlock } from '@noy-db/hub'

// One-time setup (dev only — throws in production and off localhost)
await enableDevUnlock(keyring, {
  acknowledge: 'I-UNDERSTAND-THIS-DISABLES-UNLOCK-SECURITY',
  persistAcrossTabs: false,  // true → localStorage; false (default) → sessionStorage
})

// On every page load — returns null in production / off localhost
const stored = loadDevUnlock()
if (stored) { /* skip passphrase prompt, use stored keyring */ }
```

### Events

```ts
// Event emitter for reactive UI integration
db.on('sync:push', (result) => { /* push completed */ })
db.on('sync:pull', (result) => { /* pull completed */ })
db.on('sync:conflict', (conflict) => { /* conflict detected */ })
db.on('sync:online', () => { /* went online */ })
db.on('sync:offline', () => { /* went offline */ })
db.on('change', (event) => { /* any local record changed */ })
db.on('error', (error) => { /* adapter or crypto error */ })
```

---

## Data Formats

### Encrypted Record Envelope

Every record on disk/DynamoDB/S3 uses this format:

```json
{
  "_noydb": 1,
  "_v": 3,
  "_ts": "2026-04-04T10:00:00.000Z",
  "_iv": "a3f2b8c1d4e5f60708091011",
  "_data": "U2FsdGVkX1+8m3k7Bp2xV9QhLmNpR..."
}
```

| Field | Type | Encrypted? | Purpose |
|-------|------|:----------:|---------|
| `_noydb` | number | No | Format version identifier |
| `_v` | number | No | Record version (for optimistic concurrency) |
| `_ts` | string | No | Last modified timestamp (ISO 8601) |
| `_iv` | string | No | Base64-encoded 12-byte IV for this record |
| `_data` | string | **Yes** | Base64-encoded AES-256-GCM ciphertext (includes auth tag) |

Metadata (`_v`, `_ts`) is intentionally unencrypted — the sync engine needs it without the encryption key.

> **v0.22 note.** Lazy-mode collections additionally persist secondary
> index entries under the reserved id prefix `_idx/<field>/<recordId>`.
> Each entry uses the same envelope shape; the encrypted body is
> `{ "value": <indexed value>, "writtenAt": <iso> }`. This is not a
> change to the envelope invariant — the envelope is identical; only a
> reserved id namespace is added (joining `_keyring`, `_ledger_deltas/…`,
> `_meta/handle`).

### Keyring File

```json
{
  "_noydb_keyring": 1,
  "user_id": "operator-somchai",
  "display_name": "สมชาย (Operator)",
  "role": "operator",
  "permissions": {
    "invoices": "rw",
    "disbursements": "rw"
  },
  "deks": {
    "invoices": "<base64: AES-KW wrapped DEK>",
    "disbursements": "<base64: AES-KW wrapped DEK>"
  },
  "salt": "<base64: 32-byte PBKDF2 salt>",
  "created_at": "2026-04-04T10:00:00.000Z",
  "granted_by": "owner-01"
}
```

### Compartment Backup Format

```json
{
  "_noydb_backup": 1,
  "_compartment": "C101",
  "_exported_at": "2026-04-04T12:00:00.000Z",
  "_exported_by": "owner-01",
  "keyrings": {
    "owner-01": { /* keyring */ },
    "operator-somchai": { /* keyring */ }
  },
  "collections": {
    "invoices": {
      "inv-001": { "_noydb": 1, "_v": 3, "_iv": "...", "_data": "..." },
      "inv-002": { "_noydb": 1, "_v": 1, "_iv": "...", "_data": "..." }
    },
    "payments": {
      "pay-001": { "_noydb": 1, "_v": 2, "_iv": "...", "_data": "..." }
    }
  }
}
```

The backup is encrypted — each record's `_data` is ciphertext. Only users whose keyrings are included can decrypt after restore.

### Sync Dirty Log

```json
{
  "_noydb_sync": 1,
  "last_push": "2026-04-04T10:00:00.000Z",
  "last_pull": "2026-04-04T09:55:00.000Z",
  "dirty": [
    {
      "collection": "invoices",
      "id": "inv-001",
      "action": "put",
      "version": 4,
      "timestamp": "2026-04-04T10:05:00.000Z"
    },
    {
      "collection": "payments",
      "id": "pay-003",
      "action": "delete",
      "version": 2,
      "timestamp": "2026-04-04T10:06:00.000Z"
    }
  ]
}
```

### `.noydb` Container Format (v0.6 #100)

Binary container wrapping `vault.dump()` with a minimum-disclosure
header for safe drops into cloud storage (Drive, Dropbox, iCloud). The
dump's plaintext JSON still contains `_vault`, `_exported_by`,
`_exported_at` — so the wrap's purpose is to hide that metadata from the
cloud provider's indexing API, not from someone who has already
downloaded the bytes.

**Byte layout** (offsets from start of file):

```
+--------+--------+--------+--------+
|  N=78  |  D=68  |  B=66  |  1=49  |  Magic 'NDB1' (4 bytes)
+--------+--------+--------+--------+
| flags  | compr  |  header_length (uint32 BE)            |
+--------+--------+--------+--------+--------+--------+--------+
| header_length bytes of UTF-8 JSON header                       ...
+--------+--------+
| compressed body bytes                                            ...
```

- **Magic bytes (offset 0-3):** ASCII `NDB1` — `0x4e 0x44 0x42 0x31`. File-type check.
- **Flags (offset 4):** bit 0 = body is compressed, bit 1 = header carries integrity hash, bits 2-7 reserved (must be 0 in v0.6)
- **Compression algorithm (offset 5):** `0` none, `1` gzip, `2` brotli
- **Header length (offset 6-9):** uint32 big-endian length of the JSON header that follows
- **Header (offset 10 to 10+headerLength):** UTF-8 encoded JSON, validated against a closed allowlist
- **Body (remainder):** compressed dump bytes

**Header JSON (minimum-disclosure schema):**

```json
{
  "formatVersion": 1,
  "handle": "01HYABCDEFGHJKMNPQRSTVWXYZ",
  "bodyBytes": 41234567,
  "bodySha256": "abc123..."
}
```

**Only these four keys are allowed.** The validator rejects every other key by name, including (explicitly forbidden): `compartment`, `_compartment`, `exporter`, `_exported_by`, `timestamp`, `_exported_at`, `kdfParams`, salt fields, and anything starting with underscore. Forward-compat extension keys require a format version bump and a new validator.

| Field | Type | Description |
|---|---|---|
| `formatVersion` | number | Bundle format version; must be `1` in v0.6 |
| `handle` | string | 26-character Crockford base32 ULID, stable across re-exports of the same compartment |
| `bodyBytes` | number | Compressed body length. Lets readers verify completeness without decompressing |
| `bodySha256` | string | Lowercase 64-char hex SHA-256 of the **compressed** body bytes |

**Handle persistence:** `compartment.getBundleHandle()` reads from a reserved `_meta/handle` envelope (same bypass path as `_keyring` — `_data` is plain JSON, `_iv` is empty). Different compartments on the same adapter get different handles; the same compartment always returns the same handle across `getBundleHandle()` calls, across `writeNoydbBundle()` calls, and across fresh `createNoydb()` instances over the same adapter.

**Compression:**
- Brotli when `new CompressionStream('br')` is supported (Node 22+, Chrome 124+, Firefox 122+) — typically 30-50% smaller than gzip on JSON payloads
- Gzip fallback (universally available in Node 18+)
- The writer feature-detects brotli at runtime and falls back silently when `{ compression: 'auto' }` (the default) is passed
- Explicit `{ compression: 'brotli' }` throws on unsupported runtimes
- `{ compression: 'none' }` exists for round-trip testing only

**Integrity verification:** `bodyBytes` and `bodySha256` describe the **compressed** body (not the decompressed dump), so `readNoydbBundleHeader()` can verify integrity without decompressing — useful for fast cloud-side validation. A length mismatch fires before the SHA check (cheaper, more actionable error). Both surface as `BundleIntegrityError`, distinct from format errors (missing magic, malformed header) so consumers can pattern-match the corruption case.

**Primitives:**

```ts
// Core
import {
  writeNoydbBundle,
  readNoydbBundle,
  readNoydbBundleHeader,
} from '@noy-db/hub'

const bytes = await writeNoydbBundle(vault, { compression: 'auto' })
const header = readNoydbBundleHeader(bytes) // no decompression
const { header, dumpJson } = await readNoydbBundle(bytes) // full read + verify

// File store helpers
import { saveBundle, loadBundle } from '@noy-db/to-file'

const handle = await vault.getBundleHandle()
await saveBundle(`./bundles/${handle}.noydb`, vault)
const result = await loadBundle(`./bundles/${handle}.noydb`)
```

**Why split read from load:** `readNoydbBundle()` returns the unwrapped dump JSON string, NOT a restored Vault. Restoring requires a separate `vault.load(dumpJson, passphrase)` call. The split keeps the bundle module purely a format layer with zero crypto concerns, and lets the same code feed format inspectors that never decrypt anything.

---

## Package Structure

```
noydb/
├── packages/
│   ├── core/                          # @noy-db/hub — npm main package
│   │   ├── src/
│   │   │   ├── index.ts               # barrel — all public exports
│   │   │   ├── noydb.ts               # Noydb class + PolicyEnforcer wiring
│   │   │   ├── vault.ts               # Vault class (formerly compartment.ts)
│   │   │   ├── collection.ts          # Collection<T> class
│   │   │   ├── crypto.ts              # encrypt, decrypt, deriveKey, bufferToBase64, base64ToBuffer
│   │   │   ├── keyring.ts             # Keyring management (load, grant, revoke, rotate)
│   │   │   ├── session.ts             # Session tokens — createSession, resolveSession (v0.7 #109)
│   │   │   ├── session-policy.ts      # PolicyEnforcer — idle/abs timeouts, reauth, lockOnBg (v0.7 #114)
│   │   │   ├── sync-credentials.ts    # _sync_credentials reserved collection (v0.7 #110)
│   │   │   ├── magic-link.ts          # Magic-link viewer unlock via HKDF (v0.7 #113)
│   │   │   ├── dev-unlock.ts          # Dev-mode sessionStorage/localStorage unlock (v0.7 #119)
│   │   │   ├── crdt.ts                # CRDT types + merge helpers (v0.9 #132)
│   │   │   ├── presence.ts            # PresenceHandle — encrypted ephemeral channel (v0.9 #134)
│   │   │   ├── sync.ts                # SyncEngine (dirty tracking, push, pull, partial sync, transactions)
│   │   │   ├── events.ts              # Event emitter
│   │   │   ├── biometric.ts           # Platform biometric enrollment/unlock
│   │   │   ├── errors.ts              # NoydbError subtypes
│   │   │   └── types.ts               # All TypeScript interfaces
│   │   │
│   │   └── __tests__/                 # tests (Vitest)
│   │   └── package.json
│   │
│   ├── to-file/                       # @noy-db/to-file (formerly @noy-db/store-file)
│   │   ├── src/
│   │   │   └── index.ts              # jsonFile() store factory
│   │   ├── tests/
│   │   └── package.json
│   │
│   ├── to-aws-dynamo/                 # @noy-db/to-aws-dynamo (formerly @noy-db/store-aws-dynamo)
│   │   ├── src/
│   │   │   └── index.ts              # dynamo() store factory
│   │   ├── tests/
│   │   └── package.json              # peerDep: @aws-sdk/lib-dynamodb
│   │
│   ├── to-aws-s3/                     # @noy-db/to-aws-s3 (formerly @noy-db/store-aws-s3)
│   │   ├── src/
│   │   │   └── index.ts              # s3() store factory; uses @aws-sdk/client-s3 directly
│   │   ├── tests/
│   │   └── package.json              # peerDep: @aws-sdk/client-s3
│   │
│   ├── to-memory/                     # @noy-db/to-memory (formerly @noy-db/store-memory)
│   │   ├── src/
│   │   │   └── index.ts              # memory() store factory
│   │   ├── tests/
│   │   └── package.json
│   │
│   ├── to-browser-local/              # @noy-db/to-browser-local (localStorage)
│   │   ├── src/
│   │   │   └── index.ts              # browserLocal() store factory
│   │   ├── tests/
│   │   └── package.json
│   │
│   ├── to-browser-idb/                # @noy-db/to-browser-idb (IndexedDB, atomic CAS #139)
│   │   ├── src/
│   │   │   └── index.ts              # browserIdb() store factory
│   │   ├── tests/
│   │   └── package.json
│   │
│   ├── in-yjs/                        # @noy-db/in-yjs (v0.9 #136)
│   │   ├── src/
│   │   │   ├── index.ts              # yjsCollection, yText, yMap, yArray
│   │   │   ├── yjs-collection.ts     # YjsCollection<YF> — getYDoc, putYDoc, applyUpdate
│   │   │   └── descriptors.ts        # yText(), yMap(), yArray() field descriptors
│   │   ├── __tests__/                # 11 tests
│   │   └── package.json              # peerDeps: @noy-db/hub workspace:*, yjs >=13
│   │
│   ├── on-webauthn/                 # @noy-db/on-webauthn (v0.7 #111)
│   │   ├── src/
│   │   │   └── index.ts              # enrollWebAuthn, unlockWebAuthn (PRF + rawId-HKDF)
│   │   ├── __tests__/                # 18 tests (happy-dom + navigator.credentials stub)
│   │   └── package.json              # peerDep: @noy-db/hub workspace:*
│   │
│   ├── on-oidc/                     # @noy-db/on-oidc (v0.7 #112)
│   │   ├── src/
│   │   │   └── index.ts              # enrollOidc, unlockOidc, knownProviders
│   │   ├── __tests__/                # 21 tests (happy-dom + fetch mock)
│   │   └── package.json              # peerDep: @noy-db/hub workspace:*
│   │
│   ├── in-vue/                        # @noy-db/in-vue
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── plugin.ts             # Nuxt plugin / Vue plugin
│   │   │   ├── useNoydb.ts           # Composable: db instance access
│   │   │   ├── useCollection.ts      # Composable: reactive collection
│   │   │   └── useSync.ts            # Composable: sync status and controls
│   │   ├── tests/
│   │   └── package.json              # peerDep: vue, @noy-db/hub workspace:*
│   │
│   └── create/                        # create-noy-db (unscoped — npm create noy-db)
│
├── scripts/
│   └── release.mjs                    # Version normalizer — always use pnpm release:version
├── package.json                       # Monorepo root (workspaces)
├── turbo.json                         # Build orchestration
├── tsconfig.json                      # Shared TypeScript config
├── LICENSE                            # MIT
├── README.md
├── SPEC.md                            # This file — source of truth
├── ROADMAP.md                         # Version timeline
├── HANDOVER.md                        # Session-to-session state (read first)
├── SECURITY.md                        # Security model documentation
└── CLAUDE.md                          # Claude Code instructions
```

### Install Profiles

```bash
# Local-only app (USB stick, no cloud)
npm install @noy-db/hub @noy-db/to-file

# Cloud-only app (DynamoDB)
npm install @noy-db/hub @noy-db/to-aws-dynamo

# Offline-first with cloud sync
npm install @noy-db/hub @noy-db/to-file @noy-db/to-aws-dynamo

# Browser app (localStorage)
npm install @noy-db/hub @noy-db/to-browser-local

# Browser app (IndexedDB, atomic CAS)
npm install @noy-db/hub @noy-db/to-browser-idb

# Vue/Nuxt integration
npm install @noy-db/hub @noy-db/to-file @noy-db/in-vue

# Development/testing
npm install @noy-db/hub @noy-db/to-memory

# Scaffold a new project
npm create noy-db
```

### Build Targets

- **ESM** — primary (import/export)
- **CJS** — secondary (require) for Node.js compatibility
- **TypeScript declarations** — full `.d.ts` for every package
- **Minimum Node.js:** 18+ (Web Crypto API `globalThis.crypto.subtle`)
- **Minimum browser:** Chrome 63+, Firefox 57+, Safari 13+ (Web Crypto + WebAuthn)

---

## Security Model

### Threat Model

| Threat | Mitigation |
|--------|-----------|
| **USB stick lost/stolen** | Data is AES-256-GCM encrypted. Without passphrase, all data is ciphertext. |
| **DynamoDB admin reads data** | Zero-knowledge: DynamoDB stores only ciphertext. Admin sees encrypted blobs. |
| **Man-in-the-middle** | Adapter transport (HTTPS for DynamoDB/S3) provides channel encryption. Record-level encryption is defense-in-depth. |
| **Brute-force passphrase** | PBKDF2 with 600K iterations. ~200ms per attempt on modern hardware. 8-char random passphrase: ~10^13 combinations × 0.2s = ~63,000 years. |
| **Tampered record** | AES-GCM authentication tag. Decrypt fails with TAMPERED error if any bit is modified. |
| **Revoked user retains data** | Key rotation on revoke re-encrypts all affected collections with new DEKs. Old wrapped DEKs decrypt nothing. |
| **Compromised biometric store** | Wrapped KEK in localStorage is encrypted by the WebAuthn credential. Without the platform authenticator (secure enclave), it's noise. |
| **Memory dump** | DEKs and KEK exist in-process memory during active session. Mitigated by session timeout and clearing on `db.close()`. Not solvable in JS without native modules. |
| **Side-channel timing** | Web Crypto API implementations are constant-time for AES-GCM. PBKDF2 timing reveals nothing useful. |

### What NOYDB Does NOT Protect Against

- **Malicious application code** — if the app itself is compromised, it has access to decrypted data in memory. NOYDB is a storage layer, not an application sandbox.
- **Keylogger capturing passphrase** — OS-level attack. Biometric enrollment mitigates this (passphrase entered once, then biometric).
- **Rubber hose cryptanalysis** — physical coercion. Out of scope.
- **Quantum computing** — AES-256 is considered quantum-resistant (Grover's algorithm reduces effective strength to 128-bit, still infeasible). If needed, a future version could add post-quantum key exchange.

### Security Recommendations for Users

1. **Passphrase strength:** Minimum 12 characters, or a 4+ word passphrase. NOYDB should enforce a minimum entropy check.
2. **Biometric enrollment:** Recommended for daily use. Reduces passphrase exposure.
3. **Key rotation:** Rotate on any access change (revoke, role change). The `rotateKeys: true` flag should be the default.
4. **Backup passphrase:** Store the passphrase in a password manager or physical safe. Loss of passphrase = permanent loss of data (zero-knowledge means no recovery path).
5. **Export with care:** The `export()` function produces unencrypted JSON. Use only for migration. Delete after use.

---

## Implementation Notes

### Performance Expectations

| Operation | Expected Time | Notes |
|-----------|--------------|-------|
| Open + decrypt 1000 records | < 500ms | AES-GCM is hardware-accelerated |
| Single put (encrypt + write) | < 5ms | One AES-GCM encrypt + one file write |
| Single get (read + decrypt) | < 2ms | One file read + one AES-GCM decrypt |
| List 1000 records (all in memory) | < 1ms | Already loaded, just return array |
| Query (filter 1000 records) | < 1ms | Array.filter() is nanoseconds per item |
| Key rotation (re-encrypt 1000 records) | < 1s | 1000 × encrypt + 1000 × write |
| PBKDF2 key derivation | ~200ms | 600K iterations, intentionally slow |
| Full backup dump | < 200ms | Serialize already-encrypted data |
| Sync push (100 dirty records) | < 2s | Depends on network, 100 HTTP requests |

### Testing Strategy

- **Unit tests:** crypto functions, keyring operations, permission checks (use `@noydb/memory`)
- **Integration tests:** full lifecycle with `@noydb/file` on a temp directory
- **DynamoDB tests:** use DynamoDB Local (Docker) for CI
- **Security tests:** verify that encrypted data cannot be decrypted with wrong key, that tampered data is rejected, that revoked users lose access after key rotation
- **Edge cases:** empty compartments, empty collections, concurrent writes (simulate with delays), large records (1 MB+), Unicode content (Thai text), corrupt files

### Error Types

```ts
class NoydbError extends Error {
  code: string
}

// Crypto errors
class DecryptionError extends NoydbError { code = 'DECRYPTION_FAILED' }
class TamperedError extends NoydbError { code = 'TAMPERED' }
class InvalidKeyError extends NoydbError { code = 'INVALID_KEY' }

// Access errors
class NoAccessError extends NoydbError { code = 'NO_ACCESS' }
class ReadOnlyError extends NoydbError { code = 'READ_ONLY' }
class PermissionDeniedError extends NoydbError { code = 'PERMISSION_DENIED' }

// Sync errors
class ConflictError extends NoydbError { code = 'CONFLICT'; version: number }
class NetworkError extends NoydbError { code = 'NETWORK_ERROR' }

// Data errors
class NotFoundError extends NoydbError { code = 'NOT_FOUND' }
class ValidationError extends NoydbError { code = 'VALIDATION_ERROR' }
class SchemaValidationError extends NoydbError { code = 'SCHEMA_VALIDATION_FAILED'; issues: readonly unknown[]; direction: 'input' | 'output' }

// Backup errors (v0.4)
class BackupLedgerError extends NoydbError { code = 'BACKUP_LEDGER'; divergedAt?: number }
class BackupCorruptedError extends NoydbError { code = 'BACKUP_CORRUPTED'; collection: string; id: string }

// Query DSL errors (v0.6 #73, #76)
class JoinTooLargeError extends NoydbError {
  code = 'JOIN_TOO_LARGE'
  leftRows: number
  rightRows: number
  maxRows: number
  side: 'left' | 'right'
}
class DanglingReferenceError extends NoydbError {
  code = 'DANGLING_REFERENCE'
  field: string
  target: string
  refId: string
}

// Aggregation errors (v0.6 #98)
class GroupCardinalityError extends NoydbError {
  code = 'GROUP_CARDINALITY'
  field: string
  cardinality: number
  maxGroups: number
}

// Bundle format errors (v0.6 #100)
class BundleIntegrityError extends NoydbError {
  code = 'BUNDLE_INTEGRITY'
}

// Store capability errors (v0.5 #63; renamed in v0.10)
class StoreCapabilityError extends NoydbError {
  code = 'STORE_CAPABILITY'
  capability: string
}

// Access-control escalation guard (v0.5 #62)
class PrivilegeEscalationError extends NoydbError {
  code = 'PRIVILEGE_ESCALATION'
  offendingCollection: string
}

// Session errors (v0.7 #109)
class SessionExpiredError extends NoydbError { code = 'SESSION_EXPIRED' }
class SessionNotFoundError extends NoydbError { code = 'SESSION_NOT_FOUND' }

// Session policy errors (v0.7 #114)
class SessionPolicyError extends NoydbError {
  code = 'SESSION_POLICY'
  operation: string
}

// CRDT errors (v0.9 #132)
class NonCrdtCollectionError extends NoydbError {
  code = 'NOT_CRDT_COLLECTION'
  // Thrown by collection.getRaw() when crdt option was not set
}

// i18n errors (v0.8 #82)
class MissingTranslationError extends NoydbError { code = 'MISSING_TRANSLATION' }
class LocaleNotSpecifiedError extends NoydbError { code = 'LOCALE_NOT_SPECIFIED' }
class TranslatorNotConfiguredError extends NoydbError { code = 'TRANSLATOR_NOT_CONFIGURED' }

// Dictionary errors (v0.8 #81)
class DictKeyMissingError extends NoydbError { code = 'DICT_KEY_MISSING'; key: string }
class DictKeyInUseError extends NoydbError { code = 'DICT_KEY_IN_USE'; key: string; count: number }
class ReservedCollectionNameError extends NoydbError { code = 'RESERVED_COLLECTION_NAME'; name: string }
```

---

## First Consumer

noy-db was designed for an established accounting firm's platform but is generic by construction. Here's how an accounting-firm domain maps to noy-db concepts:

| Domain Concept | noy-db Concept |
|---------------|---------------|
| Company (e.g., บริษัท ABC จำกัด) | Compartment (`C101`) |
| Invoice records | Collection<Invoice>(`invoices`) |
| Disbursement records | Collection<Disbursement>(`disbursements`) |
| Payment records | Collection<Payment>(`payments`) |
| Client profile | Collection<Client>(`clients`) |
| Report metadata | Collection<ReportMeta>(`reports`) |
| Firm principal (firm owner) | Role: `owner` |
| Senior accountant | Role: `admin` |
| Junior staff | Role: `operator` (with per-collection permissions) |
| External auditor | Role: `viewer` |
| Client company (views own invoices) | Role: `client` |
| USB stick workflow | `@noy-db/to-file` store, dir: `/Volumes/USB/firm-data` |
| Cloud access | `@noy-db/to-aws-dynamo` store, table: `firm-prod` |
| Monthly backup | `company.dump()` → encrypted JSON file |

### Example Configuration

```ts
const db = await createNoydb({
  store: jsonFile({ dir: process.env.FIRM_DATA_DIR || './data' }),
  sync: process.env.STORAGE_BACKEND === 'dynamodb'
    ? dynamo({ table: 'firm-prod', region: 'ap-southeast-1' })
    : undefined,
  user: currentUser.id,
  secret: currentUser.passphrase,
  autoSync: true,
  syncInterval: 30_000,
})

// Open company C101
const c101 = db.openVault('C101')
const invoices = c101.collection<Invoice>('invoices')
const disbursements = c101.collection<Disbursement>('disbursements')
const payments = c101.collection<Payment>('payments')

// Load all into Pinia store
const invoiceStore = useInvoiceStore()
invoiceStore.invoices = await invoices.list()
```

This replaces the current mock data imports (`import mockInvoices from '~/data/mock-invoices'`) with real persistent, encrypted storage — while keeping the Pinia stores and Vue components unchanged.

---

## Appendix

### A. Comparison with Existing Solutions

| Feature | NOYDB | RxDB | Amplify DataStore | PouchDB | TinyBase | LowDB |
|---------|:-----:|:----:|:-----------------:|:-------:|:--------:|:-----:|
| Zero-knowledge encryption | Yes | Paid plugin | No | No | No | No |
| Biometric unlock | Yes | No | No | No | No | No |
| Per-collection access control | Yes | No | IAM (server-side) | No | No | No |
| JSON file backend (USB) | Yes | No | No | No | Yes | Yes |
| DynamoDB backend | Yes | No | Via AppSync | No | No | No |
| S3 backend | Yes | No | No | No | No | No |
| Offline-first sync | Yes | Yes | Yes | Yes | Yes | No |
| Conflict detection | Yes | Yes | Yes | Yes | CRDT | No |
| Backup/restore (JSON) | Yes | Yes | No | Binary | Yes | N/A |
| Multi-user with own secrets | Yes | No | Cognito | No | No | No |
| Vue/Nuxt bindings | Yes | Plugin | Yes | No | No | No |
| Web Crypto (zero deps) | Yes | No | No | No | No | No |
| In-memory-first design | Yes | No | No | No | Yes | Yes |
| MIT license | Yes | Apache+Paid | Apache | Apache | MIT | MIT |

### B. Glossary

| Term | Definition |
|------|-----------|
| **AES-256-GCM** | Advanced Encryption Standard with 256-bit key in Galois/Counter Mode. Provides authenticated encryption (confidentiality + integrity + authentication). |
| **AES-KW** | AES Key Wrap (RFC 3394). Used to encrypt one AES key with another AES key. |
| **Compartment** | Logical namespace in NOYDB for isolating tenants/companies/projects. |
| **Collection** | A typed set of records within a compartment. Each has its own DEK. |
| **CSPRNG** | Cryptographically Secure Pseudo-Random Number Generator. Used for IV and key generation. |
| **DEK** | Data Encryption Key. Random AES-256 key that encrypts records in one collection. |
| **Envelope** | The encrypted wrapper around a record: `{ _noydb, _v, _ts, _iv, _data }`. |
| **IV** | Initialization Vector. 12-byte random value used with AES-GCM. Must be unique per encryption. |
| **KEK** | Key Encryption Key. Derived from user's passphrase. Used to wrap/unwrap DEKs. |
| **Keyring** | Per-user file containing wrapped DEKs and permissions for a compartment. |
| **PBKDF2** | Password-Based Key Derivation Function 2. Turns a passphrase into a cryptographic key. |
| **WebAuthn** | Web Authentication API (FIDO2). Used for biometric authentication. |
| **Zero-knowledge** | Storage pattern where the server/backend cannot read the data it stores. |

### C. References

- [Web Crypto API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
- [WebAuthn Guide — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API)
- [AES-GCM — NIST SP 800-38D](https://csrc.nist.gov/publications/detail/sp/800-38d/final)
- [PBKDF2 — RFC 8018](https://tools.ietf.org/html/rfc8018)
- [AES Key Wrap — RFC 3394](https://tools.ietf.org/html/rfc3394)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [DynamoDB Single-Table Design](https://www.alexdebrie.com/posts/dynamodb-single-table/)

---

*Document version: 1.0.0 — 2026-04-04*
*Author: vicio + Claude*
