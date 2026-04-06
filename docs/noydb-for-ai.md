# NOYDB — AI Integration Reference

> This document is optimized for AI coding assistants (Claude Code, Copilot, Cursor).
> It provides the fastest path to using NOYDB correctly in any project.

## What NOYDB Is

NOYDB is a zero-knowledge encrypted document store. You give it a passphrase; it encrypts everything with AES-256-GCM before storing. Backends (file, DynamoDB, S3, browser localStorage) only see ciphertext. Multi-user access control with 5 roles. Offline-first with optional cloud sync. Zero runtime dependencies.

## Install

```bash
# Pick your backend:
npm install @noy-db/core @noy-db/file      # local filesystem / USB
npm install @noy-db/core @noy-db/dynamo    # AWS DynamoDB
npm install @noy-db/core @noy-db/s3        # AWS S3
npm install @noy-db/core @noy-db/browser   # browser localStorage/IndexedDB
npm install @noy-db/core @noy-db/memory    # testing (no persistence)

# Optional:
npm install @noy-db/vue                   # Vue/Nuxt composables
```

## Minimal Working Example

```typescript
import { createNoydb } from '@noy-db/core'
import { jsonFile } from '@noy-db/file'

// 1. Create instance
const db = await createNoydb({
  adapter: jsonFile({ dir: './data' }),
  user: 'owner-01',
  secret: 'my-passphrase',
})

// 2. Open compartment (async — loads keyring, derives keys)
const company = await db.openCompartment('C101')

// 3. Get typed collection
interface Invoice {
  amount: number
  status: 'draft' | 'sent' | 'paid'
  client: string
}
const invoices = company.collection<Invoice>('invoices')

// 4. CRUD
await invoices.put('inv-001', { amount: 5000, status: 'draft', client: 'ABC Corp' })
const inv = await invoices.get('inv-001')        // Invoice | null
const all = await invoices.list()                 // Invoice[]
const drafts = invoices.query(i => i.status === 'draft')  // Invoice[] (sync, in-memory)
const count = await invoices.count()              // number
await invoices.delete('inv-001')

// 5. Close (clears all keys from memory)
db.close()
```

## Key Concepts

### Hierarchy

```
Noydb (instance)
  └─ Compartment (tenant/company — has its own keyring)
       └─ Collection<T> (typed records — has its own DEK)
            └─ Record (JSON document, identified by string ID)
```

### Important: `openCompartment` is async

```typescript
// WRONG — throws in encrypted mode:
const comp = db.compartment('C101')

// CORRECT — loads keyring, derives KEK, unwraps DEKs:
const comp = await db.openCompartment('C101')
```

The sync version `db.compartment()` only works in `encrypt: false` mode or after `openCompartment` has been called.

### `query()` is synchronous

```typescript
// query() reads from the in-memory cache.
// It returns [] if the collection hasn't been hydrated yet.
// Call any async method first (get, list, count) to hydrate.
const all = await invoices.list()         // hydrates the cache
const drafts = invoices.query(i => i.status === 'draft')  // now works
```

## All Adapter Configurations

### File Adapter (USB, local disk)

```typescript
import { jsonFile } from '@noy-db/file'

const adapter = jsonFile({
  dir: './data',       // base directory
  pretty: true,        // indent JSON (default: true)
})
// Stores: {dir}/{compartment}/{collection}/{id}.json
```

### DynamoDB Adapter

```typescript
import { dynamo } from '@noy-db/dynamo'

const adapter = dynamo({
  table: 'noydb-prod',
  region: 'ap-southeast-1',
  endpoint: 'http://localhost:8000',  // optional: DynamoDB Local
})
// Single-table: pk=compartment, sk={collection}#{id}
// Requires peer deps: @aws-sdk/client-dynamodb, @aws-sdk/lib-dynamodb
```

### S3 Adapter

```typescript
import { s3 } from '@noy-db/s3'

const adapter = s3({
  bucket: 'my-bucket',
  prefix: 'noydb',           // optional key prefix
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',  // optional: LocalStack
})
// Key: {prefix}/{compartment}/{collection}/{id}.json
// Requires peer dep: @aws-sdk/client-s3
```

### Browser Adapter

