import { DecryptionError, InvalidKeyError, TamperedError } from './errors.js'

const PBKDF2_ITERATIONS = 600_000
const SALT_BYTES = 32
const IV_BYTES = 12
const KEY_BITS = 256

const subtle = globalThis.crypto.subtle

// ─── Key Derivation ────────────────────────────────────────────────────

/** Derive a KEK from a passphrase and salt using PBKDF2-SHA256. */
export async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const keyMaterial = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )

  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-KW', length: KEY_BITS },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}

// ─── DEK Generation ────────────────────────────────────────────────────

/** Generate a random AES-256-GCM data encryption key. */
export async function generateDEK(): Promise<CryptoKey> {
  return subtle.generateKey(
    { name: 'AES-GCM', length: KEY_BITS },
    true, // extractable — needed for AES-KW wrapping
    ['encrypt', 'decrypt'],
  )
}

// ─── Key Wrapping ──────────────────────────────────────────────────────

/** Wrap (encrypt) a DEK with a KEK using AES-KW. Returns base64 string. */
export async function wrapKey(dek: CryptoKey, kek: CryptoKey): Promise<string> {
  const wrapped = await subtle.wrapKey('raw', dek, kek, 'AES-KW')
  return bufferToBase64(wrapped)
}

/** Unwrap (decrypt) a DEK from base64 string using a KEK. */
export async function unwrapKey(
  wrappedBase64: string,
  kek: CryptoKey,
): Promise<CryptoKey> {
  try {
    return await subtle.unwrapKey(
      'raw',
      base64ToBuffer(wrappedBase64) as BufferSource,
      kek,
      'AES-KW',
      { name: 'AES-GCM', length: KEY_BITS },
      true,
      ['encrypt', 'decrypt'],
    )
  } catch {
    throw new InvalidKeyError()
  }
}

// ─── Encrypt / Decrypt ─────────────────────────────────────────────────

export interface EncryptResult {
  iv: string   // base64
  data: string // base64
}

/** Encrypt plaintext JSON string with AES-256-GCM. Fresh IV per call. */
export async function encrypt(
  plaintext: string,
  dek: CryptoKey,
): Promise<EncryptResult> {
  const iv = generateIV()
  const encoded = new TextEncoder().encode(plaintext)

  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    dek,
    encoded,
  )

  return {
    iv: bufferToBase64(iv),
    data: bufferToBase64(ciphertext),
  }
}

/** Decrypt AES-256-GCM ciphertext. Throws on wrong key or tampered data. */
export async function decrypt(
  ivBase64: string,
  dataBase64: string,
  dek: CryptoKey,
): Promise<string> {
  const iv = base64ToBuffer(ivBase64)
  const ciphertext = base64ToBuffer(dataBase64)

  try {
    const plaintext = await subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      dek,
      ciphertext as BufferSource,
    )
    return new TextDecoder().decode(plaintext)
  } catch (err) {
    if (err instanceof Error && err.name === 'OperationError') {
      throw new TamperedError()
    }
    throw new DecryptionError(
      err instanceof Error ? err.message : 'Decryption failed',
    )
  }
}

// ─── Binary Encrypt / Decrypt (v0.12 #105 — attachment chunks) ────────

/**
 * Encrypt raw bytes with AES-256-GCM using a fresh random IV.
 * Used by the attachment store so binary blobs avoid double base64 encoding
 * (the existing `encrypt()` function calls `TextEncoder` on a string — here
 * we pass the `Uint8Array` directly to `subtle.encrypt`).
 */
export async function encryptBytes(
  data: Uint8Array,
  dek: CryptoKey,
): Promise<EncryptResult> {
  const iv = generateIV()
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    dek,
    data as unknown as BufferSource,
  )
  return {
    iv: bufferToBase64(iv),
    data: bufferToBase64(ciphertext),
  }
}

/**
 * Decrypt AES-256-GCM ciphertext back to raw bytes.
 * Counterpart to `encryptBytes`. Throws `TamperedError` on auth-tag failure.
 */
export async function decryptBytes(
  ivBase64: string,
  dataBase64: string,
  dek: CryptoKey,
): Promise<Uint8Array> {
  const iv = base64ToBuffer(ivBase64)
  const ciphertext = base64ToBuffer(dataBase64)
  try {
    const plaintext = await subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      dek,
      ciphertext as BufferSource,
    )
    return new Uint8Array(plaintext)
  } catch (err) {
    if (err instanceof Error && err.name === 'OperationError') {
      throw new TamperedError()
    }
    throw new DecryptionError(
      err instanceof Error ? err.message : 'Decryption failed',
    )
  }
}

