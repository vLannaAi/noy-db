/**
 * **@noy-db/as-noydb** — encrypted `.noydb` bundle export.
 *
 * The sole member of the Fork · As **encrypted tier**. Wraps the core
 * `writeNoydbBundle()` primitive with:
 *
 *   1. The `canExportBundle` authorization gate (RFC #249) — default
 *      on for owner/admin, off for operator/viewer/client. The
 *      asymmetric default reflects asymmetric risk: a bundle is inert
 *      without the KEK, so owner backups don't need the per-format
 *      friction of the plaintext tier.
 *   2. The usual audit-ledger entry (`type: 'as-export'`,
 *      `encrypted: true`) so regulators see every bundle egress even
 *      though contents stay encrypted.
 *   3. Ergonomic browser-download / Node-file-write / in-memory-bytes
 *      helpers that parallel the plaintext-tier siblings.
 *
 * **Zero-knowledge preserved.** Unlike `as-csv` / `as-json` / …, this
 * package never reveals a single byte of plaintext to its caller or
 * any downstream handler. The vault's DEKs re-encrypt the body before
 * it leaves the gate; the bundle header is the minimal-disclosure
 * shape defined in `docs/architecture.md`.
 *
 * **No `acknowledgeRisks: true` on `write()`.** Writing a `.noydb` to
 * disk is a legitimate encrypted-tier destination — the bytes are
 * ciphertext. The applicable risk is "don't also store the
 * passphrase on the same disk", not "don't write the bytes". The risk
 * is therefore documented rather than gated.
 *
 * @packageDocumentation
 */

import type { Vault, WriteNoydbBundleOptions, NoydbBundleHeader } from '@noy-db/hub'
import { writeNoydbBundle as coreWrite, readNoydbBundleHeader } from '@noy-db/hub'

export type AsNoydbOptions = WriteNoydbBundleOptions

export interface AsNoydbDownloadOptions extends AsNoydbOptions {
  /** Filename offered to the browser. Default uses the vault's bundle handle. */
  readonly filename?: string
}

/**
 * Produce the encrypted bundle as a `Uint8Array`. Caller decides the
 * sink — upload to S3, attach to email, store in IndexedDB, …
 */
export async function toBytes(vault: Vault, options: AsNoydbOptions = {}): Promise<Uint8Array> {
  vault.assertCanExport('bundle')
  return coreWrite(vault, options)
}

/**
 * Browser download — wraps `toBytes()` in a Blob + triggers the
 * browser save-as prompt. Default filename uses the vault's stable
 * bundle handle (so repeated backups sort lexically and dedupe by
 * prefix in file listings).
 */
export async function download(vault: Vault, options: AsNoydbDownloadOptions = {}): Promise<void> {
  const bytes = await toBytes(vault, options)
  const filename = options.filename ?? `vault-${await vault.getBundleHandle()}.noydb`
  const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Node file-write. No `acknowledgeRisks` gate — the bytes are
 * ciphertext; persisting them to disk is a legitimate encrypted-tier
 * destination. Store the passphrase separately.
 */
export async function write(
  vault: Vault,
  path: string,
  options: AsNoydbOptions = {},
): Promise<void> {
  const bytes = await toBytes(vault, options)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, bytes)
}

/**
 * Peek at the header of a received bundle without unpacking the body.
 * Useful for due diligence on bundles obtained from external parties
 * — confirm the handle, the compression algorithm, and the declared
 * body size before committing to decrypt.
 */
export function peek(bytes: Uint8Array): NoydbBundleHeader {
  return readNoydbBundleHeader(bytes)
}
