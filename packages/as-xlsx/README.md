# @noy-db/as-xlsx

Excel spreadsheet plaintext export for noy-db. Produces a real
`.xlsx` (Office Open XML) that opens natively in Excel, Numbers,
LibreOffice Calc, and Google Sheets.

Zero runtime dependencies — the XLSX encoder ships SpreadsheetML
parts and reuses `@noy-db/as-zip`'s zip writer. No SheetJS, no
ExcelJS, no xlsx-populate — ~230 LOC across the two-file encoder.

Part of the `@noy-db/as-*` portable-artefact family, plaintext
tier. See [`docs/patterns/as-exports.md`](https://github.com/vLannaAi/noy-db/blob/main/docs/patterns/as-exports.md).

## Install

```bash
pnpm add @noy-db/as-xlsx @noy-db/as-zip @noy-db/hub
```

`@noy-db/as-zip` + `@noy-db/hub` are peer deps.

## Authorisation (RFC #249)

```ts
await db.grant('firm', {
  userId: 'accountant',
  role: 'viewer',
  passphrase: '…',
  exportCapability: { plaintext: ['xlsx'] }, // or ['*']
})
```

Every entry point calls `assertCanExport('plaintext', 'xlsx')`.
Absent the grant → `ExportCapabilityError`.

## API

### `toBytes(vault, options)` — raw xlsx bytes

```ts
import { toBytes } from '@noy-db/as-xlsx'

const bytes = await toBytes(vault, {
  sheets: [
    {
      name: 'Invoices',
      collection: 'invoices',
      columns: ['id', 'client', 'amount', 'status', 'issueDate'],
      filter: (r) => r.status !== 'draft',
    },
    { name: 'Payments', collection: 'payments' },
  ],
})
// Uint8Array → fs.writeFile, Blob upload, S3 PutObject, …
```

### `download(vault, options)` — browser

```ts
import { download } from '@noy-db/as-xlsx'

await download(vault, {
  sheets: [{ name: 'Invoices', collection: 'invoices' }],
  filename: 'invoices-2026-03.xlsx',
})
```

### `write(vault, path, options)` — Node file

```ts
import { write } from '@noy-db/as-xlsx'

await write(vault, '/tmp/invoices.xlsx', {
  sheets: [{ name: 'Invoices', collection: 'invoices' }],
  acknowledgeRisks: true,
})
```

### Shorthand — one collection, one sheet

```ts
import { toBytesFromCollection } from '@noy-db/as-xlsx'

const bytes = await toBytesFromCollection(vault, 'invoices')
```

## Type coercion

| JS type | Cell type in xlsx |
|---------|-------------------|
| `number` (finite) | numeric |
| `boolean` | boolean (`t="b"`) |
| `string` | shared-string (`t="s"`, Unicode-safe) |
| `Date` | ISO-8601 string |
| `null` / `undefined` / `''` | empty cell |
| `object` / `Array` | `JSON.stringify` via shared-string |

Dates are stored as ISO strings rather than Excel's serial-day
encoding — the receiving spreadsheet sees text. Cell-format styles
are out of scope for this minimal writer; format via Excel's
built-in date detection or paste-special at open time.

## Unicode

Strings route through the shared-strings table (`xl/sharedStrings.xml`)
rather than being inlined on cells. Required for Excel to correctly
handle non-ASCII text (Thai, Arabic, Chinese, emoji). Tested with
Thai + Arabic + English round-trip.

## Low-level encoder

Exposed for consumers who want to build workbooks from non-noy-db
sources:

```ts
import { writeXlsx, type XlsxSheet } from '@noy-db/as-xlsx'

const bytes = writeXlsx([
  {
    name: 'Results',
    header: ['Name', 'Score'],
    rows: [['Alice', 42], ['Bob', 37]],
  },
])
```

## Not supported

Pure data export — styles, formulas, merged cells, frozen panes,
auto-filter, charts, images, drawings are all out of scope. Need
rich formatting? Use SheetJS / ExcelJS for authoring, and let
consumers of the exported xlsx apply their own formatting.

## Related

- `@noy-db/as-csv` — flat CSV (simpler format, no multi-sheet)
- `@noy-db/as-zip` — composite archive (records + blobs)
- `@noy-db/as-blob` — single attachment
