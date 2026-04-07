# What NOYDB Means For You

*You won't install NOYDB. You won't see it. But your app is built on it — and here's why that matters.*

<picture>
  <img alt="End User Features" src="assets/end-user-features.svg" width="100%">
</picture>

---

### Your Data Is Unreadable To Everyone Else

Your records are scrambled with military-grade encryption before they leave your device. The cloud server storing your data? It sees gibberish. Someone finds your USB stick? Gibberish. Even the developer who built your app cannot read your data. Only your passphrase unlocks it.

### Works Without Internet

No Wi-Fi at the client site? No problem. Your app works fully offline — read, write, edit, everything. When you're back online, changes sync automatically. The internet is a convenience, not a requirement.

### Carry Your Work On A USB Stick

Copy your data folder to a USB stick. Plug it in at home, at the office, at a client site. It just works. The data on that stick is encrypted — if you lose it, nobody can read it.

### Multiple People, Different Access

The firm owner sees everything. The senior accountant can manage the team. Junior staff only see the companies they're assigned to. The external auditor can view but not edit. Each person has their own passphrase — no shared passwords.

### Unlock With Your Fingerprint Or Face

After your first login with a passphrase, you can enroll your fingerprint (Touch ID) or face (Face ID / Windows Hello). From then on — one touch to unlock. Your passphrase stays as a backup.

### Instant Backup And Restore

One click to export a full backup. The backup file is encrypted — safe to email, upload, or store anywhere. Restore from backup just as easily. Your monthly backup routine takes seconds.

### Fire Someone, Lock Them Out Immediately

When a staff member leaves, revoke their access. The system automatically re-encrypts everything they had access to with new keys. Even if they saved a copy of their credentials — useless. Locked out permanently.

### No Vendor Lock-In

Your data is not trapped in any cloud service. Switch from USB to cloud. Switch from AWS to a different provider. Move between storage backends without losing a single record. Your data format is open and documented.

### Sync Across Devices Without Conflicts

Edit an invoice on your laptop at home. Your colleague edits a payment at the office. When both devices sync — both changes merge cleanly. On the rare occasion two people edit the same record, the system detects it and lets you choose which version to keep.

### Tiny, Fast, No Bloat

Opens 1,000 records in under half a second. Saves a record in under 5 milliseconds. Searches are instant. No loading spinners. No waiting. Your app feels fast because the storage layer underneath is fast.

---

*These aren't aspirational features. They're the design requirements NOYDB was built to deliver.*

---

# Developer reference — v0.3 features

The sections above are the *user* story. This section is the *developer* story: runnable snippets for every feature that landed in v0.3. Each example assumes the Nuxt 4 + `@noy-db/nuxt` happy path from [`getting-started.md`](./getting-started.md).

## Pinia integration

Two adoption paths, both in `@noy-db/pinia`:

**Greenfield — `defineNoydbStore`:** define an encrypted Pinia store in one call. The store exposes `items`, `byId(id)`, `count`, `add()`, `update()`, `remove()`, `refresh()`, `$ready`, plus a `query()` builder and a `$noydb` escape hatch for low-level access.

```ts
// stores/invoices.ts
export const useInvoices = defineNoydbStore<Invoice>('invoices', {
  compartment: 'demo-co',
})
```

**Augmentation — `createNoydbPiniaPlugin`:** bolt encryption onto an existing `defineStore` via a plugin. Add `noydb:` to the store options and one piece of state gets persisted through NOYDB without touching components.

```ts
// main.ts
pinia.use(createNoydbPiniaPlugin({
  adapter: browser(),
  user: 'demo-user',
  secret: () => promptPassphrase(),
}))

// stores/clients.ts — existing store, one new option
export const useClients = defineStore('clients', {
  state: () => ({ list: [] as Client[] }),
  noydb: { compartment: 'demo-co', collection: 'clients', persist: 'list' },
  actions: { add(c: Client) { this.list.push(c) } },
})
```

Both paths keep Pinia devtools, `storeToRefs`, SSR, and `pinia-plugin-persistedstate` working unmodified.

## Nuxt 4 module (`@noy-db/nuxt`)

Nuxt 4+ exclusive. Adds auto-imports for every composable, installs the Pinia plugin with `mode: 'client'` (SSR-safe), augments `@nuxt/schema` so the `noydb:` config key is fully typed, and gates the devtools tab behind `NODE_ENV !== 'production'`.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@pinia/nuxt', '@noy-db/nuxt'],
  noydb: {
    adapter: 'browser',
    pinia: true,
    devtools: true,
  },
})
```

The server bundle contains zero references to `crypto.subtle` or any DEK/KEK symbol — verified in CI by grepping `.output/server/` after `nuxt build`.

## Reactive query DSL

Chainable, client-side, works against decrypted records. Returns a plain array via `.toArray()`, or a Vue `ref` via `.live()` that re-computes on mutations.

```ts
const invoices = useInvoices()

