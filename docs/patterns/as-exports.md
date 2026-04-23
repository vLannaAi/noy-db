# Pattern — `as-*` exports: getting data OUT of noy-db as a portable artefact

> **TL;DR** — noy-db's zero-knowledge guarantee applies to **stores and
> sync**, not to the consumer's application. A legitimate consumer
> operation — downloading an Excel report, emailing a CSV, handing off
> an encrypted `.noydb` archive — is **data leaving the vault as a
> portable artefact**. The `@noy-db/as-*` package family is the fourth
> main package pillar (`to-`, `in-`, `on-`, `as-`) and holds every such
> export, in **two tiers** distinguished by whether the artefact
> crosses the plaintext boundary:
>
> - **Plaintext tier** — two sub-families sharing one gate:
>   - *Record formatters* — `as-xlsx`, `as-csv`, `as-json`, `as-ndjson`,
>     `as-xml`, `as-sql`, `as-pdf`. Take structured records, serialise
>     as the target format.
>   - *Document/blob extractors* — `as-blob`, `as-zip`. Take attached
>     binary blobs (PDFs, images, scans) from `BlobSet`, emit as native
>     MIME bytes or as a composite zip archive of records + attachments.
>
>   Both sub-families cross the plaintext boundary and share one gate:
>   owner-granted `canExportPlaintext` (**default off**) plus optional
>   JIT re-auth.
> - **Encrypted tier** — `as-noydb`. Preserves zero-knowledge (ciphertext
>   in, ciphertext out, packaged in the `.noydb` container format).
>   Gated by `canExportBundle` (**default on for owner/admin, off for
>   operator/viewer**) — softer because the bundle is useless without
>   the KEK, but still an artefact the owner should know exists.
>
> Both tiers write an audit-ledger entry with the same `type: 'as-export'`
> and an `encrypted: true|false` discriminator.

---

## The four pillars — where `as-*` fits

noy-db organises every peripheral package by a single-preposition
prefix that reads naturally in the name:

| Prefix | Reads as | What it does | Examples |
|--------|----------|--------------|----------|
| `to-`  | "data goes **to**…" | Encrypted storage backend — sees ciphertext only | `to-file`, `to-aws-dynamo`, `to-browser-idb` |
| `in-`  | "runs **in**…" | Framework integration — composables, store bindings | `in-vue`, `in-pinia`, `in-nuxt`, `in-yjs` |
| `on-`  | "you get **on** via…" | Authentication method — unlocks the KEK | `on-webauthn`, `on-oidc`, `on-magic-link`, `on-pin` |
| `as-`  | "export **as**…" | Portable-artefact export — the vault's data or documents leave as a discrete file the consumer holds. Two tiers: plaintext (records + blobs) + encrypted bundle. | `as-xlsx`, `as-csv`, `as-json`, `as-blob`, `as-zip`, `as-noydb` |

Every pillar is a category of peripheral — `@noy-db/hub` is the core.
`as-*` is the **egress** pillar: the only pillar whose output is an
artefact the vault no longer controls once it leaves. Plaintext
artefacts (`as-xlsx`, `as-csv`, …) cross the plaintext boundary;
encrypted artefacts (`as-noydb`) preserve zero-knowledge but still
represent an authorised extraction event. Both require an
authorization check on top of the keyring's read permission — the
tier determines the strength of the check, not its presence.

---

## The policy, clarified

Pilots sometimes ask: *"I want to let the user download an Excel report
of their invoices. noy-db says stores can't see plaintext. So do I need
a `to-xlsx` adapter? How does that work without breaking encryption?"*

Two ideas are colliding:

1. **Zero-knowledge live storage** (`to-*` adapters) — noy-db
   guarantees that every storage backend it syncs to sees only
   ciphertext envelopes, continuously. A hypothetical `to-xlsx`
   adapter that wrote cleartext spreadsheets would break this promise
   for every user of the library.
