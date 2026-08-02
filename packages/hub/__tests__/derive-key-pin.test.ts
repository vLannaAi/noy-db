/**
 * Pin test — `deriveKey`'s body was refactored (#940) into a shared private
 * `deriveKekFromMaterial` core so `deriveEchoKey` could reuse the same
 * PBKDF2 → AES-KW derivation over AG-1-encoded bytes instead of a raw UTF-8
 * string. This is call-site consolidation, not a KDF change — `deriveKey`
 * must still derive byte-identical PBKDF2-SHA256 (600,000 iterations) /
 * AES-KW (256-bit) keys to what the pre-refactor inline body produced.
 *
 * The key is non-extractable, so we can't compare raw bytes directly.
 * Instead we lean on AES-KW being deterministic: wrapping the same DEK
 * under the OLD (oracle) key and the NEW (`deriveKey`) key for the same
 * secret/salt must produce byte-identical wrapped output.
 */
import { describe, it, expect } from 'vitest'
import { deriveKey, generateDEK, wrapKey } from '../src/kernel/enclave/index.js'

const PBKDF2_ITERATIONS = 600_000
const subtle = globalThis.crypto.subtle

/**
 * Oracle: byte-for-byte the derivation `deriveKey` used inline before the
 * #940 `deriveKekFromMaterial` refactor.
 */
async function deriveOldKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
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
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}

describe('deriveKey — byte-identical to the pre-refactor inline derivation', () => {
  it('wraps the same DEK to byte-identical output under the OLD oracle key and the NEW deriveKey', async () => {
    const secret = 'same secret'
    const salt = new Uint8Array(32).fill(9)
    const dek = await generateDEK()

    const oldKey = await deriveOldKey(secret, salt)
    const newKey = await deriveKey(secret, salt)

    // AES-KW is deterministic, so identical KEK bytes wrap the same DEK to
    // identical ciphertext — this is the byte-identity assertion, since the
    // non-extractable keys themselves cannot be compared directly.
    const wrappedOld = await wrapKey(dek, oldKey)
    const wrappedNew = await wrapKey(dek, newKey)
    expect(wrappedNew).toEqual(wrappedOld)
  })
})
