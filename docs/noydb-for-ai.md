# NOYDB — AI Integration Reference

> This document is optimized for AI coding assistants (Claude Code, Copilot, Cursor).
> It provides the fastest path to using NOYDB correctly in any project.
>
> **Current version:** `@noy-db/*@0.4.1` — all 10 packages are on a unified version line. **Current release theme:** v0.4 Integrity & trust (schema validation, hash-chained ledger, delta history, FK refs, verifiable backups).

## What NOYDB Is

NOYDB is a zero-knowledge encrypted document store. You give it a passphrase; it encrypts everything with AES-256-GCM before storing. Backends (file, DynamoDB, S3, browser localStorage) only see ciphertext. Multi-user access control with 5 roles. Offline-first with optional cloud sync. Zero runtime dependencies.

**As of v0.4:** every record can be schema-validated via [Standard Schema v1](https://standardschema.dev) (Zod, Valibot, ArkType, Effect Schema), every mutation is recorded in a tamper-evident hash-chained ledger, history is delta-encoded via RFC 6902 JSON Patch, soft foreign-key references are enforceable per-collection, and backups verify end-to-end on load.

## Install

```bash
# Fastest: the wizard for a new Nuxt 4 + Pinia + noy-db project
npm  create @noy-db my-app
pnpm create @noy-db my-app

# Or install manually. Pick your backend:
npm install @noy-db/core @noy-db/file       # local filesystem / USB
npm install @noy-db/core @noy-db/dynamo     # AWS DynamoDB
npm install @noy-db/core @noy-db/s3         # AWS S3
npm install @noy-db/core @noy-db/browser    # browser localStorage/IndexedDB
npm install @noy-db/core @noy-db/memory     # testing (no persistence)

# Vue / Nuxt / Pinia
npm install @noy-db/core @noy-db/browser @noy-db/pinia @noy-db/nuxt @pinia/nuxt pinia
```

All `@noy-db/*` packages are on the same version line (`0.4.1` at time of writing). Installing any combination from the same line is guaranteed to work — peer deps use `workspace:^` so minor upgrades are transparent.

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

## v0.4 Feature Reference

The v0.4 line adds five composable features. Each one is opt-in; a collection with none of them behaves exactly like v0.3.

### Schema validation (Standard Schema v1)

```typescript
import { createNoydb, type StandardSchemaV1, SchemaValidationError } from '@noy-db/core'
import { z } from 'zod'  // or valibot, arktype, effect/schema — anything with '~standard'

const InvoiceSchema = z.object({
  id: z.string(),
  amount: z.number().positive(),
  status: z.enum(['draft', 'open', 'paid']),
})

const invoices = company.collection('invoices', { schema: InvoiceSchema })

// Runs the validator BEFORE encryption on every put()
await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'draft' })

// Throws SchemaValidationError on bad input (with the full Standard Schema issue list)
await invoices.put('inv-bad', { id: 'inv-bad', amount: -5, status: 'draft' })
//   → SchemaValidationError { direction: 'input', issues: [...] }

// Runs the validator AFTER decryption on every read — throws with direction: 'output' on stored-data drift
const loaded = await invoices.get('inv-1')
```

With `defineNoydbStore`:

```typescript
export const useInvoices = defineNoydbStore<z.infer<typeof InvoiceSchema>>('invoices', {
  compartment: 'demo-co',
  schema: InvoiceSchema,
})
```

History reads (`getVersion`, `history`) intentionally skip validation — historical records predate the current schema by definition.

### Hash-chained audit log (the ledger)

```typescript
const ledger = company.ledger()

// Every put/delete appended an encrypted entry automatically. Nothing to do on the write side.

// Read the chain head (stable hash suitable for external anchoring)
const head = await ledger.head()
//   → { entry, hash, length }  or  null on empty compartment

// Verify the chain — returns discriminated result
const result = await ledger.verify()
//   → { ok: true, head, length }
//   → { ok: false, divergedAt, expected, actual }

// Iterate entries in a range
const recent = await ledger.entries({ from: 0, to: 100 })
```

Ledger entries are encrypted with a per-compartment ledger DEK. `payloadHash` is `sha256(envelope._data)` — the **ciphertext**, preserving zero-knowledge. All system-prefixed DEKs (`_ledger`, `_history`, `_sync`) are propagated to every keyring via `grant()`, so every user with compartment access can append to the shared ledger.

### Delta history via RFC 6902 JSON Patch

```typescript
import { computePatch, applyPatch, type JsonPatch } from '@noy-db/core'

// Collection.put automatically computes a reverse patch when there's a previous version
// and stores it in _ledger_deltas/<paddedIndex>.

// Reconstruct any historical version by walking the chain backward
const current = await invoices.get('inv-1')
const v1 = await company.ledger().reconstruct('invoices', 'inv-1', current, 1)
//   → the record as it existed at version 1, or null if unreachable

// The pure JSON Patch primitives are also exported for direct use
const patch: JsonPatch = computePatch({ a: 1 }, { a: 2 })
//   → [{ op: 'replace', path: '/a', value: 2 }]
const restored = applyPatch({ a: 1 }, patch)
//   → { a: 2 }
```

Patches are **reverse** (`new → previous`), so the walk starts from the current state and doesn't need a base snapshot. Known limitation: ambiguous across delete+recreate cycles because version numbers restart at 1 after a delete.

### Foreign-key references via `ref()`

```typescript
import { ref, RefIntegrityError } from '@noy-db/core'

const invoices = company.collection<Invoice>('invoices', {
  refs: {
    clientId: ref('clients'),                // strict (default)
    categoryId: ref('categories', 'warn'),
    parentId: ref('invoices', 'cascade'),    // self-reference OK
  },
})

// strict:  put() rejects if the target id doesn't exist; delete() of target rejects if references exist
// warn:    both succeed; checkIntegrity() surfaces orphans
// cascade: delete() of target propagates to delete every referencing record (cycle-safe)

await invoices.put('inv-1', { id: 'inv-1', clientId: 'missing', /* ... */ })
//   → RefIntegrityError { collection, id, field, refTo, refId }

// Compartment-level report of every broken reference, regardless of mode
const { violations } = await company.checkIntegrity()
```

Cross-compartment refs are rejected at construction with `RefScopeError`. Dotted-path field names are out of scope for v0.4 — top-level fields only.

### Verifiable backups

```typescript
import { BackupLedgerError, BackupCorruptedError } from '@noy-db/core'

// dump() now embeds the chain head + the full _ledger / _ledger_deltas collections
const backup = await company.dump()

// load() re-runs verification after restoring
await targetCompany.load(backup)
//   → throws BackupLedgerError if the chain is broken or the head doesn't match
//   → throws BackupCorruptedError if any data envelope's payloadHash diverged
//   → silent success otherwise

// Can also be called on a live compartment as a periodic audit
const result = await company.verifyBackupIntegrity()
//   → { ok: true, head, length }
//   → { ok: false, kind: 'chain', divergedAt, message }
//   → { ok: false, kind: 'data', collection, id, message }
```

Legacy (pre-v0.4) backups without `ledgerHead` load with a `console.warn` and skip the integrity check.

## CLI Reference

The `@noy-db/create` package ships two bins: `create` (the wizard) and `noy-db` (the ongoing CLI tool). Install with `pnpm add -D @noy-db/create`, then invoke via `pnpm exec noy-db <cmd>` or `npx noy-db <cmd>`.

### `create @noy-db` — wizard (two modes)

```bash
# Fresh project in a new directory
npm create @noy-db my-app [--yes] [--adapter browser|file|memory] [--no-sample-data]

# Augment an existing Nuxt 4 project (run from its root)
cd ~/my-existing-app
npm create @noy-db                    # preview + confirm
npm create @noy-db --dry-run          # print diff, don't write
npm create @noy-db --yes              # non-interactive
npm create @noy-db --force-fresh      # force fresh mode even inside an existing Nuxt dir
```

Augment mode auto-detects existing Nuxt 4 projects (both `nuxt.config.{ts,js,mjs}` AND `nuxt` in `package.json` deps must be present). It uses [magicast](https://github.com/unjs/magicast) AST rewriting to add `'@noy-db/nuxt'` to the `modules` array and a `noydb: { adapter, pinia: true, devtools: true }` key. It's **idempotent** (re-runs are no-ops), **preserves pre-existing `noydb:` keys**, and **rejects opaque config shapes** cleanly.

### `noy-db` — operational CLI

```bash
# Scaffold a new collection store + page
noy-db add <collection>

# In-memory crypto integrity check
noy-db verify

# Grant a new user access to a compartment
noy-db add user <userId> <role> \
  --dir <data-dir> --compartment <name> --user <your-id> \
  [--collections name1:rw,name2:ro]   # required for operator/client
# Prompts: caller passphrase, new user passphrase, confirm

# Rotate DEKs for a compartment (re-encrypts all records)
noy-db rotate --dir <data-dir> --compartment <name> --user <your-id> \
  [--collections name1,name2]         # defaults to all if omitted
# Prompts: your passphrase

# Write a verifiable backup to a local file
noy-db backup <target> --dir <data-dir> --compartment <name> --user <your-id>
# Target: plain path or file:// URI. s3:// is rejected (tracked as follow-up).
# Prompts: your passphrase
```

**Security invariants for every command that touches real compartments:**

1. Passphrase via `@clack/prompts` `password()` — never echoed, never logged, never persisted
2. Passphrase never leaves the local closure; cleared from memory via `db.close()` in a `finally` block
3. Ctrl-C at the prompt aborts BEFORE any I/O happens
4. Unsupported backup schemes (`s3://`, `https://`) rejected BEFORE the passphrase prompt so typos don't waste an entry
5. All commands use the `file` adapter — browser/DynamoDB/S3 workflows run inside the app process, not a separate CLI

**Dependency injection pattern for programmatic use:**

```ts
import { rotate, addUser, backup } from '@noy-db/create'

// Each command accepts optional injected deps for testing:
await rotate({
  dir: './data',
  compartment: 'demo-co',
  user: 'alice',
  readPassphrase: async (label) => 'test-passphrase',  // stub for tests
  createDb,                                              // stub the Noydb factory
  buildAdapter: (dir) => memory(),                       // stub the adapter
})
```

In production code, leave all three injected deps undefined and the commands use the real implementations (clack prompts, `createNoydb`, `jsonFile`).

## Noydb.rotate() core API (v0.5+)

The `rotate()` method on the `Noydb` class rotates DEKs without revoking any users. Distinct from `revoke({ rotateKeys: true })` in that nobody is kicked out — everyone keeps their current permissions, but the key material is replaced.

```ts
import { createNoydb } from '@noy-db/core'

const db = await createNoydb({ adapter, user: 'alice', secret: '...' })

// Rotate specific collections
await db.rotate('demo-co', ['invoices', 'clients'])

// Rotate everything in a compartment (by listing collections first)
const c = await db.openCompartment('demo-co')
const all = await c.collections()
await db.rotate('demo-co', all)
```

After rotation, the compartment's in-memory keyring is refreshed automatically so subsequent `Collection.get`/`put` calls use the new DEKs. No need to close and re-open the compartment.

Use cases: post-breach key rotation, scheduled compliance rotation, pre-backup key refresh. The `noy-db rotate` CLI wraps this method.

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
| owner | all | all | all roles | all (except owner) | yes |
| admin | all | all | admin/operator/viewer/client (v0.5 #62) | same, plus cascade | yes |
| operator | granted | granted | — | — | granted (v0.5 #72) |
| viewer | all | — | — | — | yes |
| client | granted | — | — | — | granted (v0.5 #72) |

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

// Export decrypted JSON (v0.5+ — ACL-scoped, silently skips
// collections the caller cannot read; warns about plaintext on disk)
const plaintext = await comp.exportJSON()

// Streaming variant for large compartments
for await (const chunk of comp.exportStream()) {
  // chunk.collection, chunk.schema, chunk.refs, chunk.records
}
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
