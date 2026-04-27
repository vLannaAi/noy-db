/**
 * Minimal zero-dependency ZIP reader — STORE method only, with
 * optional WinZip-AES-256 decryption.
 *
 * Mirror of `./zip.ts`'s writer. Reads the central directory, walks
 * each entry, decrypts when the AES marker (method 99) is set and a
 * password was supplied. Same scope limits as the writer:
 *
 *   - **No DEFLATE / bzip2 / lzma / zstd.** STORE-only. Trying to read
 *     a deflated entry throws `ZipReadError`.
 *   - **No Zip64.** 32-bit size + offset fields apply.
 *   - **AES-256 only.** AES-128/192 and ZipCrypto are refused — same
 *     stance as the writer.
 *
 * @module
 */

import { decryptEntryWzAes, parseWzAesExtraField, ZipCipherError, WZAES_METHOD_MARKER } from './aes.js'

const TEXT_DECODER = new TextDecoder()

export class ZipReadError extends Error {
  readonly code = 'ZIP_READ_ERROR'
  constructor(message: string) {
    super(message)
    this.name = 'ZipReadError'
  }
}

export interface ReadZipEntry {
  readonly path: string
  readonly bytes: Uint8Array
  /** True iff the entry was decrypted from a WinZip-AES region. */
  readonly encrypted: boolean
}

export interface ReadZipOptions {
  /** WinZip-AES-256 passphrase. Required for encrypted archives. */
  readonly password?: string
}

/**
 * Parse a ZIP archive and return its entries. When the archive
 * contains AES-encrypted entries (method 99 with the 0x9901 extra
 * field), `options.password` MUST be supplied. Wrong password
 * surfaces a `ZipCipherError` from the underlying decrypt step.
 */
export async function readZip(
  bytes: Uint8Array,
  options: ReadZipOptions = {},
): Promise<ReadZipEntry[]> {
  if (bytes.length < 22) {
    throw new ZipReadError('readZip: archive shorter than the EOCD record (22 bytes)')
  }

  const eocdOffset = locateEOCD(bytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const cdSize = view.getUint32(eocdOffset + 12, true)
  const cdOffset = view.getUint32(eocdOffset + 16, true)
  const recordCount = view.getUint16(eocdOffset + 10, true)

  if (cdOffset + cdSize > bytes.length) {
    throw new ZipReadError('readZip: central directory extends past end of file')
  }

  const out: ReadZipEntry[] = []
  let pos = cdOffset
  for (let i = 0; i < recordCount; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) {
      throw new ZipReadError(`readZip: missing central directory file header signature at offset ${pos}`)
    }
    const flags = view.getUint16(pos + 8, true)
    const method = view.getUint16(pos + 10, true)
    const compressedSize = view.getUint32(pos + 20, true)
    const uncompressedSize = view.getUint32(pos + 24, true)
    const nameLen = view.getUint16(pos + 28, true)
    const extraLen = view.getUint16(pos + 30, true)
    const commentLen = view.getUint16(pos + 32, true)
    const lfhOffset = view.getUint32(pos + 42, true)

    const path = TEXT_DECODER.decode(bytes.subarray(pos + 46, pos + 46 + nameLen))
    const extra = bytes.subarray(pos + 46 + nameLen, pos + 46 + nameLen + extraLen)
    pos += 46 + nameLen + extraLen + commentLen

    // Locate file data — skip the local file header.
    if (lfhOffset + 30 > bytes.length) {
      throw new ZipReadError(`readZip: local header offset ${lfhOffset} past end of file`)
    }
    if (view.getUint32(lfhOffset, true) !== 0x04034b50) {
      throw new ZipReadError(`readZip: missing local file header signature for "${path}"`)
    }
    const lfhNameLen = view.getUint16(lfhOffset + 26, true)
    const lfhExtraLen = view.getUint16(lfhOffset + 28, true)
    const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen
    if (dataStart + compressedSize > bytes.length) {
      throw new ZipReadError(`readZip: data region for "${path}" extends past end of file`)
    }
    const dataRegion = bytes.subarray(dataStart, dataStart + compressedSize)

    const encryptedFlag = (flags & 0x0001) !== 0
    const isWzAes = method === WZAES_METHOD_MARKER

    if (isWzAes) {
      if (!encryptedFlag) {
        throw new ZipReadError(
          `readZip: entry "${path}" carries the AES marker but the encryption flag is unset`,
        )
      }
      const wz = parseWzAesExtraField(extra)
      if (!wz) {
        throw new ZipReadError(
          `readZip: entry "${path}" uses method 99 but is missing the 0x9901 extra field`,
        )
      }
      if (options.password === undefined) {
        throw new ZipReadError(
          `readZip: entry "${path}" is AES-encrypted but no password was supplied`,
        )
      }
      const plaintext = await decryptEntryWzAes(dataRegion, options.password)
      // Sanity: uncompressedSize records the plaintext length for AE-2.
      if (uncompressedSize !== 0 && plaintext.length !== uncompressedSize) {
        throw new ZipReadError(
          `readZip: entry "${path}" plaintext length ${plaintext.length} ≠ declared ${uncompressedSize}`,
        )
      }
      out.push({ path, bytes: plaintext, encrypted: true })
      continue
    }

    if (encryptedFlag) {
      // Encrypted but not WinZip-AES → ZipCrypto or weak AES variant.
      throw new ZipCipherError(
        `readZip: entry "${path}" uses an encryption method other than WinZip-AES-256 — refusing to decrypt`,
      )
    }
    if (method !== 0) {
      throw new ZipReadError(
        `readZip: entry "${path}" uses compression method ${method} — only STORE (0) is supported`,
      )
    }
    out.push({ path, bytes: new Uint8Array(dataRegion), encrypted: false })
  }
  return out
}

/**
 * Locate the End-of-Central-Directory record. ZIP stores it near the
 * end of the file with an optional comment trailing it; scan
 * backwards from the end looking for the EOCD signature.
 */
function locateEOCD(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // Maximum comment is 65535 bytes — stop the scan there.
  const minStart = Math.max(0, bytes.length - 22 - 65535)
  for (let pos = bytes.length - 22; pos >= minStart; pos--) {
    if (view.getUint32(pos, true) === 0x06054b50) return pos
  }
  throw new ZipReadError('readZip: EOCD signature not found — input is not a valid ZIP')
}
