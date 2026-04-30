# blobs

> **Subpath:** `@noy-db/hub/blobs`
> **Factory:** `withBlobs()`
> **Cluster:** C — Data Shape
> **LOC cost:** ~2,376 (off-bundle when not opted in)

## What it does

Binary attachments (PDFs, images, audio) attached to records as content-addressed slots. Encrypted in chunks (default 256 KB) with AES-GCM and AAD-bound chunk metadata to prevent reorder/substitution. MIME sniffing from magic bytes when not provided. Optional gzip compression for non-pre-compressed types. Compaction job for retention/TTL.

## When you need it

- Records with attached files (invoices + receipts, profiles + avatars, notes + audio memos)
- Multi-attachment-per-record flows (`invoice.blob('inv-001').put('receipt', ...)` and `.put('contract', ...)`)
- Content dedup (two records pointing at the same bytes share storage)
- Streaming uploads / downloads via `Response`-like surface

## Opt-in

```ts
import { createNoydb } from '@noy-db/hub'
import { withBlobs } from '@noy-db/hub/blobs'

const db = await createNoydb({
  store: ...,
  user: ...,
  blobStrategy: withBlobs(),
})
```

## API

```ts
const slot = invoices.blob('inv-001')
await slot.put('receipt', new Uint8Array(/* PDF bytes */), {
  mimeType: 'application/pdf',
})
const bytes: Uint8Array | null = await slot.get('receipt')
const slots = await slot.list()
await slot.delete('receipt')

// Streaming download (Response-shaped)
const response = await slot.response('receipt', { inline: true })

// Browser ObjectURL — decrypts and wraps in a revocable URL
const built = await slot.objectURL('receipt')          // { url, revoke } | null
img.src = built!.url
// caller owns revoke(); the in-vue useBlobURL composable handles
// auto-revoke on reactive id change + scope dispose.
```

Compaction: `vault.compact()` enforces per-collection `blobFields` retention/TTL.

## Bulk export

`vault.exportBlobs(opts?)` (always-on) is a framework-agnostic async iterable yielding `{ blobId, recordRef, bytes, meta }` — pipe it into a zip stream, S3 multipart, or whatever sink you need. `meta.filename` carries the user-visible slot filename.

For real-FS materialization, `@noy-db/to-file` ships `exportBlobsToDirectory(vault, targetDir, opts)` that wraps the iterable with target-profile filename sanitization, Zip-Slip path containment, and collision policy:

```ts
import { exportBlobsToDirectory } from '@noy-db/to-file'

await exportBlobsToDirectory(vault, './out', {
  filenameProfile: 'macos-smb',     // most restrictive default
  onCollision: 'suffix',            // 'overwrite' | 'fail' | callback
})

// Opaque profile renames to ${blobId}.${ext} and writes manifest.json
// mapping opaque names → originals (for handoff to untrusted recipients)
await exportBlobsToDirectory(vault, './out', { filenameProfile: 'opaque' })
```

The standalone sanitizer is exported from `@noy-db/hub/util` for adopters who write their own sinks:

```ts
import { sanitizeFilename } from '@noy-db/hub/util'

const safe = sanitizeFilename(originalName, { profile: 'windows', maxBytes: 240 })
```

Profiles: `posix` · `windows` · `macos-smb` · `zip` · `url-path` · `s3-key` · `opaque`. Always-on transforms apply across all profiles: NFC normalize, bidi-override strip (defeats `‮.exe.txt` spoofing), NUL reject (hard fail — silent strip enables truncation bypass), trim leading/trailing whitespace + control chars.

## Behavior when NOT opted in

- `collection.blob(id)` throws with a pointer to `@noy-db/hub/blobs`
- All blob storage stays out of the bundle — saves ~2,376 LOC

## Pairs well with

- **bundle** — `.noydb` containers carry blobs alongside records
- **history** — blob slot writes append to the ledger; the slot metadata is itself a versioned record
- **routing** — route blob storage to a separate backend (S3 / R2) while metadata stays on the primary

## Edge cases & limits

- Default chunk size is 256 KB. Override per-put via `chunkSize`. Stores can advertise `maxBlobBytes` to cap inputs
- Compression auto-disables for already-compressed MIME types (image/jpeg, image/png, application/zip, ...)
- Blob versions are content-addressed by hash; mutating a slot is "publish a new version"
- AAD = `${eTag}:${index}:${count}` binds chunks to their slot/version, defeating chunk-level tampering

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- `docs/recipes/accounting-app.md`
- `__tests__/blob-set.test.ts`, `showcases/src/05-blob-lifecycle.showcase.test.ts`
