# Core 01 — Vault & Collection model

> **Always-on. Cannot be opted out.**
> Source of truth: `packages/hub/src/{noydb,vault,collection}.ts`

## What it is

The three-layer data model:

```
Noydb              ← top-level instance from createNoydb()
  └── Vault        ← tenant / company namespace ("acme", "firm-2026")
        └── Collection<T>   ← typed record set ("invoices", "clients")
```

Every record lives at a `(vault, collection, id)` triple. Collections are typed via TypeScript generics; the type carries through `get` / `put` / `query` / `scan`.

## Lifecycle

```ts
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

const db = await createNoydb({ store: memory(), user: 'alice', secret: '…' })
const vault = await db.openVault('acme')
const invoices = vault.collection<Invoice>('invoices')

await invoices.put('inv-1', { amount: 100, status: 'paid' })
const inv = await invoices.get('inv-1')

db.close()  // wipes KEK + DEKs from memory
```

## Public surface

### `Noydb`
- `openVault(name, opts?)` — open + cache; idempotent
- `vault(name)` — sync access (must be opened first or via plaintext mode)
- `listVaults()` — adapter-side enumeration
- `listAccessibleVaults({ minRole })` — filtered by current user's keyring
- `close()` — clear KEK / DEKs / caches
- `transaction(fn)` — with `withTransactions()` opted in
- `grant`, `revoke`, `rotateKeys`, `changeSecret` — multi-user keyring (covered in Core 04)

### `Vault`
- `collection<T>(name, opts?)` — typed collection
- `dump()` / `load()` — backup / restore (with the bundle subsystem)
- `assertCanExport(format)` — pre-flight authorization
- `at(timestamp)` / `frame()` / `dictionary(name)` / `closePeriod` / etc. — gated by their respective subsystems

### `Collection<T>`
- `get(id, opts?)` / `put(id, record, opts?)` / `delete(id, opts?)`
- `list(opts?)` / `query()` / `scan()` / `count()`
- `subscribe(cb)` — change events (always-on)
- Bulk ops: `putMany`, `getMany`, `deleteMany`, `clear`
- History / blobs / presence / etc. — gated by their subsystems

## Reserved collection names

Internal collections start with `_`:

- `_keyring` — wrapped DEKs per user
- `_history` — version snapshots (with `withHistory()`)
- `_ledger` / `_ledger_deltas` — audit ledger (with `withHistory()`)
- `_dict_<name>` — shared dictionaries (with `withI18n()`)
- `_consent_audit` — consent log (with `withConsent()`)
- `_periods` — period anchors (with `withPeriods()`)
- `_idx/<field>/<id>` — persisted index side-cars (with `withIndexing()`)
- `_blob_*` — blob slot metadata + chunks (with `withBlobs()`)
- `_presence_<collection>` — presence storage-poll fallback (with `withSync()`)

`vault.collection('_anything')` throws `ReservedCollectionNameError`. `loadAll()` skips internal collections so backups don't leak metadata.

## Edge cases & limits

- **Memory-first**: `openVault()` loads the entire vault snapshot by default. Target scale is 1K–50K records; beyond that, opt into `prefetch: false` (lazy mode) on heavy collections via `withRouting()` + `withIndexing()`
- **Concurrent writers**: optimistic concurrency via `_v` on every put. Pass `expectedVersion` on the put call to opt into CAS

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md) — what's gated
- [Core 02 — Encryption](./02-encryption.md)
- [Core 03 — Stores](./03-stores.md)
- [Core 04 — Permissions & Keyring](./04-permissions-and-keyring.md)
