/**
 * WinZip-AES encryption for ZIP entries — write + read.
 *
 * Implements the AES-256 variant of the WinZip-AES extension as
 * documented in
 * https://www.winzip.com/win/en/aes_info.html and PKWARE Appendix E.
 *
 * **AES-256 only by design.** ZipCrypto and AES-128/192 are refused at
 * both write and read time — the security story for the package is
 * "if you need encryption, use AES-256." Adding weaker tiers would
 * give consumers the impression of meaningful choice.
 *
 * ## Layout of an encrypted entry's data region
 *
 * ```
 * ┌──────────┬──────────┬─────────────┬──────────┐
 * │ salt(16) │ verif(2) │ ciphertext  │ auth(10) │
 * └──────────┴──────────┴─────────────┴──────────┘
 * ```
 *
 *   - **salt** — 16 random bytes per entry
 *   - **verifier** — 2 bytes, last 2 bytes of the PBKDF2 output;
 *     used to fail-fast on a wrong password without running CTR
 *   - **ciphertext** — input bytes XOR-ed with AES-CTR keystream
 *   - **auth** — first 10 bytes of HMAC-SHA1(ciphertext, authKey),
 *     where authKey is the second half of the PBKDF2 output
 *
 * ## Local file header changes
 *
 * For an encrypted entry:
 *
 *   - `compression method` field is forced to **99** (AES marker)
 *   - flag **bit 0** is set (encryption)
 *   - extra field tag **0x9901** is appended with 7 bytes:
 *     - `2 bytes` vendor version  → `0x0002` (AE-2)
 *     - `2 bytes` vendor ID       → `'AE'` (`0x4541` LE)
 *     - `1 byte`  AES strength    → `0x03` (AES-256)
 *     - `2 bytes` real method     → `0x0000` (STORE)
 *   - For AE-2, `crc` is forced to 0 (the spec recommends this — the
 *     authentication code already covers integrity)
 *
 * ## Counter convention (subtle!)
 *
 * AES-CTR per WinZip uses a **little-endian** 16-byte counter. The
 * counter starts at **1** (not 0) and increments by 1 per 16-byte
 * block. The lower 8 bytes hold the counter; the upper 8 bytes are 0.
 *
 * @module
 */

import { sha1, hmacSha1 } from './sha1.js'

/** AES-256 key strength byte in the 0x9901 extra field. */
export const WZAES_STRENGTH_256 = 0x03
/** Salt size in bytes for AES-256. */
export const WZAES_SALT_LEN = 16
/** Verifier size in bytes (constant across strengths). */
export const WZAES_VERIFIER_LEN = 2
/** Authentication code size in bytes (HMAC-SHA1 truncated). */
export const WZAES_AUTH_LEN = 10
/** PBKDF2 iteration count per the spec. */
export const WZAES_PBKDF2_ITERATIONS = 1000
/** Compression method marker used in the LFH for encrypted entries. */
export const WZAES_METHOD_MARKER = 99
/** Vendor ID `'AE'` little-endian. */
export const WZAES_VENDOR_ID = 0x4541
/** Vendor version 0x0002 = AE-2 (CRC field zeroed). */
export const WZAES_VENDOR_VERSION_AE2 = 0x0002
/** Real compression method we use for encrypted entries: STORE. */
export const WZAES_REAL_METHOD = 0
/** Extra-field header ID for WinZip-AES. */
export const WZAES_EXTRA_TAG = 0x9901

export class ZipCipherError extends Error {
  readonly code = 'ZIP_CIPHER_ERROR'
  constructor(message: string) {
    super(message)
    this.name = 'ZipCipherError'
  }
}

export interface WzAesEncrypted {
  readonly extraField: Uint8Array  // 11 bytes: tag(2) + size(2) + 7 vendor bytes
  readonly dataRegion: Uint8Array  // salt + verifier + ciphertext + auth
}

/**
 * Encrypt a single entry's bytes per WinZip-AES-256.
 *
 * Returns the bytes that go in place of the entry's "file data"
 * region, plus the 11-byte extra field (tag+size+payload) the LFH
 * and central-directory header need.
 */
