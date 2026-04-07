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

## Backup and export

noy-db ships two distinct paths for getting data out of a compartment. They are not interchangeable — use the one that matches your goal.

### `compartment.dump()` — encrypted backup (the default)

Produces a tamper-evident encrypted JSON envelope. Records stay encrypted, the v0.4 hash-chained ledger is included so the receiver can verify integrity end-to-end after `load()`, and the recipient must hold a valid keyring to read anything. **Use this for backup, transport between machines, or any scenario where the data must remain protected on disk.**

```ts
const backup = await company.dump()              // string of encrypted JSON
await fs.writeFile('./acme-backup.json', backup) // safe to store anywhere
// later, on another machine:
await otherCompany.load(backup)                  // verifies + restores
```

### `compartment.exportStream()` and `compartment.exportJSON()` — plaintext export

⚠ **These methods decrypt your records and produce plaintext.**

`exportStream()` is an authorization-aware async generator that yields per-collection chunks of decrypted records, with schema and ref metadata attached. `exportJSON()` is a five-line wrapper that serializes the stream to a single JSON string.

Both methods are **ACL-scoped**: collections the calling principal cannot read are silently skipped. An operator with `{ invoices: 'rw' }` permissions on a five-collection compartment exports only `invoices`, with no error on the others.

```ts
// Stream every collection the caller can read
for await (const chunk of company.exportStream()) {
  console.log(chunk.collection, chunk.records.length)
}

// Or get a single JSON string
const json = await company.exportJSON()
await fs.writeFile('./backup.json', json)
```

**Use only when:**
- You are the authorized owner of the data, **and**
- You have a legitimate downstream tool that requires plaintext, **and**
- You have a documented plan for how the resulting plaintext will be protected and eventually destroyed.

If your goal is encrypted backup or transport between noy-db instances, use **`dump()`** instead.

#### Why no built-in file path support

Core has zero `node:` imports — it runs unchanged in browsers, Node, Bun, Deno, and edge runtimes. `exportJSON()` returns a `Promise<string>` so the consumer chooses any sink (`fs.writeFile`, `Blob` download, `fetch` upload, IndexedDB) and the destination decision stays explicit at the call site. This is also better for the security warning: there's no library function quietly writing plaintext somewhere.

#### Other plaintext formats

CSV, XML, xlsx, etc. live in dedicated `@noy-db/decrypt-*` packages (v0.6+). Each carries the same plaintext-on-disk warning as `exportJSON()`. The `decrypt-` prefix makes the consent step impossible to miss at the import line — see the [decrypt-* package family policy](https://github.com/vLannaAi/noy-db/blob/main/ROADMAP.md#plaintext-export-packages--noy-dbdecrypt-) in the roadmap.

## Documentation

- Full docs: https://github.com/vLannaAi/noy-db#readme
- Spec: https://github.com/vLannaAi/noy-db/blob/main/NOYDB_SPEC.md
- AI reference: https://github.com/vLannaAi/noy-db/blob/main/docs/noydb-for-ai.md

## License

MIT © vLannaAi
