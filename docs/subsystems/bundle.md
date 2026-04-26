# bundle

> **Subpath:** `@noy-db/hub/bundle`
> **Factory:** none — direct named imports
> **Cluster:** E — Snapshot & Portability
> **LOC cost:** ~846 (off-bundle when not opted in)

## What it does

The `.noydb` container format — a binary wrapper around a vault dump that's safe to drop on cloud storage. 10-byte fixed prefix (`NDB1` magic + flags + compression + header length) + JSON header (minimum-disclosure: format version, ULID handle, body bytes, body sha256) + compressed body (brotli with gzip fallback). ULID handles persist across reads.

## When you need it

- Backups to S3 / R2 / Google Drive / Dropbox where the consumer wants a single file per vault
- Offline transfer (USB, encrypted email) of a complete vault snapshot
- Bundle-as-store via `@noy-db/to-file` (`saveBundle` / `loadBundle`)

## Opt-in

This subsystem doesn't use the strategy pattern — it tree-shakes naturally via direct named imports:

```ts
import { writeNoydbBundle, readNoydbBundle, readNoydbBundleHeader } from '@noy-db/hub/bundle'

const bytes = await writeNoydbBundle(vault)
// ... save bytes anywhere ...

const restored = await readNoydbBundle(bytes)
const meta = await readNoydbBundleHeader(bytes) // header only, no body decompression
```

For file-system convenience helpers see `@noy-db/to-file`:

```ts
import { saveBundle, loadBundle } from '@noy-db/to-file'

await saveBundle('/path/to/vault.noydb', vault)
const restored = await loadBundle('/path/to/vault.noydb')
```

## API

- `writeNoydbBundle(vault)` → `Uint8Array`
- `readNoydbBundle(bytes)` → restored `VaultBackup`
- `readNoydbBundleHeader(bytes)` → header only (cheap)
- `vault.getBundleHandle()` — ULID handle persisted in `_meta/handle`

## Behavior when NOT opted in

- Not importing the symbols means they're not in the bundle — there's nothing to gate

## Pairs well with

- **blobs** — bundles carry attached binaries inline
- **history** — the ledger head is embedded in the header; readers can verify post-restore

## Edge cases & limits

- Brotli compression requires `CompressionStream` (Node 18+, all modern browsers); falls back to gzip if unavailable
- Handle is content-addressed at the *vault* level; two backups of the same vault share a handle
- Header rejects unknown keys at parse time — minimum-disclosure invariant

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- `__tests__/bundle.test.ts`, `showcases/src/16-email-archive.showcase.test.ts`
