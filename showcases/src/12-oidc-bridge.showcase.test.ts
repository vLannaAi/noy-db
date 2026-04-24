/**
 * Showcase 12 — "OIDC Bridge with split-key unlock"
 *
 * Framework: Pure hub + `@noy-db/on-oidc` (no browser glue)
 * Store:     `memory()` for the vault; transparent fetch mock for the
 *            key-connector server
 * Pattern:   Passphrase-less unlock via OIDC ID-token + external
 *            key-connector (Bitwarden-style split-key design)
 * Dimension: Authentication — prove the OIDC bridge wraps a keyring at
 *            enrol time and reconstructs it at unlock without the
 *            passphrase, the ID token, or the key-connector ever
 *            seeing the KEK in full
 *
 * What this proves:
 *   1. `enrollOidc(keyring, vault, config, idToken)` splits the KEK
 *      client-side into `deviceHalf` (stored in localStorage under a
 *      random id) + `serverHalf` (PUT to the key-connector, encrypted
 *      with an HKDF-derived key from the ID token).
 *   2. `unlockOidc(enrollment, config, idToken)` GETs the encrypted
 *      server half back, decrypts with a fresh ID token, XORs the two
 *      halves, and reconstructs the keyring — same userId, same role,
 *      same DEKs.
 *   3. The key-connector (here: a `vi.fn()` mock) only ever sees the
 *      encrypted `serverHalf` blob. It cannot derive the KEK or decrypt
 *      records — classic split-key guarantee.
 *   4. Three test identities round-trip independently; each enrolment
 *      generates its own device secret in localStorage, scoped by
 *      `{ sub, vault, deviceKeyId }`.
 *
 * Test pattern is lifted directly from `packages/on-oidc/__tests__/` —
 * hand-crafted JWTs via a `b64url()` helper, transparent fetch mock for
 * the key-connector. No `oidc-provider` dependency, no Docker, no
 * network round-trips. The showcase runs in happy-dom exactly like the
 * library's own tests, which is the portability bar the integration has
 * already passed.
 *
 * For an interactive demo against a real OIDC provider (Auth0 / Keycloak),
 * see `playground/nuxt/app/pages/oidc.vue` and `docs/guides/oidc-providers.md`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  enrollOidc,
  unlockOidc,
  parseIdTokenClaims,
  isIdTokenExpired,
  type OidcProviderConfig,
} from '@noy-db/on-oidc'
import type { UnlockedKeyring } from '@noy-db/hub'

import { SHOWCASE_PASSPHRASE } from './_fixtures.js'

// ─── Test helpers (mirror packages/on-oidc/__tests__/ conventions) ─────

/**
 * Minimal base64url encoder — the JWT on-disk format. `btoa()` emits
 * standard base64; OIDC wants the URL-safe variant without padding.
 */
