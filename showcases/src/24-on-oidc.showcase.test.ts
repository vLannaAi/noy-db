/**
 * Showcase 24 — OIDC split-key unlock
 *
 * What you'll learn
 * ─────────────────
 * `enrollOidc()` XOR-splits the KEK into `deviceHalf` (kept in
 * localStorage, never transmitted) and `serverHalf` (encrypted with a key
 * derived from the OIDC ID token, PUT to a key-connector server).
 * `unlockOidc()` does the reverse: GETs `serverHalf` with a fresh ID
 * token, derives `deviceHalf` from local storage, XORs them, reconstructs
 * the KEK and the keyring.
 *
 * Why it matters
 * ──────────────
 * This is the Bitwarden-style key-connector model: federated login (Google,
 * Apple, Okta, LINE) without the OIDC provider OR the key-connector ever
 * seeing the full KEK. Compromise of one half is not compromise of the
 * vault.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 22-on-passphrase (the keyring shape).
 *
 * What to read next
 * ─────────────────
 *   - showcase 25-on-magic-link (one-shot delegated access)
 *   - docs/subsystems/auth-oidc.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → auths → on-oidc
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { enrollOidc, unlockOidc, parseIdTokenClaims, isIdTokenExpired, type OidcProviderConfig } from '@noy-db/on-oidc'
import type { UnlockedKeyring } from '@noy-db/hub'

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makeIdToken(sub = 'alice', exp?: number): string {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url({ alg: 'RS256', typ: 'JWT' })
  const payload = b64url({ sub, iss: 'https://accounts.example.com', aud: 'showcase-client', iat: now, exp: exp ?? now + 3600 })
  return `${header}.${payload}.fake-sig`
}

async function makeKeyring(userId: string): Promise<UnlockedKeyring> {
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  return {
    userId, displayName: userId, role: 'owner', permissions: { invoices: 'rw' },
    deks: new Map([['invoices', dek]]),
    kek: null as unknown as CryptoKey, salt: new Uint8Array(32).fill(7),
  }
}

function makeKeyConnectorMock() {
  const stored = new Map<string, unknown>()
  return vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const auth = ((init?.headers ?? {}) as Record<string, string>)['Authorization'] ?? ''
    const payload = auth.replace(/^Bearer\s+/i, '').split('.')[1] ?? ''
    const sub = (JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { sub: string }).sub
    if ((init?.method ?? 'GET').toUpperCase() === 'PUT') {
      stored.set(sub, JSON.parse(init!.body as string))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const val = stored.get(sub)
    return val
      ? new Response(JSON.stringify(val), { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response('Not found', { status: 404 })
  })
}

const CONFIG: OidcProviderConfig = {
  name: 'Showcase',
  issuer: 'https://accounts.example.com',
  clientId: 'showcase-client',
  keyConnectorUrl: 'https://kc.example.com/kek',
}

describe('Showcase 24 — OIDC split-key unlock', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('parseIdTokenClaims + isIdTokenExpired are zero-network pre-flights', () => {
    const claims = parseIdTokenClaims(makeIdToken('alice'))
    expect(claims.sub).toBe('alice')
    expect(isIdTokenExpired(makeIdToken('alice'))).toBe(false)
    expect(isIdTokenExpired(makeIdToken('alice', Math.floor(Date.now() / 1000) - 60))).toBe(true)
  })

  it('enroll → unlock reconstructs the keyring; key-connector never sees plaintext', async () => {
    const mockFetch = makeKeyConnectorMock()
    vi.stubGlobal('fetch', mockFetch)

    const enrollment = await enrollOidc(await makeKeyring('alice'), 'demo', CONFIG, makeIdToken('alice'))
    const unlocked = await unlockOidc(enrollment, CONFIG, makeIdToken('alice'))

    expect(unlocked.userId).toBe('alice')
    expect(unlocked.role).toBe('owner')
    expect(unlocked.deks.size).toBe(1)

    // Every body the key-connector saw was opaque ciphertext.
    const bodies = mockFetch.mock.calls
      .map(([, init]) => init?.body as string | undefined)
      .filter((b): b is string => typeof b === 'string')
    for (const body of bodies) {
      expect(body).not.toContain('alice')
      expect(body).not.toContain('owner')
    }
  })
})