// One-shot query
const drafts = invoices.query()
  .where('status', '==', 'draft')
  .orderBy('dueDate')
  .limit(20)
  .toArray()

// Reactive query — updates automatically when items change
const openLarge = invoices.query()
  .where('status', '==', 'open')
  .where('amount', '>=', 10_000)
  .live()
```

Operators: `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `contains`, `startsWith`, `between`. Escape hatch: `.filter(fn)` for arbitrary predicates. Composite via `.and()` / `.or()`.

## Secondary indexes

Declared per-collection. Built client-side after decryption; kept in memory only. The planner uses them to turn linear scans into `O(1)` hash lookups for equality and `in` clauses, and falls back to scanning the candidate set for the remaining clauses.

```ts
export const useInvoices = defineNoydbStore<Invoice>('invoices', {
  compartment: 'demo-co',
  indexes: ['status', 'client'],
})

// This query uses the 'status' index for candidate selection,
// then filters the remainder with the amount clause:
const bigOpen = invoices.query()
  .where('status', '==', 'open')
  .where('amount', '>', 5_000)
  .toArray()
```

Benchmark: 10K records, indexed equality query is 4–6× faster than a linear scan. No plaintext indexes ever touch the adapter.

## Pagination (`listPage`) and streaming `scan()`

Adapters advertise a capability flag. Adapters that support `listPage` (browser, dynamo, file) expose `loadMore()` on the store:

```ts
const invoices = useInvoices()

// First 100
await invoices.refresh({ limit: 100 })
// Next 100
await invoices.loadMore({ limit: 100 })
```

For memory-bounded iteration over very large collections, use the `scan()` async iterator. It bypasses the LRU entirely — safe for 100K+ records.

```ts
for await (const inv of invoices.$noydb.scan()) {
  if (inv.status === 'overdue') await notifyClient(inv)
}
```

Peak memory stays under 200 MB on a 100K-record collection (from the v0.3 acceptance test).

## Lazy hydration + LRU eviction

By default a compartment eager-loads every record on open (the v0.2 behavior). Set `cache` and lazy mode kicks in: `get(id)` hits the adapter on cache miss and populates the LRU; `list()` and `query()` throw (use `scan()` or `loadMore()`); `indexes` are rejected at construction because they require full hydration.

```ts
export const useInvoices = defineNoydbStore<Invoice>('invoices', {
  compartment: 'demo-co',
  cache: {
    maxRecords: 5_000,
    maxBytes: '50MB',       // accepts '50MB', '2GB', or a number of bytes
  },
})

// To keep the eager behavior, opt back in:
export const useInvoices = defineNoydbStore<Invoice>('invoices', {
  compartment: 'demo-co',
  prefetch: true,
})
```

Eviction is O(1) via a `Map` + delete/set promotion. Cache stats are available as `invoices.$noydb.cacheStats()` → `{ hits, misses, evictions, bytes, records }`.

---

# v0.4 features — integrity & trust

The v0.3 release nailed the **adoption** story (Nuxt module, Pinia integration, query DSL). v0.4 adds the **integrity** layer: every record can be schema-validated, every mutation is recorded in a tamper-evident ledger, and every backup is verifiable end-to-end.

## Schema validation via Standard Schema v1

