# @noy-db/hub

> Zero-knowledge, offline-first, encrypted document store — core library.

[![npm](https://img.shields.io/npm/v/@noy-db/hub.svg)](https://www.npmjs.com/package/@noy-db/hub)
[![license](https://img.shields.io/npm/l/@noy-db/hub.svg)](https://github.com/vLannaAi/noy-db/blob/main/LICENSE)

Part of [**noy-db**](https://github.com/vLannaAi/noy-db) — *"None Of Your Damn Business"*.

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-memory
```

You need `@noy-db/hub` plus at least one adapter: [`@noy-db/to-memory`](https://npmjs.com/package/@noy-db/to-memory), [`@noy-db/to-file`](https://npmjs.com/package/@noy-db/to-file), [`@noy-db/to-browser-idb`](https://npmjs.com/package/@noy-db/to-browser-idb), [`@noy-db/to-aws-dynamo`](https://npmjs.com/package/@noy-db/to-aws-dynamo), [`@noy-db/to-aws-s3`](https://npmjs.com/package/@noy-db/to-aws-s3).

## Quick start

```ts
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

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

## Cross-compartment queries

When a single principal holds grants across many compartments — multi-tenant apps, multi-project setups, multi-workspace tools — there are two APIs for enumerating and fanning out across them:

### `db.listAccessibleCompartments(options?)` — enumerate

Returns every compartment the calling principal can unwrap, optionally filtered by minimum role. The walk is bounded by the local keyring index — compartments where the user has no keyring file or where the passphrase doesn't unwrap are silently dropped from the result.

```ts
// All compartments I can unlock
const all = await db.listAccessibleCompartments()
// → [{ id: 'T1', role: 'owner' }, { id: 'T7', role: 'admin' }, ...]

// Only compartments where I'm at least admin
const admin = await db.listAccessibleCompartments({ minRole: 'admin' })
```

**Existence-leak guarantee.** The return value never reveals the existence of a compartment the caller cannot unwrap. The adapter sees the enumeration call (it owns the storage), but downstream consumers of `listAccessibleCompartments()` only see the filtered list.

**Adapter capability.** Requires the optional `NoydbAdapter.listCompartments()` method. The `@noy-db/to-memory` and `@noy-db/to-file` adapters implement it; cloud adapters (`@noy-db/to-aws-dynamo`, `@noy-db/to-aws-s3`) and `@noy-db/to-browser-idb` do not (cloud enumeration needs a GSI or list-bucket permission that has to be configured by the consumer). Calling `listAccessibleCompartments()` against an adapter that doesn't implement `listCompartments` throws `AdapterCapabilityError`. Workaround: maintain the candidate list out of band and pass it directly to `queryAcross()`.

### `db.queryAcross(ids, fn, options?)` — fan out

Runs a per-compartment callback against a list of compartment ids and collects the results, tagged by compartment. Per-compartment errors do not abort the others — each result slot carries either `result` or `error`.

```ts
const accessible = await db.listAccessibleCompartments({ minRole: 'admin' })

const results = await db.queryAcross(
  accessible.map((c) => c.id),
  async (comp) => {
    return comp.collection<Invoice>('invoices').query()
      .where('month', '==', '2026-03')
      .toArray()
  },
  { concurrency: 4 }, // default 1 — bump for cloud adapters
)
// results: Array<{ compartment, result?: Invoice[], error?: Error }>
```

**Composes with `exportStream()` for cross-compartment plaintext export:**

```ts
await db.queryAcross(accessible.map((c) => c.id), async (comp) => {
  const out: unknown[] = []
  for await (const chunk of comp.exportStream()) out.push(chunk)
  return out
})
```

## Backup and export

noy-db ships two distinct paths for getting data out of a compartment. They are not interchangeable — use the one that matches your goal.

### `compartment.dump()` — encrypted backup (the default)

Produces a tamper-evident encrypted JSON envelope. Records stay encrypted, the hash-chained ledger is included so the receiver can verify integrity end-to-end after `load()`, and the recipient must hold a valid keyring to read anything. **Use this for backup, transport between machines, or any scenario where the data must remain protected on disk.**

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

CSV, XML, xlsx, and the rest of the plaintext tier — plus encrypted `.noydb` bundles under the `as-noydb` encrypted tier — all live in the `@noy-db/as-*` family. Every invocation is gated by the two-tier authorization model (`canExportPlaintext` default off, `canExportBundle` default on for owner/admin) and lands in the audit ledger. See [`docs/patterns/as-exports.md`](../../docs/patterns/as-exports.md) for the full policy.

## Documentation

- Full docs: https://github.com/vLannaAi/noy-db#readme
- Spec: https://github.com/vLannaAi/noy-db/blob/main/SPEC.md
- AI reference: https://github.com/vLannaAi/noy-db/blob/main/docs/guides/noydb-for-ai.md

## License

MIT © vLannaAi
