/**
 * `.noydb` container primitives — write, read, header-only read.
 *
 * v0.6 #100. Wraps a `vault.dump()` JSON string in the
 * binary container described in `format.ts`.
 *
 * **Three primitives:**
 *
 *   - `writeNoydbBundle(vault, opts?)` — produces the
 *     full container bytes ready to write to disk or upload
 *   - `readNoydbBundleHeader(bytes)` — parses just the header
 *     without decompressing the body, fast file-type and
 *     metadata read for cloud listing UIs
 *   - `readNoydbBundle(bytes)` — full read: validates magic,
 *     header, integrity hash, and decompresses the body to
 *     return the original `dump()` JSON string for use with
 *     `vault.load()`
 *
 * **Compression strategy:** brotli when available (Node 22+,
 * Chrome 124+, Firefox 122+), gzip fallback elsewhere. The
 * algorithm choice is encoded in the format byte at offset 5,
 * so readers handle either transparently. Brotli wins ~30-50%
 * on JSON payloads with repeated keys (which vault dumps
 * are).
 *
 * **Why split read/load?** `readNoydbBundle` returns the
 * *unwrapped JSON string*, not a Vault object. The caller
 * is responsible for piping that JSON into
 * `vault.load(json, passphrase)`. Splitting the layers
 * keeps the bundle module free of any crypto/passphrase
 * concerns — it's purely a format layer. The same `readNoydbBundle`
 * call can also feed verification tools, format inspectors, or
 * archive utilities that don't care about decryption.
 */

import {
  COMPRESSION_BROTLI,
  COMPRESSION_GZIP,
  COMPRESSION_NONE,
  FLAG_COMPRESSED,
  FLAG_HAS_INTEGRITY_HASH,
  NOYDB_BUNDLE_FORMAT_VERSION,
  NOYDB_BUNDLE_MAGIC,
  NOYDB_BUNDLE_PREFIX_BYTES,
  decodeBundleHeader,
  encodeBundleHeader,
  hasNoydbBundleMagic,
  readUint32BE,
  writeUint32BE,
  type CompressionAlgo,
  type NoydbBundleHeader,
} from './format.js'
import { BundleIntegrityError } from '../errors.js'
import type { Vault } from '../vault.js'

/**
 * Options accepted by `writeNoydbBundle`.
 *
 * - `compression: 'auto'` (default) — try brotli, fall back to gzip
 * - `compression: 'brotli'` — force brotli, throw if unsupported
 * - `compression: 'gzip'` — force gzip
 * - `compression: 'none'` — no compression (round-trip testing only)
 */
export interface WriteNoydbBundleOptions {
  readonly compression?: 'auto' | 'brotli' | 'gzip' | 'none'
}

/**
 * Result returned by `readNoydbBundle`. The caller is expected to
 * pass `dumpJson` into `vault.load(json, passphrase)` to
 * actually restore a vault. Splitting the layers keeps the
 * bundle module free of crypto concerns — see file-level docs.
 */
export interface NoydbBundleReadResult {
  readonly header: NoydbBundleHeader
  readonly dumpJson: string
}

/**
 * Detect whether the runtime's `CompressionStream` supports brotli.
 *
 * Brotli requires Node 22+ / Chrome 124+ / Firefox 122+. The
 * detection runs the `CompressionStream` constructor in a
 * try/catch — unsupported formats throw `TypeError` synchronously,
 * making this a safe one-shot check that we cache for the
 * lifetime of the process.
 */
let cachedBrotliSupport: boolean | null = null
function supportsBrotliCompression(): boolean {
  if (cachedBrotliSupport !== null) return cachedBrotliSupport
  try {
    new CompressionStream('br' as CompressionFormat)
    cachedBrotliSupport = true
  } catch {
    cachedBrotliSupport = false
  }
  return cachedBrotliSupport
}

/** Test-only: reset the brotli detection cache between tests. */
export function resetBrotliSupportCache(): void {
  cachedBrotliSupport = null
}

/**
 * Pick the compression algorithm and the corresponding format byte
 * from a user option. Throws if the user explicitly requests brotli
 * on a runtime that doesn't support it — a silent fallback would
 * make the produced bundle smaller-than-expected and confuse
 * size-bound tests.
 */
function selectCompression(option: WriteNoydbBundleOptions['compression']): {
  format: CompressionAlgo
  streamFormat: CompressionFormat | null
} {
  const choice = option ?? 'auto'
  if (choice === 'none') return { format: COMPRESSION_NONE, streamFormat: null }
  if (choice === 'gzip') return { format: COMPRESSION_GZIP, streamFormat: 'gzip' }
  if (choice === 'brotli') {
    if (!supportsBrotliCompression()) {
      throw new Error(
        `writeNoydbBundle({ compression: 'brotli' }) is not supported on this ` +
          `runtime. Brotli requires Node 22+, Chrome 124+, or Firefox 122+. ` +
          `Use { compression: 'auto' } to fall back to gzip silently, or ` +
          `{ compression: 'gzip' } to be explicit.`,
      )
    }
    return { format: COMPRESSION_BROTLI, streamFormat: 'br' as CompressionFormat }
  }
  // 'auto' — prefer brotli, fall back to gzip
  if (supportsBrotliCompression()) {
    return { format: COMPRESSION_BROTLI, streamFormat: 'br' as CompressionFormat }
  }
  return { format: COMPRESSION_GZIP, streamFormat: 'gzip' }
}

