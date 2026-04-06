# Getting Started with NOYDB

> **NOYDB** — a zero-knowledge, offline-first, encrypted document store with pluggable backends and multi-user access control. This guide gets you from zero to a working encrypted Pinia store in under two minutes.

---

## Requirements

- **Node.js** 18+ (for Web Crypto API) — 20+ recommended
- **Browsers:** Chrome 63+, Firefox 57+, Safari 13+
- **Nuxt 4+** for the module path (Nuxt 3 is not supported)

---

## Path 1 — Nuxt 4 project (recommended)

If you already have a Nuxt 4 app, `@noy-db/nuxt` is a one-line install. It auto-imports every composable, wires up the Pinia plugin, and keeps the runtime client-only so SSR stays safe.

### Install

```bash
pnpm add @noy-db/nuxt @noy-db/pinia @noy-db/core @noy-db/browser @pinia/nuxt pinia
```

### Register the module

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: [
    '@pinia/nuxt',
    '@noy-db/nuxt',
  ],
  noydb: {
    adapter: 'browser',   // 'browser' | 'file' | 'memory'
    pinia: true,          // install the Pinia augmentation plugin
    devtools: true,       // devtools tab in dev
  },
})
```

The `noydb:` key is fully typed — hovering it in your editor gives you autocomplete on every option because `@noy-db/nuxt` augments `@nuxt/schema`.

### Declare a store

```ts
// app/stores/invoices.ts — defineNoydbStore is auto-imported by @noy-db/nuxt
export interface Invoice {
  id: string
  client: string
  amount: number
  status: 'draft' | 'open' | 'paid' | 'overdue'
  dueDate: string
}

export const useInvoices = defineNoydbStore<Invoice>('invoices', {
  compartment: 'demo-co',
})
```

### Use it in a component

```vue
<script setup lang="ts">
const invoices = useInvoices()
await invoices.$ready

function addDraft() {
  invoices.add({
    id: crypto.randomUUID(),
    client: 'Demo Client',
    amount: 1000,
    status: 'draft',
    dueDate: new Date().toISOString(),
  })
}
</script>

<template>
  <button @click="addDraft">New draft</button>
  <ul>
    <li v-for="inv in invoices.items" :key="inv.id">
      {{ inv.client }} — {{ inv.amount }} ({{ inv.status }})
    </li>
  </ul>
</template>
```

That's the whole app. Everything on disk — localStorage, IndexedDB, or a USB stick — is encrypted. The adapter never sees plaintext.

See the reference Nuxt 4 demo in [`playground/nuxt/`](../playground/nuxt/) for a fully runnable version.

---

## Path 2 — Plain Vue 3 + Pinia (no Nuxt)

For Vite + Vue 3 + Pinia apps without Nuxt, `@noy-db/pinia` works directly:

```bash
pnpm add @noy-db/pinia @noy-db/core @noy-db/browser pinia vue
```

```ts
// main.ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createNoydbPiniaPlugin } from '@noy-db/pinia'
import { browser } from '@noy-db/browser'
import App from './App.vue'

const pinia = createPinia()
pinia.use(createNoydbPiniaPlugin({
  adapter: browser(),
  user: 'demo-user',
  secret: 'demo-passphrase', // in real apps, prompt the user
}))

const app = createApp(App)
app.use(pinia)
app.mount('#app')
```

Stores are then declared with `defineNoydbStore` exactly as in Path 1.

See [`playground/pinia/`](../playground/pinia/) for a working example.

---

## v0.3 feature highlights

Once you have a store, these features are one line away:

### Reactive query DSL

```ts
const invoices = useInvoices()

const openInvoices = invoices.query()
  .where('status', '==', 'open')
  .where('amount', '>', 1000)
  .orderBy('dueDate')
  .live()                      // Vue ref — recomputes on mutations
```

Operators: `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `contains`, `startsWith`, `between`, plus `.filter(fn)` for custom predicates. Composite via `.and()` / `.or()`. Everything runs client-side after decryption — zero-knowledge is preserved.

### Secondary indexes

Declare indexes in the store options to make equality/`in` queries O(1):

```ts
export const useInvoices = defineNoydbStore<Invoice>('invoices', {
  compartment: 'demo-co',
  indexes: ['status', 'client'],
})
```

Indexes are built client-side from decrypted records and live only in memory — they're never written to the adapter in plaintext.

### Pagination and streaming scan

For large collections, use `loadMore()` for pagination or `scan()` for memory-bounded iteration:

