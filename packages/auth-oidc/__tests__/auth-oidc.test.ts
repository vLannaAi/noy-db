/**
 * Tests for @noy-db/auth-oidc — v0.7 #112
 *
 * Uses happy-dom (for localStorage) and a fetch mock for the key-connector server.
 *
 * Covers:
 * - parseIdTokenClaims() — JWT parsing
 * - isIdTokenExpired() — exp claim check
 * - knownProviders helpers — factory configs
 * - enrollOidc() + unlockOidc() round-trip
 * - Error cases: expired token, missing device secret, connector failures
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  enrollOidc,
  unlockOidc,
  parseIdTokenClaims,
  isIdTokenExpired,
  knownProviders,
  OidcTokenError,
  KeyConnectorError,
  OidcDeviceSecretNotFoundError,
} from '../src/index.js'
import type { OidcProviderConfig, UnlockedKeyring } from '../src/index.js'

// ─── JWT helpers ──────────────────────────────────────────────────────────────

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function makeIdToken(overrides: {
  sub?: string
  iss?: string
  aud?: string
  iat?: number
  exp?: number
  email?: string
} = {}): string {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url({ alg: 'RS256', typ: 'JWT' })
  const payload = b64url({
    sub: 'user-abc-123',
    iss: 'https://accounts.google.com',
    aud: 'my-client-id',
    iat: now,
    exp: now + 3600,
    email: 'alice@example.com',
    ...overrides,
  })
  return `${header}.${payload}.fakesignature`
}

function makeExpiredToken(): string {
  return makeIdToken({ exp: Math.floor(Date.now() / 1000) - 60 })
}

// ─── Keyring helper ───────────────────────────────────────────────────────────

async function makeKeyring(): Promise<UnlockedKeyring> {
  const dek = await globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
  return {
    userId: 'alice',
    displayName: 'Alice',
    role: 'owner',
    permissions: { invoices: 'rw', clients: 'rw' },
    deks: new Map([['invoices', dek], ['clients', dek]]),
    kek: null as unknown as CryptoKey,
    salt: new Uint8Array(32).fill(9),
  }
}

// ─── Key-connector mock ───────────────────────────────────────────────────────

/**
 * Create a fetch mock that simulates a key-connector server.
 * Stores the encrypted serverHalf from PUT and returns it on GET.
 * This is a transparent passthrough — no decryption needed.
 */
