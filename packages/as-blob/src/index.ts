/**
 * **@noy-db/as-blob** — single-attachment plaintext export for noy-db.
 *
 * Extracts one blob from a record's `BlobSet` as its native MIME
 * bytes. Part of the `@noy-db/as-*` portable-artefact family —
 * plaintext tier, document sub-family. Handles the "download this
 * PDF" / "export this scan" primitive that a record-formatter
 * (`as-csv`, `as-xlsx`) can't cover — structured data vs binary
 * bytes are different shapes with the same egress gate.
 *
 * **Authorization.** Every call is gated by the invoking keyring's
 * `canExportPlaintext` capability with format `'blob'` (RFC #249).
 * Decrypted bytes crossing the plaintext boundary require an
 * explicit grant from the vault owner; the package calls
 * `vault.assertCanExport('plaintext', 'blob')` before loading any
 * chunks from the store.
 *
 * **Scope.** One blob per call. Multi-record / multi-blob archive →
 * use `@noy-db/as-zip`.
 *
 * See [`docs/patterns/as-exports.md`](https://github.com/vLannaAi/noy-db/blob/main/docs/patterns/as-exports.md).
 *
 * @packageDocumentation
 */

import type { Vault } from '@noy-db/hub'

/** Inputs shared by every `as-blob` entry point. */
export interface AsBlobOptions {
  /** Collection the record lives in. Must be in the caller's read ACL. */
  readonly collection: string
  /** Record id. */
  readonly id: string
  /**
   * Slot name within the record's `BlobSet`. Defaults to `'raw'` —
   * the convention used by scan/attachment workflows where each
   * record has a single primary blob.
   */
  readonly slot?: string
}

/** Options for `download()` — adds an optional filename override. */
export interface AsBlobDownloadOptions extends AsBlobOptions {
  /**
   * Filename offered to the browser download prompt. When omitted,
   * falls back to the `SlotRecord.filename` stored at upload time,
   * then to `<slotName>.bin`.
   */
  readonly filename?: string
}

/** Options for `write()` — requires explicit risk acknowledgement. */
export interface AsBlobWriteOptions extends AsBlobOptions {
  /**
   * Required for Node file-write calls — consumer acknowledgement
   * that plaintext bytes will persist on disk past the current
   * process lifetime (Tier 3 risk per `docs/patterns/as-exports.md`).
   */
  readonly acknowledgeRisks: true
}

/** Return shape from `toBytes()` — raw bytes plus the inferred MIME + filename. */
export interface AsBlobResult {
  /** Decrypted blob bytes in their native MIME form. */
  readonly bytes: Uint8Array
  /** MIME type, or `'application/octet-stream'` if none was stored. */
  readonly mime: string
  /** Filename stored at upload time, or `<slotName>.bin`. */
  readonly filename: string
}

/**
 * Thrown when the requested record or slot isn't found in the vault.
 * Distinct from the hub's `NotFoundError` so callers can match the
 * export-path specifically.
 */
export class AsBlobNotFoundError extends Error {
  readonly collection: string
  readonly id: string
  readonly slot: string

  constructor(collection: string, id: string, slot: string) {
    super(
      `as-blob: no blob at ${collection}/${id}[slot=${slot}]. Record may not ` +
        `exist, slot may be unset, or the caller's ACL may not include this collection.`,
    )
    this.name = 'AsBlobNotFoundError'
    this.collection = collection
    this.id = id
    this.slot = slot
  }
}

const DEFAULT_SLOT = 'raw'

/**
 * Decrypt and return the blob bytes plus MIME + filename metadata.
 * Pure — no I/O beyond the authorization check, slot lookup, and
 * chunk fetch. The caller decides where the bytes go.
 */
export async function toBytes(
  vault: Vault,
  options: AsBlobOptions,
): Promise<AsBlobResult> {
  vault.assertCanExport('plaintext', 'blob')

  const slotName = options.slot ?? DEFAULT_SLOT
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const collection = vault.collection<any>(options.collection)
  const blobSet = collection.blob(options.id)

  // Look up slot metadata FIRST so we can surface a precise error
  // without triggering an extra chunk fetch for the missing case.
  const slots = await blobSet.list()
  const slot = slots.find((s) => s.name === slotName)
  if (!slot) {
    throw new AsBlobNotFoundError(options.collection, options.id, slotName)
  }

  const bytes = await blobSet.get(slotName)
  if (!bytes) {
    throw new AsBlobNotFoundError(options.collection, options.id, slotName)
  }

  return {
    bytes,
    mime: slot.mimeType ?? 'application/octet-stream',
    filename: slot.filename ?? `${slotName}.bin`,
  }
}

/**
 * Browser download — wraps `toBytes()` in a `Blob` and triggers the
 * browser's download prompt. Tier 2 egress per the pattern doc:
 * plaintext bytes leave memory, but the lifetime is scoped to the
 * user's chosen destination (usually the OS download folder).
 *
 * Requires a browser-like environment with `URL.createObjectURL`
 * and `document.createElement`. Throws on headless runtimes — use
 * `toBytes()` there and pipe the bytes wherever you need.
 */
export async function download(
  vault: Vault,
  options: AsBlobDownloadOptions,
): Promise<void> {
  const { bytes, mime, filename } = await toBytes(vault, options)
  const finalName = options.filename ?? filename
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blob = new Blob([bytes as any], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = finalName
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Node file-write — persists the blob bytes to the filesystem.
 * Requires explicit `acknowledgeRisks: true` because the plaintext
 * file outlives the current process (Tier 3 egress). The
 * authorization check still runs even when the consumer
 * acknowledges — capability bits aren't bypassable.
 */
export async function write(
  vault: Vault,
  path: string,
  options: AsBlobWriteOptions,
): Promise<void> {
  if (options.acknowledgeRisks !== true) {
    throw new Error(
      'as-blob.write: acknowledgeRisks: true is required for on-disk plaintext output. ' +
        'This call creates a persistent plaintext copy of the blob outside noy-db\'s ' +
        'encrypted storage — see docs/patterns/as-exports.md §"The three tiers of \\"plaintext out\\""',
    )
  }
  const { bytes } = await toBytes(vault, options)
  // Defer the node:fs import so this package remains browser-safe.
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, bytes)
}