Attach any [Standard Schema v1](https://standardschema.dev) validator (Zod, Valibot, ArkType, Effect Schema) to a collection. Validation runs **before encryption on `put()`** and **after decryption on reads** — bad input is rejected at the store boundary, and stored data that has drifted from the current schema throws loudly instead of silently propagating garbage.

```ts
import { z } from 'zod'

const InvoiceSchema = z.object({
  id: z.string(),
  client: z.string(),
  amount: z.number().positive(),
  status: z.enum(['draft', 'open', 'paid', 'overdue']),
})

export const useInvoices = defineNoydbStore<z.infer<typeof InvoiceSchema>>('invoices', {
  compartment: 'demo-co',
  schema: InvoiceSchema,
})
```

The thrown `SchemaValidationError` carries the full Standard Schema issue list so UI code can render field-level messages, and a `direction: 'input' | 'output'` discriminator so callers can distinguish "user sent bad data" from "stored data drifted from the schema".

History reads (`getVersion`, `history`) intentionally skip validation — historical records predate the current schema by definition.

## Hash-chained audit log (the ledger)

Every `Collection.put` and `Collection.delete` appends an encrypted entry to the compartment's `_ledger/` internal collection. Entries are linked by `prevHash = sha256(canonicalJson(previousEntry))`, so any tampering breaks the chain at that point and is detected by `verify()`.

```ts
const company = await db.openCompartment('demo-co')
const invoices = company.collection('invoices')

await invoices.put('inv-1', { /* ... */ })
await invoices.delete('inv-1')

const ledger = company.ledger()
const head = await ledger.head()
//   → { entry: {...}, hash: 'a1b2c3...', length: 2 }

const result = await ledger.verify()
//   → { ok: true, head: 'a1b2c3...', length: 2 }
//   → or { ok: false, divergedAt: 5, expected: '...', actual: '...' }
```

`payloadHash` is the sha256 of the **encrypted** envelope, not plaintext — preserving zero-knowledge. The full ledger entry is itself encrypted with the compartment's ledger DEK, so adapters never see plaintext metadata.

The `head().hash` is the value users would publish to a third-party anchor (blockchain, OpenTimestamps, internal git repo) for external tamper detection.

## Delta history via RFC 6902 JSON Patch

Every put after the genesis computes a **reverse** JSON Patch from the new record to the previous version and stores it in `_ledger_deltas/`. Storage scales with **edit size**, not record size — a 1 KB record edited 100 times costs ~1 KB of deltas, not 100 KB of snapshots.

```ts
const ledger = company.ledger()
const current = await invoices.get('inv-1')

// Reconstruct any historical version
const v2 = await ledger.reconstruct('invoices', 'inv-1', current, 2)
const v1 = await ledger.reconstruct('invoices', 'inv-1', current, 1)
```

The reconstruction algorithm walks the chain backward from the current state, applying each entry's reverse patch. Reverse patches were chosen over forward patches because the current state is already live in the data collection — no base snapshot needed.

Known limitation: reconstruct is ambiguous across delete+recreate cycles because the version counter resets. Ledger-index-based queries are tracked for v0.5.

## Foreign-key references via `ref()`

Soft FK enforcement at the collection level. Three modes:

```ts
import { ref } from '@noy-db/core'

const invoices = company.collection<Invoice>('invoices', {
  refs: {
    clientId: ref('clients'),                // strict (default)
    categoryId: ref('categories', 'warn'),
    parentId: ref('invoices', 'cascade'),    // self-reference OK
  },
})

// strict on put: rejects records whose target id doesn't exist
await invoices.put('inv-1', { id: 'inv-1', clientId: 'nope', /* ... */ })
//   → throws RefIntegrityError

// strict on delete: rejects delete of target with referencing records
await clients.delete('c-1')
//   → throws RefIntegrityError if any invoices still reference it

// cascade on delete: propagates the delete
await clients.delete('c-2')
//   → deletes every invoice with clientId === 'c-2'

// warn mode: surfaces orphans through checkIntegrity()
const { violations } = await company.checkIntegrity()
//   → [{ collection, id, field, refTo, refId, mode }]
```

Cycle-safe cascade (mutually-cascading collections terminate). Cross-compartment refs are rejected with `RefScopeError` — they need an auth story tracked for v0.5.

## Verifiable backups

`dump()` embeds the current ledger head and the full `_ledger` + `_ledger_deltas` internal collections. `load()` re-runs `verifyBackupIntegrity()` after restoring and rejects any backup whose chain or data has been tampered with between dump and restore.

```ts
const backup = await company.dump()

// Round-trip — fully verified end-to-end
await targetCompany.load(backup)
//   → throws BackupLedgerError if the chain is broken or head doesn't match
//   → throws BackupCorruptedError if any data envelope's hash diverged

// Or call any time on a live compartment for a periodic audit
const result = await company.verifyBackupIntegrity()
// → { ok: true, head, length }
// → { ok: false, kind: 'chain', divergedAt, message }
// → { ok: false, kind: 'data', collection, id, message }
```

Detection coverage:

| Attack | Detection |
|---|---|
| Modify a ledger entry's encrypted bytes | AES-GCM auth tag fails on decrypt |
| Reorder ledger entries | `prevHash` chain break → `BackupLedgerError` |
| Modify a data envelope's encrypted bytes | sha256 mismatch with ledger payloadHash → `BackupCorruptedError` |
| Modify the embedded `ledgerHead.hash` to match a tampered chain | Reconstructed head ≠ embedded → `BackupLedgerError` |
| Out-of-band write to a data collection (bypassing `Collection.put`) | Same data envelope cross-check on the next `verifyBackupIntegrity()` |

Backwards compat: pre-v0.4 backups (no `ledgerHead`) load with a console warning and skip the integrity check.

---

## Putting it together — the Nuxt demo

The [`playground/nuxt/`](../playground/nuxt/) directory is the integration test for everything above: one Nuxt 4 app, `@noy-db/nuxt` module, two `defineNoydbStore` stores (invoices + clients), three pages. No direct `Compartment` / `Collection` calls in any component — the Pinia API covers the full surface. The invoices store is backed by a Zod schema (v0.4 #42), so the demo also exercises the validation path end-to-end.

If that demo builds, every v0.3 + v0.4 feature composes correctly. That's the acceptance test.

