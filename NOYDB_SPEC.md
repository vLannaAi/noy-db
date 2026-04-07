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

- **Plaintext export packages.** The `@noy-db/decrypt-*` family (`decrypt-csv`, `decrypt-xml`, `decrypt-xlsx`) and the core `exportJSON()` helper decrypt records and write plaintext bytes to disk on the consumer's behalf. Each function carries an explicit "this writes plaintext to disk" warning block in its README, JSDoc, and npm description.
- **The `plaintextTranslator` hook (v0.8+).** Consumers can opt individual schema fields into auto-translation by configuring a `plaintextTranslator` function on the `Noydb` instance. The library calls that function with the field's plaintext, sends it wherever the consumer's implementation sends it (DeepL, Argos, a self-hosted LLM, a human review queue), and writes the returned translation back. NOYDB ships **no built-in translator**, ships **no translator SDKs as dependencies**, and will reject any PR that adds either. Opt-in is per-field at schema-construction time and visible in the schema source — there is no runtime path that can opt a field in without an explicit schema declaration.
- **Schema validators that call out.** Consumer-supplied Standard Schema validators receive plaintext during the validate step. A validator that calls a remote service (uncommon but possible) sends plaintext over the wire on the consumer's behalf. Same opt-in principle: the validator is consumer-written code, and noy-db does not police what it does.

Every plaintext-exit mechanism shares three properties: **(1) it requires explicit consumer action** at schema or `createNoydb()` time, **(2) it never lives inside a default code path** — opting in is always a positive choice the consumer made, and **(3) it is reflected in the audit ledger** by metadata only — never by content.

The audit-ledger entries for these exits record `{ field, collection, mechanism, timestamp }` and **deliberately do not record plaintext content or plaintext content hashes**. Logging a content hash would create a fingerprint that could allow later correlation of identical phrases across the audit trail — a subtle leak that the audit logging is meant to prevent.

#### What this means in practice

> **The library guarantees the encryption boundary at the adapter layer. The library does not, and cannot, guarantee what happens to plaintext after a consumer hands it to a function the consumer themselves provided.**

A consumer who wants the strongest possible plaintext-isolation discipline can achieve it by: (a) not installing any `@noy-db/decrypt-*` package, (b) not configuring a `plaintextTranslator`, and (c) auditing their schema validators to confirm none of them call out. With that discipline, plaintext lives only in the application's own runtime memory while a session is active, and nowhere else. The library's APIs neither force nor prevent that discipline — the choice is the consumer's, by design.

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
│  ┌─ Adapter Interface ──────▼────────────────────────────┐   │
│  │  6 methods: get, put, delete, list, loadAll, saveAll   │   │
│  │                                                        │   │
│  │  @noydb/file      → JSON files (USB, local disk)       │   │
│  │  @noydb/dynamo    → AWS DynamoDB (single-table)        │   │
│  │  @noydb/s3        → AWS S3 (JSON objects)              │   │
│  │  @noydb/memory    → in-memory (testing)                │   │
│  │  @noydb/browser   → localStorage / IndexedDB           │   │
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

### Compartment
A logical namespace for isolating tenants, companies, or projects. Each compartment has its own set of collections and its own keyring (access control). Maps to a directory (file adapter), a partition key (DynamoDB), or a key prefix (S3/localStorage).

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

**v0.5 #62 — admin-grants-admin (bounded delegation).** Admins can grant and revoke other admins, removing the v0.4 bottleneck where every new admin had to go through the single `owner` principal. Two guardrails apply:

1. **No privilege escalation.** A grant cannot widen access beyond what the grantor holds. Enforced in `grant()` by checking that every DEK wrapped into the new keyring comes from the grantor's own DEK set. Throws `PrivilegeEscalationError`. Structurally trivially true under the v0.5 admin model (admin grants always inherit the full caller DEK set) but wired in so future per-collection admin scoping cannot accidentally bypass it.

2. **Cascade on revoke.** When an admin is revoked, every admin they (transitively) granted is either revoked too (`cascade: 'strict'`, default) or left in place with a `console.warn` listing the orphans (`cascade: 'warn'`). The walk uses the `granted_by` field on each keyring file as the parent pointer. A single key-rotation pass at the end covers the union of affected collections — cost is O(records in affected collections), not O(records × cascade depth).

**v0.5 #72 — exportStream / exportJSON are ACL-scoped.** The "Can Export" column in v0.4 was owner-only; in v0.5 every role that can read collections can export what they can read. Operators and clients see only their explicitly-permitted collections. Viewers (read-all) and admins (read-all) see everything.

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
- **Conflict detection** — version mismatch triggers a callback
- **Auto-sync** — push/pull when online status changes

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

## Adapters

### Interface

