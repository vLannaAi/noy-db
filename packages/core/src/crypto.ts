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

export function base64ToBuffer(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
