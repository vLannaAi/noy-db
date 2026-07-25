/**
 * #805 — second-device/partition enrollment tests for @noy-db/on-oidc.
 *
 * The firm re-invite is the ONLY way to add a device (no device-to-device
 * handoff — deliberate security decision: a compromised client device must
 * not be able to escalate into persistent multi-device access).
 *
 * Covers:
 * - Two-partition enrollment: one sub, two deviceSecrets/deviceIds, both
 *   unlock independently against a deviceId-aware mock connector
 * - Device management: listOidcDevices / revokeOidcDevice
 * - Independent revocation: revoke A → A fails with the re-invite guidance
 *   (KeyConnectorError 404), B still unlocks
 * - No-self-propagation property: nothing in the public API lets an
 *   enrolled device mint credentials for a new device without a fresh
 *   invite-derived UnlockedKeyring
 * - Backward compat: a legacy server that ignores deviceId degrades to a
 *   single last-write-wins entry; a legacy enrollment record (no deviceId)
 *   still unlocks
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as api from '../src/index.js'
import {
  enrollOidc,
  enrollOidcFromInvite,
  unlockOidc,
  listOidcDevices,
  revokeOidcDevice,
  KeyConnectorError,
  OidcTokenError,
  OidcDeviceSecretNotFoundError,
} from '../src/index.js'
import type { OidcEnrollment, OidcProviderConfig, UnlockedKeyring } from '../src/index.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function makeIdToken(overrides: { sub?: string; exp?: number } = {}): string {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url({ alg: 'ES256', typ: 'JWT', kid: 'kid-1' })
  const payload = b64url({
    iss: 'https://access.line.me',
    sub: 'U4af4980629abcdef0123456789abcdef',
    aud: '1656934047',
    iat: now,
    exp: now + 3600,
    ...overrides,
  })
  return `${header}.${payload}.fakesig`
}

async function makeInviteKeyring(userId: string): Promise<UnlockedKeyring> {
  const dek = await globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
  return {
    userId,
    displayName: userId,
    role: 'member',
    permissions: { invoices: 'ro' },
    deks: new Map([['invoices', dek]]),
    kek: null, // invite-seeded session — the portal client has no passphrase
    salt: new Uint8Array(32).fill(7),
    authenticators: [],
  } as unknown as UnlockedKeyring
}

/**
 * Minimal in-memory Storage — each instance simulates one PARTITION
 * (LINE in-app WebView / external browser / installed PWA each have
 * isolated storage; that isolation is exactly why re-invite exists).
 */
function makeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k) },
    setItem: (k: string, v: string) => { map.set(k, v) },
  } as Storage
}

const TEST_CONFIG: OidcProviderConfig = {
  name: 'LINE',
  issuer: 'https://access.line.me',
  clientId: '1656934047',
  keyConnectorUrl: 'https://kc.example.com',
}

// ─── Mock connectors ──────────────────────────────────────────────────────────

