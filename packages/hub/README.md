# @noy-db/hub

> Zero-knowledge, offline-first, encrypted document store — core library.

[![npm](https://img.shields.io/npm/v/@noy-db/hub.svg)](https://www.npmjs.com/package/@noy-db/hub)
[![license](https://img.shields.io/npm/l/@noy-db/hub.svg)](https://github.com/vLannaAi/noy-db/blob/main/LICENSE)

Part of [**noy-db**](https://github.com/vLannaAi/noy-db) — *"None Of Your Damn Business"*. This is the **core library** — install this first, then pair it with a storage backend.

## Install

Every noy-db app needs `@noy-db/hub` plus at least one storage backend (`to-*`). Everything else is optional.

```bash
pnpm add @noy-db/hub @noy-db/to-memory
```

### Pick a storage backend — [`@noy-db/to-*`](https://www.npmjs.com/search?q=%40noy-db%2Fto-)

| Package | Use for |
|---------|---------|
| [`to-memory`](https://www.npmjs.com/package/@noy-db/to-memory) | Tests, prototypes, ephemeral data |
| [`to-file`](https://www.npmjs.com/package/@noy-db/to-file) | Local disk, USB stick |
| [`to-browser-idb`](https://www.npmjs.com/package/@noy-db/to-browser-idb) | Browser IndexedDB (atomic CAS) |
| [`to-browser-local`](https://www.npmjs.com/package/@noy-db/to-browser-local) | Browser localStorage |
| [`to-aws-dynamo`](https://www.npmjs.com/package/@noy-db/to-aws-dynamo) | DynamoDB single-table |
| [`to-aws-s3`](https://www.npmjs.com/package/@noy-db/to-aws-s3) | S3 object store |
| [`to-cloudflare-d1`](https://www.npmjs.com/package/@noy-db/to-cloudflare-d1) | Edge SQLite via Workers |
| [`to-cloudflare-r2`](https://www.npmjs.com/package/@noy-db/to-cloudflare-r2) | Zero-egress object storage |
| [`to-postgres`](https://www.npmjs.com/package/@noy-db/to-postgres) | PostgreSQL `jsonb` |
| [`to-mysql`](https://www.npmjs.com/package/@noy-db/to-mysql) | MySQL / MariaDB `JSON` |
| [`to-sqlite`](https://www.npmjs.com/package/@noy-db/to-sqlite) | better-sqlite3 / node:sqlite / bun:sqlite |
| [`to-supabase`](https://www.npmjs.com/package/@noy-db/to-supabase) | Supabase Postgres + Storage |
| [`to-turso`](https://www.npmjs.com/package/@noy-db/to-turso) | Hosted libSQL (replicated SQLite) |
| [`to-webdav`](https://www.npmjs.com/package/@noy-db/to-webdav) | Nextcloud / ownCloud |
| [`to-ssh`](https://www.npmjs.com/package/@noy-db/to-ssh) | Remote SFTP backend |
| [`to-smb`](https://www.npmjs.com/package/@noy-db/to-smb) | Windows shares / NAS |
| [`to-nfs`](https://www.npmjs.com/package/@noy-db/to-nfs) | NFS mounts |
| [`to-icloud`](https://www.npmjs.com/package/@noy-db/to-icloud) | iCloud Drive (.icloud-aware) |
| [`to-drive`](https://www.npmjs.com/package/@noy-db/to-drive) | Google Drive bundle |
| [`to-meter`](https://www.npmjs.com/package/@noy-db/to-meter) | Wrap any store with metrics |

### Optional ecosystem

- **Framework integrations** — [`@noy-db/in-*`](https://www.npmjs.com/search?q=%40noy-db%2Fin-): vue, pinia, nuxt, react, nextjs, svelte, solid, zustand, tanstack-query, tanstack-table, yjs, ai, rest.
- **Authentication paths** — [`@noy-db/on-*`](https://www.npmjs.com/search?q=%40noy-db%2Fon-): webauthn, oidc, totp, email-otp, magic-link, recovery, shamir, pin, threat.
- **Export formats** — [`@noy-db/as-*`](https://www.npmjs.com/search?q=%40noy-db%2Fas-): csv, json, ndjson, xml, sql, xlsx, blob, zip, noydb (encrypted bundle).
- **Session-share transports** — [`@noy-db/by-*`](https://www.npmjs.com/search?q=%40noy-db%2Fby-): tabs (BroadcastChannel multi-tab), peer (WebRTC).
- **CLI tooling** — [`@noy-db/cli`](https://www.npmjs.com/package/@noy-db/cli) (`noydb` binary; inspect/verify `.noydb` files), [`create-noy-db`](https://www.npmjs.com/package/create-noy-db) (`npm create noy-db` scaffolder).

## Quick start

```ts
import { createNoydb } from '@noy-db/hub'
import { toMemory } from '@noy-db/to-memory'

type Invoice = { id: string; amount: number; customer: string }

const db = await createNoydb({
  store: toMemory(),
  user: 'alice',
  secret: 'correct horse battery staple',
})

const acme = await db.openVault('acme')
const invoices = acme.collection<Invoice>('invoices')

await invoices.put('INV-001', { id: 'INV-001', amount: 8500, customer: 'ABC Trading' })
const all = await invoices.list()
```

## What it does

- **Zero-knowledge encryption** — AES-256-GCM + PBKDF2 (600K iterations) + AES-KW, all via Web Crypto API
- **Per-collection keys** — one DEK per collection, wrapped with a per-user KEK
- **Multi-user access control** — owner, admin, operator, viewer, client roles
- **Offline-first sync** — push/pull with optimistic concurrency on encrypted envelopes
- **Audit history** — full-copy snapshots with `history()`, `diff()`, `revert()`, `pruneHistory()`
- **No third-party runtime dependencies to install** — the only runtime dependency is
  `@noy-db/attestation`, on the same version line. (`zod` is vendored into the bundle for the
  optional persisted-schema converter and loaded lazily; it never executes unless you use that
  path, and it does not appear in your lockfile.)

## Cross-vault queries

When a single principal holds grants across many vaults — multi-tenant apps, multi-project setups, multi-workspace tools — there are two APIs for enumerating and fanning out across them:

### `db.listAccessibleVaults(options?)` — enumerate

Returns every vault the calling principal can unwrap, optionally filtered by minimum role. The walk is bounded by the local keyring index — vaults where the user has no keyring file or where the secret doesn't unwrap are silently dropped from the result.

```ts
// All vaults I can unlock
const all = await db.listAccessibleVaults()
// → [{ id: 'T1', role: 'owner' }, { id: 'T7', role: 'admin' }, ...]

// Only vaults where I'm at least admin
const admin = await db.listAccessibleVaults({ minRole: 'admin' })
```

**Existence-leak guarantee.** The return value never reveals the existence of a vault the caller cannot unwrap. The store sees the enumeration call (it owns the storage), but downstream consumers of `listAccessibleVaults()` only see the filtered list.

**Store capability.** Requires the optional `NoydbStore.listVaults()` method. The `@noy-db/to-memory` and `@noy-db/to-file` stores implement it; cloud stores (`@noy-db/to-aws-dynamo`, `@noy-db/to-aws-s3`) and `@noy-db/to-browser-idb` do not (cloud enumeration needs a GSI or list-bucket permission that has to be configured by the consumer). Calling `listAccessibleVaults()` against a store that doesn't implement `listVaults` throws `StoreCapabilityError`. Workaround: maintain the candidate list out of band and pass it directly to `queryAcross()`.

### `db.queryAcross(ids, fn, options?)` — fan out

Runs a per-vault callback against a list of vault ids and collects the results, tagged by vault. Per-vault errors do not abort the others — each result slot carries either `result` or `error`.

```ts
const accessible = await db.listAccessibleVaults({ minRole: 'admin' })

const results = await db.queryAcross(
  accessible.map((v) => v.id),
  async (vault) => {
    return vault.collection<Invoice>('invoices').query()
      .where('month', '==', '2026-03')
      .toArray()
  },
  { concurrency: 4 }, // default 1 — bump for cloud stores
)
// results: Array<{ vault, result?: Invoice[], error?: Error }>
```

**Composes with `exportStream()` for cross-vault plaintext export:**

```ts
await db.queryAcross(accessible.map((v) => v.id), async (vault) => {
  const out: unknown[] = []
  for await (const chunk of vault.exportStream()) out.push(chunk)
  return out
})
```

## Backup and export

noy-db ships two distinct paths for getting data out of a vault. They are not interchangeable — use the one that matches your goal.

### `vault.dump()` — encrypted backup (the default)

Produces a tamper-evident encrypted JSON envelope. Records stay encrypted, the hash-chained ledger is included so the receiver can verify integrity end-to-end after `load()`, and the recipient must hold a valid keyring to read anything. **Use this for backup, transport between machines, or any scenario where the data must remain protected on disk.**

```ts
const backup = await acme.dump()                // string of encrypted JSON
await fs.writeFile('./acme-backup.json', backup) // safe to store anywhere
// later, on another machine:
await otherAcme.load(backup)                    // verifies + restores
```

### `vault.exportStream()` and `vault.exportJSON()` — plaintext export

⚠ **These methods decrypt your records and produce plaintext.**

`exportStream()` is an authorization-aware async generator that yields per-collection chunks of decrypted records, with schema and ref metadata attached. `exportJSON()` is a five-line wrapper that serializes the stream to a single JSON string.

Both methods are **ACL-scoped**: collections the calling principal cannot read are silently skipped. An operator with `{ invoices: 'rw' }` permissions on a five-collection vault exports only `invoices`, with no error on the others.

```ts
// Stream every collection the caller can read
for await (const chunk of acme.exportStream()) {
  console.log(chunk.collection, chunk.records.length)
}

// Or get a single JSON string
const json = await acme.exportJSON()
await fs.writeFile('./backup.json', json)
```

**Use only when:**
- You are the authorized owner of the data, **and**
- You have a legitimate downstream tool that requires plaintext, **and**
- You have a documented plan for how the resulting plaintext will be protected and eventually destroyed.

If your goal is encrypted backup or transport between noy-db instances, use **`vault.dump()`** instead.

#### Why no built-in file path support

Core has zero `node:` imports — it runs unchanged in browsers, Node, Bun, Deno, and edge runtimes. `exportJSON()` returns a `Promise<string>` so the consumer chooses any sink (`fs.writeFile`, `Blob` download, `fetch` upload, IndexedDB) and the destination decision stays explicit at the call site. This is also better for the security warning: there's no library function quietly writing plaintext somewhere.

#### Other plaintext formats

CSV, XML, xlsx, and the rest of the plaintext tier — plus encrypted `.noydb` bundles under the `as-noydb` encrypted tier — all live in the [`@noy-db/as-*`](https://www.npmjs.com/search?q=%40noy-db%2Fas-) family. Every invocation is gated by the two-tier authorization model (`assertCanExport('plaintext')` default off, `canExportBundle` default on for owner/admin) and lands in the audit ledger.

## Money fields

`money()` is a schema-layer field descriptor (a sibling of `i18nText()` / `dictKey()`) for currency-safe, exact decimal values. Money is stored as a scaled integer encoded as a **digit string**, so it is exact for any magnitude — past `Number.MAX_SAFE_INTEGER` included (a JSON number would silently truncate at 2^53).

```ts
vault.collection('invoices', {
  schema: z.object({ id: z.string(), total: z.union([z.number(), z.string()]) }),
  moneyFields: { total: money({ currency: 'EUR', scale: 2 }) }, // scale optional — ISO-4217 default
})

await invoices.put('a', { id: 'a', total: '123.45' })          // stored as '12345'
const inv = await invoices.get('a', { locale: 'de-DE' })
// inv.total           → '123.45'   (exact decimal string)
// inv.totalFormatted  → '123,45 €' (Intl, full precision)
// inv.totalNumber     → 123.45     (convenience JS number; lossy past 2^53)

// Exact aggregation — sum/min/max run in BigInt, no float drift:
invoices.query().aggregate({ total: sum('total') }).run() // → '0.60', never 0.6000000000000001
```

- **Rounding:** excess precision is **rejected** by default; opt in per field with `money({ ..., rounding: 'half-even' })` (`half-up` / `half-even` / `half-down` / `up` / `down` / `ceil` / `floor`).
- **Multi-currency:** opt in with `money({ currencies: 'any' | ['EUR','USD'] })` — currency travels per record as `{ amount, currency }`; `sum` returns an exact per-currency map (`{ EUR: '15.50', USD: '3.00' }`), or one figure with `sum('total', { convertTo: 'EUR', fx })`.
- Money `sum`/`min`/`max` implement incremental `remove()`, so they stay exact under live aggregation and materialized-view maintenance.

## Computed fields

`computed` declares schema-owned scalar fields derived on write — keeping the arithmetic next to the schema instead of scattered across handlers. Each function is pure and synchronous; they run **first** in the write pipeline (before schema validation), in declaration order, so a later field can read an earlier one. The result is **materialized** on the record — stored, queryable, and `aggregate(sum())`-able like any field.

```ts
vault.collection('lines', {
  schema: z.object({
    id: z.string(), unitPrice: z.number(), qty: z.number(),
    netAmount: z.number().optional(), taxAmount: z.number().optional(), total: z.number().optional(),
  }),
  computed: {
    netAmount: (r) => r.unitPrice * r.qty,
    taxAmount: (r) => r.netAmount * 0.22,   // reads the field computed above
    total:     (r) => r.netAmount + r.taxAmount,
  },
})

await lines.put('a', { id: 'a', unitPrice: 10, qty: 3 })  // computed fields not supplied
const line = await lines.get('a')   // → { …, netAmount: 30, taxAmount: 6.6, total: 36.6 }
```

- A computed field **overwrites** any user-supplied value of the same name (the field is schema-owned); a throwing function rejects the write with `ComputedFieldError`.
- **Composes with `money()`** — declare a computed field as a money field too and it's quantized after evaluation, so `sum()` over it is exact.

## Immutable collections (WORM)

`immutableGuard` makes a collection write-once after a condition holds — issued invoices/DDTs that must never change. It's declarative sugar over `guards`: it generates the block-on-`check`/`onDelete` + ledgered admin-`amendment` strategy, so it reuses the whole guard machinery (and composes with `periods`/`history`).

```ts
import { createNoydb, immutableGuard } from '@noy-db/hub'

await createNoydb({
  store, user, secret,
  guardStrategies: [
    immutableGuard({ collection: 'invoices', after: (r) => r.status === 'issued' }),
  ],
})

await invoices.put('a', { id: 'a', status: 'draft',  total: 100 }) // ok
await invoices.put('a', { id: 'a', status: 'issued', total: 100 }) // ok — the transition write
await invoices.put('a', { id: 'a', status: 'issued', total: 999 }) // ✗ RecordLockedError
await invoices.delete('a')                                          // ✗ RecordLockedError

// the sanctioned, ledgered override:
await db.transaction({ amendment: true, reason: 'correct issued total' }, async (tx) => {
  tx.vault('books').collection('invoices').put('a', { id: 'a', status: 'issued', total: 110 })
})
```

- `after(record)` is evaluated on the **existing** record, so inserts and the write that *first* makes a record immutable are allowed; everything after is blocked.
- `appendOnly: true` is shorthand for `after: () => true` — immutable from creation.
- The admin/owner `amendment` path is the only way through, and every amendment is appended to the audit ledger.

## Retention, legal-hold & archival

For retention-bound data (e.g. 10-year fiscal records), two facilities share one rule — **a legal hold blocks eviction**.

**Blob retention** (`vault.compact()`) gains a hold and a period-bound floor:

```ts
vault.collection('invoices', {
  blobFields: {
    pdf: {
      retainDays: 3650,                              // base TTL
      legalHold:  (r) => r.underLitigation === true, // never evict while held
      retainUntil:(r) => r.fiscalYearEnd,            // floor: keep until period obligation ends
    },
  },
})
const { evicted, held } = await vault.compact() // held = retained-by-hold count
```

**Record archival** (`withArchive`) relocates sealed records to a cold store — envelope-level, no re-encryption — and restores on demand:

```ts
import { createNoydb, withArchive } from '@noy-db/hub'

const db = await createNoydb({ store: primary, user, secret, archiveStrategy: withArchive({ store: coldStore }) })
vault.collection('invoices', {
  archive: { archiveWhen: (r) => r.fiscalYear <= thisYear - 1, legalHold: (r) => r.underHold },
})

await vault.archive()                       // → { archived, held, scanned }
await vault.listArchived('invoices')        // → [{ collection, id }, …]
await vault.restore('invoices', 'inv-2020') // relocate back to primary (decryptable)
```

Archival uses low-level relocation, so it **bypasses guards** (issued/immutable records over a sealed period can still be archived) and doesn't recompute finalized aggregates. Archived records read `null` from the primary store until restored; a `legalHold` predicate blocks archival entirely.

## Atomic sequences

`vault.sequence(name)` gives gap-free, exactly-once numbering — the primitive fiscal/ERP/ticketing apps need for invoice or DDT numbers — backed by an optimistic compare-and-swap counter.

```ts
const n = await vault.sequence('invoice-2026').next()   // 1, then 2, 3, … no gaps, no duplicates
const cur = await vault.sequence('invoice-2026').peek()  // read current value without allocating
```

- **Independent per name** — `sequence('invoice-2026')` and `sequence('ddt-2026')` are separate counters.
- **Concurrency-safe** — concurrent `next()` calls retry on CAS contention (jittered backoff); a genuine burst beyond the retry budget surfaces `SequenceContentionError` so the caller can retry or queue.
- **Online-only — by design.** Gap-free numbering needs single-authority serialization, which an offline writer can't provide. `next()` throws `SequenceOfflineError` unless the store advertises `capabilities.casAtomic`. This is the honest wall: assign each `next()` value to its record in the same operation (a discarded value is a gap in *usage*, not in the sequence).

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`. Install from the `next` dist-tag:

```bash
pnpm add @noy-db/hub@next @noy-db/to-memory@next
```

## Documentation

- Full docs: <https://github.com/vLannaAi/noy-db-docs>
- Spec: <https://github.com/vLannaAi/noy-db-docs/blob/main/SPEC.md>
- Roadmap: <https://github.com/vLannaAi/noy-db-docs/blob/main/ROADMAP.md>

## License

[MIT](./LICENSE) © vLannaAi
