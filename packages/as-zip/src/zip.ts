/**
 * Minimal zero-dependency ZIP writer — STORE method only (no compression).
 *
 * Produces single-disk zip archives readable by `unzip`, macOS Finder,
 * Windows Explorer, and every well-behaved unzipper. Store-method is
 * sufficient here because:
 *
 * 1. Most blobs reaching this writer are already compressed — PDFs,
 *    PNGs, JPEGs, `.zip`-inside-zip, encrypted `.noydb` bundles.
 *    Re-deflating yields near-zero savings at non-trivial CPU cost.
 * 2. STORE keeps the encoder compact (~150 lines) and dependency-free.
 *    Deflate would need a ~5KB gzip-style implementation or an
 *    external dep; we're zero-deps by design.
 * 3. Consumers who need further compression can deflate the whole zip
 *    after it's produced (`gzip archive.zip`).
 *
 * ## Wire format used
 *
 * Per PKWARE APPNOTE (the canonical ZIP spec):
 *
 * ```
 * [Local File Header 1][File 1 data]
 * [Local File Header 2][File 2 data]
 * ...
 * [Central Directory File Header 1]
 * [Central Directory File Header 2]
 * ...
 * [End of Central Directory Record]
 * ```
 *
 * All multi-byte integers are little-endian. Filenames are UTF-8
 * (flag bit 11 set so unzippers interpret them correctly). The
 * per-file CRC-32 uses the standard polynomial 0xEDB88320.
 *
 * ## What this does NOT support
 *
 * - Deflate / bzip2 / lzma / zstd compression methods.
 * - Zip64 (files / archives > 4 GiB). 32-bit size fields apply.
 * - Multi-disk / spanned archives.
 * - Encryption (the ZIP-level kind — noy-db records are already
 *   encrypted at the envelope layer before reaching this writer).
 * - Symlinks, extended attributes, NTFS/UNIX permissions.
 *
 * @module
 */

import {
  encryptEntryWzAes,
  WZAES_METHOD_MARKER,
  WZAES_REAL_METHOD,
} from './aes.js'

const TEXT_ENCODER = new TextEncoder()

/** Input entry to `writeZip`. */
export interface ZipEntry {
  /** Slash-delimited path inside the archive (e.g. `"records.json"`, `"attachments/01H.../raw.pdf"`). */
  readonly path: string
  /** Raw bytes. Pass plaintext as-is; the writer doesn't interpret content. */
  readonly bytes: Uint8Array
  /** Optional file mtime. Defaults to the call-time `Date`. */
  readonly mtime?: Date
}

/** Optional archive-wide settings for `writeZip`. */
export interface WriteZipOptions {
  /**
   * When set, every entry is encrypted with WinZip-AES-256 sealed
   * under this passphrase. Recipients open with stock archive
   * tooling (7-Zip, Archive Utility, WinRAR, modern unzip builds)
   * by typing the same passphrase.
   *
   * Single passphrase across all entries by design — per-entry
   * passwords don't fit a noy-db export workflow and would muddy
   * the API.
   */
  readonly password?: string
}

/**
 * Build a complete ZIP archive byte stream from `entries`. The result
 * is the full archive including central directory and EOCD — ready
 * to `fs.writeFile` or hand to `new Blob([bytes])`.
 *
 * When `options.password` is set, every entry is encrypted with
 * WinZip-AES-256 (vendor version AE-2). Output remains a valid
 * single-disk ZIP that archive tools recognising WinZip-AES prompt
 * for the password on extract.
 */
