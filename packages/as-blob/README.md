# @noy-db/as-blob

Single-attachment plaintext export for noy-db. Pulls one blob out of
a record's `BlobSet` as its native MIME bytes — PDF, JPEG, `.eml`,
anything you stored via `collection.blob(id).put(slot, bytes, …)`.

Part of the `@noy-db/as-*` portable-artefact family, plaintext tier,
document sub-family. See [`docs/packages-exports.md#authorization-model`](https://github.com/vLannaAi/noy-db/blob/main/docs/packages-exports.md#authorization-model)
for the four-tier model and authorisation matrix.

## Install

```bash
pnpm add @noy-db/as-blob
```

Requires `@noy-db/hub` as a peer.

## Authorisation (RFC #249)

Every call is gated by the invoking keyring's
`canExportPlaintext` capability with format `'blob'`. Decrypted
bytes crossing the plaintext boundary require an explicit grant
from the vault owner. By default **no role** has the capability —
the owner grants it per-format:

```ts
await db.grant('firm', {
  userId: 'accountant',
  displayName: 'Somchai',
  role: 'operator',
  passphrase: '…',
  permissions: { invoices: 'ro' },
  exportCapability: { plaintext: ['blob', 'pdf'] }, // or ['*']
})
```

Absent the grant, every entry point throws
`ExportCapabilityError` from `@noy-db/hub`.

## API

### `toBytes(vault, options)` — raw bytes + metadata

```ts
import { toBytes } from '@noy-db/as-blob'

const { bytes, mime, filename } = await toBytes(vault, {
  collection: 'invoices',
  id: '01HXX...',
  slot: 'raw', // optional, defaults to 'raw'
})
// bytes: Uint8Array — decrypted PDF/PNG/whatever
// mime:  'application/pdf'
// filename: 'scan-001.pdf' (from the stored SlotRecord)
```

The caller decides where the bytes go — `fetch` upload, IndexedDB
cache, custom sink. Pure operation beyond the authorisation check
and a single slot-metadata lookup.

### `download(vault, options)` — browser

```ts
import { download } from '@noy-db/as-blob'

await download(vault, {
  collection: 'invoices',
  id: '01HXX...',
  filename: 'invoice-01HXX.pdf', // optional override
})
```

Wraps `toBytes()` in a `Blob` and triggers the browser's download
prompt. Requires `URL.createObjectURL` + `document.createElement` —
happy-dom or jsdom work for tests; headless Node doesn't.

### `write(vault, path, options)` — Node file

```ts
import { write } from '@noy-db/as-blob'

await write(vault, '/tmp/invoice.pdf', {
  collection: 'invoices',
  id: '01HXX...',
  acknowledgeRisks: true, // required
})
```

Persists the blob to disk. Requires `acknowledgeRisks: true`
because the plaintext file outlives the current process (Tier 3
egress per the pattern doc). The capability check still runs even
when acknowledged — acknowledgement scales the visibility of the
output, not the permission to produce it.

## Error shapes

| Error | When |
|-------|------|
| `ExportCapabilityError` (`@noy-db/hub`) | Caller lacks `plaintext:['blob']` grant |
| `AsBlobNotFoundError` (this package) | Record or slot not present / not visible via ACL |
| `Error` | `write()` called without `acknowledgeRisks: true` |

## Related

- `@noy-db/as-csv` / `@noy-db/as-xlsx` / `@noy-db/as-json` — record formatters
- `@noy-db/as-zip` — composite archive (records + blobs)
- `@noy-db/as-noydb` — encrypted bundle (bundle tier, not plaintext)