```typescript
import { browser } from '@noy-db/browser'

const adapter = browser({
  prefix: 'myapp',            // localStorage key prefix (default: 'noydb')
  backend: 'localStorage',    // or 'indexedDB' (default: auto-detect)
  obfuscate: true,             // hash keys + encode values (default: false)
})
// With obfuscate: keys become hashed, values XOR-encoded
// No plaintext collection names, record IDs, or user IDs in storage
```

### Memory Adapter (testing)

```typescript
import { memory } from '@noy-db/memory'

const adapter = memory()
// No persistence. Lost when process exits.
```

## createNoydb — Full Options

```typescript
const db = await createNoydb({
  // Required
  adapter: jsonFile({ dir: './data' }),  // primary adapter
  user: 'owner-01',                      // user identifier

  // Authentication
  secret: 'my-passphrase',              // required unless encrypt: false
  encrypt: true,                         // default: true. Set false for dev/testing

  // Sync (optional)
  sync: dynamo({ table: 'prod' }),       // remote adapter for sync
  conflict: 'version',                   // 'version' | 'local-wins' | 'remote-wins' | custom fn
  autoSync: false,                       // listen for online/offline events
  syncInterval: 30_000,                  // periodic sync interval (ms)

  // History (optional)
  history: {
    enabled: true,                       // default: true
    maxVersions: 50,                     // auto-prune oldest (default: unlimited)
  },

  // Session
  sessionTimeout: 600_000,              // auto-close after 10min inactivity (ms)
})
```

## Multi-User Access Control

### Roles

| Role | Read | Write | Grant | Revoke | Export |
|------|:----:|:-----:|:-----:|:------:|:------:|
| owner | all | all | all roles | all | yes |
| admin | all | all | operator/viewer/client | same | yes |
| operator | granted | granted | — | — | — |
| viewer | all | — | — | — | — |
| client | granted | — | — | — | — |

### Grant Access

```typescript
await db.grant('C101', {
  userId: 'op-somchai',
  displayName: 'Somchai',
  role: 'operator',
  passphrase: 'temporary-passphrase',    // given out-of-band
  permissions: { invoices: 'rw', payments: 'rw' },
})
```

### Revoke with Key Rotation

```typescript
await db.revoke('C101', {
  userId: 'op-somchai',
  rotateKeys: true,    // re-encrypts affected collections with new DEKs
})
// After rotation, remaining users need re-grant for rotated collections
```

### Other User Operations

```typescript
const users = await db.listUsers('C101')
// [{ userId, displayName, role, permissions, createdAt, grantedBy }]

await db.changeSecret('C101', 'new-passphrase')
// Re-wraps DEKs. Old passphrase stops working.
```

## Sync Engine

```typescript
const db = await createNoydb({
  adapter: jsonFile({ dir: './data' }),
  sync: dynamo({ table: 'prod' }),
  user: 'owner', secret: 'pass',
  conflict: 'version',
})

const comp = await db.openCompartment('C101')
// ... write records locally ...

// Push local changes to remote
const push = await db.push('C101')
// { pushed: 5, conflicts: [], errors: [] }

// Pull remote changes to local
const pull = await db.pull('C101')
// { pulled: 3, conflicts: [], errors: [] }

// Bidirectional (pull then push)
await db.sync('C101')

// Check status
const status = db.syncStatus('C101')
// { dirty: 0, lastPush: '2026-...', lastPull: '2026-...', online: true }
```

### Conflict Strategies

```typescript
conflict: 'version'       // higher version wins (default)
conflict: 'local-wins'    // always keep local
conflict: 'remote-wins'   // always accept remote
conflict: (c) => {         // custom function
  // c.local, c.remote, c.localVersion, c.remoteVersion
  return c.localVersion > c.remoteVersion ? 'local' : 'remote'
}
```

## Audit History & Diff