function makeKeyConnectorMock() {
  let stored: { encryptedServerHalf: string; iv: string } | null = null

  const mockFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()

    if (method === 'PUT') {
      stored = JSON.parse(init?.body as string)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    if (method === 'GET') {
      if (!stored) {
        return new Response('Not found', { status: 404 })
      }
      return new Response(JSON.stringify(stored), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response('Method not allowed', { status: 405 })
  })

  return mockFetch
}

const TEST_CONFIG: OidcProviderConfig = {
  name: 'TestProvider',
  issuer: 'https://test.example.com',
  clientId: 'client-test',
  keyConnectorUrl: 'https://kc.example.com',
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

// ─── parseIdTokenClaims ────────────────────────────────────────────────────────

describe('parseIdTokenClaims', () => {
  it('extracts sub, exp, iss, aud, email', () => {
    const token = makeIdToken({ sub: 'user-xyz', email: 'x@example.com' })
    const claims = parseIdTokenClaims(token)
    expect(claims.sub).toBe('user-xyz')
    expect(claims.email).toBe('x@example.com')
    expect(claims.iss).toBe('https://accounts.google.com')
    expect(typeof claims.exp).toBe('number')
    expect(typeof claims.iat).toBe('number')
  })

  it('throws OidcTokenError for non-JWT string', () => {
    expect(() => parseIdTokenClaims('not-a-jwt')).toThrow(OidcTokenError)
  })

  it('throws OidcTokenError when sub is missing', () => {
    const header = b64url({ alg: 'RS256' })
    const payload = b64url({ iss: 'x', aud: 'y', iat: 1, exp: 99999999999 })
    expect(() => parseIdTokenClaims(`${header}.${payload}.sig`)).toThrow(OidcTokenError)
  })

  it('throws OidcTokenError when exp is missing', () => {
    const header = b64url({ alg: 'RS256' })
    const payload = b64url({ sub: 'x', iss: 'y', aud: 'z', iat: 1 })
    expect(() => parseIdTokenClaims(`${header}.${payload}.sig`)).toThrow(OidcTokenError)
  })
})

// ─── isIdTokenExpired ──────────────────────────────────────────────────────────

describe('isIdTokenExpired', () => {
  it('returns false for a fresh token', () => {
    expect(isIdTokenExpired(makeIdToken())).toBe(false)
  })

  it('returns true for an expired token', () => {
    expect(isIdTokenExpired(makeExpiredToken())).toBe(true)
  })

  it('returns true for an invalid token (safe fallback)', () => {
    expect(isIdTokenExpired('garbage')).toBe(true)
  })
})

// ─── knownProviders ───────────────────────────────────────────────────────────

describe('knownProviders', () => {
  it('line() returns correct issuer and scopes', () => {
    const cfg = knownProviders.line('my-line-client', 'https://kc.example.com')
    expect(cfg.name).toBe('LINE')
    expect(cfg.issuer).toBe('https://access.line.me')
    expect(cfg.clientId).toBe('my-line-client')
    expect(cfg.keyConnectorUrl).toBe('https://kc.example.com')
    expect(cfg.scopes).toContain('openid')
  })

  it('google() returns correct issuer', () => {
    const cfg = knownProviders.google('my-google-client', 'https://kc.example.com')
    expect(cfg.issuer).toBe('https://accounts.google.com')
    expect(cfg.name).toBe('Google')
  })

  it('apple() returns correct issuer', () => {
    const cfg = knownProviders.apple('my-apple-client', 'https://kc.example.com')
    expect(cfg.issuer).toBe('https://appleid.apple.com')
    expect(cfg.name).toBe('Apple')
  })
})

// ─── enrollOidc ──────────────────────────────────────────────────────────────

describe('enrollOidc', () => {
  it('throws OidcTokenError for expired token', async () => {
    const keyring = await makeKeyring()
    await expect(
      enrollOidc(keyring, 'company-a', TEST_CONFIG, makeExpiredToken()),
    ).rejects.toThrow(OidcTokenError)
  })

  it('saves device secret to localStorage', async () => {
    const keyring = await makeKeyring()
    const token = makeIdToken()
    const mockFetch = makeKeyConnectorMock()
    vi.stubGlobal('fetch', mockFetch)

    await enrollOidc(keyring, 'company-a', TEST_CONFIG, token)

    // A device secret should have been written to localStorage
    const keys = Object.keys(localStorage).filter(k => k.startsWith('noydb:oidc:device-secret:'))
    expect(keys.length).toBe(1)
    const secret = keys[0]!.split(':').pop()
    expect(typeof secret).toBe('string')
    expect(secret!.length).toBeGreaterThan(0)
  })

  it('calls PUT /kek-fragment on the key-connector', async () => {
    const keyring = await makeKeyring()
    const token = makeIdToken()
    const mockFetch = makeKeyConnectorMock()
    vi.stubGlobal('fetch', mockFetch)

    await enrollOidc(keyring, 'company-a', TEST_CONFIG, token)

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0]!
    expect(String(url)).toBe('https://kc.example.com/kek-fragment')
    expect((init as RequestInit).method).toBe('PUT')
  })

  it('returns an enrollment record with correct fields', async () => {
    const keyring = await makeKeyring()
    const token = makeIdToken({ sub: 'enroll-sub-456' })
    const mockFetch = makeKeyConnectorMock()
    vi.stubGlobal('fetch', mockFetch)

    const enrollment = await enrollOidc(keyring, 'company-a', TEST_CONFIG, token)

    expect(enrollment._noydb_oidc).toBe(1)
    expect(enrollment.sub).toBe('enroll-sub-456')
    expect(enrollment.compartment).toBe('company-a')
    expect(enrollment.providerName).toBe('TestProvider')
    expect(typeof enrollment.deviceKeyId).toBe('string')
    expect(typeof enrollment.enrolledAt).toBe('string')
  })

  it('throws KeyConnectorError when PUT returns non-2xx', async () => {
    const keyring = await makeKeyring()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    ))
    await expect(
      enrollOidc(keyring, 'company-a', TEST_CONFIG, makeIdToken()),
    ).rejects.toThrow(KeyConnectorError)
  })
})

// ─── enrollOidc + unlockOidc round-trip ──────────────────────────────────────

