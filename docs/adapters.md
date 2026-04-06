# Adapters Guide

NOYDB uses a pluggable adapter system. Every adapter implements the same 6-method interface. Swap backends without changing application code.

## Built-in Adapters

### @noy-db/file — JSON File Adapter

Maps data to the filesystem. One JSON file per record.

```typescript
import { jsonFile } from '@noy-db/file'

const adapter = jsonFile({
  dir: './data',        // base directory
  pretty: true,         // indent JSON (default: true)
})
```

**File structure:**
```
{dir}/{compartment}/{collection}/{id}.json
{dir}/{compartment}/_keyring/{userId}.json
```

**Use cases:** USB sticks, local disk, network drives, portable data.

### @noy-db/dynamo — DynamoDB Adapter

Single-table design for AWS DynamoDB.

```typescript
import { dynamo } from '@noy-db/dynamo'

const adapter = dynamo({
  table: 'noydb-prod',
  region: 'ap-southeast-1',
  endpoint: 'http://localhost:8000', // optional: DynamoDB Local
})
```

**Table schema:**

| Attribute | Type | Value |
|-----------|------|-------|
| pk | String (partition) | compartment |
| sk | String (sort) | `{collection}#{id}` |
| _v, _ts, _iv, _data | — | Envelope fields |

**Requires:** `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` as peer dependencies.

### @noy-db/s3 — S3 Adapter

Stores records as JSON objects in S3.

```typescript
import { s3 } from '@noy-db/s3'

const adapter = s3({
  bucket: 'noydb-archive',
  prefix: 'data',              // optional key prefix
  region: 'us-east-1',
  endpoint: 'http://localhost:4566', // optional: LocalStack
})
```

**Key scheme:** `{prefix}/{compartment}/{collection}/{id}.json`

**Requires:** `@aws-sdk/client-s3` as a peer dependency.

### @noy-db/browser — Browser Storage Adapter

Uses localStorage or IndexedDB.

```typescript
import { browser } from '@noy-db/browser'

const adapter = browser({
  prefix: 'myapp',              // storage key prefix (default: 'noydb')
  backend: 'localStorage',      // force backend (default: auto-detect)
})
```

Auto-selects localStorage for small datasets, IndexedDB for larger ones.

### @noy-db/memory — In-Memory Adapter

No persistence. For testing and development.

```typescript
import { memory } from '@noy-db/memory'

const adapter = memory()
```

## Writing a Custom Adapter

Implement the `NoydbAdapter` interface (6 methods):

```typescript
import { defineAdapter } from '@noy-db/core'
import type { NoydbAdapter, EncryptedEnvelope, CompartmentSnapshot } from '@noy-db/core'

export const myAdapter = defineAdapter((options: MyOptions) => ({
  async get(compartment, collection, id): Promise<EncryptedEnvelope | null> {
    // Return envelope or null if not found
  },

  async put(compartment, collection, id, envelope, expectedVersion?): Promise<void> {
    // Store envelope. If expectedVersion provided and doesn't match, throw ConflictError
  },

  async delete(compartment, collection, id): Promise<void> {
    // Delete record. No-op if not found.
  },

  async list(compartment, collection): Promise<string[]> {
    // Return array of record IDs in the collection
  },

  async loadAll(compartment): Promise<CompartmentSnapshot> {
    // Return all records across all collections (skip _keyring, _sync)
  },

  async saveAll(compartment, data): Promise<void> {
    // Bulk write all records for a compartment
  },

  // Optional: connectivity check for sync engine (v0.2+)
  async ping?(): Promise<boolean> {
    return true
  },

  // Optional: pagination capability (v0.3+) — see "Optional capabilities" below
  async listPage?(compartment, collection, cursor?, limit?): Promise<ListPageResult> {
    return { records: [], cursor: undefined }
  },
}))
```

## Optional capabilities (v0.3+)

The 6-method core contract is sacred. New optional methods are surfaced as **capability flags** the core checks at runtime — adapters that don't implement them simply opt out, and the Collection layer falls back to the eager API.

### `listPage` — pagination

```ts
interface ListPageResult {
  records: EncryptedEnvelope[]
  cursor: string | undefined   // opaque, adapter-specific
}

interface NoydbAdapter {
  // ... 6 mandatory methods
  listPage?(
    compartment: string,
    collection: string,
    cursor?: string,
    limit?: number,
  ): Promise<ListPageResult>
}
```

Adapters that implement `listPage` enable `Collection.listPage()` and the Pinia store's `loadMore()` method. The cursor is **opaque** — its format is up to the adapter (DynamoDB uses `LastEvaluatedKey` JSON; the file adapter uses an offset). Core never inspects it.

| Adapter           | `listPage` | Cursor format                       |
|-------------------|:----------:|-------------------------------------|
| `@noy-db/memory`  | ✓          | numeric offset                      |
| `@noy-db/file`    | ✓          | numeric offset                      |
| `@noy-db/browser` | ✓          | numeric offset                      |
| `@noy-db/dynamo`  | ✓          | base64-encoded `LastEvaluatedKey`   |
| `@noy-db/s3`      | ✓          | S3 `ContinuationToken`              |

### Capability detection

Core checks for the method at runtime — no flag, no registration:

```ts
// Inside Collection.loadMore()
if (typeof this.adapter.listPage !== 'function') {
  throw new Error(
    `Adapter '${this.adapter.name}' does not support pagination. ` +
    `Use scan() for streaming iteration instead.`
  )
}
```

The same pattern applies to `ping?` (sync engine connectivity check) and any future optional method.

### Streaming `scan()` — no adapter changes required

`Collection.scan()` is built on `loadAll()` (or `listPage()` if available) and yields decrypted records via an `AsyncIterableIterator`. It bypasses the LRU entirely, so peak memory stays bounded regardless of collection size. No adapter needs to opt in — `scan()` works on every adapter.

### Testing Your Adapter

Use the conformance test suite (22 tests):

```typescript
import { runAdapterConformanceTests } from '@noy-db/test-adapter-conformance'
import { myAdapter } from './index.js'

runAdapterConformanceTests(
  'my-adapter',
  async () => myAdapter({ /* options */ }),
  async () => { /* cleanup */ },
)
```

All 22 tests must pass for your adapter to be NOYDB-compatible.

### Key Requirements

1. **Optimistic concurrency:** If `expectedVersion` is provided and doesn't match the stored version, throw `ConflictError`
2. **Isolation:** Records in different compartments and collections must not interfere
3. **Internal prefixes:** `loadAll()` must skip collections starting with `_` (e.g., `_keyring`, `_sync`)
4. **Idempotent delete:** Deleting a non-existent record must not throw
5. **Unicode support:** IDs and data may contain any Unicode characters