```typescript
const db = await createNoydb({
  adapter, user: 'owner', secret: 'pass',
  history: { enabled: true, maxVersions: 100 },
})

const comp = await db.openCompartment('C101')
const invoices = comp.collection<Invoice>('invoices')

// Make changes (history tracked automatically)
await invoices.put('inv-1', { amount: 1000, status: 'draft', client: 'A' })
await invoices.put('inv-1', { amount: 2000, status: 'sent', client: 'A' })
await invoices.put('inv-1', { amount: 2000, status: 'paid', client: 'A' })

// Browse history (newest first)
const history = await invoices.history('inv-1')
// [{ version: 2, timestamp, userId, record: { amount: 2000, status: 'sent' } },
//  { version: 1, timestamp, userId, record: { amount: 1000, status: 'draft' } }]

// Filter history
const recent = await invoices.history('inv-1', { limit: 5 })
const range = await invoices.history('inv-1', { from: '2026-01-01', to: '2026-03-31' })

// Get specific past version
const v1 = await invoices.getVersion('inv-1', 1)

// Diff between versions
import { formatDiff } from '@noy-db/core'
const changes = await invoices.diff('inv-1', 1, 2)
// [{ path: 'amount', type: 'changed', from: 1000, to: 2000 },
//  { path: 'status', type: 'changed', from: 'draft', to: 'sent' }]
console.log(formatDiff(changes))
// ~ amount: 1000 → 2000
// ~ status: "draft" → "sent"

// Diff against current version
const allChanges = await invoices.diff('inv-1', 1)

// Revert to past version (creates new version with old content)
await invoices.revert('inv-1', 1)

// Prune history
await invoices.pruneRecordHistory('inv-1', { keepVersions: 10 })
await invoices.pruneRecordHistory(undefined, { beforeDate: '2025-01-01' })
await invoices.clearHistory('inv-1')
```

## Backup & Restore

```typescript
const comp = await db.openCompartment('C101')

// Dump (encrypted JSON — safe to transport)
const backup = await comp.dump()

// Restore
await comp.load(backup)

// Export decrypted JSON (owner only)
const plaintext = await comp.export()
```

## Vue / Nuxt Integration

```typescript
// Plugin setup
import { NoydbPlugin } from '@noy-db/vue'
app.use(NoydbPlugin, { instance: db })
```

```vue
<script setup lang="ts">
import { useNoydb, useCollection, useSync } from '@noy-db/vue'

const db = useNoydb()
const { data: invoices, loading, error, refresh } = useCollection<Invoice>(db, 'C101', 'invoices')
const { status, syncing, push, pull, sync } = useSync(db, 'C101')
</script>

<template>
  <div v-if="loading">Loading...</div>
  <div v-for="inv in invoices" :key="inv.client">
    {{ inv.client }}: ฿{{ inv.amount }}
  </div>
  <button @click="push" :disabled="syncing">Push</button>
  <span>{{ status.dirty }} unsaved changes</span>
</template>
```

## Events

```typescript
db.on('change', (e) => {
  // { compartment, collection, id, action: 'put' | 'delete' }
})

db.on('sync:push', (result) => { /* { pushed, conflicts, errors } */ })
db.on('sync:pull', (result) => { /* { pulled, conflicts, errors } */ })
db.on('sync:conflict', (conflict) => { /* { local, remote, localVersion, remoteVersion } */ })
db.on('sync:online', () => { })
db.on('sync:offline', () => { })
db.on('history:save', (e) => { /* { compartment, collection, id, version } */ })
db.on('history:prune', (e) => { /* { compartment, collection, id, pruned } */ })
db.on('error', (err) => { })
```

## Error Handling

```typescript
import {
  NoydbError,           // base class — all errors extend this
  DecryptionError,      // code: 'DECRYPTION_FAILED'
  TamperedError,        // code: 'TAMPERED' — AES-GCM auth tag failed
  InvalidKeyError,      // code: 'INVALID_KEY' — wrong passphrase
  NoAccessError,        // code: 'NO_ACCESS' — no keyring for this user
  ReadOnlyError,        // code: 'READ_ONLY' — viewer/client tried to write
  PermissionDeniedError,// code: 'PERMISSION_DENIED' — can't grant/revoke/export
  ConflictError,        // code: 'CONFLICT' — version mismatch (has .version)
  NetworkError,         // code: 'NETWORK_ERROR'
  NotFoundError,        // code: 'NOT_FOUND'
  ValidationError,      // code: 'VALIDATION_ERROR'
} from '@noy-db/core'

try {
  await collection.put('id', data)
} catch (err) {
  if (err instanceof ReadOnlyError) { /* viewer can't write */ }
  if (err instanceof ConflictError) { /* version mismatch: err.version */ }
  if (err instanceof TamperedError) { /* data was modified outside NOYDB */ }
}
```