2. **Portable-artefact export** (`as-*` family) — an end user
   downloading an Excel file, an accountant emailing a CSV to a
   vendor, a vault owner handing off an encrypted `.noydb` archive
   to a colleague — legitimate one-shot operations that extract data
   *as a discrete artefact*, with an explicit authorization trail.

**The `to-*` taxonomy is for live encrypted storage. The `as-*`
taxonomy is for authorized artefact extraction** (plaintext or
encrypted). They are not interchangeable, and conflating them is how
you accidentally ship a library that looks zero-knowledge on paper but
leaks plaintext in practice.

## What SPEC.md promises

From `SPEC.md` §"What zero-knowledge does and does not promise":

> **Plaintext export packages.** The `@noy-db/as-*` family
> (`as-csv`, `as-xml`, `as-xlsx`, `as-json`, `as-sql`, ...) decrypts
> records and formats them as interchange-format bytes on the
> consumer's behalf. Unlike `plaintextTranslator` or schema
> validators, which a consumer can enable unilaterally in their own
> code, **every `as-*` invocation is gated by a hub-enforced
> authorization check**: an owner-granted capability bit on the
> invoking keyring plus (optionally) a just-in-time re-authentication
> requirement via `SessionPolicy.requireReAuthFor: 'export'`. A
> consumer who adds `@noy-db/as-xlsx` to `package.json` cannot
> actually export anything until the vault owner grants the
> capability.

The shift from `decrypt-*` (earlier naming) to `as-*` matters:
**safety is provided by enforcement, not by a warning in the
package name.** A keyring without the capability bit cannot export,
regardless of what packages are installed. That is a stronger
guarantee than "audit the dependency list during review."

## Authorization model

Every `as-*` invocation is gated by **three independent checks**, any
of which can veto the export. The second check — the *capability bit*
— differs between the two tiers; everything else is shared.

### 1. Keyring read permission (existing, both tiers)

The invoking keyring must already be able to read the collections
being exported. An `operator` with `rw` on `invoices` but no access
to `payments` can only export `invoices`. This is the same ACL that
governs `collection.get()` / `.list()` — nothing new.

### 2. Owner-granted export capability (new, RFC open — tier-specific)

A new capability on the keyring with **two bits**, one per tier:

| Bit | Default | Gates |
|-----|---------|-------|
| `canExportPlaintext` | **off** | Every plaintext-tier package — record formatters (`as-xlsx`, `as-csv`, `as-json`, `as-ndjson`, `as-xml`, `as-sql`, `as-pdf`) AND document extractors (`as-blob`, `as-zip`). Also core `vault.exportJSON()` / `exportStream()` and any future `vault.exportBlobs()` primitive. One gate covers both content shapes because both produce plaintext bytes that cross the library boundary. |
| `canExportBundle` | **on for owner/admin, off for operator/viewer** | `as-noydb` and any future encrypted-container export (e.g., a hypothetical `as-noydb-split` for Shamir-split archives). Also the existing `writeNoydbBundle()` / `saveBundle()` helpers once they route through the gate. |

Only `owner` or `admin` can grant or revoke either bit. The asymmetry
is deliberate:

- **Plaintext off by default** because a plaintext artefact is
  world-readable by anyone who finds the file on disk. The owner
  must positively turn on the capability for each keyring — no silent
  upgrades.
- **Bundle on for owner/admin by default** because an encrypted
  `.noydb` bundle is inert without the KEK. The owner producing a
  backup of their own vault is the happy path and doesn't need an
  additional opt-in. But for `operator` / `viewer` / `client` — who
  might export-then-attempt to share bundles as a social-engineering
  vector — it defaults off and requires an explicit grant.

**This is the load-bearing mechanism.** Installing `@noy-db/as-xlsx`
or `@noy-db/as-noydb` into `package.json` does not unlock anything —
the capability bit does. A compromised developer machine with every
`as-*` package installed but no granted bits produces no artefacts of
either tier.