```ts
interface NoydbAdapter {
  /**
   * Get a single record by compartment/collection/id.
   * Returns the encrypted envelope or null if not found.
   */
  get(compartment: string, collection: string, id: string): Promise<EncryptedEnvelope | null>

  /**
   * Put a record. If expectedVersion is provided and doesn't match
   * the current version, throw a ConflictError (409).
   */
  put(
    compartment: string,
    collection: string,
    id: string,
    envelope: EncryptedEnvelope,
    expectedVersion?: number
  ): Promise<void>

  /**
   * Delete a record by compartment/collection/id.
   */
  delete(compartment: string, collection: string, id: string): Promise<void>

  /**
   * List all record IDs in a collection.
   */
  list(compartment: string, collection: string): Promise<string[]>

  /**
   * Load all records across all collections for a compartment.
   * Used for initial hydration on open.
   */
  loadAll(compartment: string): Promise<CompartmentSnapshot>

  /**
   * Save all records for a compartment (bulk write).
   * Used for restore and key rotation.
   */
  saveAll(compartment: string, data: CompartmentSnapshot): Promise<void>
}
```

### @noydb/file — JSON File Adapter

Maps the hierarchy to the filesystem:

```
{baseDir}/
  {compartment}/
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
- Optimistic concurrency: read `_v` from file, compare, write
- Works on any mounted filesystem: local disk, USB stick, network drive, SD card

**Configuration:**
```ts
jsonFile({
  dir: '/Volumes/USB/noydb-data',   // base directory
  pretty: true,                      // indent JSON (default: true, costs ~20% space)
})
```

### @noydb/dynamo — DynamoDB Adapter

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

**Optimistic concurrency** via `ConditionExpression`:
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

### @noydb/s3 — S3 Adapter

Maps the hierarchy to S3 object keys:

```
s3://{bucket}/{compartment}/{collection}/{recordId}.json
s3://{bucket}/{compartment}/_keyring/{userId}.json
```

Uses S3 ETags for optimistic concurrency (`If-Match` header).

### @noydb/memory — In-Memory Adapter (Testing)

Stores everything in a `Map`. No persistence. Used for unit tests.

### @noydb/browser — Browser Storage Adapter

Uses `localStorage` (< 5 MB) or `IndexedDB` (> 5 MB, via a thin wrapper). Used as a cache layer in browser-based apps for instant hydration on page load.

### Custom Adapters

Implement the `NoydbAdapter` interface (6 methods). Example skeleton:

```ts
import { defineAdapter } from '@noydb/core'

export const myAdapter = defineAdapter((options: MyOptions) => ({
  name: 'my-backend',
  async get(compartment, collection, id) { /* ... */ },
  async put(compartment, collection, id, envelope, expectedVersion) { /* ... */ },
  async delete(compartment, collection, id) { /* ... */ },
  async list(compartment, collection) { /* ... */ },
  async loadAll(compartment) { /* ... */ },
  async saveAll(compartment, data) { /* ... */ },
}))
```

---

## API Specification

### Creating an Instance

```ts
import { createNoydb } from '@noydb/core'
import { jsonFile } from '@noydb/file'

// Minimal — local only, passphrase auth
const db = await createNoydb({
  adapter: jsonFile({ dir: './data' }),
  user: 'owner-01',
  secret: 'my-passphrase',
})

// With sync — offline-first with cloud backup
const db = await createNoydb({
  adapter: jsonFile({ dir: './data' }),       // primary (local)
  sync: dynamo({ table: 'myapp' }),            // secondary (cloud)
  user: 'owner-01',
  secret: 'my-passphrase',
  conflict: 'version',                         // or 'local-wins', 'remote-wins', custom fn
  autoSync: true,                              // sync on online/offline events
  syncInterval: 30_000,                        // periodic sync (ms)
})

// Biometric auth (browser only)
const db = await createNoydb({
  adapter: jsonFile({ dir: './data' }),
  user: 'owner-01',
  auth: 'biometric',                           // triggers Touch ID / Face ID
})

// Unencrypted mode (development/testing)
const db = await createNoydb({
  adapter: memory(),
  user: 'dev',
  encrypt: false,                              // plaintext — NEVER use in production
})
```

### Compartments and Collections

```ts
// Open a compartment
const company = db.compartment('C101')

// Open a typed collection
const invoices = company.collection<Invoice>('invoices')
const payments = company.collection<Payment>('payments')

// List available compartments
const compartments: string[] = await db.compartments()

// List collections in a compartment
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

### Sync Operations

