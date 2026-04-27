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

- `writeNoydbBundle(vault, options?)` → `Uint8Array`
- `readNoydbBundle(bytes)` → restored `VaultBackup`
- `readNoydbBundleHeader(bytes)` → header only (cheap)
- `vault.getBundleHandle()` — ULID handle persisted in `_meta/handle`
- `vault.buildBundleRecipientKeyrings(recipients)` — produce per-recipient `KeyringFile` records without touching the source adapter (used by the re-keying path; #301)

### `WriteNoydbBundleOptions`

```ts
interface WriteNoydbBundleOptions {
  // Compression (always supported)
  compression?: 'auto' | 'brotli' | 'gzip' | 'none'

  // Slice — what records go in (#301)
  collections?: readonly string[]    // allowlist of user-collection names
  since?: Date | string              // drop records with envelope `_ts` older

  // Re-keying — who can decrypt (#301; mutually exclusive)
  exportPassphrase?: string          // single-recipient shorthand
  recipients?: readonly BundleRecipient[]
}

interface BundleRecipient {
  id: string
  displayName?: string
  passphrase: string
  role?: Role                        // default 'viewer'
  permissions?: Permissions          // role default applies otherwise
  exportCapability?: ExportCapability
}
```

### Re-keying pipeline

1. `vault.dump()` produces the canonical backup JSON (records + source keyring + ledger).
2. When `recipients` (or `exportPassphrase` shorthand) is set, the source keyring is **replaced** with one freshly-derived `KeyringFile` per recipient. Each recipient's KEK is derived from their passphrase + a fresh salt via PBKDF2-SHA256 (600K iterations); DEKs are unwrapped from the source keyring once and re-wrapped under each recipient's KEK with AES-KW.
3. Slice filters apply over the result.
4. The pruned + re-keyed JSON is compressed and wrapped in the standard bundle envelope.

Record ciphertext is **never** rewritten — re-keying touches only the small DEK blobs (32 bytes each), so re-keying a multi-GB bundle is milliseconds. The privilege-escalation guard from `grant()` is reused: every DEK wrapped into a recipient's slot must come from the source's own DEK set.

### Recipient list = portable keyring

The `recipients` array, after re-keying, materialises as `Record<userId, KeyringFile>` inside the bundle's `keyrings` field — structurally identical to the live-vault multi-user keyring shape. Adding a new recipient family in the future is a schema field on `KeyringFile`, not a new format primitive.

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
