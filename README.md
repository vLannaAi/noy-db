<div align="center">

<img alt="noy-db logo" src="docs/assets/brand.svg" width="180">

# noy-db

### None Of Your Damn Business

Your data. Your device. Your keys. Not your DB's business.

A zero-knowledge, offline-first, encrypted document store with pluggable backends and multi-user access control.

[![npm](https://img.shields.io/npm/v/@noy-db/core.svg?label=%40noy-db%2Fcore)](https://www.npmjs.com/package/@noy-db/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](https://www.typescriptlang.org)
[![Runtime Deps](https://img.shields.io/badge/Runtime_Deps-0-brightgreen.svg)](#zero-dependencies)
[![Crypto](https://img.shields.io/badge/Crypto-Web_Crypto_API-purple.svg)](#encryption)

</div>

---

## The Problem

You have a small, sensitive dataset (1K–50K records). It needs to work offline, sync to the cloud when available, be encrypted at rest on every backend, and support multiple users with different access levels. You want to swap storage backends without changing your app code.

**No existing library does all of this.** NOYDB does.

| Library | What's Missing |
|---------|---------------|
| RxDB | Encryption is a paid plugin. No file backend. |
| Amplify DataStore | Mandatory AppSync. No zero-knowledge encryption. |
| PouchDB | CouchDB only. No DynamoDB. Aging project. |
| TinyBase | No encryption. No DynamoDB. |
| LowDB | No sync. No encryption. No multi-user. |
| Dexie | Browser only. No server-side. |
| Replicache | BSL license (paid). Browser only. |

---

## Architecture

<picture>
  <img alt="NOYDB Architecture" src="docs/assets/architecture.svg" width="100%">
</picture>

> Adapters **only see ciphertext**. Encryption happens in core before data reaches any backend. A DynamoDB admin, an S3 bucket owner, someone who finds the USB stick — they all see encrypted blobs.

---

## Encryption

<picture>
  <img alt="Key Hierarchy" src="docs/assets/key-hierarchy.svg" width="100%">
</picture>

| Layer | Algorithm | Purpose |
|-------|-----------|---------|
| Key derivation | PBKDF2-SHA256 (600K iterations) | Passphrase to KEK |
| Key wrapping | AES-KW (RFC 3394) | KEK wraps/unwraps DEKs |
| Data encryption | AES-256-GCM | DEK encrypts records |
| IV generation | CSPRNG | Fresh 12-byte IV per write |

**Zero crypto dependencies.** Everything uses the Web Crypto API (`crypto.subtle`), built into Node.js 18+ and modern browsers.

---

## Record Format

<picture>
  <img alt="Encrypted Envelope" src="docs/assets/envelope-format.svg" width="100%">
</picture>

Every record on disk, DynamoDB, or S3 is an encrypted envelope. Metadata (`_v`, `_ts`) stays plaintext so the sync engine can work without encryption keys.

---

## Deployment Profiles

<picture>
  <img alt="Deployment Profiles" src="docs/assets/deployment-profiles.svg" width="100%">
</picture>

### Install

```bash
# USB / Local disk only
npm install @noydb/core @noydb/file

# Cloud only (DynamoDB)
npm install @noydb/core @noydb/dynamo

# Offline-first with cloud sync
npm install @noydb/core @noydb/file @noydb/dynamo

# Browser SPA / PWA
npm install @noydb/core @noydb/browser

# Vue / Nuxt full stack
npm install @noydb/core @noydb/file @noydb/dynamo @noydb/vue

# Development / testing
npm install @noydb/core @noydb/memory
```

---

## Quick Start

```ts
import { createNoydb } from '@noydb/core'
import { jsonFile } from '@noydb/file'

// Create an encrypted store
const db = await createNoydb({
  adapter: jsonFile({ dir: './data' }),
  user: 'owner-01',
  secret: 'my-passphrase',
})

// Open a compartment and collection
const company = db.compartment('C101')
const invoices = company.collection<Invoice>('invoices')

// CRUD — everything is encrypted transparently
await invoices.put('inv-001', { amount: 5000, status: 'draft' })
const inv = await invoices.get('inv-001')
const drafts = invoices.query(i => i.status === 'draft')

// Backup — output is all ciphertext, safe to transport
const backup = await company.dump()
```

### With Cloud Sync

```ts
import { dynamo } from '@noydb/dynamo'

const db = await createNoydb({
  adapter: jsonFile({ dir: './data' }),       // primary (local)
  sync: dynamo({ table: 'myapp-prod' }),      // secondary (cloud)
  user: 'owner-01',
  secret: 'my-passphrase',
  autoSync: true,
  syncInterval: 30_000,
})

// Works offline. Syncs when online.
await db.push()   // send local changes to cloud
await db.pull()   // fetch cloud changes to local
await db.sync()   // pull then push
```

### Multi-User Access

```ts
// Grant access (owner/admin only)
await db.grant('C101', {
  userId: 'operator-somchai',
  displayName: 'Somchai',
  role: 'operator',
  passphrase: 'temporary-passphrase',
  permissions: { invoices: 'rw', disbursements: 'rw' },
})

// Revoke with key rotation (old keyring becomes useless)
await db.revoke('C101', {
  userId: 'operator-somchai',
  rotateKeys: true,
})
```

---

## Roles & Permissions

| Role | Read | Write | Grant | Revoke | Export |
|------|:----:|:-----:|:-----:|:------:|:------:|
| **owner** | all | all | all roles | all | yes |
| **admin** | all | all | operator, viewer, client | same | yes |
| **operator** | granted collections | granted collections | — | — | — |
| **viewer** | all | — | — | — | — |
| **client** | granted collections | — | — | — | — |

---

<a name="zero-dependencies"></a>
## Zero Dependencies

```
┌────────────────────┬──────────────┬─────────────────────────┐
│ Package            │ Runtime deps │ Peer deps               │
├────────────────────┼──────────────┼─────────────────────────┤
│ @noydb/core        │ 0            │ —                       │
│ @noydb/file        │ 0            │ @noydb/core             │
│ @noydb/dynamo      │ 0            │ @noydb/core, @aws-sdk/* │
│ @noydb/s3          │ 0            │ @noydb/core, @aws-sdk/* │
│ @noydb/browser     │ 0            │ @noydb/core             │
│ @noydb/memory      │ 0            │ @noydb/core             │
│ @noydb/vue         │ 0            │ @noydb/core, vue        │
└────────────────────┴──────────────┴─────────────────────────┘
```

Every package has **zero runtime dependencies**. AWS SDKs and Vue are peer dependencies — your app already has them.

---

## Performance

| Operation | Target |
|-----------|--------|
| Open + decrypt 1,000 records | < 500ms |
| Single `put` (encrypt + write) | < 5ms |
| Single `get` (read + decrypt) | < 2ms |
| `list` / `query` 1,000 records | < 1ms |
| Key rotation (1,000 records) | < 1s |
| PBKDF2 derivation | ~200ms |

---

## Custom Adapters

The adapter interface is 6 methods. Anything that can store a blob works with NOYDB:

```ts
import { defineAdapter } from '@noydb/core'

export const myAdapter = defineAdapter((options) => ({
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

## Status

**Pre-release.** See the [Roadmap](ROADMAP.md) for the full build plan.

| Phase | Status | Scope |
|-------|--------|-------|
| 0 — Scaffolding | Planned | Monorepo, CI, tooling |
| 0.5 — Test Architecture | Planned | Conformance suites, simulation harnesses |
| 1 — Core MVP | Planned | Crypto, CRUD, file + memory adapters |
| 2 — Multi-User | Planned | Keyring, grant/revoke, roles |
| 3 — Sync | Planned | Dirty tracking, push/pull, DynamoDB adapter |
| 4 — Browser | Planned | IndexedDB, WebAuthn, Vue composables |
| 5 — Polish | Planned | S3 adapter, migration, docs, npm publish |

---

## License

[MIT](LICENSE)

---

<div align="center">
  <sub>Your data. Your device. Your keys. <b>None of your DB's damn business.</b></sub>
</div>