## Writing a Custom Adapter

```typescript
import { defineAdapter, ConflictError } from '@noy-db/core'
import type { NoydbAdapter, EncryptedEnvelope, CompartmentSnapshot } from '@noy-db/core'

export const redis = defineAdapter((opts: { url: string }) => ({
  async get(compartment, collection, id) {
    // Return EncryptedEnvelope | null
  },
  async put(compartment, collection, id, envelope, expectedVersion?) {
    // If expectedVersion provided and doesn't match, throw new ConflictError(currentVersion)
  },
  async delete(compartment, collection, id) {
    // No-op if not found
  },
  async list(compartment, collection) {
    // Return string[] of record IDs
  },
  async loadAll(compartment) {
    // Return { [collection]: { [id]: EncryptedEnvelope } }
    // MUST exclude _keyring, _sync, _history (underscore-prefixed collections)
  },
  async saveAll(compartment, data) {
    // Bulk write
  },
}))

// Test with the conformance suite (22+ tests):
import { runAdapterConformanceTests } from '@noy-db/test-adapter-conformance'
runAdapterConformanceTests('redis', async () => redis({ url: 'redis://localhost' }))
```

## Unencrypted Mode (Development)

```typescript
const db = await createNoydb({
  adapter: memory(),
  user: 'dev',
  encrypt: false,    // plaintext — no passphrase needed
})
// All APIs work identically. Data is just not encrypted.
```

## Critical Rules for AI Assistants

1. **Always `await openCompartment()`** — never use the sync `compartment()` in encrypted mode
2. **Never import crypto libraries** — NOYDB uses Web Crypto API only (`crypto.subtle`)
3. **Fresh IV per encrypt** — never reuse IVs. The crypto module handles this automatically
4. **KEK is never stored** — derived from passphrase at runtime, cleared on `close()`
5. **Adapters see only ciphertext** — encryption happens in `@noy-db/core`, not in adapters
6. **`loadAll()` must skip `_`-prefixed collections** — `_keyring`, `_sync`, `_history` are internal
7. **`query()` is synchronous** — it reads from cache. Call an async method first to hydrate
8. **Passphrase persistence** — after page reload, use the same passphrase to load the existing keyring. Wrong passphrase throws `InvalidKeyError`
9. **Key rotation on revoke** — remaining users lose access to rotated collections and need re-grant
10. **History entries are full encrypted snapshots** — not diffs. Any entry can be deleted independently

## Package Exports Quick Reference

```typescript
// Core
export { createNoydb, Noydb, Compartment, Collection, SyncEngine } from '@noy-db/core'

// Types
export type {
  NoydbAdapter, NoydbOptions, EncryptedEnvelope, CompartmentSnapshot,
  Role, Permission, Permissions, GrantOptions, RevokeOptions, UserInfo,
  Conflict, ConflictStrategy, PushResult, PullResult, SyncStatus,
  ChangeEvent, NoydbEventMap, HistoryConfig, HistoryOptions, HistoryEntry,
  PruneOptions, KeyringFile, CompartmentBackup,
} from '@noy-db/core'

// Errors
export {
  NoydbError, DecryptionError, TamperedError, InvalidKeyError,
  NoAccessError, ReadOnlyError, PermissionDeniedError,
  ConflictError, NetworkError, NotFoundError, ValidationError,
} from '@noy-db/core'

// Utilities
export { defineAdapter, formatDiff, diff, validatePassphrase } from '@noy-db/core'
export type { DiffEntry, ChangeType } from '@noy-db/core'
export { isBiometricAvailable, enrollBiometric, unlockBiometric } from '@noy-db/core'

// Adapters
export { jsonFile } from '@noy-db/file'
export { dynamo } from '@noy-db/dynamo'
export { s3 } from '@noy-db/s3'
export { browser } from '@noy-db/browser'
export { memory } from '@noy-db/memory'

// Vue
export { NoydbPlugin, useNoydb, useCollection, useSync } from '@noy-db/vue'
```
