/**
 * #804 — LINE/LIFF hardening tests for @noy-db/on-oidc.
 *
 * Uses happy-dom (for localStorage) and a fetch mock for the key-connector
 * server — no real LINE or network anywhere (CI law).
 *
 * Covers:
 * - `knownProviders.line` vs the real LINE LIFF token contract (issuer,
 *   channel-scoped aud, ES256 JWKS endpoint)
 * - A recorded-shape LINE LIFF ID-token FIXTURE (structurally real: correct
 *   iss/aud/exp/sub layout, ES256 header, fake signature — client-side
 *   checks are structural only per the package's documented split of
 *   responsibilities)
 * - Token lifecycle: expiry surfaces as OidcTokenError BEFORE any network
 *   call; an unlocked session SURVIVES token expiry
 * - Invite-seeded enrollment: an invite-sourced UnlockedKeyring (no
 *   passphrase anywhere, `kek: null`) enrolls and round-trips fine
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  enrollOidc,
  unlockOidc,
  parseIdTokenClaims,
  isIdTokenExpired,
  knownProviders,
  OidcTokenError,
} from '../src/index.js'
import type { UnlockedKeyring } from '../src/index.js'

// ─── LINE LIFF ID-token fixture ───────────────────────────────────────────────
//
// Recorded SHAPE of a LIFF ID token (https://access.line.me issuer):
//   header  : { alg: 'ES256', typ: 'JWT', kid }        — LINE signs with ES256
//   payload : { iss, sub: 'U'+32hex, aud: channelId,   — aud IS the LINE Login
//               exp: iat+3600, iat, amr: ['linesso'],    channel ID (numeric
//               name, picture, email? }                  string); ~1h lifetime
//   signature: fake — signature verification is the key-connector server's
//              job against https://api.line.me/oauth2/v2.1/certs; this
//              package's client-side checks are structural only.

const LINE_CHANNEL_ID = '1656934047'
const LINE_SUB = 'U4af4980629abcdef0123456789abcdef'

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function makeLineIdToken(overrides: {
  sub?: string
  aud?: string
  iat?: number
  exp?: number
} = {}): string {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url({ alg: 'ES256', typ: 'JWT', kid: 'a2c4e6f8-line-key-1' })
  const payload = b64url({
    iss: 'https://access.line.me',
    sub: LINE_SUB,
    aud: LINE_CHANNEL_ID,
    exp: now + 3600,
    iat: now,
    amr: ['linesso'],
    name: 'Somchai T.',
    picture: 'https://profile.line-scdn.net/0h4af4980629abcdef',
    email: 'somchai@example.com',
    ...overrides,
  })
  return `${header}.${payload}.RmFrZUVTMjU2U2lnbmF0dXJl`
}

// ─── Keyring helpers ──────────────────────────────────────────────────────────

async function makeDek(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
}

/** A passphrase-unlocked keyring (owner session). */
async function makeKeyring(): Promise<UnlockedKeyring> {
  const dek = await makeDek()
  return {
    userId: 'alice',
    displayName: 'Alice',
    role: 'owner',
    permissions: { invoices: 'rw', clients: 'rw' },
    deks: new Map([['invoices', dek], ['clients', dek]]),
    kek: null,
    salt: new Uint8Array(32).fill(9),
    authenticators: [],
  } as unknown as UnlockedKeyring
}

/**
 * The shape an INVITE-SEEDED unlocked keyring has: minted by the firm via
 * `@noy-db/on-magic-link`'s `issueInvite` → recipient's `acceptInvite`.
 * The portal client NEVER had a passphrase — and the keyring carries no
 * passphrase-derived KEK (`kek: null`). Only DEKs/salt/identity matter to
 * enrollment.
 */
async function makeInviteSourcedKeyring(): Promise<UnlockedKeyring> {
  const dek = await makeDek()
  return {
    userId: 'portal-client-somchai',
    displayName: 'Somchai (portal)',
    role: 'member',
    permissions: { invoices: 'ro', etax: 'ro' },
    deks: new Map([['invoices', dek], ['etax', dek]]),
    kek: null,
    salt: new Uint8Array(32).fill(3),
    authenticators: [],
  } as unknown as UnlockedKeyring
}

// ─── Key-connector mock (replay: returns PUT ciphertext verbatim on GET) ─────

function makeKeyConnectorMock() {
  let stored: { encryptedServerHalf: string; iv: string } | null = null
  return vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'PUT') {
      stored = JSON.parse(init?.body as string)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (method === 'GET') {
      if (!stored) return new Response('Not found', { status: 404 })
      return new Response(JSON.stringify(stored), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('Method not allowed', { status: 405 })
  })
}

const LINE_CONFIG = knownProviders.line(LINE_CHANNEL_ID, 'https://kc.example.com')

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

// ─── knownProviders.line vs the LIFF contract ────────────────────────────────