/** deviceId-aware connector: entries keyed by (implicit sub ×) deviceId. */
function makeDeviceAwareConnector() {
  const entries = new Map<string, { encryptedServerHalf: string; iv: string; createdAt: string }>()
  const LEGACY = '__no-device-id__'

  const mockFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    const method = (init?.method ?? 'GET').toUpperCase()

    if (method === 'PUT' && u.pathname === '/kek-fragment') {
      const body = JSON.parse(init?.body as string) as {
        encryptedServerHalf: string; iv: string; deviceId?: string
      }
      entries.set(body.deviceId ?? LEGACY, {
        encryptedServerHalf: body.encryptedServerHalf,
        iv: body.iv,
        createdAt: new Date().toISOString(),
      })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    if (method === 'GET' && u.pathname === '/kek-fragment/devices') {
      const devices = [...entries.entries()]
        .filter(([id]) => id !== LEGACY)
        .map(([deviceId, e]) => ({ deviceId, createdAt: e.createdAt }))
      return new Response(JSON.stringify({ devices }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (method === 'GET' && u.pathname === '/kek-fragment') {
      const entry = entries.get(u.searchParams.get('deviceId') ?? LEGACY)
      if (!entry) return new Response('Not found', { status: 404 })
      return new Response(
        JSON.stringify({ encryptedServerHalf: entry.encryptedServerHalf, iv: entry.iv }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    if (method === 'DELETE' && u.pathname === '/kek-fragment') {
      const deviceId = u.searchParams.get('deviceId')
      if (deviceId) entries.delete(deviceId)
      return new Response(null, { status: 204 })
    }

    return new Response('Method not allowed', { status: 405 })
  })

  return { mockFetch, entries }
}

/** Legacy v1 connector: IGNORES deviceId — one slot per sub, last write wins. */
function makeLegacySingleSlotConnector() {
  let stored: { encryptedServerHalf: string; iv: string } | null = null
  let putCount = 0

  const mockFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'PUT' && u.pathname === '/kek-fragment') {
      const body = JSON.parse(init?.body as string) as { encryptedServerHalf: string; iv: string }
      stored = { encryptedServerHalf: body.encryptedServerHalf, iv: body.iv }
      putCount += 1
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (method === 'GET' && u.pathname === '/kek-fragment') {
      if (!stored) return new Response('Not found', { status: 404 })
      return new Response(JSON.stringify(stored), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('Not found', { status: 404 })
  })

  return { mockFetch, getPutCount: () => putCount }
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

// ─── Two-partition enrollment ─────────────────────────────────────────────────

describe('two-partition enrollment (one sub, per-device serverHalf entries)', () => {
  it('each partition gets its own deviceId + deviceSecret; both unlock independently', async () => {
    const token = makeIdToken()
    const { mockFetch, entries } = makeDeviceAwareConnector()
    vi.stubGlobal('fetch', mockFetch)

    // Partition A: first enrollment (e.g. LINE in-app WebView).
    const storageA = makeStorage()
    const enrollmentA = await enrollOidc(
      await makeInviteKeyring('portal-somchai'), 'company-a', TEST_CONFIG, token, { storage: storageA },
    )

    // Partition B: installed PWA — fresh FIRM re-invite, invite-seeded
    // keyring, new deviceSecret + deviceId. Same keyring identity, no new
    // principal.
    const storageB = makeStorage()
    const enrollmentB = await enrollOidcFromInvite(
      await makeInviteKeyring('portal-somchai'), 'company-a', TEST_CONFIG, token, { storage: storageB },
    )

    expect(enrollmentA.deviceId).toBeTruthy()
    expect(enrollmentB.deviceId).toBeTruthy()
    expect(enrollmentA.deviceId).not.toBe(enrollmentB.deviceId)
    expect(entries.size).toBe(2) // two (sub, deviceId) entries on the connector

    const unlockedA = await unlockOidc(enrollmentA, TEST_CONFIG, token, { storage: storageA })
    const unlockedB = await unlockOidc(enrollmentB, TEST_CONFIG, token, { storage: storageB })
    expect(unlockedA.userId).toBe('portal-somchai')
    expect(unlockedB.userId).toBe('portal-somchai')
  })

  it('listOidcDevices enumerates both device entries', async () => {
    const token = makeIdToken()
    const { mockFetch } = makeDeviceAwareConnector()
    vi.stubGlobal('fetch', mockFetch)

    const a = await enrollOidc(
      await makeInviteKeyring('u1'), 'company-a', TEST_CONFIG, token, { storage: makeStorage() },
    )
    const b = await enrollOidcFromInvite(
      await makeInviteKeyring('u1'), 'company-a', TEST_CONFIG, token, { storage: makeStorage() },
    )

    const devices = await listOidcDevices(TEST_CONFIG, token)
    const ids = devices.map((d) => d.deviceId).sort()
    expect(ids).toEqual([a.deviceId, b.deviceId].sort())
  })
})

// ─── Independent revocation ───────────────────────────────────────────────────

describe('independent device revocation', () => {
  it('revoking A makes A fail with re-invite guidance (404); B still unlocks', async () => {
    const token = makeIdToken()
    const { mockFetch } = makeDeviceAwareConnector()
    vi.stubGlobal('fetch', mockFetch)

    const storageA = makeStorage()
    const storageB = makeStorage()
    const enrollmentA = await enrollOidc(
      await makeInviteKeyring('u1'), 'company-a', TEST_CONFIG, token, { storage: storageA },
    )
    const enrollmentB = await enrollOidcFromInvite(
      await makeInviteKeyring('u1'), 'company-a', TEST_CONFIG, token, { storage: storageB },
    )

    await revokeOidcDevice(TEST_CONFIG, token, enrollmentA.deviceId!)

    // A: fragment gone → 404 mapped to the documented re-invite flow. The
    // guidance points at the FIRM (custodian) re-invite — never at a
    // device-to-device handoff.
    const failure = await unlockOidc(enrollmentA, TEST_CONFIG, token, { storage: storageA })
      .then(() => null, (e: unknown) => e as KeyConnectorError)
    expect(failure).toBeInstanceOf(KeyConnectorError)
    expect(failure!.status).toBe(404)
    expect(failure!.message).toMatch(/re-invite/i)
    expect(failure!.message).toMatch(/custodian/i)
    expect(failure!.message).toMatch(/cannot hand off/i)

    // B is untouched — revocation is per-device.
    const unlockedB = await unlockOidc(enrollmentB, TEST_CONFIG, token, { storage: storageB })
    expect(unlockedB.userId).toBe('u1')

    const devices = await listOidcDevices(TEST_CONFIG, token)
    expect(devices.map((d) => d.deviceId)).toEqual([enrollmentB.deviceId])
  })

  it('expired token → OidcTokenError from listOidcDevices/revokeOidcDevice BEFORE any network call', async () => {
    const expired = makeIdToken({ exp: Math.floor(Date.now() / 1000) - 60 })
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)

    await expect(listOidcDevices(TEST_CONFIG, expired)).rejects.toThrow(OidcTokenError)
    await expect(revokeOidcDevice(TEST_CONFIG, expired, 'dev-1')).rejects.toThrow(OidcTokenError)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

// ─── No-self-propagation property ─────────────────────────────────────────────

describe('no self-propagation (firm re-invite is the ONLY new-device path)', () => {
  it('a fresh partition cannot unlock even with a valid token + live server entries — it fails locally before any network call', async () => {
    const token = makeIdToken()
    const { mockFetch } = makeDeviceAwareConnector()
    vi.stubGlobal('fetch', mockFetch)

    const storageA = makeStorage()
    const enrollmentA = await enrollOidc(
      await makeInviteKeyring('u1'), 'company-a', TEST_CONFIG, token, { storage: storageA },
    )
    const callsAfterEnroll = mockFetch.mock.calls.length

    // Fresh partition: valid token, knowledge of the enrollment record,
    // live serverHalf entries for the sub — but NO device secret. The only
    // way forward is a fresh invite-derived UnlockedKeyring (firm re-invite).
    const freshPartition = makeStorage()
    await expect(
      unlockOidc(enrollmentA, TEST_CONFIG, token, { storage: freshPartition }),
    ).rejects.toThrow(OidcDeviceSecretNotFoundError)
    expect(mockFetch.mock.calls.length).toBe(callsAfterEnroll)
  })

  it('the public API surface has no handoff/mint primitive — enrollment REQUIRES an UnlockedKeyring, which only invite/passphrase paths produce', () => {
    // Frozen value-export list. Everything that creates a NEW device entry
    // (enrollOidc / enrollOidcFromInvite) takes an UnlockedKeyring parameter;
    // the only function RETURNING an UnlockedKeyring is unlockOidc, which
    // requires this partition's own prior enrollment (device secret). No
    // export lets an enrolled device mint credentials for another device.
    const valueExports = Object.keys(api).sort()
    expect(valueExports).toEqual([
      'KeyConnectorError',
      'OidcDeviceSecretNotFoundError',
      'OidcTokenError',
      'ValidationError',
      'enrollOidc',
      'enrollOidcFromInvite',
      'isIdTokenExpired',
      'knownProviders',
      'listOidcDevices',
      'parseIdTokenClaims',
      'revokeOidcDevice',
      'unlockOidc',
    ])
  })
})

// ─── Backward compatibility (legacy single-entry server) ─────────────────────

describe('backward compat — server that ignores deviceId', () => {
  it('degrades to last-write-wins: the most recently enrolled partition unlocks', async () => {
    const token = makeIdToken()
    const { mockFetch, getPutCount } = makeLegacySingleSlotConnector()
    vi.stubGlobal('fetch', mockFetch)

    const storageA = makeStorage()
    const storageB = makeStorage()
    await enrollOidc(
      await makeInviteKeyring('u1'), 'company-a', TEST_CONFIG, token, { storage: storageA },
    )
    // Second enrollment clobbers the single per-sub slot (documented
    // degradation of the v1 contract).
    const enrollmentB = await enrollOidcFromInvite(
      await makeInviteKeyring('u1'), 'company-a', TEST_CONFIG, token, { storage: storageB },
    )
    expect(getPutCount()).toBe(2)

    const unlockedB = await unlockOidc(enrollmentB, TEST_CONFIG, token, { storage: storageB })
    expect(unlockedB.userId).toBe('u1')
  })

  it('a legacy enrollment record (no deviceId anywhere) still unlocks', async () => {
    const token = makeIdToken()
    const { mockFetch } = makeLegacySingleSlotConnector()
    vi.stubGlobal('fetch', mockFetch)

    const storage = makeStorage()
    const enrollment = await enrollOidc(
      await makeInviteKeyring('u1'), 'company-a', TEST_CONFIG, token, { storage },
    )

    // Simulate a pre-#805 client's persisted state: enrollment record
    // without deviceId AND no partition-stored device id.
    const { deviceId: _dropped, ...legacyFields } = enrollment
    const legacyEnrollment = legacyFields as OidcEnrollment
    storage.removeItem(`noydb:oidc:device-id:${enrollment.sub}`)

    const unlocked = await unlockOidc(legacyEnrollment, TEST_CONFIG, token, { storage })
    expect(unlocked.userId).toBe('u1')

    // The GET went out with no deviceId query — legacy wire shape.
    const getCall = mockFetch.mock.calls.find(([, init]) =>
      ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'GET')
    expect(String(getCall![0])).toBe('https://kc.example.com/kek-fragment')
  })
})
