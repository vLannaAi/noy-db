# @noy-db/core

> Zero-knowledge, offline-first, encrypted document store — core library.

[![npm](https://img.shields.io/npm/v/@noy-db/core.svg)](https://www.npmjs.com/package/@noy-db/core)
[![license](https://img.shields.io/npm/l/@noy-db/core.svg)](https://github.com/vLannaAi/noy-db/blob/main/LICENSE)

Part of [**noy-db**](https://github.com/vLannaAi/noy-db) — *"None Of Your Damn Business"*.

## Install

```bash
pnpm add @noy-db/core @noy-db/memory
```

You need `@noy-db/core` plus at least one adapter: [`@noy-db/memory`](https://npmjs.com/package/@noy-db/memory), [`@noy-db/file`](https://npmjs.com/package/@noy-db/file), [`@noy-db/browser`](https://npmjs.com/package/@noy-db/browser), [`@noy-db/dynamo`](https://npmjs.com/package/@noy-db/dynamo), [`@noy-db/s3`](https://npmjs.com/package/@noy-db/s3).

## Quick start

```ts
import { createNoydb } from '@noy-db/core'
import { memory } from '@noy-db/memory'

type Invoice = { id: string; amount: number; customer: string }

const db = await createNoydb({
  adapter: memory(),
  userId: 'alice',
  passphrase: 'correct horse battery staple',
})

const c101 = await db.openCompartment('C101')
const invoices = c101.collection<Invoice>('invoices')

await invoices.put('INV-001', { id: 'INV-001', amount: 8500, customer: 'ABC Trading' })
const all = await invoices.list()
```

## What it does

- **Zero-knowledge encryption** — AES-256-GCM + PBKDF2 (600K iterations) + AES-KW, all via Web Crypto API
- **Per-collection keys** — one DEK per collection, wrapped with a per-user KEK
- **Multi-user access control** — owner, admin, operator, viewer, client roles
- **Offline-first sync** — push/pull with optimistic concurrency on encrypted envelopes
- **Audit history** — full-copy snapshots with `history()`, `diff()`, `revert()`, `pruneHistory()`
- **Zero runtime dependencies**

## Documentation

- Full docs: https://github.com/vLannaAi/noy-db#readme
- Spec: https://github.com/vLannaAi/noy-db/blob/main/NOYDB_SPEC.md
- AI reference: https://github.com/vLannaAi/noy-db/blob/main/docs/noydb-for-ai.md

## License

MIT © vLannaAi
