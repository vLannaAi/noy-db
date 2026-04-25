# Core 03 — Stores

> **Always-on. The pluggable storage layer.**
> Source of truth: `packages/hub/src/types.ts` (`NoydbStore` interface)

## What it is

A `NoydbStore` is a 6-method async interface. The hub never sees the inside of one — it hands ciphertext envelopes to the store and gets ciphertext back. Twenty backends ship today; you can write your own in ~150 lines.

## The contract

```ts
interface NoydbStore {
  readonly name: string

  get(vault: string, collection: string, id: string)
    : Promise<EncryptedEnvelope | null>

  put(vault: string, collection: string, id: string,
      envelope: EncryptedEnvelope, expectedVersion?: number)
    : Promise<void>

  delete(vault: string, collection: string, id: string)
    : Promise<void>

  list(vault: string, collection: string)
    : Promise<string[]>

  loadAll(vault: string)
    : Promise<VaultSnapshot>

  saveAll(vault: string, snapshot: VaultSnapshot)
    : Promise<void>
}
```

Optional capabilities:

```ts
interface StoreCapabilities {
  casAtomic: boolean   // does put(expectedVersion) fail atomically?
  auth: StoreAuth      // metadata for unlock flows
}

// Optional methods stores MAY implement:
listPage(vault, collection, opts): Promise<{ ids, cursor }>
listSince(vault, collection, since): Promise<string[]>
presencePublish(vault, channel, payload): Promise<void>
presenceSubscribe(vault, channel, cb): () => void
tx(vault, ops): Promise<TxResult>  // native multi-record atomicity
```

## Authoring a store

```ts
import { createStore, type NoydbStore } from '@noy-db/hub'

interface MyStoreOptions {
  client: SomeClient
}

export const myStore = createStore((opts: MyStoreOptions): NoydbStore => ({
  name: 'my-backend',
  async get(v, c, id) { /* ... */ },
  async put(v, c, id, env, ev) { /* ... */ },
  async delete(v, c, id) { /* ... */ },
  async list(v, c) { /* ... */ },
  async loadAll(v) { /* ... */ },
  async saveAll(v, data) { /* ... */ },
}))
```

`runStoreConformanceTests(store)` exercises the 6-method contract against a mock vault. CI for every `to-*` package runs it.

## Capabilities by built-in store

| Store | `casAtomic` | Notes |
|---|:--:|---|
| `to-memory` | ✓ | Map-of-maps; testing only |
| `to-file` | ✗ | Atomic write via tmp + rename |
| `to-browser-local` | ✓ | localStorage transactions |
| `to-browser-idb` | ✓ | Single-readwrite IDB transaction (#139) |
| `to-aws-dynamo` | ✓ | `ConditionExpression: attribute_not_exists OR _v = :ev` |
| `to-aws-s3` | ✗ | No native CAS; advisory locks via `If-Match` |
| `to-postgres` | ✓ | UPDATE … WHERE _v = $expectedVersion |
| `to-cloudflare-r2` | ✗ | S3-compatible; no CAS |
| `to-cloudflare-d1` | ✓ | SQLite transactions |

Full list: [docs/packages/to-stores.md](../packages/to-stores.md).

## Store routing & middleware

Multi-backend routing, retry / circuit-breaker / metrics middleware, lazy-mode caching, and bundle-store wrapping live in the [routing](../subsystems/routing.md) subsystem.

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- [docs/subsystems/routing.md](../subsystems/routing.md)
- [docs/reference/store-conformance.md](../reference/store-conformance.md) (TODO)
