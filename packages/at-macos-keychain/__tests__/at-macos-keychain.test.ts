/**
 * Unit tests for @noy-db/at-macos-keychain — macOS Keychain sealing
 * key provider for managed-secret mode.
 *
 * These tests use an INJECTED memory-backed `KeychainEntry` stub
 * (via the `entry` option), so they run on every platform without
 * touching the real Keychain. The real Keychain integration is
 * exercised by the env-gated darwin-only contract suite in
 * `keychain-integration.test.ts`.
 *
 * The seal/unseal AES-GCM pipeline is fully exercised here — only
 * the OS-Keychain-call part is stubbed out. That's exactly the
 * right split: the AES-GCM code is platform-independent and can be
 * tested everywhere; only the platform-bound Keychain binding needs
 * a real macOS runner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeychainEntry } from '../src/index.js'
import { macosKeychainSealingProvider } from '../src/index.js'

/** Memory-backed KeychainEntry stub. */
function memoryEntry(): KeychainEntry {
  let stored: string | null = null
  return {
    getPassword: () => stored,
    setPassword: (v: string) => { stored = v },
    deletePassword: () => { const had = stored !== null; stored = null; return had },
  }
}

describe('@noy-db/at-macos-keychain — construction', () => {
  it('throws when service is empty', () => {
    expect(() =>
      macosKeychainSealingProvider({ service: '', account: 'alice', entry: memoryEntry() }),
    ).toThrow(/service.*required/i)
  })

  it('throws when account is empty', () => {
    expect(() =>
      macosKeychainSealingProvider({ service: 'com.acme', account: '', entry: memoryEntry() }),
    ).toThrow(/account.*required/i)
  })

  it('produces the locked pid format `macos-keychain:<service>/<account>`', () => {
    const p = macosKeychainSealingProvider({
      service: 'com.acme.app',
      account: 'alice@acme.example',
      entry: memoryEntry(),
    })
    expect(p.id).toBe('macos-keychain:com.acme.app/alice@acme.example')
  })

  it('preserves service + account case verbatim (no normalization)', () => {
    const p = macosKeychainSealingProvider({
      service: 'Com.Acme.App',
      account: 'Alice@ACME.example',
      entry: memoryEntry(),
    })
    expect(p.id).toBe('macos-keychain:Com.Acme.App/Alice@ACME.example')
  })
})

describe('@noy-db/at-macos-keychain — seal/unseal pipeline', () => {
  it('seal → unseal round-trips arbitrary bytes', async () => {
    const p = macosKeychainSealingProvider({
      service: 'com.acme.app',
      account: 'alice',
      entry: memoryEntry(),
    })
    const original = new TextEncoder().encode('the managed secret bytes')
    const sealed = await p.seal(original)
    expect(sealed).not.toEqual(original) // ciphertext differs
    const unsealed = await p.unseal(sealed)
    expect(new TextDecoder().decode(unsealed)).toBe('the managed secret bytes')
  })

  it('produces different ciphertext for same plaintext (fresh IV per seal)', async () => {
    const p = macosKeychainSealingProvider({
      service: 'com.acme.app',
      account: 'alice',
      entry: memoryEntry(),
    })
    const plaintext = new TextEncoder().encode('same input')
    const a = await p.seal(plaintext)
    const b = await p.seal(plaintext)
    expect(Array.from(a)).not.toEqual(Array.from(b)) // IVs differ
  })

  it('two provider instances sharing the same KeychainEntry unseal each other', async () => {
    // Simulates a process restart: same Keychain item, fresh provider.
    const shared = memoryEntry()
    const p1 = macosKeychainSealingProvider({
      service: 'com.acme.app',
      account: 'alice',
      entry: shared,
    })
    const sealed = await p1.seal(new Uint8Array([1, 2, 3, 4]))
    const p2 = macosKeychainSealingProvider({
      service: 'com.acme.app',
      account: 'alice',
      entry: shared,
    })
    const out = await p2.unseal(sealed)
    expect(Array.from(out)).toEqual([1, 2, 3, 4])
  })

  it('different KeychainEntry backings produce mutually unsealable outputs', async () => {
    const p1 = macosKeychainSealingProvider({
      service: 'com.acme.app',
      account: 'alice',
      entry: memoryEntry(),
    })
    const p2 = macosKeychainSealingProvider({
      service: 'com.acme.app',
      account: 'bob', // different account → different entry → different key
      entry: memoryEntry(),
    })
    const sealedByP1 = await p1.seal(new TextEncoder().encode('secret-A'))
    await expect(p2.unseal(sealedByP1)).rejects.toThrow()
  })

  it('rejects sealed bytes shorter than IV + GCM tag', async () => {
    const p = macosKeychainSealingProvider({
      service: 'com.acme.app',
      account: 'alice',
      entry: memoryEntry(),
    })
    await expect(p.unseal(new Uint8Array([1, 2, 3]))).rejects.toThrow(/too short|invalid/i)
  })

  it('detects tampered ciphertext via AES-GCM auth tag', async () => {
    const p = macosKeychainSealingProvider({
      service: 'com.acme.app',
      account: 'alice',
      entry: memoryEntry(),
    })
    const sealed = await p.seal(new Uint8Array([10, 20, 30, 40]))
    const tampered = new Uint8Array(sealed)
    tampered[15] ^= 0xff // flip a byte in the ciphertext+tag region
    await expect(p.unseal(tampered)).rejects.toThrow()
  })
})