function b64url(obj: object): string {
  return btoa(JSON.stringify(obj))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Craft a hand-rolled JWT with the shape `enrollOidc`/`unlockOidc`
 * expect. The signature is `"fake-sig"` — verification isn't this
 * showcase's responsibility. The production path validates tokens at a
 * layer the consumer owns (either the OIDC SDK's `validate_token` call
 * or a `jose`-style JWKS verifier before handing the token to noy-db).
 */
function makeIdToken(overrides: {
  sub?: string
  iss?: string
  aud?: string
  email?: string
  exp?: number
} = {}): string {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url({ alg: 'RS256', typ: 'JWT', kid: 'showcase-key' })
  const payload = b64url({
    sub: 'alice',
    iss: 'https://accounts.example.com',
    aud: 'showcase-client-id',
    iat: now,
    exp: now + 3600,
    email: 'alice@firm.example',
    ...overrides,
  })
  return `${header}.${payload}.fake-sig`
}

/**
 * Build an in-memory `UnlockedKeyring` with a known `userId` + `role` +
 * two DEKs. In a real deployment this comes out of the normal
 * passphrase-driven `createNoydb()` flow — here we construct it
 * directly because the focus is the OIDC wrap, not the underlying
 * encryption primitives.
 */
async function makeKeyring(userId: string): Promise<UnlockedKeyring> {
  const dek = await globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
  return {
    userId,
    displayName: userId.charAt(0).toUpperCase() + userId.slice(1),
    role: 'owner',
    permissions: { invoices: 'rw', clients: 'rw' },
    deks: new Map([['invoices', dek], ['clients', dek]]),
    kek: null as unknown as CryptoKey, // Not needed post-unlock
    salt: new Uint8Array(32).fill(7),
  }
}

/**
 * Transparent mock for the external key-connector server. Stores
 * encrypted `serverHalf` blobs keyed by the `sub` claim the caller
 * presents in its Bearer token (the same way a real key-connector
 * distinguishes users — validate the token server-side, key storage
 * by its `sub`). NEVER decrypts the payload.
 */
function makeKeyConnectorMock(): ReturnType<typeof vi.fn> {
  const stored = new Map<string, { encryptedServerHalf: string; iv: string }>()

  function subFromBearer(init?: RequestInit): string {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const auth = headers['Authorization'] ?? headers['authorization'] ?? ''
    const token = auth.replace(/^Bearer\s+/i, '')
    const payload = token.split('.')[1] ?? ''
    try {
      const decoded = JSON.parse(
        atob(payload.replace(/-/g, '+').replace(/_/g, '/')),
      ) as { sub?: string }
      return decoded.sub ?? ''
    } catch {
      return ''
    }
  }

  return vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const sub = subFromBearer(init)
    if (method === 'PUT') {
      stored.set(sub, JSON.parse(init!.body as string))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (method === 'GET') {
      const val = stored.get(sub)
      return val
        ? new Response(JSON.stringify(val), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response('Not found', { status: 404 })
    }
    return new Response('Method not allowed', { status: 405 })
  })
}

const TEST_CONFIG: OidcProviderConfig = {
  name: 'ShowcaseProvider',
  issuer: 'https://accounts.example.com',
  clientId: 'showcase-client-id',
  keyConnectorUrl: 'https://kc.example.com/kek-fragment',
}

const VAULT = 'firm-demo'

// ─── The showcase ────────────────────────────────────────────────────────

describe('Showcase 12 — OIDC Bridge (split-key unlock)', () => {
  // Silence the unused-import warning for SHOWCASE_PASSPHRASE —
  // it's kept available in case a future step needs to open a real
  // vault alongside the OIDC flow.
  void SHOWCASE_PASSPHRASE

  beforeEach(() => {
    // Each test starts with a clean localStorage so device secrets from
    // one test don't leak into another.
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('step 1 — parseIdTokenClaims surfaces the sub/iss/aud without verification', () => {
    // Before enrolment, a caller will typically inspect the token to
    // decide which provider config to use, whether to refresh, etc.
    // `parseIdTokenClaims` is the public helper for that — it does NOT
    // verify the signature.
    const token = makeIdToken({ sub: 'alice', email: 'alice@firm.example' })
    const claims = parseIdTokenClaims(token)
    expect(claims.sub).toBe('alice')
    expect(claims.iss).toBe('https://accounts.example.com')
    expect(claims.aud).toBe('showcase-client-id')
    expect(claims.email).toBe('alice@firm.example')

    // And a cheap pre-flight to catch expired tokens before hitting the
    // key-connector.
    expect(isIdTokenExpired(token)).toBe(false)
    const stale = makeIdToken({ exp: Math.floor(Date.now() / 1000) - 60 })
    expect(isIdTokenExpired(stale)).toBe(true)
  })

  it('step 2 — enrollOidc splits the KEK and PUTs the server half', async () => {
    const mockFetch = makeKeyConnectorMock()
    vi.stubGlobal('fetch', mockFetch)

    const keyring = await makeKeyring('alice')
    const token = makeIdToken({ sub: 'alice' })
    const enrollment = await enrollOidc(keyring, VAULT, TEST_CONFIG, token)

    // Enrolment record carries the sub (for later lookup) + a deviceKeyId
    // (a random id scoping the localStorage device secret).
    expect(enrollment.sub).toBe('alice')
    expect(enrollment.deviceKeyId).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect((enrollment as unknown as { _noydb_oidc: number })._noydb_oidc).toBe(1)

    // Device secret landed in localStorage (the clearBeforeEach guarantees
    // any key here is from this enrolment). The key-connector got one
    // PUT with the encrypted server half.
    const lsKeys = Object.keys(localStorage)
    expect(lsKeys.length).toBeGreaterThan(0)

    const puts = mockFetch.mock.calls.filter(
      ([, init]) => (init?.method ?? 'GET').toUpperCase() === 'PUT',
    )
    expect(puts).toHaveLength(1)
  })

  it('step 3 — unlockOidc reconstructs the keyring with same userId + role + DEKs', async () => {
    const mockFetch = makeKeyConnectorMock()
    vi.stubGlobal('fetch', mockFetch)

    const keyring = await makeKeyring('alice')
    const enrolToken = makeIdToken({ sub: 'alice' })
    const enrollment = await enrollOidc(keyring, VAULT, TEST_CONFIG, enrolToken)

    // Simulate a new session: the user closes the app, reopens it, has
    // a fresh ID token from the provider. The enrolment record (from
    // persistent storage) + the new token are the only inputs to unlock.
    const unlockToken = makeIdToken({ sub: 'alice' })
    const unlocked = await unlockOidc(enrollment, TEST_CONFIG, unlockToken)

    expect(unlocked.userId).toBe('alice')
    expect(unlocked.displayName).toBe('Alice')
    expect(unlocked.role).toBe('owner')
    expect(unlocked.deks.size).toBe(2)
    expect(unlocked.deks.has('invoices')).toBe(true)
    expect(unlocked.deks.has('clients')).toBe(true)
    expect(unlocked.permissions).toEqual({ invoices: 'rw', clients: 'rw' })
  })

  it('step 4 — three identities round-trip independently', async () => {
    // This exercises the multi-user shape the first consumer needs:
    // several staff members unlock the same platform via OIDC, each
    // with their own device secret and their own keyring.
    const mockFetch = makeKeyConnectorMock()
    vi.stubGlobal('fetch', mockFetch)

    const identities = ['alice', 'somchai', 'bob']
    const enrolments = []

    for (const sub of identities) {
      const keyring = await makeKeyring(sub)
      const token = makeIdToken({ sub })
      enrolments.push(await enrollOidc(keyring, VAULT, TEST_CONFIG, token))
    }

    // All three device keys are distinct — no accidental key reuse.
    const deviceKeyIds = new Set(enrolments.map((e) => e.deviceKeyId))
    expect(deviceKeyIds.size).toBe(3)

    // Unlock each with a fresh token; each returns the right keyring.
    for (let i = 0; i < identities.length; i++) {
      const unlockToken = makeIdToken({ sub: identities[i]! })
      const unlocked = await unlockOidc(enrolments[i]!, TEST_CONFIG, unlockToken)
      expect(unlocked.userId).toBe(identities[i])
    }
  })

  it('step 5 — recap: key-connector only ever saw ciphertext', async () => {
    const mockFetch = makeKeyConnectorMock()
    vi.stubGlobal('fetch', mockFetch)

    const keyring = await makeKeyring('alice')
    await enrollOidc(
      keyring,
      VAULT,
      TEST_CONFIG,
      makeIdToken({ sub: 'alice' }),
    )

    // Inspect every PUT/GET body the mock saw. None of them contain
    // plaintext fields — no "alice", no "owner", no "rw", no DEK bytes.
    // Just `{ encryptedServerHalf, iv }`, both base64 blobs.
    const bodies = mockFetch.mock.calls
      .map(([, init]) => init?.body as string | undefined)
      .filter((b): b is string => typeof b === 'string')

    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) {
      expect(body).not.toContain('alice')
      expect(body).not.toContain('owner')
      expect(body).not.toContain('"rw"')
      expect(body).not.toContain('invoices')

      const parsed = JSON.parse(body) as Record<string, unknown>
      expect(parsed['encryptedServerHalf']).toMatch(/^[A-Za-z0-9+/=]+$/)
      expect(parsed['iv']).toMatch(/^[A-Za-z0-9+/=]+$/)
    }
  })
})