/**
 * SHA-256 hex digest of raw bytes. Used to derive content-addressed
 * eTags for blob deduplication (v0.12 #105). Computed on plaintext bytes
 * before compression and encryption so the eTag identifies content, not
 * ciphertext, and survives re-encryption (key rotation, re-upload).
 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await subtle.digest('SHA-256', data as unknown as BufferSource)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ─── HMAC-SHA-256 (v0.12 #105 — keyed eTag) ─────────────────────────────

/**
 * Compute HMAC-SHA-256(key, data) and return hex string.
 *
 * Used to derive content-addressed eTags that are opaque to the store:
 * ```
 * eTag = hmacSha256Hex(blobDEK, plaintext)
 * ```
 *
 * Unlike a plain SHA-256, the HMAC is keyed by the vault-shared `_blob` DEK,
 * so an attacker with store access cannot pre-compute eTags for known files.
 * Deduplication still works within a vault (same key + same content = same eTag).
 */
export async function hmacSha256Hex(key: CryptoKey, data: Uint8Array): Promise<string> {
  // Export AES-GCM DEK raw bytes → import as HMAC key
  const rawKey = await subtle.exportKey('raw', key)
  const hmacKey = await subtle.importKey(
    'raw',
    rawKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await subtle.sign('HMAC', hmacKey, data as unknown as BufferSource)
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ─── AAD-aware Binary Encrypt / Decrypt (v0.12 #105 — chunk integrity) ──

/**
 * Encrypt raw bytes with AES-256-GCM using Additional Authenticated Data.
 *
 * The AAD binds each chunk to its parent blob and position, preventing
 * chunk reorder, substitution, and truncation attacks:
 * ```
 * AAD = UTF-8("{eTag}:{chunkIndex}:{chunkCount}")
 * ```
 *
 * The AAD is NOT stored — the reader reconstructs it from `BlobObject`
 * metadata and passes it to `decryptBytesWithAAD`.
 */
export async function encryptBytesWithAAD(
  data: Uint8Array,
  dek: CryptoKey,
  aad: Uint8Array,
): Promise<EncryptResult> {
  const iv = generateIV()
  const ciphertext = await subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as BufferSource,
      additionalData: aad as BufferSource,
    },
    dek,
    data as unknown as BufferSource,
  )
  return {
    iv: bufferToBase64(iv),
    data: bufferToBase64(ciphertext),
  }
}

/**
 * Decrypt AES-256-GCM ciphertext with AAD verification.
 *
 * If the AAD does not match the one used at encryption time (e.g. because
 * a chunk was reordered or substituted from another blob), the GCM auth
 * tag fails and this throws `TamperedError`.
 */
export async function decryptBytesWithAAD(
  ivBase64: string,
  dataBase64: string,
  dek: CryptoKey,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const iv = base64ToBuffer(ivBase64)
  const ciphertext = base64ToBuffer(dataBase64)
  try {
    const plaintext = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource,
        additionalData: aad as BufferSource,
      },
      dek,
      ciphertext as BufferSource,
    )
    return new Uint8Array(plaintext)
  } catch (err) {
    if (err instanceof Error && err.name === 'OperationError') {
      throw new TamperedError()
    }
    throw new DecryptionError(
      err instanceof Error ? err.message : 'Decryption failed',
    )
  }
}

// ─── Presence Key Derivation (v0.9 #134) ──────────────────────────────

/**
 * Derive an AES-256-GCM presence key from a collection DEK using HKDF-SHA256.
 *
 * The presence key is domain-separated from the data DEK by the fixed salt
 * `'noydb-presence'` and the `info` = collection name. This means:
 *  - The adapter never sees the presence key.
 *  - Presence payloads rotate automatically when the collection DEK is rotated.
 *  - Revoked users cannot derive the new presence key after a DEK rotation.
 *
 * @param dek            The collection's AES-256-GCM DEK (extractable).
 * @param collectionName Used as the HKDF `info` parameter for domain separation.
 * @returns A non-extractable AES-256-GCM key suitable for presence payload encryption.
 */
export async function derivePresenceKey(dek: CryptoKey, collectionName: string): Promise<CryptoKey> {
  // Step 1: export DEK raw bytes
  const rawDek = await subtle.exportKey('raw', dek)

  // Step 2: import as HKDF key material
  const hkdfKey = await subtle.importKey(
    'raw',
    rawDek,
    'HKDF',
    false,
    ['deriveBits'],
  )

  // Step 3: derive 256 bits with salt='noydb-presence' and info=collectionName
  const salt = new TextEncoder().encode('noydb-presence')
  const info = new TextEncoder().encode(collectionName)
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    hkdfKey,
    KEY_BITS,
  )

  // Step 4: import derived bits as AES-GCM key
  return subtle.importKey(
    'raw',
    bits,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  )
}

// ─── Random Generation ─────────────────────────────────────────────────

/** Generate a random 12-byte IV for AES-GCM. */
export function generateIV(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES))
}

/** Generate a random 32-byte salt for PBKDF2. */
export function generateSalt(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES))
}

// ─── Base64 Helpers ────────────────────────────────────────────────────

export function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

export function base64ToBuffer(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