describe('@noy-db/at-macos-keychain — key lifecycle', () => {
  it('generates a fresh 32-byte key on first call when Keychain is empty', async () => {
    const entry = memoryEntry()
    expect(entry.getPassword()).toBeNull() // empty

    const p = macosKeychainSealingProvider({
      service: 'com.acme.app',
      account: 'alice',
      entry,
    })
    await p.seal(new Uint8Array([0])) // triggers getKey() → first-use path

    const stored = entry.getPassword()
    expect(stored).not.toBeNull()
    // 32 bytes → 44 base64 chars (with padding).
    expect(stored).toMatch(/^[A-Za-z0-9+/]{42,44}={0,2}$/)
  })

  it('reads the existing key from Keychain on subsequent calls', async () => {
    // Pre-populate the entry with a known 32-byte key.
    const known32 = new Uint8Array(32)
    for (let i = 0; i < 32; i++) known32[i] = i
    const known32Base64 = btoa(String.fromCharCode(...known32))

    const entry = memoryEntry()
    entry.setPassword(known32Base64)

    const p = macosKeychainSealingProvider({
      service: 'com.acme.app',
      account: 'alice',
      entry,
    })
    const sealed = await p.seal(new Uint8Array([42]))

    // Verify the stored key was unchanged — the provider reads, doesn't overwrite.
    expect(entry.getPassword()).toBe(known32Base64)

    // And the seal/unseal cycle works under this known key.
    const unsealed = await p.unseal(sealed)
    expect(Array.from(unsealed)).toEqual([42])
  })

  it('caches the imported CryptoKey across seal/unseal calls', async () => {
    const entry = memoryEntry()
    const getSpy = vi.spyOn(entry, 'getPassword')

    const p = macosKeychainSealingProvider({
      service: 'com.acme.app',
      account: 'alice',
      entry,
    })

    await p.seal(new Uint8Array([1]))
    await p.seal(new Uint8Array([2]))
    await p.unseal(await p.seal(new Uint8Array([3])))

    // The first call to getKey() reads the entry; later calls reuse
    // the cached CryptoKey. Some implementation latitude — we just
    // assert it doesn't grow linearly with the number of operations.
    expect(getSpy.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('throws when stored key is valid base64 but wrong byte length', async () => {
    const entry = memoryEntry()
    // 8 bytes of base64 → decodes to ~6 bytes, not 32.
    entry.setPassword('AAECAwQF')

    const p = macosKeychainSealingProvider({
      service: 'com.acme.app',
      account: 'alice',
      entry,
    })
    await expect(p.seal(new Uint8Array([0]))).rejects.toThrow(/32|tampered/i)
  })

  it('throws when stored key is not valid base64', async () => {
    const entry = memoryEntry()
    entry.setPassword('!!!not-base64!!!')

    const p = macosKeychainSealingProvider({
      service: 'com.acme.app',
      account: 'alice',
      entry,
    })
    await expect(p.seal(new Uint8Array([0]))).rejects.toThrow()
  })
})

describe('@noy-db/at-macos-keychain — platform guard', () => {
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  })
  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('throws on non-darwin platforms when no test entry is injected', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(() =>
      macosKeychainSealingProvider({ service: 'com.acme.app', account: 'alice' }),
    ).toThrow(/darwin|platform "linux"/i)
  })

  it('does NOT throw on non-darwin when an injected entry is provided (test path)', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(() =>
      macosKeychainSealingProvider({
        service: 'com.acme.app',
        account: 'alice',
        entry: memoryEntry(),
      }),
    ).not.toThrow()
  })

  it('error message points users at alternative at-* packages', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    expect(() =>
      macosKeychainSealingProvider({ service: 'com.acme.app', account: 'alice' }),
    ).toThrow(/at-env|at-wincred|at-libsecret/i)
  })
})
