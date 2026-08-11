/**
 * Cryptographic primitives — thin wrappers around the Web Crypto API.
 *
 * ## Design principle
 *
 * **Zero npm crypto dependencies.** Every operation uses `globalThis.crypto.subtle`,
 * which is available natively in Node.js ≥ 18, all modern browsers, and
 * Deno/Bun. This avoids supply-chain risk from third-party crypto packages and
 * ensures the library stays auditable.
 *
 * ## Algorithms
 *
 * | Use case | Algorithm | Parameters |
 * |----------|-----------|------------|
 * | Key derivation | PBKDF2-SHA256 | 600,000 iterations, 32-byte salt |
 * | Record encryption | AES-256-GCM | 12-byte random IV per operation |
 * | DEK wrapping | AES-KW (RFC 3394) | 256-bit KEK |
 * | Binary encrypt | AES-256-GCM | same as record encryption |
 * | Integrity | HMAC-SHA256 | for presence channels |
 * | Content hash | SHA-256 | for ledger and bundle integrity |
 *
 * ## Key lifecycle
 *
 * ```
 * secret + salt
 *   └─► deriveKey()       → KEK (CryptoKey, extractable: false)
 *         └─► wrapKey()   → wrapped DEK bytes  [stored in keyring]
 *         └─► unwrapKey() → DEK (CryptoKey)    [memory only during session]
 *               └─► encrypt() / decrypt()       → ciphertext / plaintext
 * ```
 *
 * IVs are generated fresh by {@link generateIV} on every encrypt call.
 * Reusing an IV with the same key would break GCM's authentication guarantee —
 * this function should be the only place IVs are produced.
 *
 * @module
 */

import { DecryptionError, InvalidKeyError, TamperedError, ValidationError } from '../errors.js'

/**
 * **EnclaveKey** — the opaque key type at the enclave seam.
 *
 * In noy-db's reference enclave this is `CryptoKey` (the Web Crypto API's
 * key handle). A fork's enclave redefines this alias to its own key
 * representation (e.g. `type EnclaveKey = null` for a keyless HSM-backed
 * fork) — outside `kernel/enclave/**`, every consumer must treat it as
 * opaque: never construct, inspect, or serialize it directly, only pass it
 * between barrel functions (`encrypt`/`decrypt`/`wrapKey`/`unwrapKey`/…).
 */
export type EnclaveKey = CryptoKey

const PBKDF2_ITERATIONS = 600_000
const SALT_BYTES = 32
const IV_BYTES = 12
const KEY_BITS = 256

const subtle = globalThis.crypto.subtle

// ─── Key Derivation ────────────────────────────────────────────────────

/** Derive a KEK from a secret and salt using PBKDF2-SHA256. */
export async function deriveKey(
  secret: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  return deriveKekFromMaterial(new TextEncoder().encode(secret), salt)
}

/**
 * Shared PBKDF2 → AES-KW derivation core. `material` is the raw
 * pre-KDF input bytes (a UTF-8 phrase for standard mode, an
 * AG-1-encoded 3-part structure for echo mode).
 */
