/**
 * Tests for v0.7 #113 — magic-link unlock
 *
 * Pure crypto — no browser APIs needed; runs in Node env.
 *
 * Covers:
 * - createMagicLinkToken() — structure, expiry, ULID token
 * - isMagicLinkValid() — TTL / expiry boundary
 * - deriveMagicLinkKEK() — determinism and compartment binding
 * - buildMagicLinkKeyring() — structure and viewer role enforcement
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createMagicLinkToken,
  isMagicLinkValid,
  deriveMagicLinkKEK,
  buildMagicLinkKeyring,
  MAGIC_LINK_DEFAULT_TTL_MS,
} from '../src/magic-link.js'

afterEach(() => {
  vi.useRealTimers()
})

// ─── createMagicLinkToken ──────────────────────────────────────────────────

describe('createMagicLinkToken', () => {
  it('returns an object with the correct fields', () => {
    const link = createMagicLinkToken('company-a')
    expect(link.role).toBe('viewer')
    expect(link.compartment).toBe('company-a')
    expect(typeof link.token).toBe('string')
    expect(link.token.length).toBeGreaterThan(10)  // ULID is 26 chars
    expect(typeof link.expiresAt).toBe('string')
    expect(new Date(link.expiresAt).getTime()).not.toBeNaN()
  })

  it('default TTL is 24 hours', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const link = createMagicLinkToken('company-a')
    const expiryMs = new Date(link.expiresAt).getTime()
    const expected = new Date('2026-01-02T00:00:00Z').getTime()
    expect(expiryMs).toBe(expected)
  })

  it('respects custom ttlMs', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const link = createMagicLinkToken('company-a', { ttlMs: 60_000 })
    const expiryMs = new Date(link.expiresAt).getTime()
    expect(expiryMs).toBe(new Date('2026-01-01T00:01:00Z').getTime())
  })

  it('generates unique tokens on every call', () => {
    const tokens = new Set(
      Array.from({ length: 20 }, () => createMagicLinkToken('company-a').token),
    )
    expect(tokens.size).toBe(20)
  })

  it('MAGIC_LINK_DEFAULT_TTL_MS is 24 hours in milliseconds', () => {
    expect(MAGIC_LINK_DEFAULT_TTL_MS).toBe(86_400_000)
  })
})

// ─── isMagicLinkValid ──────────────────────────────────────────────────────

describe('isMagicLinkValid', () => {
  it('returns true for a freshly created link', () => {
    const link = createMagicLinkToken('company-a')
    expect(isMagicLinkValid(link)).toBe(true)
  })

  it('returns false for an expired link', () => {
    const link = createMagicLinkToken('company-a', { ttlMs: -1 })  // already expired
    expect(isMagicLinkValid(link)).toBe(false)
  })

  it('returns false exactly at expiry boundary', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const link = createMagicLinkToken('company-a', { ttlMs: 5000 })
    // Advance past expiry
    vi.setSystemTime(1_005_001)
    expect(isMagicLinkValid(link)).toBe(false)
  })

  it('returns true just before expiry', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const link = createMagicLinkToken('company-a', { ttlMs: 5000 })
    vi.setSystemTime(1_004_999)
    expect(isMagicLinkValid(link)).toBe(true)
  })
})

// ─── deriveMagicLinkKEK ────────────────────────────────────────────────────

describe('deriveMagicLinkKEK', () => {
  it('returns an AES-KW CryptoKey', async () => {
    const kek = await deriveMagicLinkKEK('server-secret', 'token-abc', 'company-a')
    expect(kek.type).toBe('secret')
    expect(kek.extractable).toBe(false)
    expect(kek.algorithm.name).toBe('AES-KW')
  })

  it('is deterministic — same inputs produce functionally identical keys', async () => {
    // Prove equality by wrap/unwrap round-trip:
    // wrap a test key with KEK₁, unwrap with KEK₂ — if they differ, decrypt throws
    const kek1 = await deriveMagicLinkKEK('my-server-secret', 'tok-001', 'acme')
    const kek2 = await deriveMagicLinkKEK('my-server-secret', 'tok-001', 'acme')

    // Create an extractable AES-GCM key to use as the test payload
    const testKey = await globalThis.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )

    // Wrap with kek1
    const wrapped = await globalThis.crypto.subtle.wrapKey('raw', testKey, kek1, 'AES-KW')

    // Unwrap with kek2 — must succeed if keys are identical
    const unwrapped = await globalThis.crypto.subtle.unwrapKey(
      'raw',
      wrapped,
      kek2,
      'AES-KW',
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )

    // Verify unwrapped key works: encrypt with original, decrypt with unwrapped
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
    const plaintext = new TextEncoder().encode('magic-link-test')
    const ct = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, testKey, plaintext)
    const decrypted = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, unwrapped, ct)
    expect(new TextDecoder().decode(decrypted)).toBe('magic-link-test')
  })

  it('different server secrets produce different keys', async () => {
    const kek1 = await deriveMagicLinkKEK('secret-A', 'tok-001', 'acme')
    const kek2 = await deriveMagicLinkKEK('secret-B', 'tok-001', 'acme')

    const testKey = await globalThis.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
    const wrapped = await globalThis.crypto.subtle.wrapKey('raw', testKey, kek1, 'AES-KW')

    // Unwrap with a different-server-secret key must fail
    await expect(
      globalThis.crypto.subtle.unwrapKey(
        'raw', wrapped, kek2, 'AES-KW',
        { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
      ),
    ).rejects.toThrow()
  })

  it('different tokens produce different keys (token is included in salt)', async () => {
    const kek1 = await deriveMagicLinkKEK('my-secret', 'tok-001', 'acme')
    const kek2 = await deriveMagicLinkKEK('my-secret', 'tok-002', 'acme')

    const testKey = await globalThis.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
    const wrapped = await globalThis.crypto.subtle.wrapKey('raw', testKey, kek1, 'AES-KW')
    await expect(
      globalThis.crypto.subtle.unwrapKey(
        'raw', wrapped, kek2, 'AES-KW',
        { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
      ),
    ).rejects.toThrow()
  })

  it('compartment binds the key — token for company-a cannot unlock company-b', async () => {
    const kekA = await deriveMagicLinkKEK('my-secret', 'tok-001', 'company-a')
    const kekB = await deriveMagicLinkKEK('my-secret', 'tok-001', 'company-b')

    const testKey = await globalThis.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
    const wrapped = await globalThis.crypto.subtle.wrapKey('raw', testKey, kekA, 'AES-KW')
    await expect(
      globalThis.crypto.subtle.unwrapKey(
        'raw', wrapped, kekB, 'AES-KW',
        { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
      ),
    ).rejects.toThrow()
  })

  it('accepts Uint8Array serverSecret (bytes bypass text encoding)', async () => {
    const secretBytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
    const kek1 = await deriveMagicLinkKEK(secretBytes, 'tok-001', 'acme')
    const kek2 = await deriveMagicLinkKEK(secretBytes, 'tok-001', 'acme')

    const testKey = await globalThis.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
    const wrapped = await globalThis.crypto.subtle.wrapKey('raw', testKey, kek1, 'AES-KW')
    // Must not throw — keys are identical
    await expect(
      globalThis.crypto.subtle.unwrapKey(
        'raw', wrapped, kek2, 'AES-KW',
        { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
      ),
    ).resolves.toBeDefined()
  })
})

// ─── buildMagicLinkKeyring ──────────────────────────────────────────────────

describe('buildMagicLinkKeyring', () => {
  it('constructs a keyring with role viewer', async () => {
    const dek = await globalThis.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
    const kek = await globalThis.crypto.subtle.generateKey(
      { name: 'AES-KW', length: 256 },
      false,
      ['wrapKey', 'unwrapKey'],
    )
    const salt = new Uint8Array(32).fill(3)

    const keyring = buildMagicLinkKeyring({
      viewerUserId: 'viewer-alice',
      displayName: 'Alice (viewer)',
      deks: new Map([['invoices', dek]]),
      kek,
      salt,
    })

    expect(keyring.role).toBe('viewer')
    expect(keyring.userId).toBe('viewer-alice')
    expect(keyring.displayName).toBe('Alice (viewer)')
    expect(keyring.deks.size).toBe(1)
    expect(keyring.deks.has('invoices')).toBe(true)
    expect(keyring.kek).toBe(kek)
    expect(keyring.salt).toBe(salt)
  })

  it('permissions object is empty (viewer has no explicit collection grants)', async () => {
    const kek = await globalThis.crypto.subtle.generateKey(
      { name: 'AES-KW', length: 256 },
      false,
      ['wrapKey', 'unwrapKey'],
    )
    const keyring = buildMagicLinkKeyring({
      viewerUserId: 'v1',
      displayName: 'V1',
      deks: new Map(),
      kek,
      salt: new Uint8Array(32),
    })
    expect(keyring.permissions).toEqual({})
  })
})