describe('enrollOidc + unlockOidc round-trip', () => {
  it('reconstructs the keyring with the same userId and role', async () => {
    const keyring = await makeKeyring()
    const sub = 'roundtrip-user-789'
    const token = makeIdToken({ sub })
    const mockFetch = makeKeyConnectorMock()
    vi.stubGlobal('fetch', mockFetch)

    const enrollment = await enrollOidc(keyring, 'company-a', TEST_CONFIG, token)

    // Use a fresh token (same sub, still valid)
    const unlockToken = makeIdToken({ sub })
    const unlocked = await unlockOidc(enrollment, TEST_CONFIG, unlockToken)

    expect(unlocked.userId).toBe('alice')
    expect(unlocked.displayName).toBe('Alice')
    expect(unlocked.role).toBe('owner')
    expect(unlocked.deks.size).toBe(2)
    expect(unlocked.deks.has('invoices')).toBe(true)
    expect(unlocked.deks.has('clients')).toBe(true)
  })

  it('reconstructed DEK can encrypt and decrypt data', async () => {
    const keyring = await makeKeyring()
    const sub = 'crypto-user'
    const token = makeIdToken({ sub })
    const mockFetch = makeKeyConnectorMock()
    vi.stubGlobal('fetch', mockFetch)

    const enrollment = await enrollOidc(keyring, 'company-a', TEST_CONFIG, token)
    const unlocked = await unlockOidc(enrollment, TEST_CONFIG, makeIdToken({ sub }))

    const dek = unlocked.deks.get('invoices')!
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
    const plaintext = new TextEncoder().encode('confidential-invoice-data')
    const ct = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, plaintext)
    const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, dek, ct)
    expect(new TextDecoder().decode(pt)).toBe('confidential-invoice-data')
  })

  it('reconstructed keyring permissions match original', async () => {
    const keyring = await makeKeyring()
    const sub = 'perms-user'
    const mockFetch = makeKeyConnectorMock()
    vi.stubGlobal('fetch', mockFetch)

    await enrollOidc(keyring, 'company-a', TEST_CONFIG, makeIdToken({ sub }))
    const unlocked = await unlockOidc(enrollment_placeholder(), TEST_CONFIG, makeIdToken({ sub }))
    expect(unlocked.permissions).toEqual({ invoices: 'rw', clients: 'rw' })

    function enrollment_placeholder() {
      return {
        _noydb_oidc: 1 as const,
        providerName: 'TestProvider',
        sub,
        compartment: 'company-a',
        enrolledAt: new Date().toISOString(),
        deviceKeyId: 'ignored',
        enrollmentCount: 1,
      }
    }
  })
})

// ─── unlockOidc error cases ───────────────────────────────────────────────────

describe('unlockOidc error cases', () => {
  it('throws OidcTokenError for expired token', async () => {
    const keyring = await makeKeyring()
    const sub = 'err-user'
    const mockFetch = makeKeyConnectorMock()
    vi.stubGlobal('fetch', mockFetch)

    await enrollOidc(keyring, 'company-a', TEST_CONFIG, makeIdToken({ sub }))

    const enrollment = {
      _noydb_oidc: 1 as const,
      providerName: 'TestProvider',
      sub,
      compartment: 'company-a',
      enrolledAt: new Date().toISOString(),
      deviceKeyId: 'd',
      enrollmentCount: 1,
    }
    await expect(
      unlockOidc(enrollment, TEST_CONFIG, makeExpiredToken()),
    ).rejects.toThrow(OidcTokenError)
  })

  it('throws OidcDeviceSecretNotFoundError when device secret is gone', async () => {
    const enrollment = {
      _noydb_oidc: 1 as const,
      providerName: 'TestProvider',
      sub: 'no-device-secret',
      compartment: 'company-a',
      enrolledAt: new Date().toISOString(),
      deviceKeyId: 'd',
      enrollmentCount: 1,
    }
    vi.stubGlobal('fetch', vi.fn())  // Should not be called
    await expect(
      unlockOidc(enrollment, TEST_CONFIG, makeIdToken({ sub: 'no-device-secret' })),
    ).rejects.toThrow(OidcDeviceSecretNotFoundError)
  })

  it('throws KeyConnectorError when GET returns non-2xx', async () => {
    const keyring = await makeKeyring()
    const sub = 'gc-error-user'
    const mockFetch = makeKeyConnectorMock()
    vi.stubGlobal('fetch', mockFetch)

    await enrollOidc(keyring, 'company-a', TEST_CONFIG, makeIdToken({ sub }))

    // Swap fetch to return error on GET
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('Service unavailable', { status: 503 }),
    ))
    const enrollment = {
      _noydb_oidc: 1 as const,
      providerName: 'TestProvider',
      sub,
      compartment: 'company-a',
      enrolledAt: new Date().toISOString(),
      deviceKeyId: 'd',
      enrollmentCount: 1,
    }
    await expect(
      unlockOidc(enrollment, TEST_CONFIG, makeIdToken({ sub })),
    ).rejects.toThrow(KeyConnectorError)
  })
})
