/**
 * **Wrap-DEKs primitive** — a single canonical shape for the
 * pattern of "serialize a DEK set, encrypt it under a credential-derived
 * AES-GCM key." Used by:
 *
 *   - **tier-0** — paper recovery entries (`_meta/recovery-paper`),
 *     credential = the printed code.
 *   - **tier-2** — password authenticator slots (`KeyringFile.authenticators`,
 *     `wrapKind: 'deks'`), credential = the user's password.
 *
 * **Not** used by `@noy-db/on-pin` — tier-3 wraps the DEK set under
 * the same conceptual pattern but at **100,000 PBKDF2 iterations**
 * (vs the 600,000 here), because the protection window for a PIN
 * slot is short (idle-timeout-bounded, typically 15 min) and 600k
 * iterations would make every PIN-resume noticeably slow. The wire
 * formats are deliberately incompatible. See `@noy-db/on-pin`'s
 * `PIN_PBKDF2_ITERATIONS` and the threat-model rationale in its
 * module docstring.
 *
 * Previously, the same crypto lived in two places: `mintPaperRecoveryEntry`
 * (in `team/recovery.ts`) and `enrollPasswordAuthenticator` (in
 * `@noy-db/on-password`). Both functions did identical work — PBKDF2
 * the credential, AES-GCM-encrypt the JSON-serialized DEK set — but
 * their implementations had drifted apart enough that fixing a bug
 * in one wouldn't fix the other.
 *
 * This module owns the canonical implementation. Consumers compose:
 *
 *   - `mintPaperRecoveryEntry` is now a thin wrapper that calls
 *     `mintWrappedDeksBlob` and adds `{ codeId, enrolledAt }`.
 *   - `enrollPasswordAuthenticator` calls `mintWrappedDeksBlob` and
 *     wraps the result in the slot envelope.
 *
 * @module
 */

import {
  deriveSecretKey,
  generateSalt,
  generateIV,
  bufferToBase64,
  base64ToBuffer,
  type EnclaveKey,
} from '../../kernel/enclave/index.js'

const PBKDF2_ITERATIONS = 600_000

const subtle = globalThis.crypto.subtle

// ─── Type ──────────────────────────────────────────────────────────────

/**
 * The wrap-DEKs primitive — a serialized + AES-GCM-encrypted DEK set
 * keyed under a credential-derived key.
 *
 * All three fields are base64-encoded so the blob is JSON-safe and
 * round-trips through `_meta/*` envelopes (which carry plaintext
 * JSON in `_data`).
 *
 * Composition: `PaperRecoveryEntry extends WrappedDeksBlob` plus
 * `{ codeId, enrolledAt }`. `KeyringAuthenticatorWrappingDEKs`
 * carries the same three fields with `salt` stored in `meta` for
 * slot-format back-compat (defers moving it to top-level).
 */
export interface WrappedDeksBlob {
  /** Base64 PBKDF2 salt for the credential-derived wrapping key. */
  readonly salt: string
  /** Base64 AES-GCM IV used for the `wrappedDeks` ciphertext. */
  readonly iv: string
  /** Base64 AES-GCM ciphertext of `{ deks: { collection: base64rawDek } }`. */
  readonly wrappedDeks: string
}

// ─── Mint ──────────────────────────────────────────────────────────────

/**
 * Mint a fresh `WrappedDeksBlob` from a DEK set + a string credential.
 *
 * Generates a random salt + IV, derives a 256-bit AES-GCM key via
 * PBKDF2-SHA256(credential, salt, 600K), serializes the DEK set as
 * `{ deks: { coll: rawBase64 } }`, and AES-GCM-encrypts.
 *
 * The `credential` is the user-typed string (recovery code, password,
 * PIN). Caller normalization rules apply (e.g. paper
 * recovery uppercase-strips the code before reaching this function).
 *
 * @param deks - DEK set to wrap. Each DEK must be exportable via
 *               `subtle.exportKey('raw', dek)` (the hub mints DEKs
 *               this way; consumers feeding non-extractable keys
 *               will get `InvalidAccessError` from WebCrypto).
 * @param credential - String input the consumer minted (paper code,
 *               password, PIN). Treated as opaque bytes by PBKDF2.
 */
export async function mintWrappedDeksBlob(
  deks: Map<string, EnclaveKey>,
  credential: string,
): Promise<WrappedDeksBlob> {
  const salt = generateSalt()
  const iv = generateIV()
  const wrappingKey = await deriveWrappingKey(credential, salt)

  // Serialize the DEK set as JSON `{ deks: { collection: base64 } }`.
  const exported: Record<string, string> = {}
  for (const [coll, dek] of deks) {
    const raw = await subtle.exportKey('raw', dek)
    exported[coll] = bufferToBase64(new Uint8Array(raw))
  }
  const plaintext = new TextEncoder().encode(JSON.stringify({ deks: exported }))
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    wrappingKey,
    plaintext as BufferSource,
  )

  return {
    salt: bufferToBase64(salt),
    iv: bufferToBase64(iv),
    wrappedDeks: bufferToBase64(new Uint8Array(ciphertext)),
  }
}

// ─── Unwrap ────────────────────────────────────────────────────────────

/**
 * Reverse of {@link mintWrappedDeksBlob}. Re-derives the wrapping key
 * from the credential + stored salt, AES-GCM-decrypts the wrapped DEK
 * set, and re-imports each DEK as an extractable AES-GCM CryptoKey.
 *
 * Throws (AES-GCM auth tag failure) when the credential doesn't
 * match the blob. Callers iterating over multiple blobs (e.g. paper
 * recovery's "try every entry until one matches") should catch.
 */
export async function unwrapDeksFromBlob(
  blob: WrappedDeksBlob,
  credential: string,
): Promise<Map<string, EnclaveKey>> {
  const wrappingKey = await deriveWrappingKey(credential, base64ToBuffer(blob.salt))
  const plaintext = await subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBuffer(blob.iv) as BufferSource },
    wrappingKey,
    base64ToBuffer(blob.wrappedDeks) as BufferSource,
  )
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as { deks: Record<string, string> }
  const deks = new Map<string, EnclaveKey>()
  for (const [coll, b64] of Object.entries(parsed.deks)) {
    const raw = base64ToBuffer(b64)
    const key = await subtle.importKey(
      'raw',
      raw as BufferSource,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
    deks.set(coll, key)
  }
  return deks
}

// ─── Internals ─────────────────────────────────────────────────────────

async function deriveWrappingKey(credential: string, salt: Uint8Array): Promise<CryptoKey> {
  return deriveSecretKey(credential, salt, { iterations: PBKDF2_ITERATIONS, keyUsage: 'aes-gcm' })
}
