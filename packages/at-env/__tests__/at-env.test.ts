/**
 * Tests for @noy-db/at-env — env-var sealing key provider for managed-secret mode.
 *
 * The provider implements the {@link SealingKeyProvider} contract from
 * @noy-db/hub: seal(bytes) → sealed bytes; unseal(sealed) → bytes.
 * Sealing is AES-256-GCM under a 32-byte key read from a configurable
 * environment variable (default `NOYDB_SEALING_KEY`, base64-encoded).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { envSealingProvider } from '../src/index.js'

const TEST_ENV = 'NOYDB_TEST_SEALING_KEY'

// 32 bytes of arbitrary but stable test material, base64-encoded.
const TEST_KEY_BASE64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='

describe('@noy-db/at-env — envSealingProvider', () => {
  beforeEach(() => { process.env[TEST_ENV] = TEST_KEY_BASE64 })
  afterEach(() => { delete process.env[TEST_ENV] })

  it('id surfaces the envVar name for audit (non-secret)', () => {
    const p = envSealingProvider({ envVar: TEST_ENV })
    expect(p.id).toBe(`env:${TEST_ENV}`)
  })

  it('seal → unseal round-trips arbitrary bytes', async () => {
    const p = envSealingProvider({ envVar: TEST_ENV })
    const original = new TextEncoder().encode('the managed secret bytes')
    const sealed = await p.seal(original)
    expect(sealed).not.toEqual(original) // ciphertext differs
    const unsealed = await p.unseal(sealed)
    expect(new TextDecoder().decode(unsealed)).toBe('the managed secret bytes')
  })

  it('produces different ciphertext for the same plaintext (fresh IV per seal)', async () => {
    const p = envSealingProvider({ envVar: TEST_ENV })
    const plaintext = new TextEncoder().encode('same input')
    const a = await p.seal(plaintext)
    const b = await p.seal(plaintext)
    expect(Array.from(a)).not.toEqual(Array.from(b)) // IVs differ → AES-GCM output differs
  })

  it('two provider instances built from the same env value unseal each other', async () => {
    const p1 = envSealingProvider({ envVar: TEST_ENV })
    const sealed = await p1.seal(new Uint8Array([1, 2, 3, 4]))
    // Simulate a process restart: same env, fresh provider instance.
    const p2 = envSealingProvider({ envVar: TEST_ENV })
    const out = await p2.unseal(sealed)
    expect(Array.from(out)).toEqual([1, 2, 3, 4])
  })

  it('rejects sealed bytes produced under a different env key', async () => {
    const p1 = envSealingProvider({ envVar: TEST_ENV })
    const sealed = await p1.seal(new TextEncoder().encode('secret'))
    // Swap the env var to a different 32-byte key (reverse byte order of TEST_KEY).
    process.env[TEST_ENV] = 'Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA='
    const p2 = envSealingProvider({ envVar: TEST_ENV })
    await expect(p2.unseal(sealed)).rejects.toThrow()
  })

  it('throws clearly when the env var is not set', () => {
    delete process.env[TEST_ENV]
    expect(() => envSealingProvider({ envVar: TEST_ENV })).toThrow(/not set|missing/i)
  })

  it('throws clearly when the env var is valid base64 but wrong length', () => {
    process.env[TEST_ENV] = 'AAAA' // valid base64, decodes to 3 bytes
    expect(() => envSealingProvider({ envVar: TEST_ENV })).toThrow(/32 bytes|256-bit/i)
  })

  it('throws when the env var is not valid base64', () => {
    process.env[TEST_ENV] = '!!!not-base64!!!'
    expect(() => envSealingProvider({ envVar: TEST_ENV })).toThrow()
  })

  it('defaults to NOYDB_SEALING_KEY when envVar is omitted', () => {
    process.env.NOYDB_SEALING_KEY = TEST_KEY_BASE64
    try {
      const p = envSealingProvider()
      expect(p.id).toBe('env:NOYDB_SEALING_KEY')
    } finally {
      delete process.env.NOYDB_SEALING_KEY
    }
  })

  it('rejects sealed bytes that are shorter than the IV (12 bytes)', async () => {
    const p = envSealingProvider({ envVar: TEST_ENV })
    await expect(p.unseal(new Uint8Array([1, 2, 3]))).rejects.toThrow(/too short|invalid/i)
  })

  it('detects tampered ciphertext via AES-GCM auth tag', async () => {
    const p = envSealingProvider({ envVar: TEST_ENV })
    const sealed = await p.seal(new Uint8Array([10, 20, 30, 40]))
    // Flip a byte past the IV (offset 12) to break the GCM tag.
    const tampered = new Uint8Array(sealed)
    tampered[15] ^= 0xff
    await expect(p.unseal(tampered)).rejects.toThrow()
  })
})

describe('@noy-db/at-env — integration with @noy-db/hub managed-secret mode', () => {
  beforeEach(() => { process.env[TEST_ENV] = TEST_KEY_BASE64 })
  afterEach(() => { delete process.env[TEST_ENV] })

  // 30s timeout (#564): two full managed-mode opens = several 600K-PBKDF2
  // derivations plus first-import transform of three packages — legitimately
  // near the 5s vitest default when parallel suites compete for CPU.
  it('round-trips a managed-mode vault end-to-end (no user secret typed)', async () => {
    const { createNoydb } = await import('@noy-db/hub')
    const { toMemory } = await import('@noy-db/to-memory')
    const { shamirRecoveryProvider } = await import('@noy-db/on-shamir')

    const store = toMemory()
    const provider = envSealingProvider({ envVar: TEST_ENV })

    // First open — hub mints + seals via at-env, derives KEK, and
    // atomically enrolls the strong recovery required by #195 for
    // managed-mode vaults.
    const db1 = await createNoydb({
      store, user: 'alice',
      secretMode: 'managed',
      sealingKey: provider,
      shamirRecovery: shamirRecoveryProvider(),
    })
    const { vault: vault1 } = await db1.team.openVaultAndEnrollRecovery('demo', {
      recovery: [{ profile: 'shamir', k: 2, n: 3 }],
    })
    await vault1.collection<{ id: string; note: string }>('notes').put('n1', {
      id: 'n1', note: 'managed-mode write via at-env',
    })
    db1.close()

    // Second open — fresh provider built from the same env, unseal works.
    const db2 = await createNoydb({
      store, user: 'alice',
      secretMode: 'managed',
      sealingKey: envSealingProvider({ envVar: TEST_ENV }),
      shamirRecovery: shamirRecoveryProvider(),
    })
    const vault2 = await db2.openVault('demo')
    const note = await vault2.collection<{ id: string; note: string }>('notes').get('n1')
    expect(note).toEqual({ id: 'n1', note: 'managed-mode write via at-env' })
    db2.close()
  }, 30_000)
})
