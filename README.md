# NOYDB — None Of Your Damn Business

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-strict-blue.svg)](https://www.typescriptlang.org/)
[![Zero Dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](#dependency-budget)

> Your data. Your device. Your keys. Not your DB's business.

A zero-knowledge, offline-first, encrypted document store with pluggable backends and multi-user access control.

## Features

- **Zero-knowledge** — Backends store only ciphertext. No server ever sees plaintext.
- **Offline-first** — Local adapter is primary. Cloud sync is optional.
- **Pluggable backends** — USB file, DynamoDB, S3, browser storage, or your own.
- **Multi-user ACL** — 5 roles, per-collection permissions, portable keyrings.
- **Zero runtime dependencies** — All crypto via Web Crypto API (`crypto.subtle`).
- **Memory-first queries** — `Array.filter()` for 1K–50K records. No query engine.

## Install

```bash
# Local-only (USB stick, local disk)
npm install @noydb/core @noydb/file

# Cloud-only (DynamoDB)
npm install @noydb/core @noydb/dynamo

# Offline-first with cloud sync
npm install @noydb/core @noydb/file @noydb/dynamo

# Browser app
npm install @noydb/core @noydb/browser

# Vue/Nuxt integration
npm install @noydb/core @noydb/file @noydb/vue

# Development / testing
npm install @noydb/core @noydb/memory
```

## Quick Start

```typescript
import { createNoydb } from '@noydb/core'
import { jsonFile } from '@noydb/file'

const db = await createNoydb({
  adapter: jsonFile({ dir: './data' }),
  user: 'owner-01',
  secret: 'my-passphrase',
})

const company = db.compartment('C101')
const invoices = company.collection<Invoice>('invoices')

// CRUD — encrypted at rest, transparent to your code
await invoices.put('inv-001', { amount: 5000, status: 'draft' })
const inv = await invoices.get('inv-001')
const drafts = invoices.query(i => i.status === 'draft')

// Backup — encrypted JSON, safe to email or store anywhere
const backup = await company.dump()
```

## Requirements

- **Node.js** 18+ (Web Crypto API)
- **Browsers:** Chrome 63+, Firefox 57+, Safari 13+

## Packages

| Package | Description | Runtime Deps |
|---------|------------|:------------:|
| `@noydb/core` | Core library — crypto, CRUD, access control | 0 |
| `@noydb/memory` | In-memory adapter (testing) | 0 |
| `@noydb/file` | JSON file adapter (USB, local disk) | 0 |
| `@noydb/dynamo` | AWS DynamoDB adapter | 0 (peer: `@aws-sdk/lib-dynamodb`) |
| `@noydb/s3` | AWS S3 adapter | 0 (peer: `@aws-sdk/client-s3`) |
| `@noydb/browser` | localStorage / IndexedDB adapter | 0 |
| `@noydb/vue` | Vue/Nuxt composables | 0 (peer: `vue`) |

## Documentation

- [Specification](NOYDB_SPEC.md) — Full design document
- [Roadmap](docs/ROADMAP.md) — Implementation plan
- [Security](SECURITY.md) — Threat model and crypto details
- [Contributing](CONTRIBUTING.md) — How to contribute

## License

[MIT](LICENSE)