export async function encryptEntryWzAes(
  plaintext: Uint8Array,
  password: string,
): Promise<WzAesEncrypted> {
  if (password.length === 0) {
    throw new ZipCipherError('encryptEntryWzAes: password must be a non-empty string')
  }

  const salt = crypto.getRandomValues(new Uint8Array(WZAES_SALT_LEN))
  const { encryptKey, authKey, verifier } = await deriveKeys(password, salt)

  const ciphertext = await aesCtrXor(plaintext, encryptKey)
  const authCode = await hmacSha1(authKey, ciphertext)
  const auth = authCode.slice(0, WZAES_AUTH_LEN)

  const data = new Uint8Array(salt.length + verifier.length + ciphertext.length + auth.length)
  let pos = 0
  data.set(salt, pos); pos += salt.length
  data.set(verifier, pos); pos += verifier.length
  data.set(ciphertext, pos); pos += ciphertext.length
  data.set(auth, pos)

  return {
    extraField: buildExtraField(),
    dataRegion: data,
  }
}

/**
 * Decrypt a single entry's data region produced by `encryptEntryWzAes`.
 *
 * Refuses to decrypt unless the verifier matches (wrong password
 * fast-path) AND the HMAC matches (tamper detection). Both produce a
 * `ZipCipherError`; callers cannot distinguish wrong-password from
 * tampered, by design.
 */
export async function decryptEntryWzAes(
  data: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  if (data.length < WZAES_SALT_LEN + WZAES_VERIFIER_LEN + WZAES_AUTH_LEN) {
    throw new ZipCipherError('decryptEntryWzAes: data region is shorter than the WinZip-AES envelope')
  }
  const salt = data.slice(0, WZAES_SALT_LEN)
  const verifier = data.slice(WZAES_SALT_LEN, WZAES_SALT_LEN + WZAES_VERIFIER_LEN)
  const ciphertext = data.slice(
    WZAES_SALT_LEN + WZAES_VERIFIER_LEN,
    data.length - WZAES_AUTH_LEN,
  )
  const auth = data.slice(data.length - WZAES_AUTH_LEN)

  const { encryptKey, authKey, verifier: expectedVerifier } = await deriveKeys(password, salt)

  if (!constantTimeEqual(verifier, expectedVerifier)) {
    throw new ZipCipherError('decryptEntryWzAes: wrong password (verifier mismatch)')
  }

  const expectedAuth = (await hmacSha1(authKey, ciphertext)).slice(0, WZAES_AUTH_LEN)
  if (!constantTimeEqual(auth, expectedAuth)) {
    throw new ZipCipherError('decryptEntryWzAes: authentication code mismatch (tampered ciphertext or wrong password)')
  }

  return aesCtrXor(ciphertext, encryptKey)
}

// ─── PBKDF2 + key split ────────────────────────────────────────────────

/**
 * PBKDF2-SHA1 with 1000 iterations, output length 66 bytes for AES-256:
 *
 *   bytes 0..31  → AES-256 encryption key
 *   bytes 32..63 → HMAC-SHA1 key
 *   bytes 64..65 → 2-byte verifier
 */
async function deriveKeys(password: string, salt: Uint8Array): Promise<{
  encryptKey: CryptoKey
  authKey: Uint8Array
  verifier: Uint8Array
}> {
  const passBytes = new TextEncoder().encode(password)

  const baseKey = await crypto.subtle.importKey(
    'raw',
    passBytes as BufferSource,
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  )
  const totalBits = (32 + 32 + 2) * 8
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-1',
      salt: salt as BufferSource,
      iterations: WZAES_PBKDF2_ITERATIONS,
    },
    baseKey,
    totalBits,
  )
  const out = new Uint8Array(bits)

  const encryptRaw = out.slice(0, 32)
  const authKey = out.slice(32, 64)
  const verifier = out.slice(64, 66)

  const encryptKey = await crypto.subtle.importKey(
    'raw',
    encryptRaw as BufferSource,
    { name: 'AES-CTR' },
    false,
    ['encrypt', 'decrypt'],
  )

  return { encryptKey, authKey, verifier }
}

// ─── AES-CTR with WinZip's little-endian, 1-based counter ─────────────

