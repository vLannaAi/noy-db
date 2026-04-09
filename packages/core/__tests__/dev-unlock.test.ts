/**
 * Tests for v0.7 #119 — dev-mode persistent unlock
 *
 * @vitest-environment happy-dom
 *
 * Covers:
 * - enableDevUnlock() serializes DEKs into sessionStorage and emits warning
 * - loadDevUnlock() reconstructs a fully-functional UnlockedKeyring
 * - clearDevUnlock() removes the stored state
 * - isDevUnlockActive() reflects storage presence
 * - localStorage path (persistAcrossTabs: true)
 * - Production guard (NODE_ENV=production)
 * - Hostname guard (non-localhost)
 * - Acknowledge string enforcement
 * - Malformed / missing storage entries return null
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  enableDevUnlock,
  loadDevUnlock,
  clearDevUnlock,
  isDevUnlockActive,
} from '../src/dev-unlock.js'
import { ValidationError } from '../src/errors.js'
import type { UnlockedKeyring } from '../src/keyring.js'

const ACK = 'I-UNDERSTAND-THIS-DISABLES-UNLOCK-SECURITY'

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeDek(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,    // must be extractable so dev-unlock can export it
    ['encrypt', 'decrypt'],
  )
}

async function makeKeyring(overrides?: Partial<UnlockedKeyring>): Promise<UnlockedKeyring> {
  const dek = await makeDek()
  return {
    userId: 'alice',
    displayName: 'Alice',
    role: 'owner',
    permissions: { invoices: 'rw' },
    deks: new Map([['invoices', dek]]),
    kek: null as unknown as CryptoKey,
    salt: new Uint8Array(32).fill(7),
    ...overrides,
  }
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  // happy-dom: window.location.hostname defaults to 'localhost' — safe for guards
})

afterEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  vi.restoreAllMocks()
})

// ─── Core round-trip ──────────────────────────────────────────────────────────

describe('enableDevUnlock + loadDevUnlock round-trip', () => {
  it('stores and retrieves a keyring via sessionStorage', async () => {
    const keyring = await makeKeyring()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await enableDevUnlock('company-a', 'alice', keyring, { acknowledge: ACK })

    expect(warnSpy).toHaveBeenCalledOnce()

    const loaded = await loadDevUnlock('company-a', 'alice')
    expect(loaded).not.toBeNull()
    expect(loaded!.userId).toBe('alice')
    expect(loaded!.displayName).toBe('Alice')
    expect(loaded!.role).toBe('owner')
    expect(loaded!.permissions).toEqual({ invoices: 'rw' })
    expect(loaded!.deks.size).toBe(1)
    expect(loaded!.deks.has('invoices')).toBe(true)
  })

  it('reconstructed DEK can actually encrypt + decrypt', async () => {
    const keyring = await makeKeyring()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await enableDevUnlock('company-a', 'alice', keyring, { acknowledge: ACK })
    const loaded = await loadDevUnlock('company-a', 'alice')

    const dek = loaded!.deks.get('invoices')!
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
    const plaintext = new TextEncoder().encode('hello noydb')
    const ciphertext = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, plaintext)
    const decrypted = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, dek, ciphertext)
    expect(new TextDecoder().decode(decrypted)).toBe('hello noydb')
  })

  it('stores salt as base64 and round-trips it correctly', async () => {
    const keyring = await makeKeyring()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await enableDevUnlock('company-a', 'alice', keyring, { acknowledge: ACK })
    const loaded = await loadDevUnlock('company-a', 'alice')

    expect(loaded!.salt).toBeInstanceOf(Uint8Array)
    const saltBytes = loaded!.salt as Uint8Array
    expect(saltBytes.length).toBe(32)
    expect(saltBytes[0]).toBe(7)  // matches makeKeyring fill(7)
  })

  it('handles multiple DEKs (multi-collection keyring)', async () => {
    const dek1 = await makeDek()
    const dek2 = await makeDek()
    const keyring = await makeKeyring({
      deks: new Map([['invoices', dek1], ['clients', dek2]]),
      permissions: { invoices: 'rw', clients: 'ro' },
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await enableDevUnlock('company-b', 'bob', keyring, { acknowledge: ACK })
    const loaded = await loadDevUnlock('company-b', 'bob')

    expect(loaded!.deks.size).toBe(2)
    expect(loaded!.deks.has('invoices')).toBe(true)
    expect(loaded!.deks.has('clients')).toBe(true)
  })

  it('scopes storage key to compartment + userId', async () => {
    const k1 = await makeKeyring({ userId: 'alice', role: 'owner' })
    const k2 = await makeKeyring({ userId: 'bob', role: 'viewer' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await enableDevUnlock('company-a', 'alice', k1, { acknowledge: ACK })
    await enableDevUnlock('company-a', 'bob', k2, { acknowledge: ACK })

    const l1 = await loadDevUnlock('company-a', 'alice')
    const l2 = await loadDevUnlock('company-a', 'bob')
    expect(l1!.role).toBe('owner')
    expect(l2!.role).toBe('viewer')
  })
})

// ─── localStorage path ────────────────────────────────────────────────────────

describe('persistAcrossTabs: true (localStorage)', () => {
  it('stores in localStorage, not sessionStorage', async () => {
    const keyring = await makeKeyring()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await enableDevUnlock('company-a', 'alice', keyring, {
      acknowledge: ACK,
      persistAcrossTabs: true,
    })

    // sessionStorage should be empty
    expect(sessionStorage.length).toBe(0)
    // localStorage should have an entry
    expect(localStorage.length).toBe(1)
  })

  it('loads from localStorage when persistAcrossTabs is specified', async () => {
    const keyring = await makeKeyring()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await enableDevUnlock('company-a', 'alice', keyring, {
      acknowledge: ACK,
      persistAcrossTabs: true,
    })

    const loaded = await loadDevUnlock('company-a', 'alice', { persistAcrossTabs: true })
    expect(loaded).not.toBeNull()
    expect(loaded!.userId).toBe('alice')

    // Without the flag should return null (different storage)
    const notFound = await loadDevUnlock('company-a', 'alice')
    expect(notFound).toBeNull()
  })
})

// ─── clearDevUnlock ───────────────────────────────────────────────────────────

describe('clearDevUnlock', () => {
  it('removes the stored entry', async () => {
    const keyring = await makeKeyring()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await enableDevUnlock('company-a', 'alice', keyring, { acknowledge: ACK })
    expect(await loadDevUnlock('company-a', 'alice')).not.toBeNull()

    clearDevUnlock('company-a', 'alice')
    expect(await loadDevUnlock('company-a', 'alice')).toBeNull()
  })

  it('is a no-op when nothing is stored', () => {
    expect(() => clearDevUnlock('company-a', 'alice')).not.toThrow()
  })

  it('only removes the specified compartment+userId pair', async () => {
    const k1 = await makeKeyring({ userId: 'alice' })
    const k2 = await makeKeyring({ userId: 'bob' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await enableDevUnlock('company-a', 'alice', k1, { acknowledge: ACK })
    await enableDevUnlock('company-a', 'bob', k2, { acknowledge: ACK })

    clearDevUnlock('company-a', 'alice')

    expect(await loadDevUnlock('company-a', 'alice')).toBeNull()
    expect(await loadDevUnlock('company-a', 'bob')).not.toBeNull()
  })
})

// ─── isDevUnlockActive ────────────────────────────────────────────────────────

describe('isDevUnlockActive', () => {
  it('returns false when nothing stored', () => {
    expect(isDevUnlockActive('company-a', 'alice')).toBe(false)
  })

  it('returns true after enableDevUnlock', async () => {
    const keyring = await makeKeyring()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await enableDevUnlock('company-a', 'alice', keyring, { acknowledge: ACK })
    expect(isDevUnlockActive('company-a', 'alice')).toBe(true)
  })

  it('returns false after clearDevUnlock', async () => {
    const keyring = await makeKeyring()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await enableDevUnlock('company-a', 'alice', keyring, { acknowledge: ACK })
    clearDevUnlock('company-a', 'alice')
    expect(isDevUnlockActive('company-a', 'alice')).toBe(false)
  })
})

// ─── Production guard ─────────────────────────────────────────────────────────

describe('production guard', () => {
  it('throws if NODE_ENV is "production"', async () => {
    const orig = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const keyring = await makeKeyring()
      await expect(
        enableDevUnlock('company-a', 'alice', keyring, { acknowledge: ACK }),
      ).rejects.toThrow(ValidationError)
    } finally {
      process.env.NODE_ENV = orig
    }
  })

  it('throws if hostname is not localhost', async () => {
    // Override hostname to simulate prod domain
    const locationDescriptor = Object.getOwnPropertyDescriptor(window, 'location')
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: { ...window.location, hostname: 'app.example.com' },
    })
    try {
      const keyring = await makeKeyring()
      await expect(
        enableDevUnlock('company-a', 'alice', keyring, { acknowledge: ACK }),
      ).rejects.toThrow(ValidationError)
    } finally {
      if (locationDescriptor) {
        Object.defineProperty(window, 'location', locationDescriptor)
      }
    }
  })
})

// ─── Acknowledge string ───────────────────────────────────────────────────────

describe('acknowledge string', () => {
  it('throws if acknowledge is missing', async () => {
    const keyring = await makeKeyring()
    await expect(
      enableDevUnlock('company-a', 'alice', keyring, { acknowledge: '' }),
    ).rejects.toThrow(ValidationError)
  })

  it('throws if acknowledge is wrong', async () => {
    const keyring = await makeKeyring()
    await expect(
      enableDevUnlock('company-a', 'alice', keyring, { acknowledge: 'yes i understand' }),
    ).rejects.toThrow(ValidationError)
  })

  it('succeeds with exact acknowledge string', async () => {
    const keyring = await makeKeyring()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      enableDevUnlock('company-a', 'alice', keyring, { acknowledge: ACK }),
    ).resolves.toBeUndefined()
  })
})

// ─── Edge cases / resilience ──────────────────────────────────────────────────

describe('edge cases', () => {
  it('loadDevUnlock returns null when storage is empty', async () => {
    expect(await loadDevUnlock('company-a', 'alice')).toBeNull()
  })

  it('loadDevUnlock returns null for malformed JSON', async () => {
    sessionStorage.setItem('noydb:dev-unlock:company-a:alice', 'not-json{{{')
    expect(await loadDevUnlock('company-a', 'alice')).toBeNull()
  })

  it('loadDevUnlock returns null when magic field is wrong', async () => {
    sessionStorage.setItem(
      'noydb:dev-unlock:company-a:alice',
      JSON.stringify({ _noydb_dev_unlock: 99, userId: 'alice', displayName: 'x', role: 'viewer', permissions: {}, deks: {}, salt: '' }),
    )
    expect(await loadDevUnlock('company-a', 'alice')).toBeNull()
  })

  it('loadDevUnlock is safe to call in production (returns null, no throw)', async () => {
    const orig = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      // No stored state → null, no guard thrown
      expect(await loadDevUnlock('company-a', 'alice')).toBeNull()
    } finally {
      process.env.NODE_ENV = orig
    }
  })

  it('clearDevUnlock is safe to call in production (no-op, no throw)', () => {
    const orig = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      expect(() => clearDevUnlock('company-a', 'alice')).not.toThrow()
    } finally {
      process.env.NODE_ENV = orig
    }
  })
})