export async function writeZip(
  entries: readonly ZipEntry[],
  options: WriteZipOptions = {},
): Promise<Uint8Array> {
  // Pre-compute per-entry binary so we know total size + central
  // directory offsets before we build the wrapper header.
  const localParts: Uint8Array[] = []
  const cdParts: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = TEXT_ENCODER.encode(entry.path)
    const dosTime = toDosTime(entry.mtime ?? new Date())

    let dataBytes: Uint8Array
    let extraField: Uint8Array
    let methodField: number
    let crcField: number
    let flagsField = 0x0800   // UTF-8 names (bit 11)

    if (options.password !== undefined) {
      const enc = await encryptEntryWzAes(entry.bytes, options.password)
      dataBytes = enc.dataRegion
      extraField = enc.extraField
      methodField = WZAES_METHOD_MARKER         // 99 — AES marker
      // AE-2 zeroes the CRC (auth code already covers integrity).
      crcField = 0
      // Bit 0 set to indicate encryption.
      flagsField |= 0x0001
      void WZAES_REAL_METHOD                    // imported for parity
    } else {
      dataBytes = entry.bytes
      extraField = new Uint8Array(0)
      methodField = 0                            // STORE
      crcField = crc32(entry.bytes)
    }

    const size = dataBytes.length
    const uncompressedSize = options.password !== undefined
      ? entry.bytes.length
      : size

    // Local file header: 30 bytes fixed + filename + extra + data.
    const lfh = new Uint8Array(30 + nameBytes.length + extraField.length)
    const lfhView = new DataView(lfh.buffer)
    lfhView.setUint32(0, 0x04034b50, true)       // Signature PK\3\4
    lfhView.setUint16(4, 20, true)               // Version needed: 2.0
    lfhView.setUint16(6, flagsField, true)       // Flags
    lfhView.setUint16(8, methodField, true)      // Method
    lfhView.setUint16(10, dosTime.time, true)    // Mod time
    lfhView.setUint16(12, dosTime.date, true)    // Mod date
    lfhView.setUint32(14, crcField, true)        // CRC-32 (0 for AE-2)
    lfhView.setUint32(18, size, true)            // Compressed size (encrypted region for AES)
    lfhView.setUint32(22, uncompressedSize, true)// Uncompressed size (plaintext length)
    lfhView.setUint16(26, nameBytes.length, true)
    lfhView.setUint16(28, extraField.length, true)
    lfh.set(nameBytes, 30)
    if (extraField.length > 0) lfh.set(extraField, 30 + nameBytes.length)

    localParts.push(lfh, dataBytes)

    // Central directory header: 46 bytes fixed + filename + extra.
    const cdh = new Uint8Array(46 + nameBytes.length + extraField.length)
    const cdhView = new DataView(cdh.buffer)
    cdhView.setUint32(0, 0x02014b50, true)       // Signature
    cdhView.setUint16(4, 20, true)               // Version made by
    cdhView.setUint16(6, 20, true)               // Version needed
    cdhView.setUint16(8, flagsField, true)       // Flags
    cdhView.setUint16(10, methodField, true)     // Method
    cdhView.setUint16(12, dosTime.time, true)
    cdhView.setUint16(14, dosTime.date, true)
    cdhView.setUint32(16, crcField, true)
    cdhView.setUint32(20, size, true)
    cdhView.setUint32(24, uncompressedSize, true)
    cdhView.setUint16(28, nameBytes.length, true)
    cdhView.setUint16(30, extraField.length, true)
    cdhView.setUint16(32, 0, true)               // Comment length
    cdhView.setUint16(34, 0, true)               // Disk number
    cdhView.setUint16(36, 0, true)               // Internal attrs
    cdhView.setUint32(38, 0, true)               // External attrs
    cdhView.setUint32(42, offset, true)          // Local header offset
    cdh.set(nameBytes, 46)
    if (extraField.length > 0) cdh.set(extraField, 46 + nameBytes.length)
    cdParts.push(cdh)

    offset += lfh.length + dataBytes.length
  }

  const localTotal = offset
  const cdSize = cdParts.reduce((n, p) => n + p.length, 0)

  // End-of-Central-Directory record (EOCD) — 22 bytes fixed.
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)        // Signature
  eocdView.setUint16(4, 0, true)                 // Disk number
  eocdView.setUint16(6, 0, true)                 // CD disk
  eocdView.setUint16(8, entries.length, true)    // Records this disk
  eocdView.setUint16(10, entries.length, true)   // Records total
  eocdView.setUint32(12, cdSize, true)           // CD size
  eocdView.setUint32(16, localTotal, true)       // CD offset
  eocdView.setUint16(20, 0, true)                // Comment length

  // Concat everything.
  const out = new Uint8Array(localTotal + cdSize + eocd.length)
  let pos = 0
  for (const part of localParts) {
    out.set(part, pos)
    pos += part.length
  }
  for (const part of cdParts) {
    out.set(part, pos)
    pos += part.length
  }
  out.set(eocd, pos)
  return out
}

// ── CRC-32 ───────────────────────────────────────────────────────────

/**
 * CRC-32 using polynomial 0xEDB88320 (standard ZIP/PNG/ethernet).
 * Table-driven for speed; the table is lazy-built on first call.
 */
let CRC_TABLE: Uint32Array | null = null

function ensureCrcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    t[n] = c >>> 0
  }
  CRC_TABLE = t
  return t
}

export function crc32(bytes: Uint8Array): number {
  const t = ensureCrcTable()
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = t[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

// ── DOS time encoding ────────────────────────────────────────────────

/**
 * Encode a JS `Date` to ZIP's MS-DOS time + date fields.
 * Year floor is 1980 (DOS epoch); seconds have 2-second resolution.
 */
function toDosTime(date: Date): { time: number; date: number } {
  const y = Math.max(1980, date.getUTCFullYear()) - 1980
  const m = date.getUTCMonth() + 1
  const d = date.getUTCDate()
  const hh = date.getUTCHours()
  const mm = date.getUTCMinutes()
  const ss = Math.floor(date.getUTCSeconds() / 2)
  return {
    date: (y << 9) | (m << 5) | d,
    time: (hh << 11) | (mm << 5) | ss,
  }
}