**API shape (landed 2026-04-21 via RFC #249 foundation commit):**

```ts
import { hasExportCapability } from '@noy-db/hub'
import type { ExportCapability } from '@noy-db/hub'

// On the keyring — set at grant time, defaults to undefined:
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

Plaintext defaults to empty (no format) for every role; bundle
defaults to on for owner/admin, off for others. See
[`packages/hub/__tests__/export-capability.test.ts`](../../packages/hub/__tests__/export-capability.test.ts).

> **Remaining follow-up (not blocking as-\* packages):** vault-level
> gated wrappers `vault.exportRecords()` / `vault.exportBlobs()` /
> `vault.writeBundle()` that centralise the enforcement at the
> primitive level. Until those land, `as-*` packages call
> `hasExportCapability()` before invoking the underlying primitive —
> the helper IS the gate.

### 3. Optional just-in-time re-authentication (existing machinery, both tiers)

The hub's existing `SessionPolicy.requireReAuthFor: 'export'` flag
already forces the caller to present a fresh credential before
`'export'`-class operations. Vault owners who want stronger guarantees
configure this at `createNoydb()` time — the enforcer throws
`SessionPolicyError` and the consumer's UI prompts for a re-auth
before the export continues.

No new session machinery is needed — `'export'` is already one of the
valid `ReAuthOperation` values in `packages/hub/src/types.ts`. Both
tiers route through the same enforcer; the re-auth policy applies to
both equally (or neither, if the policy omits `'export'`).

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

## The encrypted tier (`as-noydb`)

Not every export is plaintext. The `.noydb` container format
(binary prefix + JSON header + compressed body, AES-GCM throughout —
see `SPEC.md` §"`.noydb` Container Format") is the canonical way to
ship a whole vault as a single file: a backup, a device migration, a
hand-off between offices.

**Why it belongs in `as-*`, not in `to-*`:**

- `to-*` is for **live encrypted storage** that noy-db writes to
  continuously under a `syncPolicy`. The backend is part of the
  vault's runtime surface.
- A `.noydb` bundle is a **one-shot artefact**. Once it's written, the
  vault doesn't know where it is, who holds it, or when it'll be
  decrypted. That is the same risk shape as `as-xlsx` — data left the
  vault's control — just with the plaintext dimension zeroed out.

**Why the capability bit defaults differ from the plaintext tier:**

- A backup is the happy path for the vault owner. Requiring a
  `canExportBundle` grant on every `owner` keyring would be friction
  without safety gain — the owner already holds the KEK.
- An `operator` who exports a bundle and hands it to someone outside
  the org hasn't leaked plaintext (the recipient needs the
  passphrase) but they *have* created a persistent copy outside the
  keyring's revocation scope. A `revoke()` on the operator's keyring
  won't reach into that bundle. Defaulting `canExportBundle` off for
  non-admin roles forces the owner to opt them in explicitly.

**Today's primitives** (to be re-exported from `@noy-db/as-noydb`):

- `writeNoydbBundle(vault, options)` in `@noy-db/hub` — core codec.
  Returns `Uint8Array`. No gate today; gate lands with #249.
- `saveBundle(path, vault)` / `loadBundle(path)` in `@noy-db/to-file` —
  thin Node convenience wrappers.
- `readNoydbBundleHeader(bytes)` in `@noy-db/hub` — peek at the header
  (handle, bodyBytes, bodySha256) without decrypting.

`@noy-db/as-noydb`, when it ships, re-exports these under the
`@noy-db/as-*` import path, wraps them in the authorization gate,
writes the audit-ledger entry, and adds browser-download / Node
file-write helpers parallel to the plaintext siblings. The core codec
stays in hub — the `as-noydb` package is the audited, gated surface.

## Multi-sheet, dictionary-expanded Excel (`as-xlsx`)

The canonical pilot request — "download an Excel file of invoices" —
is not just "dump records as rows". Real-world spreadsheet consumers
(accountants, auditors, clients) expect:

- **One sheet per collection** — `Invoices`, `Payments`, `Clients`,
  each a tab in the workbook. `exportStream()`'s collection-scoped
  chunk metadata maps naturally to sheets.
- **Dictionary labels resolved, not stable keys** — the `status`
  column renders `"Paid"` / `"ชำระแล้ว"` / `"مدفوع"` at the requested
  locale, not the stable key `"paid"`. This is the one place where
  the stable-key invariant named in
  [`i18n-boundaries.md`](./i18n-boundaries.md) is *deliberately
  violated*: records store keys, exports resolve labels. The
  invariant holds inside the library; the spreadsheet is the
  documented egress exception.
- **Reference fields expanded** — `clientId` becomes a second column
  `clientName` (resolved from the FK target) so the accountant
  reading row 47 isn't squinting at a ULID.
- **Schema-aware headers** — the Standard Schema validator attached
  to each collection (surfaced via `collection.schema()`) provides
  field types, so `as-xlsx` can set Excel cell formats (date, number,
  currency) without the consumer spelling it out.

The combination means `as-xlsx(vault)` produces a workbook a
non-technical user can open and understand immediately — the opposite
of a dumped JSON blob. The price is that `as-xlsx` is allowed to
touch more of the hub's surface (collection list, dictionaries,
schemas, references) than a pure formatter would — but still under
the single authorization gate above.

## Document / blob exports — when the data is already a file

noy-db is a **dual data + document store**: structured records live
in `Collection<T>`, binary attachments (PDFs, images, scans, emails,
audio) live in `BlobSet` (encrypted chunks, HMAC eTags, MIME-magic
detection, versioning). The pilot's accounting workflow has both —
invoices are records, scans are blobs, the two are linked.

Record formatters (`as-xlsx`, `as-csv`, `as-json`, …) handle only
the structured half. When the consumer wants **the scan itself**,
they reach for a document extractor:

| Package | Input | Output | Use case |
|---------|-------|--------|----------|
| `@noy-db/as-blob` | `(vault, collection, id, slot?)` | Single file in the blob's native MIME | "Download the PDF for invoice 01H…" — user clicks an attachment, gets the PDF |
| `@noy-db/as-zip` | `(vault, query \| ids, options)` | zip archive: `metadata.json` + per-record folder with blobs | "Download everything for these 50 invoices" — one-click archive for an auditor, a migration, an offline review |

Both sit in the **plaintext sub-family of records' tier** — same
`canExportPlaintext` gate, same audit-ledger entry type, same
default-off policy. The reason for one shared gate (instead of a
separate `canExportBlobs` bit) is that the plaintext boundary is the
same boundary either way: a decrypted PDF on disk is every bit as
egressed as a decrypted xlsx. Splitting the gate would give the
illusion of two separately-controlled risks when there is only one.

**Composite artefacts via `as-zip`.** The killer use case is the
composite entity pattern named in
[`docs/patterns/email-archive.md`](./email-archive.md) — an invoice
record + its PDF scan + any derivative documents. `as-zip` produces:

```
invoices-2026-03.zip
├── manifest.json                 # Index of what's in the archive
├── records.json                  # All invoice records as JSON
├── records.csv                   # Same, as csv for auditors who prefer spreadsheets
└── attachments/
    ├── 01H5.../raw.pdf           # Original scan
    ├── 01H5.../body-html.html    # (for email archive) rendered body
    ├── 01H5.../att-0-receipt.pdf # Additional attachment
    └── 01H8.../raw.pdf
```

The consumer chooses which formats to include via options; one audit
entry captures the full composite call regardless of how many files
come out.

**Why not `as-pdf` for this?** `as-pdf` is a *report generator* —
render structured data into a laid-out PDF document (heavy
dependency, complex layout engine). `as-blob` extracts the PDF that
was *already* attached; there's no rendering, just decryption +
MIME-typed emission. They don't conflict — a deployment might use
both: `as-pdf` for a monthly summary report, `as-blob` for individual
attached receipts.

**ACL scoping applies to blobs too.** `BlobSet` inherits the parent
collection's permissions. An `operator` without read access to
`payments` can't export `payments`'s records OR its attached blobs,
even with `canExportPlaintext` granted. The gate is layered on top of
read ACL, not instead of it.

## Risk classification — two axes

Every real-world noy-db deployment has at least one egress path.
Classify yours by **two independent dimensions**:

### Axis A — plaintext-tier risk (applies to every non-`as-noydb` tier)

| Tier | Pattern | Risk | Approach |
|------|---------|:-:|----------|
| **1 — Runtime-memory only** | Decrypt → use in-process → discard | Lowest | Default. No special package. Just `collection.get(id)`. |
| **2 — One-shot user download** | Decrypt → write to `Blob` / `Uint8Array` → browser download prompt, never hits your own disk | Low | `@noy-db/as-*` plaintext-tier package with `canExportPlaintext` granted. Plaintext lives in memory + the end-user's Downloads folder only. |
| **3 — Long-term plaintext storage** | Decrypt → write to a filesystem / shared drive / cloud bucket the consumer controls | **High** | Plaintext-tier package with capability + `acknowledgeRisks: true`. README warnings. Audit log entry. Consider: do you really need this? |

The pilot's `.xlsx` export for end-user download is **Tier 2** — low
risk. A scheduled cron job writing a plaintext `.xlsx` to a NFS share
is **Tier 3** — start asking whether the business need justifies the
egress.

### Axis B — encrypted-bundle risk (applies to `as-noydb`)

Bundles don't fit the plaintext-tier taxonomy — the bytes are
ciphertext, so Tier-3-like destinations (cloud buckets, shared
drives) are **legitimate** bundle destinations. The threat model is
different:

| Scenario | Risk | Approach |
|----------|:-:|----------|
| Owner makes a local backup of their own vault | Lowest | `as-noydb` default path. `canExportBundle` is on by default for owner. |
| Owner ships a bundle to a colleague, passphrase shared out-of-band | Low | Same path. Audit ledger captures the export. Recipient's re-opening is a separate session, unrelated to this vault. |
| Operator exports a bundle and hands it to an external party | **Medium** | `canExportBundle` must have been granted explicitly. The revocation of that operator's keyring does NOT reach into bundles already exported — plan accordingly. |
| Bundle stored alongside a passphrase hint, key file, or the passphrase itself | **Critical** | Whole threat model collapses. Treat passphrase and bundle as a single unit for key-management purposes; never store them in the same location. |

The bundle's encryption is only as strong as the location of the
passphrase. A `.noydb` on S3 next to a `.txt` containing the
passphrase is plaintext-equivalent.

> **The "Critical" row is threat-model advice, not library-enforced
> policy.** The library cannot detect that a passphrase is stored
> alongside a bundle on the same S3 bucket or in the same USB
> directory — that's a storage-discipline concern that code review,
> ops runbooks, and key-management policy catch, not a runtime check
> the library can perform. The other rows map to enforcement points:
> read ACL + `canExportBundle` cover the first three rows at call
> time; only the passphrase-colocation risk is outside the library's
> reach.

## What exists today vs what's planned

### Shared primitives

| Package | Status | Purpose |
|---------|:-:|---------|
| `exportJSON()` / `exportStream()` in `@noy-db/hub` | ✅ shipped | Core plaintext primitives. Every plaintext-tier `as-*` package builds on `exportStream()`. Will honour `canExportPlaintext` once #249 lands. |
| `writeNoydbBundle()` / `readNoydbBundle()` in `@noy-db/hub` | ✅ shipped (v0.6) | Core encrypted-bundle codec. `@noy-db/as-noydb` re-exports through the authorization gate once #249 lands. |
| `saveBundle()` / `loadBundle()` in `@noy-db/to-file` | ✅ shipped (v0.6) | Thin Node convenience wrappers. |
| Authorization model RFC (#249) | 📋 blocks non-core packages | Two capability bits (`canExportPlaintext`, `canExportBundle`), grant/revoke surface, audit entry shape. |

### Plaintext tier — gated by `canExportPlaintext` (default off)

**Record formatters** — serialise structured records:

| Package | Status | Purpose |
|---------|:-:|---------|
| `@noy-db/as-sql` (#107) | 📋 planned | SQL dump for migration into postgres/mysql/sqlite |
| `@noy-db/as-csv` (#247) | 📋 planned | CSV for spreadsheet import — simplest of the family |
| `@noy-db/as-xml` (#248) | 📋 planned | XML for legacy systems + accounting software |
| `@noy-db/as-xlsx` (#246) | 📋 planned | Multi-sheet, dictionary-expanded Excel for non-technical end users |
| `@noy-db/as-json` (#250) | 📋 planned | Structured JSON bundle — sibling to `exportJSON()`, adds audit + browser download helper |
| `@noy-db/as-ndjson` (#251) | 📋 planned | Newline-delimited JSON — streaming-friendly for large vaults |
| `@noy-db/as-pdf` | 💡 speculative | PDF reports from records — consumer-driven layout, heavy dep tree |

**Document / blob extractors** — emit blob bytes:

| Package | Status | Purpose |
|---------|:-:|---------|
| `@noy-db/as-blob` | 📋 planned | Single-blob export — pull one attachment out as native MIME bytes (PDF, JPEG, email `.eml`, …). Simplest of the document sub-family. |
| `@noy-db/as-zip` | 📋 planned | Composite archive — records + attached blobs in one zip, folder-per-record layout. The canonical "download this audit trail" primitive. |

### Encrypted tier — gated by `canExportBundle` (default on for owner/admin)

| Package | Status | Purpose |
|---------|:-:|---------|
| `@noy-db/as-noydb` | 📋 planned | Authorised wrapper around `writeNoydbBundle()`/`readNoydbBundle()`. Adds `canExportBundle` gate, audit-ledger entry, browser-download + Node file-write helpers. |

## The pattern for today (before the `as-*` family ships)

The pilot doesn't need to wait. The hub already exposes what's
needed, and the consumer application takes responsibility for the
authorization step until the capability bit ships:

```ts
// Pattern: use exportStream() or collection.list() to get plaintext
// records, then feed them into your XLSX library of choice.

import { utils, write } from 'xlsx'  // SheetJS — MIT-licensed, de-facto xlsx lib

async function downloadInvoicesXLSX(vault, filenameHint: string) {
  // Step 0 — application-level authorization gate (until canExportPlaintext
  // lands). Check your own app's permission layer before invoking.
  assertCanExport(currentUser)

  // Step 1 — decrypt into memory (ACL-scoped — only collections the
  // caller has read access to)
  const invoices = await vault.collection<Invoice>('invoices').list()

  // Step 2 — format as xlsx in memory (SheetJS handles the OOXML).
  // Resolve dictKey values to labels at the target locale — this is
  // the documented exception to the stable-key invariant (see
  // i18n-boundaries.md).
  const statusEntries = await vault.dictionary('status').list()
  const statusLabels = Object.fromEntries(
    statusEntries.map(e => [e.key, e.labels.en ?? e.key])
  )
  const sheet = utils.json_to_sheet(invoices.map(i => ({
    id: i.id,
    client: i.clientName,
    amount: i.amount,
    status: statusLabels[i.status] ?? i.status,
    issueDate: i.issueDate,
  })))
  const wb = utils.book_new()
  utils.book_append_sheet(wb, sheet, 'Invoices')
  const bytes = write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array

  // Step 3 — trigger browser download (Tier 2 — never hits your server)
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${filenameHint}.xlsx`
  a.click()
  URL.revokeObjectURL(url)
}
```

What this gets the pilot right now:

1. Plaintext lives in RAM + the end-user's Downloads folder only (Tier 2).
2. Dictionary labels resolved at export time — accountant sees `Paid`,
   not `paid`.
3. Authorization gate is the pilot's responsibility today (step 0);
   when `canExportPlaintext` lands, hub enforces it automatically.
4. Zero bytes ever touch the noy-db `to-*` adapter layer as plaintext —
   the library's guarantee is intact.

When `@noy-db/as-xlsx` ships, it replaces steps 1–3 with a one-liner,
adds the audit-ledger entry automatically, and checks the capability
bit before doing anything.

## Anti-patterns — what to NOT do

### ❌ `@noy-db/to-xlsx` — don't build this

A `to-*` adapter implies "noy-db writes to this backend and syncs with
it." An xlsx file doesn't fit — it's not a key-value store, it's a
publishable artefact. If you tried:

- Either the adapter would encrypt before writing → produces an
  unreadable xlsx (no one's ship-goal).
- Or the adapter would write plaintext → violates zero-knowledge for
  every user of the library.

There is no third path. Don't build `to-xlsx`. Build `as-xlsx` (with
the authorization gate) instead.

### ❌ Bypassing the authorization gate inside a custom `as-*` clone

Every `as-*` package MUST call `vault.exportStream()` (or a lower-level
primitive that routes through the same enforcer). A formatter that
reaches into `collection.list()` directly and serialises from there
skips the capability check. Don't ship that — code review should
reject it on sight once the enforcer is in place.

### ❌ Long-term plaintext storage without `acknowledgeRisks`

Exports that land on a shared drive, a Google Drive folder, a
WebDAV path, or any location the consumer doesn't tightly control
should require the consumer to explicitly opt in. The `as-*`
packages will surface this via an `acknowledgeRisks: true` option —
until then, the consumer's application code should make the egress
visible to their own code reviewers.

### ❌ Using `exportJSON()` / `exportStream()` without thinking about retention

These work. They produce plaintext. If you write the result to a file
and leave it there for three years, you've accidentally opted into
Tier 3. Write → use → delete (or keep inside an ephemeral Blob URL).

## Decision tree — picking the right tool

```
What bytes leave the vault?
│
├─ PLAINTEXT — records and/or blobs crossing the plaintext boundary
│   │  (one gate — canExportPlaintext — covers everything below)
│   │
│   ├─ Runtime-memory only → collection.get() / blob.get(). Nothing else.
│   │
│   ├─ Structured record formatters (xlsx / csv / json / xml / sql / …)
│   │    → as-xlsx / as-csv / as-json / as-xml / as-sql / as-ndjson
│   │      One-shot end-user download: Tier 2 (low risk).
│   │      Long-term on-disk: Tier 3 + acknowledgeRisks: true.
│   │
│   ├─ Document extraction (a single attached PDF / image / email)
│   │    → as-blob — native MIME bytes, one file out.
│   │
│   └─ Composite archive (records + their attached documents)
│        → as-zip — manifest.json + per-record folders with blobs.
│          The canonical "download this audit trail" primitive.
│
└─ CIPHERTEXT — the whole vault as a portable archive
    │  (separate gate — canExportBundle — with softer defaults)
    │
    ├─ Owner backup / device migration / hand-off to colleague
    │    → as-noydb. canExportBundle is on by default for owner/admin.
    │
    └─ Operator / non-admin role producing a bundle for an external party
         → as-noydb, BUT owner must have granted canExportBundle.
           Bundle outlives keyring revocation — think twice.
```

## The ACL-scoping guarantee

One nuance worth naming: `exportStream()` and `exportJSON()` (and,
when they ship, every `as-*` package) are **ACL-scoped** on top of
the capability gate. An `operator` role that has `rw` on the
`invoices` collection but no access to `payments` can only export
the invoices they can see — *and only if the owner has granted the
export capability.* Owners and viewers with `*: ro` can export
everything they can read. Clients with single-collection access can
only export that one collection.

The zero-knowledge boundary is preserved along three axes:
- **Vertically** — stores never see plaintext.
- **Horizontally** — role restrictions translate cleanly to export
  scope.
- **Authorization** — the capability bit gates whether plaintext
  egress is allowed at all, independently of the read ACL.

## The audit-ledger integration

When the `@noy-db/as-*` packages ship, every call writes an entry to
the hash-chained ledger (`@noy-db/hub/history`) with a single shared
`type: 'as-export'` and an `encrypted: true|false` discriminator so
consumers can filter either tier:

```
// Plaintext-tier example
LedgerEntry {
  type: 'as-export',
  encrypted: false,
  package: '@noy-db/as-xlsx',
  collection: 'invoices',
  recordCount: 143,
  actor: 'somchai@firm.example',
  field: null,
  mechanism: 'xlsx',
  grantedBy: 'owner@firm.example',   // who turned on canExportPlaintext
  reauthFresh: true,                  // if requireReAuthFor:'export' was set
  timestamp: '2026-04-23T10:45:00Z',
}

// Encrypted-tier example
LedgerEntry {
  type: 'as-export',
  encrypted: true,
  package: '@noy-db/as-noydb',
  collection: null,                   // whole-vault bundle
  recordCount: 1842,                  // total records sealed into the bundle
  actor: 'owner@firm.example',
  mechanism: 'noydb-bundle',
  bundleHandle: '01HMQ…',              // ULID from readNoydbBundleHeader()
  bundleBytes: 2_483_901,
  grantedBy: null,                    // default-on for owner; no grant needed
  reauthFresh: true,
  timestamp: '2026-04-23T10:45:00Z',
}
```

**No record contents, no content hashes, no field values — for either
tier.** The ledger records that an `as-*` export happened, by whom,
with what authorization, at what time, against which collection (or
the whole vault, for bundles) — never what was exported. This mirrors
the `plaintextTranslator` audit discipline (SPEC.md: *"deliberately
do not record plaintext content or plaintext content hashes"*). The
encrypted tier records the bundle's public header fields (ULID
handle, byte count) because those are already unencrypted in the
`.noydb` format's 10-byte prefix and JSON header — no new information
leaks.

For the pilot's current (pre-package) pattern, the audit entry is the
consumer's responsibility. When `@noy-db/as-*` ships, it becomes
automatic.

## Anti-pattern — don't decompose the `.noydb` format

A subtle footgun: once someone holds a decrypted vault in RAM (via
`readNoydbBundle()` + the passphrase), it's tempting to write a
debug dump of the contents alongside the bundle for convenience.
*Don't.* That debug dump is a plaintext-tier artefact; it belongs
in a plaintext `as-*` export path with the `canExportPlaintext`
gate. The bundle's zero-knowledge property does not transfer to
derived plaintext files sitting next to it.

If you need both — a bundle and an xlsx, say — produce them as two
separate audited `as-*` calls. The ledger captures both; review can
spot when plaintext followed a bundle to the same destination.

## Cross-references

- **[`SPEC.md`](../../SPEC.md)** §"What zero-knowledge does and does
  not promise" — authoritative policy definition; the `as-*`
  two-tier authorization gate is a first-class mechanism there.
- **[`SPEC.md`](../../SPEC.md)** §"`.noydb` Container Format" — byte
  layout of the encrypted bundle (10-byte prefix, JSON header,
  compressed body) that `as-noydb` wraps under the gate.
- **[`docs/patterns/i18n-boundaries.md`](./i18n-boundaries.md)** —
  the stable-key invariant; `as-xlsx`'s dictionary-label expansion is
  the documented render-time exception.
- **[`ROADMAP.md`](../../ROADMAP.md)** §"Fork · As" —
  canonical description of the family + the authorization-model RFC.
- **[`docs/patterns/email-archive.md`](./email-archive.md)** —
  composite-entity pattern (one record + N blobs) that `as-zip`
  materialises into a downloadable archive.
- **Issues**: #107 `as-sql`, #246 `as-xlsx`, #247 `as-csv`,
  #248 `as-xml`, #250 `as-json`, #251 `as-ndjson`, #252 `as-noydb`,
  plus new issues filed for `as-blob` and `as-zip` (document
  sub-family) under Fork · As, and the core authorization-model
  RFC #249.

---

*Pattern doc last updated: 2026-04-23 (auth-model rewrite).*