```ts
// Push local changes to remote
const pushResult = await db.push()
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

// Export as decrypted JSON (v0.5+, ACL-scoped — #72)
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

---

## Package Structure

```
noydb/
├── packages/
│   ├── core/                          # @noydb/core — npm main package
│   │   ├── src/
│   │   │   ├── index.ts               # createNoydb() entry point
│   │   │   ├── noydb.ts               # Noydb class
│   │   │   ├── compartment.ts         # Compartment class
│   │   │   ├── collection.ts          # Collection<T> class
│   │   │   ├── crypto.ts              # encrypt, decrypt, deriveKey (Web Crypto)
│   │   │   ├── keyring.ts             # Keyring management (load, grant, revoke, rotate)
│   │   │   ├── sync.ts               # SyncEngine (dirty tracking, push, pull)
│   │   │   ├── events.ts              # Event emitter
│   │   │   ├── biometric.ts           # WebAuthn enrollment and unlock
│   │   │   ├── errors.ts              # NoydbError subtypes
│   │   │   └── types.ts               # All TypeScript interfaces
│   │   ├── tests/
│   │   │   ├── crypto.test.ts
│   │   │   ├── collection.test.ts
│   │   │   ├── keyring.test.ts
│   │   │   ├── sync.test.ts
│   │   │   └── access-control.test.ts
│   │   └── package.json
│   │
│   ├── adapter-file/                  # @noydb/file
│   │   ├── src/
│   │   │   └── index.ts              # jsonFile() adapter factory
│   │   ├── tests/
│   │   └── package.json
│   │
│   ├── adapter-dynamo/                # @noydb/dynamo
│   │   ├── src/
│   │   │   └── index.ts              # dynamo() adapter factory
│   │   ├── tests/
│   │   └── package.json              # peerDep: @aws-sdk/lib-dynamodb
│   │
│   ├── adapter-s3/                    # @noydb/s3
│   │   ├── src/
│   │   │   └── index.ts              # s3() adapter factory
│   │   ├── tests/
│   │   └── package.json              # peerDep: @aws-sdk/client-s3
│   │
│   ├── adapter-memory/                # @noydb/memory
│   │   ├── src/
│   │   │   └── index.ts              # memory() adapter factory
│   │   ├── tests/
│   │   └── package.json
│   │
│   ├── adapter-browser/               # @noydb/browser
│   │   ├── src/
│   │   │   └── index.ts              # browser() adapter (localStorage/IndexedDB)
│   │   ├── tests/
│   │   └── package.json
│   │
│   └── vue/                           # @noydb/vue
│       ├── src/
│       │   ├── index.ts
│       │   ├── plugin.ts             # Nuxt plugin / Vue plugin
│       │   ├── useNoydb.ts           # Composable: db instance access
│       │   ├── useCollection.ts      # Composable: reactive collection
│       │   └── useSync.ts            # Composable: sync status and controls
│       ├── tests/
│       └── package.json              # peerDep: vue, @noydb/core
│
├── package.json                       # Monorepo root (workspaces)
├── turbo.json                         # Build orchestration
├── tsconfig.json                      # Shared TypeScript config
├── vitest.config.ts                   # Test runner
├── LICENSE                            # MIT
├── README.md
├── SECURITY.md                        # Security model documentation
└── CLAUDE.md                          # Claude Code instructions
```

### Install Profiles

```bash
# Local-only app (USB stick, no cloud)
npm install @noydb/core @noydb/file

# Cloud-only app (DynamoDB)
npm install @noydb/core @noydb/dynamo

# Offline-first with cloud sync
npm install @noydb/core @noydb/file @noydb/dynamo

# Browser app with local cache
npm install @noydb/core @noydb/browser

# Vue/Nuxt integration
npm install @noydb/core @noydb/file @noydb/vue

# Development/testing
npm install @noydb/core @noydb/memory
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

### Priority Order

Build in this order to get a usable library as early as possible:

**Phase 1: Core + File Adapter (MVP)**
1. `@noydb/core` — createNoydb, Compartment, Collection, crypto (encrypt/decrypt/deriveKey)
2. `@noydb/memory` — in-memory adapter for tests
3. `@noydb/file` — JSON file adapter
4. Single-user mode only (owner, no grant/revoke)
5. No sync engine yet
6. Backup/restore (dump/load)

**Phase 2: Multi-User**
7. Keyring management (grant, revoke, rotate)
8. Role-based permission checks
9. Multi-user tests (owner + operator + viewer)

**Phase 3: Sync**
10. Dirty tracking
11. Push/pull with remote adapter
12. Conflict detection and resolution
13. `@noydb/dynamo` adapter

**Phase 4: Browser**
14. `@noydb/browser` adapter (localStorage/IndexedDB)
15. Biometric enrollment and unlock (WebAuthn)
16. `@noydb/vue` composables
17. Auto-sync (online/offline events)

**Phase 5: Polish**
18. `@noydb/s3` adapter
19. Passphrase strength validation
20. Session timeout (auto-lock)
21. CLI tool for key management

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
| USB stick workflow | `@noy-db/file` adapter, dir: `/Volumes/USB/firm-data` |
| Cloud access | `@noy-db/dynamo` adapter, table: `firm-prod` |
| Monthly backup | `company.dump()` → encrypted JSON file |

### Example Configuration

```ts
const db = await createNoydb({
  adapter: jsonFile({ dir: process.env.FIRM_DATA_DIR || './data' }),
  sync: process.env.STORAGE_BACKEND === 'dynamodb'
    ? dynamo({ table: 'firm-prod', region: 'ap-southeast-1' })
    : undefined,
  user: currentUser.id,
  secret: currentUser.passphrase,
  autoSync: true,
  syncInterval: 30_000,
})

// Open company C101
const c101 = db.compartment('C101')
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
