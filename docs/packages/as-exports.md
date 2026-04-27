# `@noy-db/as-*` — Portable-artefact exports

> **How data leaves the vault.** Each `as-*` package takes a Vault and
> produces a portable artefact — spreadsheet, PDF, JSON dump, encrypted
> bundle, SQL migration script. Two authorisation tiers gate them.

The `as-` prefix reads as *"export **as** XLSX / JSON / NoyDB."* This is
the one family where **policy matters more than mechanics** — crossing
the plaintext boundary is the most sensitive operation in the whole
library, so every formatter runs through a two-tier capability check
and writes an audit-ledger entry.

---

## The two tiers

**Plaintext tier** — gated by `canExportPlaintext` on the keyring. Default
is `[]` (no formats) for every role. The owner grants per-format
(`['xlsx']`, `['csv', 'json']`, `['*']`).

**Encrypted tier** — gated by `canExportBundle`. Default is `true` for
owner/admin, `false` for operator/viewer/client. A bundle is inert
without the KEK, so owner backups don't need the per-format friction.

Every successful export — tier 1 or tier 2 — writes an entry to the
audit ledger with `{ type: 'as-export', encrypted: true|false, format,
actor, ts }`. Metadata only; never contents.

---

## The distinctive ones

| Package | What's unusual |
|---|---|
| [`@noy-db/as-noydb`](../packages/as-noydb) | **The only encrypted tier.** Wraps `writeNoydbBundle()` — ciphertext in, ciphertext out. No plaintext crosses the boundary. `peek()` reads the header without decrypting the body, for due-diligence on received bundles. |
| [`@noy-db/as-zip`](../packages/as-zip) | **Composite archive.** Records + attachments together as one `.zip` — useful for one-click "hand someone a quarter of data" workflows. |
| [`@noy-db/as-sql`](../packages/as-sql) | **Dialect-aware migration dump.** Postgres / MySQL / SQLite flavours. `schema+data`, `schema-only`, or `data-only` modes. Drop straight into `psql -f` / `mysql <` / `sqlite3 <`. |
| [`@noy-db/as-xml`](../packages/as-xml) | **Hand-rolled emitter** (no `xml-js` dep). Legacy systems, banking batch imports, SpreadsheetML. Optional namespaces, custom element names. |

---

## The essentials

| Package | When to use |
|---|---|
| [`@noy-db/as-csv`](../packages/as-csv) | RFC 4180 CSV per collection. Direct Excel / Google Sheets import. |
| [`@noy-db/as-xlsx`](../packages/as-xlsx) | Native Excel with dictionary-label expansion + ACL-scoped rows. |
| [`@noy-db/as-json`](../packages/as-json) | Structured JSON grouped by collection. `pretty: true/false`, `includeMeta: true/false`. |
| [`@noy-db/as-ndjson`](../packages/as-ndjson) | Newline-delimited JSON for streaming + `jq` pipelines. O(1 record) memory via `pipe()`. |
| [`@noy-db/as-blob`](../packages/as-blob) | Single attachment extraction — "give me this PDF, not the whole vault." |

---

## Full catalog (9 packages)

**Plaintext tier** (gated by `canExportPlaintext`, default off)

- [`as-csv`](../packages/as-csv) · RFC 4180 CSV
- [`as-xlsx`](../packages/as-xlsx) · Excel with dict-label expansion
- [`as-json`](../packages/as-json) · structured JSON
- [`as-ndjson`](../packages/as-ndjson) · newline-delimited JSON (streaming)
- [`as-xml`](../packages/as-xml) · XML for legacy / enterprise systems
- [`as-sql`](../packages/as-sql) · SQL dump (postgres / mysql / sqlite)
- [`as-blob`](../packages/as-blob) · single-attachment extraction
- [`as-zip`](../packages/as-zip) · records + attachments in one archive

**Encrypted tier** (gated by `canExportBundle`, default on for owner/admin)

- [`as-noydb`](../packages/as-noydb) · `.noydb` encrypted bundle export

---

## Shape

Every `as-*` package ships the same three-function surface for
consistency:

```ts
await asFormat.toString(vault, options)                    // tier 1: in-memory
await asFormat.download(vault, { filename, ...options })   // tier 2: browser save-as
await asFormat.write(vault, path, { acknowledgeRisks: true, ...options })
                                                            // tier 3: disk write
```

Tier 3 (disk write) requires `acknowledgeRisks: true` on the plaintext
formatters because the bytes outlive the process. The encrypted tier
(`as-noydb`) has no such gate — the bytes are ciphertext.

---

## Import side — phase 1 (#302)

Four `as-*` packages now ship symmetric **readers** that parse a file
back into records, build a preview diff via `diffVault()` (#303), and
expose an `apply()` method that writes the changes through the normal
collection API:

| Package | Reader | Returns |
|---|---|---|
| `@noy-db/as-csv` | `fromString(vault, csv, { collection, idKey?, columnTypes?, policy? })` | `AsCSVImportPlan` |
| `@noy-db/as-json` | `fromString(vault, json, { collections?, idKey?, policy? })` and `fromObject(vault, doc, ...)` | `AsJSONImportPlan` |
| `@noy-db/as-ndjson` | `fromString(vault, ndjson, { collection, idKey?, policy? })` | `AsNDJSONImportPlan` |
| `@noy-db/as-zip` | `fromBytes(vault, bytes, { collection, password?, idKey?, policy? })` | `AsZipImportPlan` |

Every plan carries:

```ts
interface ImportPlan {
  plan: VaultDiff       // from diffVault — preview is free
  policy: ImportPolicy  // 'merge' | 'replace' | 'insert-only'
  apply(): Promise<void>
}
```

Reconciliation policies:

- **`'merge'`** (default) — insert + update, never delete.
- **`'replace'`** — full mirror; absent records get deleted.
- **`'insert-only'`** — only insert new records; modifications and deletes are skipped.

Two-step shape — preview is buffered up-front so consumers render review-and-confirm UI before mutating. The plan's `format({ detail: 'full' })` produces a git-style human-readable diff (count line + per-record `path: from → to` rows) for terminal or chat surfacing.

**Phase 2 (deferred):**

- `ImportCapability` keyring extension + `vault.assertCanImport(tier, format?)` (#308) — explicit per-format import grant defaulting closed.
- `apply()` inside a `runTransaction` boundary (#309) — atomic apply with full rollback on partial failure.
- Per-import ledger tagging (`reason: 'import:<format>'`) (#310) — audit consumers can distinguish manual edits from imports.
- Readers for `as-xlsx` / `as-xml` / `as-blob` (#311). `as-sql` is explicitly out of scope (dialect-specific parsing is a tar pit).

---

## Authorization model

noy-db's zero-knowledge guarantee applies to **stores and sync**, not to
the consumer's application. A legitimate consumer operation —
downloading an Excel report, emailing a CSV, handing off an encrypted
`.noydb` archive — is **data leaving the vault as a portable artefact**.
The `as-*` family is the fourth main package pillar alongside `to-*`,
`in-*`, `on-*`, and holds every such export.

### Two ideas that sometimes collide

1. **Zero-knowledge live storage** (`to-*` adapters) — noy-db
   guarantees that every storage backend it syncs to sees only
   ciphertext envelopes, continuously. A hypothetical `to-xlsx`
   adapter that wrote cleartext spreadsheets would break this promise
   for every user of the library.
2. **Portable-artefact export** (`as-*` family) — an end user
   downloading an Excel file, an operator emailing a CSV to a
   vendor, a vault owner handing off an encrypted `.noydb` archive
   to a colleague — legitimate one-shot operations that extract data
   *as a discrete artefact*, with an explicit authorization trail.

The **`to-*` taxonomy is for live encrypted storage. The `as-*`
taxonomy is for authorized artefact extraction** (plaintext or
encrypted). They are not interchangeable, and conflating them is how
you accidentally ship a library that looks zero-knowledge on paper but
leaks plaintext in practice.

### Three independent checks

Every `as-*` invocation is gated by **three independent checks**, any
of which can veto the export.

**1. Keyring read permission.** The invoking keyring must already be
able to read the collections being exported. An `operator` with `rw`
on `invoices` but no access to `payments` can only export `invoices`.
Same ACL that governs `collection.get()` / `.list()`.

**2. Owner-granted export capability.** A capability on the keyring
with **two bits**:

| Bit | Default | Gates |
|-----|---------|-------|
| `canExportPlaintext` | **off** | Every plaintext-tier package — record formatters (`as-xlsx`, `as-csv`, `as-json`, `as-ndjson`, `as-xml`, `as-sql`, `as-pdf`) AND document extractors (`as-blob`, `as-zip`). Also core `vault.exportJSON()` / `exportStream()`. One gate covers both content shapes because both produce plaintext bytes that cross the library boundary. |
| `canExportBundle` | **on for owner/admin, off for operator/viewer** | `as-noydb` and any future encrypted-container export. |

Only `owner` or `admin` can grant or revoke either bit. The asymmetry
is deliberate:

- **Plaintext off by default** because a plaintext artefact is
  world-readable by anyone who finds the file on disk. The owner
  must positively turn on the capability for each keyring — no silent
  upgrades.
- **Bundle on for owner/admin by default** because an encrypted
  `.noydb` bundle is inert without the KEK. The owner producing a
  backup of their own vault is the happy path and doesn't need an
  additional opt-in. For `operator` / `viewer` / `client` it defaults
  off and requires an explicit grant.

**This is the load-bearing mechanism.** Installing `@noy-db/as-xlsx`
or `@noy-db/as-noydb` into `package.json` does not unlock anything —
the capability bit does. A compromised developer machine with every
`as-*` package installed but no granted bits produces no artefacts of
either tier.

**API shape:**

```ts
import { hasExportCapability, ExportCapabilityError } from '@noy-db/hub'

interface KeyringExportCapability {
  plaintext?: Array<'xlsx' | 'csv' | 'json' | 'ndjson' | 'xml'
                  | 'sql' | 'pdf' | 'blob' | 'zip' | '*'>
  bundle?: boolean
}

// Grant:
await vault.grant('acme', {
  userId, displayName, role, passphrase,
  permissions: { invoices: 'rw' },
  exportCapability: { plaintext: ['xlsx', 'csv'], bundle: false },
})

// Check (in as-* packages):
if (!hasExportCapability(keyring, 'plaintext', 'xlsx')) {
  throw new ExportCapabilityError({ tier: 'plaintext', userId, format: 'xlsx' })
}
```

**3. Optional just-in-time re-authentication.** The hub's existing
`SessionPolicy.requireReAuthFor: 'export'` flag forces the caller to
present a fresh credential before `'export'`-class operations. Vault
owners who want stronger guarantees configure this at `createNoydb()`
time — the enforcer throws `SessionPolicyError` and the consumer's UI
prompts for a re-auth before the export continues.

### Composition

| Tier | Cap bit granted? | Re-auth fresh? (if required) | Result |
|------|:-:|:-:|--------|
| Plaintext | No | — | `AuthorizationError` |
| Plaintext | Yes | Yes *(or not required)* | Export proceeds |
| Plaintext | Yes | No | `SessionPolicyError` — prompt re-auth, retry |
| Encrypted | No | — | `AuthorizationError` |
| Encrypted | Yes | Yes *(or not required)* | Export proceeds |
| Encrypted | Yes | No | `SessionPolicyError` — prompt re-auth, retry |

Every `as-*` package inherits this check by building on
`vault.exportStream()` (plaintext tier) or `vault.writeBundle()`
(encrypted tier) — they cannot individually reinvent or bypass it.
Single enforcement point per tier, many formatters on top.

### Risk classification — two axes

#### Axis A — plaintext-tier risk

| Tier | Pattern | Risk | Approach |
|------|---------|:-:|----------|
| **1 — Runtime-memory only** | Decrypt → use in-process → discard | Lowest | Default. No special package. Just `collection.get(id)`. |
| **2 — One-shot user download** | Decrypt → write to `Blob` / `Uint8Array` → browser download prompt, never hits your own disk | Low | Plaintext-tier package with `canExportPlaintext` granted. Plaintext lives in memory + the end-user's Downloads folder only. |
| **3 — Long-term plaintext storage** | Decrypt → write to a filesystem / shared drive / cloud bucket the consumer controls | **High** | Plaintext-tier package with capability + `acknowledgeRisks: true`. Audit log entry. Consider: do you really need this? |

#### Axis B — encrypted-bundle risk

| Scenario | Risk | Approach |
|----------|:-:|----------|
| Owner makes a local backup of their own vault | Lowest | `as-noydb` default path. `canExportBundle` is on by default for owner. |
| Owner ships a bundle to a colleague, passphrase shared out-of-band | Low | Same path. Audit ledger captures the export. |
| Operator exports a bundle and hands it to an external party | **Medium** | `canExportBundle` must have been granted explicitly. The revocation of that operator's keyring does NOT reach into bundles already exported — plan accordingly. |
| Bundle stored alongside a passphrase hint, key file, or the passphrase itself | **Critical** | Whole threat model collapses. Treat passphrase and bundle as a single unit for key-management purposes; never store them in the same location. |

> The "Critical" row is threat-model advice, not library-enforced
> policy. The library cannot detect that a passphrase is stored
> alongside a bundle on the same S3 bucket or in the same USB
> directory — that's a storage-discipline concern that code review,
> ops runbooks, and key-management policy catch.

### Anti-patterns

**Don't build `@noy-db/to-xlsx`.** A `to-*` adapter implies "noy-db
writes to this backend and syncs with it." An xlsx file doesn't fit
— either the adapter encrypts before writing (produces an unreadable
xlsx) or writes plaintext (violates zero-knowledge for every user of
the library). Build `as-xlsx` with the authorization gate instead.

**Don't bypass the authorization gate inside a custom `as-*` clone.**
Every `as-*` package MUST call `vault.exportStream()` (or a
lower-level primitive that routes through the same enforcer). A
formatter that reaches into `collection.list()` directly skips the
capability check.

**Don't use `exportJSON()` / `exportStream()` without thinking about
retention.** These work. They produce plaintext. If you write the
result to a file and leave it there for three years, you've
accidentally opted into Tier 3.

### Multi-sheet dictionary-expanded Excel (`as-xlsx`)

Real-world spreadsheet consumers expect one sheet per collection,
dictionary labels resolved (not stable keys), reference fields
expanded, and schema-aware cell formats. `as-xlsx` produces a workbook
a non-technical user can open and understand immediately — the opposite
of a dumped JSON blob.

Dictionary labels are the one place where the stable-key invariant
named in [`architecture.md#i18n-boundaries-what-hub-knows-vs-what-you-own`](./architecture.md#i18n-boundaries-what-hub-knows-vs-what-you-own)
is *deliberately violated*: records store keys, exports resolve labels.
The invariant holds inside the library; the spreadsheet is the
documented egress exception.

### ACL scoping applies to blobs too

`BlobSet` inherits the parent collection's permissions. An `operator`
without read access to `payments` can't export `payments`'s records
OR its attached blobs, even with `canExportPlaintext` granted. The
gate is layered on top of read ACL, not instead of it.

### Audit-ledger integration

Every `as-*` call writes an entry to the hash-chained ledger with a
single shared `type: 'as-export'` and an `encrypted: true|false`
discriminator so consumers can filter either tier:

```ts
LedgerEntry {
  type: 'as-export',
  encrypted: false,            // or true
  package: '@noy-db/as-xlsx',
  collection: 'invoices',
  recordCount: 143,
  actor: 'operator@example',
  mechanism: 'xlsx',
  grantedBy: 'owner@example',  // who turned on canExportPlaintext
  reauthFresh: true,            // if requireReAuthFor:'export' was set
  timestamp: '2026-04-23T10:45:00Z',
}
```

**No record contents, no content hashes, no field values — for either
tier.** The ledger records that an `as-*` export happened, by whom,
with what authorization, at what time, against which collection (or
the whole vault, for bundles) — never what was exported.

[← Back to README](../README.md)
