# `@noy-db/as-*` — Portable-artefact exports

> **How data leaves the vault.** Each `as-*` package takes a Vault and
> produces a portable artefact — spreadsheet, PDF, JSON dump, encrypted
> bundle, SQL migration script. Two authorisation tiers gate them.

The `as-` prefix reads as *"export **as** XLSX / JSON / NoyDB."* This is
the one family where **policy matters more than mechanics** — crossing
the plaintext boundary is the most sensitive operation in the whole
library, so every formatter runs through a two-tier capability check
(RFC [#249](../spec/archive/issue-249.md)) and writes an audit-ledger
entry.

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
| [`@noy-db/as-noydb`](../../packages/as-noydb) | **The only encrypted tier.** Wraps `writeNoydbBundle()` — ciphertext in, ciphertext out. No plaintext crosses the boundary. `peek()` reads the header without decrypting the body, for due-diligence on received bundles. |
| [`@noy-db/as-zip`](../../packages/as-zip) | **Composite archive.** Records + attachments together as one `.zip` — useful for "hand my accountant the quarter's data" workflows. |
| [`@noy-db/as-sql`](../../packages/as-sql) | **Dialect-aware migration dump.** Postgres / MySQL / SQLite flavours. `schema+data`, `schema-only`, or `data-only` modes. Drop straight into `psql -f` / `mysql <` / `sqlite3 <`. |
| [`@noy-db/as-xml`](../../packages/as-xml) | **Hand-rolled emitter** (no `xml-js` dep). Legacy accounting software, banking batch imports, SpreadsheetML. Optional namespaces, custom element names. |

---

## The essentials

| Package | When to use |
|---|---|
| [`@noy-db/as-csv`](../../packages/as-csv) | RFC 4180 CSV per collection. Direct Excel / Google Sheets import. |
| [`@noy-db/as-xlsx`](../../packages/as-xlsx) | Native Excel with dictionary-label expansion + ACL-scoped rows. |
| [`@noy-db/as-json`](../../packages/as-json) | Structured JSON grouped by collection. `pretty: true/false`, `includeMeta: true/false`. |
| [`@noy-db/as-ndjson`](../../packages/as-ndjson) | Newline-delimited JSON for streaming + `jq` pipelines. O(1 record) memory via `pipe()`. |
| [`@noy-db/as-blob`](../../packages/as-blob) | Single attachment extraction — "give me this PDF, not the whole vault." |

---

## Full catalog (9 packages)

**Plaintext tier** (gated by `canExportPlaintext`, default off)

- [`as-csv`](../../packages/as-csv) · RFC 4180 CSV
- [`as-xlsx`](../../packages/as-xlsx) · Excel with dict-label expansion
- [`as-json`](../../packages/as-json) · structured JSON
- [`as-ndjson`](../../packages/as-ndjson) · newline-delimited JSON (streaming)
- [`as-xml`](../../packages/as-xml) · XML for legacy / accounting software
- [`as-sql`](../../packages/as-sql) · SQL dump (postgres / mysql / sqlite)
- [`as-blob`](../../packages/as-blob) · single-attachment extraction
- [`as-zip`](../../packages/as-zip) · records + attachments in one archive

**Encrypted tier** (gated by `canExportBundle`, default on for owner/admin)

- [`as-noydb`](../../packages/as-noydb) · `.noydb` encrypted bundle export

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

See [`docs/patterns/as-exports.md`](../patterns/as-exports.md) for the
full three-tier risk model.

[← Back to README](../../README.md)
