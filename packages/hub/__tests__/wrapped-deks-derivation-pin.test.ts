/**
 * Pin test — `with-party/team/wrapped-deks.ts`'s `deriveWrappingKey` used to
 * PBKDF2/AES-GCM-derive its wrapping key inline; C6 (enclave contract v1)
 * consolidates that onto the barrel's `derivePassphraseKey` primitive
 * (`kernel/enclave/crypto.ts`). This is call-site consolidation, not a KDF
 * change — the derived key must be byte-identical to what the old inline
 * code produced.
 *
 * Keys are non-extractable, so we can't compare raw bytes directly. Instead
 * we assert equivalence behaviorally: a fixed plaintext encrypted under a key
 * derived by the OLD inline code (reconstructed here as an oracle, verbatim —
 * see `deriveOldWrappingKey`) must decrypt under a key derived by the NEW
 * `derivePassphraseKey` primitive for the same credential/salt, and vice
 * versa. If either derivation produced different bytes, the AES-GCM auth tag
 * would fail and decryption would throw.
 */
import { describe, it, expect } from 'vitest'
import { derivePassphraseKey } from '../src/kernel/enclave/index.js'

const PBKDF2_ITERATIONS = 600_000
const subtle = globalThis.crypto.subtle

/**
 * Oracle: byte-for-byte the OLD inline derivation that lived directly in
 * `wrapped-deks.ts`'s `deriveWrappingKey` before the C6 consolidation.
 */
async function deriveOldWrappingKey(credential: string, salt: Uint8Array): Promise<CryptoKey> {
  const ikm = await subtle.importKey(
    'raw',
    new TextEncoder().encode(credential),
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
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

describe('derivePassphraseKey — byte-identical to the old inline wrapped-deks derivation', () => {
  const credential = 'correct horse battery staple'
  const salt = new Uint8Array(32).fill(7)
  const iv = new Uint8Array(12).fill(3)
  const plaintext = new TextEncoder().encode('pin-test fixed plaintext payload')

  it('ciphertext produced under the OLD key decrypts under the NEW primitive key', async () => {
    const oldKey = await deriveOldWrappingKey(credential, salt)
    const newKey = await derivePassphraseKey(credential, salt, {
      iterations: PBKDF2_ITERATIONS,
      keyUsage: 'aes-gcm',
    })

    const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, oldKey, plaintext as BufferSource)
    const decrypted = await subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, newKey, ciphertext)
    expect(new Uint8Array(decrypted)).toEqual(plaintext)
  })

  it('ciphertext produced under the NEW primitive key decrypts under the OLD key', async () => {
    const oldKey = await deriveOldWrappingKey(credential, salt)
    const newKey = await derivePassphraseKey(credential, salt, {
      iterations: PBKDF2_ITERATIONS,
      keyUsage: 'aes-gcm',
    })

    const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, newKey, plaintext as BufferSource)
    const decrypted = await subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, oldKey, ciphertext)
    expect(new Uint8Array(decrypted)).toEqual(plaintext)
  })

  it('sanity: a mismatched credential does NOT decrypt (the pin would catch a wrong param)', async () => {
    const oldKey = await deriveOldWrappingKey(credential, salt)
    const wrongKey = await derivePassphraseKey('wrong credential', salt, {
      iterations: PBKDF2_ITERATIONS,
      keyUsage: 'aes-gcm',
    })
    const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, oldKey, plaintext as BufferSource)
    await expect(
      subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, wrongKey, ciphertext),
    ).rejects.toThrow()
  })
})