/**
 * Pump a Uint8Array through a CompressionStream / DecompressionStream
 * and collect the output. Both APIs are universally available in
 * Node 18+ and modern browsers; the only variance is which
 * formats they support, handled by `selectCompression` above.
 *
 * Implementation: build a single-chunk ReadableStream from the
 * input, pipe through the transform, then drain the resulting
 * ReadableStream into a single concatenated Uint8Array. This is
 * O(N) memory in the input + output sizes, which is fine for the
 * dump-sized payloads (typically <50MB) v0.6 targets.
 */
async function pumpThroughStream(
  input: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const readable = new Blob([input as BlobPart]).stream().pipeThrough(stream)
  const reader = readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value as Uint8Array)
      total += value.length
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * SHA-256 hex digest of `bytes`. Used for the bundle integrity
 * hash carried in the header. Web Crypto API only — no Node
 * crypto module, no third-party hash library.
 *
 * The output format is lowercase hex (64 chars for SHA-256). The
 * format validator pins this — uppercase or mixed-case digests
 * are rejected, so the writer and reader agree on canonicalization.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed Uint8Array. The
  // underlying buffer of `bytes` may be SharedArrayBuffer (e.g.
  // from a worker), which `subtle.digest` rejects via TypeScript's
  // BufferSource type. Allocating a fresh ArrayBuffer-backed view
  // sidesteps the type narrowing and is portable across all
  // runtimes — the copy cost is O(N) but bundle bodies are
  // typically <50MB, well below the threshold where the copy
  // matters.
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', copy)
  const view = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < view.length; i++) {
    hex += view[i]!.toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * Concatenate any number of Uint8Arrays into a single new buffer.
 * Used to assemble the final bundle from its prefix + header +
 * body parts.
 */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/**
 * Write a `.noydb` bundle for the given vault.
 *
 * Pipeline:
 *   1. Resolve or create the compartment's stable bundle handle
 *      via `vault.getBundleHandle()` — same handle on
 *      every export from the same vault instance, so cloud
 *      adapters can use it as a primary key.
 *   2. `vault.dump()` → JSON string with encrypted records
 *      inside.
 *   3. UTF-8 encode the dump string.
 *   4. Compress (brotli if available, gzip fallback by default).
 *   5. Compute SHA-256 of the compressed body for integrity.
 *   6. Build the minimum-disclosure header from format version,
 *      handle, body length, body sha.
 *   7. Serialize: magic (4) + flags (1) + algo (1) + headerLen (4)
 *      + header JSON (N) + compressed body (M).
 *
 * The output is a single `Uint8Array`. Consumers writing to disk
 * pass it to `fs.writeFile`; consumers uploading to cloud storage
 * pass it as the request body. The `@noy-db/file` adapter wraps
 * this with a `saveBundle(path, vault)` helper.
 */
export async function writeNoydbBundle(
  vault: Vault,
  opts: WriteNoydbBundleOptions = {},
): Promise<Uint8Array> {
  const handle = await vault.getBundleHandle()
  const dumpJson = await vault.dump()
  const dumpBytes = new TextEncoder().encode(dumpJson)

  const { format, streamFormat } = selectCompression(opts.compression)
  const body = streamFormat === null
    ? dumpBytes
    : await pumpThroughStream(dumpBytes, new CompressionStream(streamFormat))

  const bodySha256 = await sha256Hex(body)
  const header: NoydbBundleHeader = {
    formatVersion: NOYDB_BUNDLE_FORMAT_VERSION,
    handle,
    bodyBytes: body.length,
    bodySha256,
  }
  const headerBytes = encodeBundleHeader(header)

  // Assemble the fixed prefix in a 10-byte buffer.
  const prefix = new Uint8Array(NOYDB_BUNDLE_PREFIX_BYTES)
  prefix.set(NOYDB_BUNDLE_MAGIC, 0)
  prefix[4] =
    (streamFormat === null ? 0 : FLAG_COMPRESSED) | FLAG_HAS_INTEGRITY_HASH
  prefix[5] = format
  writeUint32BE(prefix, 6, headerBytes.length)

  return concatBytes([prefix, headerBytes, body])
}

/**
 * Internal helper shared by both readers — parses just the prefix
 * + header region of a bundle without touching the body. Returns
 * the parsed header plus the offset where the body starts and the
 * compression algorithm needed to decompress it.
 *
 * Throws on any format violation: missing/invalid magic, truncated
 * prefix, header length larger than the file, or unknown
 * compression algorithm.
 */
function parsePrefixAndHeader(bytes: Uint8Array): {
  header: NoydbBundleHeader
  bodyOffset: number
  algo: CompressionAlgo
  flags: number
} {
  if (!hasNoydbBundleMagic(bytes)) {
    throw new Error(
      `Not a .noydb bundle: missing 'NDB1' magic prefix. The first 4 bytes ` +
        `are ${[...bytes.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}.`,
    )
  }
  if (bytes.length < NOYDB_BUNDLE_PREFIX_BYTES) {
    throw new Error(
      `Truncated .noydb bundle: file is only ${bytes.length} bytes, ` +
        `which is less than the ${NOYDB_BUNDLE_PREFIX_BYTES}-byte fixed prefix.`,
    )
  }
  const flags = bytes[4]!
  const algo = bytes[5]!
  if (algo !== COMPRESSION_NONE && algo !== COMPRESSION_GZIP && algo !== COMPRESSION_BROTLI) {
    throw new Error(
      `.noydb bundle declares unknown compression algorithm ${algo}. ` +
        `Known values: 0 (none), 1 (gzip), 2 (brotli).`,
    )
  }
  const headerLength = readUint32BE(bytes, 6)
  const bodyOffset = NOYDB_BUNDLE_PREFIX_BYTES + headerLength
  if (bodyOffset > bytes.length) {
    throw new Error(
      `Truncated .noydb bundle: declared header length ${headerLength} ` +
        `would extend past end of file (${bytes.length} bytes).`,
    )
  }
  const headerBytes = bytes.slice(NOYDB_BUNDLE_PREFIX_BYTES, bodyOffset)
  const header = decodeBundleHeader(headerBytes)
  return { header, bodyOffset, algo: algo as CompressionAlgo, flags }
}

/**
 * Read just the bundle header — no body decompression, no
 * integrity verification. Fast (O(prefix + header bytes)) and
 * intended for cloud-listing UIs that want to show the handle and
 * size before downloading the full body.
 *
 * Returns the same `NoydbBundleHeader` shape as the writer, with
 * minimum-disclosure validation already applied.
 */
export function readNoydbBundleHeader(bytes: Uint8Array): NoydbBundleHeader {
  return parsePrefixAndHeader(bytes).header
}

/**
 * Read a full `.noydb` bundle: validate magic + header, verify
 * integrity hash over the body bytes, decompress, and return the
 * original `vault.dump()` JSON string ready to pass to
 * `vault.load()`.
 *
 * Throws `BundleIntegrityError` if the body's actual SHA-256 does
 * not match the value declared in the header. Distinct from a
 * format error so consumers can pattern-match in catch blocks
 * (corrupted-in-transit vs malformed-by-producer).
 *
 * Note: this function does NOT take a passphrase. The dump JSON
 * inside the body still contains encrypted records — restoring
 * the vault requires `vault.load(dumpJson, passphrase)`
 * after this call. Splitting the layers keeps the bundle module
 * free of crypto concerns and lets the same code feed format
 * inspectors that never decrypt anything.
 */
export async function readNoydbBundle(
  bytes: Uint8Array,
): Promise<NoydbBundleReadResult> {
  const { header, bodyOffset, algo } = parsePrefixAndHeader(bytes)
  const body = bytes.slice(bodyOffset)

  // Length check before hash check — a length mismatch is the
  // cheapest tamper signal and produces a more actionable error.
  if (body.length !== header.bodyBytes) {
    throw new BundleIntegrityError(
      `body length ${body.length} does not match header.bodyBytes ` +
        `${header.bodyBytes}. The bundle was truncated or padded ` +
        `between write and read.`,
    )
  }

  const actualSha = await sha256Hex(body)
  if (actualSha !== header.bodySha256) {
    throw new BundleIntegrityError(
      `body sha256 ${actualSha} does not match header.bodySha256 ` +
        `${header.bodySha256}. The bundle bytes were modified between ` +
        `write and read — refuse to decompress.`,
    )
  }

  let dumpBytes: Uint8Array
  if (algo === COMPRESSION_NONE) {
    dumpBytes = body
  } else {
    const streamFormat: CompressionFormat =
      algo === COMPRESSION_BROTLI ? ('br' as CompressionFormat) : 'gzip'
    try {
      dumpBytes = await pumpThroughStream(body, new DecompressionStream(streamFormat))
    } catch (err) {
      throw new BundleIntegrityError(
        `decompression failed: ${(err as Error).message}. The bundle ` +
          `passed the integrity hash but the body is not valid ` +
          `${streamFormat} data — likely a producer bug.`,
      )
    }
  }

  const dumpJson = new TextDecoder('utf-8', { fatal: true }).decode(dumpBytes)
  return { header, dumpJson }
}