```ts
// Pagination — requires adapter with listPage capability (browser, dynamo)
await invoices.loadMore({ limit: 100 })

// Streaming scan — bypasses LRU, safe for 100K+ records
for await (const inv of invoices.scan()) {
  if (inv.status === 'overdue') notifyClient(inv)
}
```

### Lazy hydration + LRU eviction

By default a compartment loads every record on open. For large datasets, switch to lazy mode and set a cache budget:

```ts
export const useInvoices = defineNoydbStore<Invoice>('invoices', {
  compartment: 'demo-co',
  cache: {
    maxRecords: 5_000,
    maxBytes: '50MB',
  },
})
```

In lazy mode, `get(id)` hits the adapter on cache miss and populates the LRU; `list()` and `query()` throw (use `scan()` or `loadMore()` instead). Setting `prefetch: true` restores the v0.2 eager behavior.

See [`end-user-features.md`](./end-user-features.md) for runnable examples of every feature.

---

## Cloud sync

Wire a remote adapter as the `sync` target. The local adapter stays primary; the sync engine pushes/pulls encrypted envelopes when online:

```ts
// nuxt.config.ts
noydb: {
  adapter: 'file',   // primary (USB / disk)
  sync: {
    adapter: 'dynamo',
    table: 'myapp-prod',
    mode: 'auto',    // 'auto' | 'manual' | 'none'
  },
}
```

Manual sync from any component:

```ts
const invoices = useInvoices()
await invoices.$noydb.push()   // local → remote
await invoices.$noydb.pull()   // remote → local
await invoices.$noydb.sync()   // bidirectional
```

Conflict strategies: `'version'` (default, higher `_v` wins), `'local-wins'`, `'remote-wins'`, or a custom merge function.

---

## Multi-user access

Grant and revoke are owner/admin-only operations. The keyring file for the new user holds wrapped DEKs for exactly the collections they're allowed to read or write.

```ts
// Grant access
await invoices.$noydb.grant('demo-co', {
  userId: 'accountant-ann',
  displayName: 'Ann',
  role: 'operator',
  passphrase: 'temporary-passphrase',
  permissions: { invoices: 'rw', payments: 'rw' },
})

// Revoke with key rotation — old wrapped DEKs decrypt nothing
await invoices.$noydb.revoke('demo-co', {
  userId: 'accountant-ann',
  rotateKeys: true,
})
```

| Role     | Read     | Write    | Grant                  | Export |
|----------|:--------:|:--------:|:----------------------:|:------:|
| owner    | all      | all      | all roles              | yes    |
| admin    | all      | all      | operator/viewer/client | yes    |
| operator | granted  | granted  | —                      | —      |
| viewer   | all      | —        | —                      | —      |
| client   | granted  | —        | —                      | —      |

See [`architecture.md`](./architecture.md) for the key hierarchy and rotation flow.

---

## Appendix — low-level `createNoydb()` API

The Pinia store sits on top of the low-level `Compartment` / `Collection` API. You only need this for non-Vue contexts (CLIs, tests, backends).

```ts
import { createNoydb } from '@noy-db/core'
import { jsonFile } from '@noy-db/file'

const db = await createNoydb({
  adapter: jsonFile({ dir: './data' }),
  user: 'owner-01',
  secret: 'my-secure-passphrase',
})

const company = await db.openCompartment('demo-co')
const invoices = company.collection<Invoice>('invoices')

await invoices.put('inv-001', {
  id: 'inv-001',
  client: 'ABC Corp',
  amount: 5000,
  status: 'draft',
  dueDate: '2026-05-01',
})

const inv = await invoices.get('inv-001')
const drafts = invoices.query().where('status', '==', 'draft').toArray()

// Backup — output is all ciphertext, safe to transport
const backup = await company.dump()
await company.load(backup)

db.close()   // clears KEK/DEK from memory
```

The store path should be your first choice — it handles SSR, reactivity, and Pinia devtools integration for free.

---

## Testing / development adapter

For unit tests and prototypes, use `@noy-db/memory` with `encrypt: false` to inspect plaintext:

```ts
import { memory } from '@noy-db/memory'

const db = await createNoydb({
  adapter: memory(),
  user: 'dev',
  encrypt: false,     // development only — never in production
})
```

---

## Next steps

- [End-user features](./end-user-features.md) — runnable examples of every v0.3 feature
- [Architecture](./architecture.md) — data flow, key hierarchy, threat model
- [Adapters](./adapters.md) — built-in adapters and custom adapter development
- [Deployment profiles](./deployment-profiles.md) — pick a topology for your stack
- [Roadmap](../ROADMAP.md) — what's shipped and what's next