async function deriveKekFromMaterial(
  material: Uint8Array,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const keyMaterial = await subtle.importKey('raw', material as BufferSource, 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-KW', length: KEY_BITS },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}

/** One three-part echo secret: prompt (typed) → echo (revealed) → key (typed). */
export interface EchoSecretParts {
  readonly prompt: string
  readonly echo: string
  readonly key: string
}

/**
 * Domain context for the AG-1 encoding. The leading `0xFF` is the load-bearing
 * byte: it is not a legal UTF-8 lead byte, so `TextEncoder` can never emit it —
 * no string's UTF-8 encoding can equal an AG-1 encoding, whatever the string.
 */
const ECHO_KDF_CONTEXT = new Uint8Array([0xff, ...new TextEncoder().encode('noydb-echo-secret-v1')])

/**
 * AG-1 encoding: domain context + 4-byte big-endian length prefix per
 * part. Two independent guarantees make a single typed string unable to
 * derive an echo vault's KEK (spec AG-1):
 *
 *   1. The `0xFF` context prefix — UTF-8 never produces that byte, so the
 *      encoding is provably not the encoding of ANY string (not merely of
 *      no separator-joined form).
 *   2. Structural length prefixes — part boundaries are key material, so
 *      re-splitting the same characters changes the derived KEK.
 *
 * @throws ValidationError when any part is not a string — the single
 * chokepoint every echo KEK derivation and block mint passes through, so a
 * malformed parts object cannot be `TextEncoder`-coerced into key material.
 */
export function encodeEchoParts(parts: EchoSecretParts): Uint8Array {
  for (const name of ['prompt', 'echo', 'key'] as const) {
    if (typeof parts?.[name] !== 'string') {
      throw new ValidationError('echo secret parts must be three strings: prompt, echo, key')
    }
  }
  const enc = new TextEncoder()
  const segments = [parts.prompt, parts.echo, parts.key].map((p) => enc.encode(p))
  const total = ECHO_KDF_CONTEXT.length + segments.reduce((n, s) => n + 4 + s.length, 0)
  const out = new Uint8Array(total)
  out.set(ECHO_KDF_CONTEXT, 0)
  let offset = ECHO_KDF_CONTEXT.length
  for (const s of segments) {
    new DataView(out.buffer).setUint32(offset, s.length, false)
    out.set(s, offset + 4)
    offset += 4 + s.length
  }
  return out
}

/** Derive the tier-1 KEK from a 3-part echo secret (spec: KEK from ALL parts). */
export async function deriveEchoKey(
  parts: EchoSecretParts,
  salt: Uint8Array,
): Promise<CryptoKey> {
  return deriveKekFromMaterial(encodeEchoParts(parts), salt)
}

/**
 * Which AES algorithm/usage a {@link deriveSecretKey} result is for:
 * `'aes-kw'` mints a key-wrapping key (`wrapKey`/`unwrapKey`, e.g. for
 * KEK derivation); `'aes-gcm'` mints a direct encrypt/decrypt key (e.g.
 * for the wrap-DEKs primitive in `with-party/team/wrapped-deks.ts`).
 */
export type SecretKeyUsage = 'aes-kw' | 'aes-gcm'

/**
 * Derive a non-extractable AES key from a secret/credential and salt
 * via PBKDF2-SHA256, generalizing {@link deriveKey}'s AES-KW derivation to
 * also cover AES-GCM-usage keys. Callers pin their own `iterations` and
 * `keyUsage` so an existing call site's exact parameters (and thus its
 * derived-key bytes) are preserved verbatim when migrated onto this
 * shared primitive — this is call-site consolidation, not a KDF change.
 */
export async function deriveSecretKey(
  secret: string,
  salt: Uint8Array,
  params: { iterations: number; keyUsage: SecretKeyUsage },
): Promise<CryptoKey> {
  const keyMaterial = await subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'PBKDF2',
    false,
    ['deriveKey'],
  )

  return params.keyUsage === 'aes-gcm'
    ? subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt: salt as BufferSource,
          iterations: params.iterations,
          hash: 'SHA-256',
        },
        keyMaterial,
        { name: 'AES-GCM', length: KEY_BITS },
        false,
        ['encrypt', 'decrypt'],
      )
    : subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt: salt as BufferSource,
          iterations: params.iterations,
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

// ─── Per-record CEK wrapping ───────────────────────────────────────────

/**
 * Derive a **dedicated** AES-KW wrapping key from a collection/tier DEK via
 * HKDF-SHA256, used to wrap/unwrap a per-record CEK.
 *
 * The collection/tier DEKs are AES-256-**GCM** keys (usages
 * `encrypt`/`decrypt`) and cannot themselves act as an AES-KW KEK. We do NOT
 * re-import the raw DEK bytes directly as an AES-KW key — that would reuse one
 * key across two primitives (AES-GCM for `_det`/presence, AES-KW for CEK
 * wrapping), violating key separation. Instead we HKDF-derive a domain-
 * separated KW key (salt `noydb-cek-wrap`), exactly as `derivePresenceKey`
 * derives a separate presence key. The derivation is deterministic, so
 * wrapping the same CEK under the same DEK always yields identical ciphertext
 * — which is what lets an update reuse a record's stable CEK and produce a
 * byte-identical `_cek`. The KW key is independent of the DEK's GCM key.
 *
 * The DEK must be extractable (it is — `generateDEK`/`unwrapKey` mint
 * extractable keys).
 */
async function asKwKey(dek: CryptoKey): Promise<CryptoKey> {
  const rawDek = await subtle.exportKey('raw', dek)
  const hkdfKey = await subtle.importKey('raw', rawDek, 'HKDF', false, ['deriveBits'])
  const salt = new TextEncoder().encode('noydb-cek-wrap')
  const info = new TextEncoder().encode('v1')
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    hkdfKey,
    KEY_BITS,
  )
  return subtle.importKey('raw', bits, 'AES-KW', false, ['wrapKey', 'unwrapKey'])
}