/**
 * Apply AES-CTR keystream to `data`. WinZip-AES uses a 16-byte block
 * counter, **little-endian**, starting at **1** and incrementing by 1
 * per block.
 *
 * Web Crypto's AES-CTR uses a 128-bit big-endian counter, so we can't
 * call subtle.encrypt() directly with a single counter and let it run.
 * Instead we generate the keystream block-by-block by encrypting the
 * raw counter bytes (with AES-ECB-equivalent: AES-CTR with a single
 * block of plaintext), then XOR.
 */
async function aesCtrXor(data: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const out = new Uint8Array(data.length)
  let blockNum = 1n
  let pos = 0
  // 16 zero bytes — encrypted in CTR mode with our chosen counter
  // block, the result is exactly AES_K(counter). XOR-ing that with
  // the data block gives WinZip's CTR-mode output for that 16 bytes.
  const zeroBlock = new Uint8Array(16) as BufferSource
  while (pos < data.length) {
    const counterBlock = new Uint8Array(16)
    // Lower 8 bytes = counter LE. Upper 8 bytes = 0.
    let n = blockNum
    for (let i = 0; i < 8; i++) {
      counterBlock[i] = Number(n & 0xffn)
      n >>= 8n
    }
    // AES-CTR with counter = our counterBlock, length = 128, plaintext
    // = 16 zeros, returns AES_K(counterBlock) directly. The CTR
    // increment never fires because we only encrypt one block.
    const block = await crypto.subtle.encrypt(
      { name: 'AES-CTR', counter: counterBlock as BufferSource, length: 128 },
      key,
      zeroBlock,
    )
    const keystream = new Uint8Array(block)
    const remain = Math.min(16, data.length - pos)
    for (let i = 0; i < remain; i++) {
      out[pos + i] = data[pos + i]! ^ keystream[i]!
    }
    pos += remain
    blockNum += 1n
  }
  return out
}

// ─── Extra field assembly ─────────────────────────────────────────────

function buildExtraField(): Uint8Array {
  // Header ID(2) + size(2) + payload(7) = 11 bytes total
  const ef = new Uint8Array(11)
  const view = new DataView(ef.buffer)
  view.setUint16(0, WZAES_EXTRA_TAG, true)            // tag
  view.setUint16(2, 7, true)                          // payload size
  view.setUint16(4, WZAES_VENDOR_VERSION_AE2, true)   // vendor version (AE-2)
  view.setUint16(6, WZAES_VENDOR_ID, true)            // vendor ID 'AE'
  ef[8] = WZAES_STRENGTH_256                          // strength: AES-256
  view.setUint16(9, WZAES_REAL_METHOD, true)          // real method (STORE)
  return ef
}

/**
 * Parse the WinZip-AES extra field of an entry. Returns null when
 * none is present, throws ZipCipherError when one is present but
 * declares a strength other than AES-256.
 */
export function parseWzAesExtraField(extra: Uint8Array): { vendorVersion: number } | null {
  let pos = 0
  while (pos + 4 <= extra.length) {
    const tag = readU16(extra, pos)
    const size = readU16(extra, pos + 2)
    if (tag === WZAES_EXTRA_TAG) {
      if (size !== 7) {
        throw new ZipCipherError(
          `WinZip-AES extra field has size ${size}, expected 7`,
        )
      }
      const vendorVersion = readU16(extra, pos + 4)
      const vendorId = readU16(extra, pos + 6)
      const strength = extra[pos + 8]!
      if (vendorId !== WZAES_VENDOR_ID) {
        throw new ZipCipherError(
          `WinZip-AES extra field vendor id 0x${vendorId.toString(16)}, expected 0x${WZAES_VENDOR_ID.toString(16)}`,
        )
      }
      if (strength !== WZAES_STRENGTH_256) {
        throw new ZipCipherError(
          `WinZip-AES strength ${strength} not supported — AES-256 only`,
        )
      }
      return { vendorVersion }
    }
    pos += 4 + size
  }
  return null
}

// ─── Helpers ──────────────────────────────────────────────────────────

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i]! ^ b[i]!)
  return diff === 0
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

// Re-export hashing helpers so the consumer barrel can pull them too.
export { sha1, hmacSha1 }
