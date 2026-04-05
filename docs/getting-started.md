# Getting Started with NOYDB

## Installation

Pick the packages for your use case:

```bash
# Local-only (USB stick, local disk)
npm install @noydb/core @noydb/file

# Cloud-only (DynamoDB)
npm install @noydb/core @noydb/dynamo

# Offline-first with cloud sync
npm install @noydb/core @noydb/file @noydb/dynamo

# Browser app
npm install @noydb/core @noydb/browser

# Vue / Nuxt
npm install @noydb/core @noydb/file @noydb/vue

# Testing / development
npm install @noydb/core @noydb/memory
```

## Requirements

- **Node.js** 18+ (for Web Crypto API)
- **Browsers:** Chrome 63+, Firefox 57+, Safari 13+

## Quick Start

### 1. Create an encrypted store

```typescript
import { createNoydb } from '@noydb/core'
import { jsonFile } from '@noydb/file'

const db = await createNoydb({
  adapter: jsonFile({ dir: './data' }),
  user: 'owner-01',
  secret: 'my-secure-passphrase',
})
```

### 2. Open a compartment and collection

```typescript
// Compartments isolate tenants, companies, or projects
const company = await db.openCompartment('C101')

// Collections are typed sets of records
interface Invoice {
  amount: number
  status: 'draft' | 'sent' | 'paid'
  client: string
}

const invoices = company.collection<Invoice>('invoices')
```

### 3. CRUD operations

```typescript
// Create / update
await invoices.put('inv-001', {
  amount: 5000,
  status: 'draft',
  client: 'ABC Corp',
})

// Read
const inv = await invoices.get('inv-001')
// => { amount: 5000, status: 'draft', client: 'ABC Corp' }

// List all
const all = await invoices.list()

// Query (in-memory filter)
const drafts = invoices.query(i => i.status === 'draft')
const large = invoices.query(i => i.amount > 10000)

// Count
const count = await invoices.count()

// Delete
await invoices.delete('inv-001')
```

Everything is encrypted transparently. The adapter only sees ciphertext.

### 4. Backup and restore

```typescript
// Dump as encrypted JSON (safe to transport)
const backup = await company.dump()

// Restore from backup
await company.load(backup)

// Export as decrypted JSON (owner only)
const plaintext = await company.export()
```

## Multi-User Access

### Grant access

```typescript
await db.grant('C101', {
  userId: 'operator-somchai',
  displayName: 'Somchai',
  role: 'operator',
  passphrase: 'temporary-passphrase',
  permissions: { invoices: 'rw', payments: 'rw' },
})
```

### Roles

| Role | Read | Write | Grant | Export |
|------|:----:|:-----:|:-----:|:------:|
| owner | all | all | all roles | yes |
| admin | all | all | operator/viewer/client | yes |
| operator | granted | granted | — | — |
| viewer | all | — | — | — |
| client | granted | — | — | — |

### Revoke with key rotation

```typescript
await db.revoke('C101', {
  userId: 'operator-somchai',
  rotateKeys: true, // re-encrypts affected collections
})
```

## Cloud Sync

### Setup

```typescript
import { dynamo } from '@noydb/dynamo'

const db = await createNoydb({
  adapter: jsonFile({ dir: './data' }),     // primary (local)
  sync: dynamo({ table: 'myapp-prod' }),    // secondary (cloud)
  user: 'owner-01',
  secret: 'my-passphrase',
  conflict: 'version',                      // conflict strategy
})
```

### Sync operations

```typescript
const company = await db.openCompartment('C101')

// Push local changes to cloud
const pushResult = await db.push('C101')
// => { pushed: 5, conflicts: [], errors: [] }

// Pull cloud changes to local
const pullResult = await db.pull('C101')
// => { pulled: 3, conflicts: [], errors: [] }

// Bidirectional sync (pull then push)
await db.sync('C101')

// Check sync status
const status = db.syncStatus('C101')
// => { dirty: 0, lastPush: '2026-...', lastPull: '2026-...', online: true }
```

### Conflict strategies

- `'version'` — higher version wins (default)
- `'local-wins'` — always keep local
- `'remote-wins'` — always accept remote
- Custom function: `(conflict) => 'local' | 'remote'`

## Vue / Nuxt Integration

```typescript
// main.ts or plugin
import { NoydbPlugin } from '@noydb/vue'

app.use(NoydbPlugin, { instance: db })
```

```vue
<script setup lang="ts">
import { useCollection, useSync } from '@noydb/vue'

const { data: invoices, loading } = useCollection<Invoice>(db, 'C101', 'invoices')
const { status, push, pull, syncing } = useSync(db, 'C101')
</script>
```

## Unencrypted Mode (Development)

```typescript
import { memory } from '@noydb/memory'

const db = await createNoydb({
  adapter: memory(),
  user: 'dev',
  encrypt: false,
})
```

## Next Steps

- [API Reference](api-reference.md) — Full API documentation
- [Adapters Guide](adapters.md) — Built-in adapters and custom adapter development
- [Security Model](../SECURITY.md) — Threat model and crypto details