describe('knownProviders.line — LIFF contract', () => {
  it('matches LINE\'s real endpoints (issuer, authorize, token, JWKS)', () => {
    expect(LINE_CONFIG.issuer).toBe('https://access.line.me')
    expect(LINE_CONFIG.authorizationEndpoint).toBe('https://access.line.me/oauth2/v2.1/authorize')
    expect(LINE_CONFIG.tokenEndpoint).toBe('https://api.line.me/oauth2/v2.1/token')
    expect(LINE_CONFIG.jwksUri).toBe('https://api.line.me/oauth2/v2.1/certs')
  })

  it('clientId is the channel ID — LIFF tokens carry it as aud', () => {
    expect(LINE_CONFIG.clientId).toBe(LINE_CHANNEL_ID)
    const claims = parseIdTokenClaims(makeLineIdToken())
    expect(claims.aud).toBe(LINE_CONFIG.clientId)
  })
})

// ─── Recorded-shape fixture parsing ──────────────────────────────────────────

describe('LINE LIFF ID-token fixture', () => {
  it('parseIdTokenClaims extracts the LIFF claim layout', () => {
    const claims = parseIdTokenClaims(makeLineIdToken())
    expect(claims.iss).toBe('https://access.line.me')
    expect(claims.sub).toBe(LINE_SUB)
    expect(claims.aud).toBe(LINE_CHANNEL_ID)
    expect(claims.exp - claims.iat).toBe(3600) // ~1h lifetime, no silent refresh
    expect(claims.email).toBe('somchai@example.com')
  })

  it('enroll + unlock round-trips with the LINE fixture token', async () => {
    const keyring = await makeKeyring()
    const token = makeLineIdToken()
    vi.stubGlobal('fetch', makeKeyConnectorMock())

    const enrollment = await enrollOidc(keyring, 'company-a', LINE_CONFIG, token)
    expect(enrollment.sub).toBe(LINE_SUB)
    expect(enrollment.providerName).toBe('LINE')

    const unlocked = await unlockOidc(enrollment, LINE_CONFIG, token)
    expect(unlocked.userId).toBe('alice')
    expect(unlocked.deks.size).toBe(2)
  })
})

// ─── Token lifecycle ─────────────────────────────────────────────────────────

describe('token lifecycle (LIFF ~1h expiry, no silent refresh)', () => {
  it('expired token → OidcTokenError from enrollOidc BEFORE any network call', async () => {
    const keyring = await makeKeyring()
    const expired = makeLineIdToken({ exp: Math.floor(Date.now() / 1000) - 60 })
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      enrollOidc(keyring, 'company-a', LINE_CONFIG, expired),
    ).rejects.toThrow(OidcTokenError)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('expired token → OidcTokenError from unlockOidc BEFORE any network call', async () => {
    const keyring = await makeKeyring()
    const token = makeLineIdToken()
    vi.stubGlobal('fetch', makeKeyConnectorMock())
    const enrollment = await enrollOidc(keyring, 'company-a', LINE_CONFIG, token)

    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    const expired = makeLineIdToken({ exp: Math.floor(Date.now() / 1000) - 60 })
    await expect(
      unlockOidc(enrollment, LINE_CONFIG, expired),
    ).rejects.toThrow(OidcTokenError)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('an unlocked session SURVIVES token expiry — the token is only needed at serverHalf-fetch time', async () => {
    const keyring = await makeKeyring()
    const token = makeLineIdToken()
    const mockFetch = makeKeyConnectorMock()
    vi.stubGlobal('fetch', mockFetch)

    const enrollment = await enrollOidc(keyring, 'company-a', LINE_CONFIG, token)
    const unlocked = await unlockOidc(enrollment, LINE_CONFIG, token)
    const callsAtUnlock = mockFetch.mock.calls.length

    // Two hours pass — the LIFF token is now well past its ~1h exp.
    const later = Date.now() + 2 * 3600 * 1000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    expect(isIdTokenExpired(token)).toBe(true)

    // The session keeps working: DEKs stay usable, nothing re-checks the
    // token, nothing phones the key-connector again.
    const dek = unlocked.deks.get('invoices')!
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
    const pt = new TextEncoder().encode('post-expiry-write')
    const ct = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, pt)
    const rt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, dek, ct)
    expect(new TextDecoder().decode(rt)).toBe('post-expiry-write')
    expect(mockFetch.mock.calls.length).toBe(callsAtUnlock)
  })
})

// ─── Invite-seeded enrollment (portal client has NO passphrase) ──────────────

describe('invite-seeded enrollment', () => {
  it('an invite-sourced UnlockedKeyring (kek: null) enrolls and round-trips', async () => {
    const keyring = await makeInviteSourcedKeyring()
    const token = makeLineIdToken()
    vi.stubGlobal('fetch', makeKeyConnectorMock())

    // The KEK material arrived via the firm's magic-link invite
    // (acceptInvite → UnlockedKeyring) — enrollOidc binds the LINE sub to
    // it without ever seeing a passphrase.
    const enrollment = await enrollOidc(keyring, 'company-a', LINE_CONFIG, token)
    expect(enrollment.sub).toBe(LINE_SUB)

    const unlocked = await unlockOidc(enrollment, LINE_CONFIG, token)
    expect(unlocked.userId).toBe('portal-client-somchai')
    expect(unlocked.role).toBe('member')
    expect(unlocked.permissions).toEqual({ invoices: 'ro', etax: 'ro' })
    expect(unlocked.deks.has('etax')).toBe(true)
  })
})
