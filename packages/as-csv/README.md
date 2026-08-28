# @noy-db/as-csv

CSV plaintext export for noy-db — decrypts records from a single collection and formats them as comma-separated values with RFC 4180 escaping. Part of the `@noy-db/as-*` portable-artefact family (plaintext tier).

The **reference implementation** of the plaintext-tier shape — every other record formatter in the family (`as-json`, `as-xml`, `as-sql`, …) follows the same 3-entry-point + authorization-gate structure.

## Install

```bash
pnpm add @noy-db/as-csv
```

## Authorization (RFC #249)

Every call checks `vault.assertCanExport('plaintext', 'csv')` **before decrypting anything**. The caller's keyring must have been granted the `'csv'` format (or `'*'` wildcard) via `vault.grant({ exportCapability: { plaintext: ['csv'] } })`. Otherwise → `ExportCapabilityError`.

**Default policy:** every role (including `owner`) requires explicit plaintext grant. Installing this package does not unlock anything; the owner's grant does. See [`docs/packages-exports.md#authorization-model`](../../docs/packages-exports.md#authorization-model) for the full policy.

## Usage

### `toString(vault, options)` — returns CSV string

```ts
import { asCsv } from '@noy-db/as-csv'

const csv = await vault.export(asCsv(), { collections: ['invoices'] })
// id,client,amount,status\n
// inv-1,Globex,1500,paid\n
// inv-2,"Acme, Inc.",2400,draft\n
// inv-3,"Stark ""Industries""",999,overdue
```

### `download(vault, options)` — browser download (Tier 2)

```ts
import { download } from '@noy-db/as-csv'

await download(vault, {
  collections: ['invoices'],
  filename: 'invoices-2026-03.csv',  // optional; defaults to '<collection>.csv'
})
```

Wraps the CSV in a `Blob`, creates an object URL, clicks a hidden anchor. Plaintext lives in RAM + the end-user's Downloads folder only. Does not write to your server.

### `write(vault, path, options)` — Node file-write (Tier 3)

```ts
import { write } from '@noy-db/as-csv'

await write(vault, '/tmp/invoices.csv', {
  collections: ['invoices'],
  acknowledgeRisks: true,   // required — see below
})
```

`acknowledgeRisks: true` is **required** at runtime (in addition to being a type requirement). This signals the consumer has considered that the CSV will persist on disk past the current process — consider retention, access control, and secondary-exposure risk before using.

### Options

```ts
interface AsCSVOptions {
  collection: string            // required
  columns?: readonly string[]   // optional — default: infer from record keys
  eol?: '\n' | '\r\n'          // optional — default: '\n' (LF)
}
```

## RFC 4180 escaping

- Strings containing `,` `"` `\r` or `\n` are wrapped in double quotes.
- Embedded double quotes are doubled: `She said "hi"` → `"She said ""hi"""`.
- `null` / `undefined` → empty field.
- `number` / `boolean` → stringified.
- `Date` → ISO 8601 string.
- Objects / arrays → `JSON.stringify()` (then escaped if needed).

Dates render as ISO strings rather than locale-formatted — spreadsheet consumers can re-parse if needed. For locale-formatted dates with Thai BE calendar, pipe through `@noy-db/locale-th` before exporting.

## Audit

This package does NOT write an audit-ledger entry yet — that lands with the full vault-level gated wrappers in a #249 follow-up. For now, applications using `@noy-db/as-csv` should write their own `type: 'as-export'` ledger entry after each call:

```ts
await vault.collection<AsExportEntry>('_ledger_custom').put(ulid(), {
  type: 'as-export',
  encrypted: false,
  package: '@noy-db/as-csv',
  collection: options.collection,
  recordCount: records.length,
  actor: currentUserId,
  timestamp: new Date().toISOString(),
})
```

## Related packages

- `@noy-db/as-json` — structured JSON, schema-aware
- `@noy-db/as-ndjson` — newline-delimited JSON, streaming-friendly
- `@noy-db/as-xml` — XML for legacy systems
- `@noy-db/as-xlsx` — multi-sheet Excel with dictionary-label expansion
- `@noy-db/as-sql` — SQL dump for migration
- `@noy-db/as-blob` — single-attachment extraction (binary, not structured data)
- `@noy-db/as-zip` — composite records + attached blobs
- `@noy-db/as-noydb` — encrypted-tier whole-vault bundle

All share the same authorization model; see [`docs/packages-exports.md#authorization-model`](../../docs/packages-exports.md#authorization-model).

## License

MIT
