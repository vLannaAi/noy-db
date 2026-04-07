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
# Nuxt 4 + Pinia (recommended — the v0.3 happy path)
pnpm add @noy-db/nuxt @noy-db/pinia @noy-db/core @noy-db/browser @pinia/nuxt pinia

# Plain Vue 3 + Pinia (no Nuxt)
pnpm add @noy-db/pinia @noy-db/core @noy-db/browser pinia vue

# USB / Local disk only
pnpm add @noy-db/core @noy-db/file

# Cloud only (DynamoDB)
pnpm add @noy-db/core @noy-db/dynamo

# Offline-first with cloud sync
pnpm add @noy-db/core @noy-db/file @noy-db/dynamo

# Development / testing
pnpm add @noy-db/core @noy-db/memory
```

---

## Quick Start — Nuxt 4 + Pinia (two minutes)

The v0.3 happy path is one config block, one store file, one component. Everything below is encrypted with AES-256-GCM before it touches localStorage / IndexedDB.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@pinia/nuxt', '@noy-db/nuxt'],
  noydb: {
    adapter: 'browser',
    pinia: true,
    devtools: true,
  },
})
```

```ts
// app/stores/invoices.ts — defineNoydbStore is auto-imported
export interface Invoice {
  id: string
  client: string
  amount: number
  status: 'draft' | 'open' | 'paid'
}

export const useInvoices = defineNoydbStore<Invoice>('invoices', {
  compartment: 'demo-co',
})
```

```vue
<!-- app/pages/invoices.vue -->
<script setup lang="ts">
const invoices = useInvoices()
await invoices.$ready

const drafts = invoices.query()
  .where('status', '==', 'draft')
  .live()
</script>

<template>
  <ul>
    <li v-for="inv in drafts" :key="inv.id">
      {{ inv.client }} — {{ inv.amount }}
    </li>
  </ul>
</template>
```

That's the whole app. Reactive Pinia store, encrypted storage, SSR-safe. See [`docs/getting-started.md`](docs/getting-started.md) for the complete walkthrough and the [`playground/nuxt/`](playground/nuxt/) demo for a runnable reference.

### Lower-level API (no Vue/Pinia)

For CLIs, tests, or backends, use `@noy-db/core` directly:

```ts
import { createNoydb } from '@noy-db/core'
import { jsonFile } from '@noy-db/file'

const db = await createNoydb({
  adapter: jsonFile({ dir: './data' }),
  user: 'owner-01',
  secret: 'my-passphrase',
})

const company = await db.openCompartment('C101')
const invoices = company.collection<Invoice>('invoices')

await invoices.put('inv-001', { amount: 5000, status: 'draft' })
const inv = await invoices.get('inv-001')
const drafts = invoices.query().where('status', '==', 'draft').toArray()

const backup = await company.dump()   // ciphertext, safe to transport
db.close()                            // clears KEK/DEK from memory
```

### With Cloud Sync

```ts
import { dynamo } from '@noy-db/dynamo'

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
┌────────────────────┬──────────────┬───────────────────────────────────────┐
│ Package            │ Runtime deps │ Peer deps                             │
├────────────────────┼──────────────┼───────────────────────────────────────┤
│ @noy-db/core       │ 0            │ —                                     │
│ @noy-db/file       │ 0            │ @noy-db/core                          │
│ @noy-db/dynamo     │ 0            │ @noy-db/core, @aws-sdk/*              │
│ @noy-db/s3         │ 0            │ @noy-db/core, @aws-sdk/*              │
│ @noy-db/browser    │ 0            │ @noy-db/core                          │
│ @noy-db/memory     │ 0            │ @noy-db/core                          │
│ @noy-db/vue        │ 0            │ @noy-db/core, vue                     │
│ @noy-db/pinia      │ 0            │ @noy-db/core, pinia, vue              │
│ @noy-db/nuxt       │ 0            │ @noy-db/core, @noy-db/pinia, nuxt ^4  │
└────────────────────┴──────────────┴───────────────────────────────────────┘
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
import { defineAdapter } from '@noy-db/core'

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

**v0.4 shipped on npm.** All releases through 0.4 are published. See the [Roadmap](ROADMAP.md) for the full plan.

| Version | Status   | Scope                                                              |
|---------|----------|--------------------------------------------------------------------|
| 0.1     | shipped  | Core MVP, multi-user, file + memory adapters, 5-role ACL           |
| 0.2     | shipped  | Sync engine, DynamoDB/S3/browser adapters, WebAuthn, Vue composables |
| 0.3     | shipped  | Nuxt 4 module, Pinia integration, query DSL, indexes, lazy hydration |
| 0.3.1   | shipped  | `@noy-db/create` scaffolder + `noy-db` CLI                          |
| 0.4     | shipped  | Schema validation, hash-chained ledger, delta history, FK refs, verifiable backups |
| 0.5+    | planned  | Identity & sessions, CRDT sync, ledger devtools                     |

---

## License

[MIT](LICENSE)

---

<div align="center">
  <sub>Your data. Your device. Your keys. <b>None of your DB's damn business.</b></sub>
</div>