/**
 * AES-KW-wrap a per-record CEK under a collection/tier DEK. Returns base64.
 * Deterministic over `(cek, dek)`.
 */
export async function wrapCek(cek: CryptoKey, dek: CryptoKey): Promise<string> {
  const kw = await asKwKey(dek)
  const wrapped = await subtle.wrapKey('raw', cek, kw, 'AES-KW')
  return bufferToBase64(wrapped)
}

/**
 * Unwrap a per-record CEK from base64 under a collection/tier DEK. Throws
 * `InvalidKeyError` if the wrapped bytes do not authenticate under the DEK.
 */
export async function unwrapCek(wrappedBase64: string, dek: CryptoKey): Promise<CryptoKey> {
  const kw = await asKwKey(dek)
  try {
    return await subtle.unwrapKey(
      'raw',
      base64ToBuffer(wrappedBase64) as BufferSource,
      kw,
      'AES-KW',
      { name: 'AES-GCM', length: KEY_BITS },
      true,
      ['encrypt', 'decrypt'],
    )
  } catch {
    throw new InvalidKeyError()
  }
}

/**
 * Import a raw 32-byte AES-256-GCM record CEK (e.g. from a sealed-CEK
 * delivery binding). Non-extractable, decrypt-only — the imported key is
 * used solely to open the record's `_iv`/`_data` body under `decrypt()`.
 */
export async function importCek(rawKey: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey('raw', rawKey as BufferSource, { name: 'AES-GCM', length: KEY_BITS }, false, ['decrypt'])
}

// ─── Encrypt / Decrypt ─────────────────────────────────────────────────

export interface EncryptResult {
  iv: string   // base64
  data: string // base64
}

/**
 * Encrypt plaintext JSON string with AES-256-GCM. Fresh IV per call.
 *
 * `aad` binds the record's identity into the auth tag (#1041) — see
 * `record-aad.ts` for what is bound and why `_v` is not. A body sealed with
 * AAD can only be opened by a reader supplying the identical bytes, which is
 * what stops an untrusted store from relocating or re-tiering an envelope.
 *
 * Optional **only while the call-site sweep is in progress**. It becomes
 * mandatory once every `encrypt`/`decrypt` pair supplies it, at which point
 * the format version bumps and the reader rejects anything unbound. Until
 * then an omitted `aad` reproduces the previous, unauthenticated behaviour.
 */
export async function encrypt(
  plaintext: string,
  dek: CryptoKey,
  aad?: Uint8Array,
): Promise<EncryptResult> {
  const iv = generateIV()
  const encoded = new TextEncoder().encode(plaintext)

  const ciphertext = await subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as BufferSource,
      ...(aad !== undefined && { additionalData: aad as BufferSource }),
    },
    dek,
    encoded,
  )

  return {
    iv: bufferToBase64(iv),
    data: bufferToBase64(ciphertext),
  }
}

/**
 * Decrypt AES-256-GCM ciphertext. Throws on wrong key or tampered data.
 *
 * `aad` must be byte-identical to what {@link encrypt} was given, or the auth
 * tag fails and this throws `TamperedError` (#1041). Note the asymmetry that
 * makes this useful: a mismatched identity is indistinguishable from a
 * corrupted body, so relocation fails **closed** rather than returning a
 * plausible record in the wrong place.
 */
