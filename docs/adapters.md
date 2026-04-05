# Adapters Guide

NOYDB uses a pluggable adapter system. Every adapter implements the same 6-method interface. Swap backends without changing application code.

## Built-in Adapters

### @noydb/file — JSON File Adapter

Maps data to the filesystem. One JSON file per record.

```typescript
import { jsonFile } from '@noydb/file'

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

### @noydb/dynamo — DynamoDB Adapter

Single-table design for AWS DynamoDB.

```typescript
import { dynamo } from '@noydb/dynamo'

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

### @noydb/s3 — S3 Adapter

Stores records as JSON objects in S3.

```typescript
import { s3 } from '@noydb/s3'

const adapter = s3({
  bucket: 'noydb-archive',
  prefix: 'data',              // optional key prefix
  region: 'us-east-1',
  endpoint: 'http://localhost:4566', // optional: LocalStack
})
```

**Key scheme:** `{prefix}/{compartment}/{collection}/{id}.json`

**Requires:** `@aws-sdk/client-s3` as a peer dependency.

### @noydb/browser — Browser Storage Adapter

Uses localStorage or IndexedDB.

```typescript
import { browser } from '@noydb/browser'

const adapter = browser({
  prefix: 'myapp',              // storage key prefix (default: 'noydb')
  backend: 'localStorage',      // force backend (default: auto-detect)
})
```

Auto-selects localStorage for small datasets, IndexedDB for larger ones.

### @noydb/memory — In-Memory Adapter

No persistence. For testing and development.

```typescript
import { memory } from '@noydb/memory'

const adapter = memory()
```

## Writing a Custom Adapter

Implement the `NoydbAdapter` interface (6 methods):

```typescript
import { defineAdapter } from '@noydb/core'
import type { NoydbAdapter, EncryptedEnvelope, CompartmentSnapshot } from '@noydb/core'

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

  // Optional: connectivity check for sync engine
  async ping?(): Promise<boolean> {
    return true
  },
}))
```

### Testing Your Adapter

Use the conformance test suite (22 tests):

```typescript
import { runAdapterConformanceTests } from '@noydb/test-adapter-conformance'
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
