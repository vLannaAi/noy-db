import { describe, it, expect } from 'vitest'
import {
  deriveKey,
  generateDEK,
  wrapKey,
  unwrapKey,
  encrypt,
  decrypt,
  generateIV,
  generateSalt,
  bufferToBase64,
} from '../src/crypto.js'
import { TamperedError, InvalidKeyError } from '../src/errors.js'

describe('crypto', () => {
  // ─── Key Derivation ────────────────────────────────────────────────

  describe('deriveKey', () => {
    it('produces deterministic output for same passphrase + salt', async () => {
      const salt = generateSalt()
      const kek1 = await deriveKey('test-passphrase', salt)
      const kek2 = await deriveKey('test-passphrase', salt)

      // KEK is not extractable, so verify both can unwrap the same wrapped key
      const dek = await generateDEK()
      const wrapped1 = await wrapKey(dek, kek1)
      const unwrapped = await unwrapKey(wrapped1, kek2)
      expect(unwrapped).toBeDefined()
    })

    it('produces different output for different passphrases', async () => {
      const salt = generateSalt()
      const dek = await generateDEK()
      const kek1 = await deriveKey('passphrase-a', salt)
      const kek2 = await deriveKey('passphrase-b', salt)

      const wrapped = await wrapKey(dek, kek1)
      await expect(unwrapKey(wrapped, kek2)).rejects.toThrow(InvalidKeyError)
    })

    it('produces different output for different salts', async () => {
      const salt1 = generateSalt()
      const salt2 = generateSalt()
      const dek = await generateDEK()
      const kek1 = await deriveKey('same-passphrase', salt1)
      const kek2 = await deriveKey('same-passphrase', salt2)

      const wrapped = await wrapKey(dek, kek1)
      await expect(unwrapKey(wrapped, kek2)).rejects.toThrow(InvalidKeyError)
    })
  })

  // ─── DEK Generation ────────────────────────────────────────────────

  describe('generateDEK', () => {
    it('returns a CryptoKey', async () => {
      const dek = await generateDEK()
      expect(dek).toBeInstanceOf(CryptoKey)
      expect(dek.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
    })
  })

  // ─── Key Wrapping ──────────────────────────────────────────────────

  describe('wrapKey / unwrapKey', () => {
    it('round-trips a DEK', async () => {
      const salt = generateSalt()
      const kek = await deriveKey('my-passphrase', salt)
      const dek = await generateDEK()

      const wrapped = await wrapKey(dek, kek)
      expect(typeof wrapped).toBe('string')
      expect(wrapped.length).toBeGreaterThan(0)

      const unwrapped = await unwrapKey(wrapped, kek)
      expect(unwrapped).toBeInstanceOf(CryptoKey)

      // Verify the unwrapped key can encrypt/decrypt the same as original
      const { iv, data } = await encrypt('test', dek)
      const plaintext = await decrypt(iv, data, unwrapped)
      expect(plaintext).toBe('test')
    })

    it('unwrapKey with wrong KEK throws InvalidKeyError', async () => {
      const kek1 = await deriveKey('passphrase-1', generateSalt())
      const kek2 = await deriveKey('passphrase-2', generateSalt())
      const dek = await generateDEK()

      const wrapped = await wrapKey(dek, kek1)
      await expect(unwrapKey(wrapped, kek2)).rejects.toThrow(InvalidKeyError)
    })
  })

  // ─── Encrypt / Decrypt ─────────────────────────────────────────────

  describe('encrypt / decrypt', () => {
    it('round-trips plaintext', async () => {
      const dek = await generateDEK()
      const { iv, data } = await encrypt('hello world', dek)
      const result = await decrypt(iv, data, dek)
      expect(result).toBe('hello world')
    })

    it('handles empty string', async () => {
      const dek = await generateDEK()
      const { iv, data } = await encrypt('', dek)
      const result = await decrypt(iv, data, dek)
      expect(result).toBe('')
    })

    it('handles Unicode / Thai text', async () => {
      const dek = await generateDEK()
      const thai = 'สวัสดีครับ ทดสอบข้อมูลภาษาไทย 🇹🇭'
      const { iv, data } = await encrypt(thai, dek)
      const result = await decrypt(iv, data, dek)
      expect(result).toBe(thai)
    })

    it('handles large payload (1MB)', async () => {
      const dek = await generateDEK()
      const large = 'x'.repeat(1_000_000)
      const { iv, data } = await encrypt(large, dek)
      const result = await decrypt(iv, data, dek)
      expect(result).toBe(large)
    })

    it('handles JSON object serialization', async () => {
      const dek = await generateDEK()
      const obj = { amount: 5000, status: 'draft', client: 'บริษัท ABC' }
      const json = JSON.stringify(obj)
      const { iv, data } = await encrypt(json, dek)
      const result = JSON.parse(await decrypt(iv, data, dek)) as typeof obj
      expect(result).toEqual(obj)
    })

    it('each encrypt produces a different IV', async () => {
      const dek = await generateDEK()
      const { iv: iv1 } = await encrypt('same', dek)
      const { iv: iv2 } = await encrypt('same', dek)
      expect(iv1).not.toBe(iv2)
    })

    it('each encrypt produces different ciphertext', async () => {
      const dek = await generateDEK()
      const { data: d1 } = await encrypt('same', dek)
      const { data: d2 } = await encrypt('same', dek)
      expect(d1).not.toBe(d2)
    })

    it('decrypt with wrong DEK throws TamperedError', async () => {
      const dek1 = await generateDEK()
      const dek2 = await generateDEK()
      const { iv, data } = await encrypt('secret', dek1)
      await expect(decrypt(iv, data, dek2)).rejects.toThrow(TamperedError)
    })

    it('decrypt with tampered ciphertext throws TamperedError', async () => {
      const dek = await generateDEK()
      const { iv, data } = await encrypt('secret', dek)

      // Flip a byte in the ciphertext
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0))
      bytes[0] = (bytes[0]! ^ 0xff)
      const tampered = bufferToBase64(bytes)

      await expect(decrypt(iv, tampered, dek)).rejects.toThrow(TamperedError)
    })

    it('decrypt with tampered IV throws TamperedError', async () => {
      const dek = await generateDEK()
      const { iv, data } = await encrypt('secret', dek)

      const ivBytes = Uint8Array.from(atob(iv), c => c.charCodeAt(0))
      ivBytes[0] = (ivBytes[0]! ^ 0xff)
      const tamperedIV = bufferToBase64(ivBytes)

      await expect(decrypt(tamperedIV, data, dek)).rejects.toThrow(TamperedError)
    })
  })

  // ─── Random Generation ─────────────────────────────────────────────

  describe('generateIV', () => {
    it('returns 12 bytes', () => {
      const iv = generateIV()
      expect(iv).toBeInstanceOf(Uint8Array)
      expect(iv.length).toBe(12)
    })

    it('produces unique values', () => {
      const iv1 = generateIV()
      const iv2 = generateIV()
      expect(bufferToBase64(iv1)).not.toBe(bufferToBase64(iv2))
    })
  })

  describe('generateSalt', () => {
    it('returns 32 bytes', () => {
      const salt = generateSalt()
      expect(salt).toBeInstanceOf(Uint8Array)
      expect(salt.length).toBe(32)
    })
  })

  // ─── Performance ───────────────────────────────────────────────────

  describe('performance', () => {
    it('encrypts 1000 records in under 500ms', async () => {
      const dek = await generateDEK()
      const plaintext = JSON.stringify({ amount: 5000, status: 'draft' })

      const start = performance.now()
      const promises = Array.from({ length: 1000 }, () => encrypt(plaintext, dek))
      await Promise.all(promises)
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(500)
    })
  })
})