export async function decrypt(
  ivBase64: string,
  dataBase64: string,
  dek: CryptoKey,
  aad?: Uint8Array,
): Promise<string> {
  const iv = base64ToBuffer(ivBase64)
  const ciphertext = base64ToBuffer(dataBase64)

  try {
    const plaintext = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource,
        ...(aad !== undefined && { additionalData: aad as BufferSource }),
      },
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

// ─── Binary Encrypt / Decrypt ────────

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
 * eTags for blob deduplication. Computed on plaintext bytes
 * before compression and encryption so the eTag identifies content, not
 * ciphertext, and survives re-encryption (key rotation, re-upload).
 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await subtle.digest('SHA-256', data as unknown as BufferSource)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ─── HMAC-SHA-256 ─────────────────────────────

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

// ─── AAD-aware Binary Encrypt / Decrypt ──

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

// ─── Presence Key Derivation ──────────────────────────────

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

// ─── Sealed Field Key Derivation ──────────────────────────

/**
 * Derive a **per-field** AES-256-GCM key from a collection DEK using
 * HKDF-SHA256, used to encrypt a single sensitive field into its own
 * `_sealed[field]` envelope slot (structural group-encryption).
 *
 * Domain-separated from the data DEK (and from the presence/deterministic
 * channels) by the fixed salt `'noydb-sealed'` and an `info` of
 * `JSON.stringify(['noydb-sealed', collectionName, field])`. The JSON-array
 * encoding is injective — each element is separately quoted/escaped — so
 * collection `a/sealed/b` + field `c` cannot collide with collection `a` +
 * field `b/sealed/c`. Each sensitive field gets a **distinct** key, so a
 * `_sealed[a]` ciphertext does not authenticate under field `b`'s key —
 * sealed fields are cryptographically isolated from one another. The
 * collection name keeps the same field name in two collections from sharing a
 * key, mirroring how `derivePresenceKey` / `encryptDeterministic` domain-separate.
 *
 * @param dek            The collection's AES-256-GCM DEK (extractable).
 * @param collectionName Part of the HKDF `info` for domain separation.
 * @param field          Sensitive field name — the rest of the `info`.
 * @returns A non-extractable AES-256-GCM key for that field's sealed slot.
 */
export async function deriveSealedFieldKey(
  dek: CryptoKey,
  collectionName: string,
  field: string,
): Promise<CryptoKey> {
  const rawDek = await subtle.exportKey('raw', dek)
  const hkdfKey = await subtle.importKey('raw', rawDek, 'HKDF', false, ['deriveBits'])
  const salt = new TextEncoder().encode('noydb-sealed')
  // JSON-array encoding is injective: each element is separately quoted/
  // escaped, so collection `a/sealed/b` + field `c` cannot collide with
  // collection `a` + field `b/sealed/c`.
  const info = new TextEncoder().encode(JSON.stringify(['noydb-sealed', collectionName, field]))
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    hkdfKey,
    KEY_BITS,
  )
  return subtle.importKey(
    'raw',
    bits,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Derive a per-record sealed-field key from the record's **per-record CEK**
 * rather than the collection DEK. Same HKDF construction as
 * {@link deriveSealedFieldKey} but with salt `'noydb-sealed-cek'` (distinct
 * from `'noydb-sealed'`), so a CEK-derived key can never collide with a
 * DEK-derived one for the same `{collection, field}`.
 *
 * The point: the sealed ciphertext's only key now flows from the record's CEK.
 * Dropping the record's wrapped `_cek` (crypto-shred / `forget`) makes the key
 * — and thus `_sealed[field]` — unrecoverable, giving sealed fields the same
 * erasure guarantee `_data` already has. The CEK must be extractable (it is —
 * `unwrapCek`/`generateDEK` mint extractable keys).
 *
 * @param cek            The record's AES-256-GCM CEK (extractable).
 * @param collectionName Part of the HKDF `info` for domain separation.
 * @param field          Sensitive field name — the rest of the `info`.
 * @returns A non-extractable AES-256-GCM key for that field's sealed slot.
 */
export async function deriveSealedFieldKeyFromCek(
  cek: CryptoKey,
  collectionName: string,
  field: string,
): Promise<CryptoKey> {
  const rawCek = await subtle.exportKey('raw', cek)
  const hkdfKey = await subtle.importKey('raw', rawCek, 'HKDF', false, ['deriveBits'])
  const salt = new TextEncoder().encode('noydb-sealed-cek')
  const info = new TextEncoder().encode(JSON.stringify(['noydb-sealed-cek', collectionName, field]))
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    hkdfKey,
    KEY_BITS,
  )
  return subtle.importKey(
    'raw',
    bits,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  )
}

// ─── Deterministic Encryption ────────────────────────────

/**
 * Derive the collection's **dedicated deterministic-index key** from its DEK
 * via HKDF-SHA256 (L-1, #554).
 *
 * `_det` slots previously encrypted under the raw collection DEK — the same
 * key `_data` uses with a *randomized*-IV regime while `_det` uses a
 * *deterministic*-IV regime. Two IV regimes on one key is avoidable hygiene
 * debt (~2^-96 theoretical collision), so the deterministic index now gets its
 * own HKDF-separated key: salt `'noydb-det'`, info
 * `JSON.stringify(['noydb-det'])` (the injective JSON-array domain tag, same
 * convention as {@link deriveSealedFieldKey}). Per-field separation still
 * comes from the `'<collection>/<field>'` context inside
 * {@link encryptDeterministic}, exactly as before.
 *
 * The derived key stays **DEK-derived (collection-level)** on purpose: `_det`
 * is carried verbatim through per-record CEK rotation (see
 * `record-keys/sealing.ts`), so its key must not depend on the CEK. It rotates
 * with the collection DEK, like the presence key.
 *
 * The key is minted **extractable** — {@link encryptDeterministic} derives its
 * per-value IV via HKDF over the raw key bytes (an `exportKey` under the
 * hood), which a non-extractable key would forbid. Same in-memory posture as
 * the DEK itself (`generateDEK` mints extractable keys).
 *
 * @param dek The collection's AES-256-GCM DEK (extractable).
 * @returns A dedicated AES-256-GCM key for the `_det` deterministic index.
 */
export async function deriveDeterministicKey(dek: CryptoKey): Promise<CryptoKey> {
  const rawDek = await subtle.exportKey('raw', dek)
  const hkdfKey = await subtle.importKey('raw', rawDek, 'HKDF', false, ['deriveBits'])
  const salt = new TextEncoder().encode('noydb-det')
  const info = new TextEncoder().encode(JSON.stringify(['noydb-det']))
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    hkdfKey,
    KEY_BITS,
  )
  return subtle.importKey(
    'raw',
    bits,
    { name: 'AES-GCM', length: KEY_BITS },
    true,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Derive a deterministic 12-byte IV from `{ DEK, context, plaintext }`
 * via HKDF-SHA256. Given the same three inputs, the IV is identical, so
 * `encryptDeterministic` produces the same ciphertext on every call —
 * which is precisely what enables blind equality search on encrypted
 * fields.
 *
 * **The side channel this opens.** Two records whose field value is the
 * same produce the same ciphertext. An observer with store access can
 * therefore tell which records share a value — not *what* the value is,
 * but the equivalence class. This is the well-known trade-off of
 * deterministic encryption and is why the feature is strictly opt-in
 * per field, guarded by `acknowledgeDeterministicRisk: true` at
 * collection creation.
 *
 * The context string MUST include the collection name and field name,
 * so:
 *   - The same plaintext in two different fields encrypts differently
 *     (no cross-field equality leak).
 *   - The same plaintext in two different collections (different DEKs)
 *     encrypts differently by virtue of the key, even before HKDF
 *     domain separation kicks in.
 */
async function deriveDeterministicIV(
  dek: CryptoKey,
  context: string,
  plaintext: string,
): Promise<Uint8Array> {
  const rawDek = await subtle.exportKey('raw', dek)
  const hkdfKey = await subtle.importKey('raw', rawDek, 'HKDF', false, ['deriveBits'])
  const salt = new TextEncoder().encode('noydb-deterministic-v1')
  const info = new TextEncoder().encode(`${context}\x00${plaintext}`)
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    hkdfKey,
    IV_BYTES * 8,
  )
  return new Uint8Array(bits)
}

/**
 * Encrypt a plaintext string with AES-256-GCM and a deterministic,
 * HKDF-derived IV.
 *
 * The same `{ dek, context, plaintext }` triple always produces the
 * same `{ iv, data }` — call this twice and you can string-compare the
 * ciphertexts to check equality of the inputs without decrypting them.
 *
 * @param context  Domain-separation string — by convention
 *                 `'<collection>/<field>'`. Different contexts encrypt
 *                 the same plaintext to different ciphertexts, so
 *                 `email` in collection `users` does not collide with
 *                 `email` in collection `customers`.
 */
export async function encryptDeterministic(
  plaintext: string,
  dek: CryptoKey,
  context: string,
): Promise<EncryptResult> {
  const iv = await deriveDeterministicIV(dek, context, plaintext)
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

/**
 * Counterpart to {@link encryptDeterministic}. The IV is stored
 * alongside the ciphertext (exactly like the randomized path), so
 * decrypt uses the stored IV and verifies the GCM auth tag — a tampered
 * ciphertext throws `TamperedError` just like randomized AES-GCM.
 */
export async function decryptDeterministic(
  ivBase64: string,
  dataBase64: string,
  dek: CryptoKey,
): Promise<string> {
  return decrypt(ivBase64, dataBase64, dek)
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
