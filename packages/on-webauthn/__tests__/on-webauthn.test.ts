/**
 * Tests for @noy-db/on-webauthn — v0.7 #111
 *
 * Stubs navigator.credentials.create / get so the full enroll→unlock
 * round-trip can be exercised in a browser-like (happy-dom) environment
 * without a physical authenticator.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  enrollWebAuthn,
  unlockWebAuthn,
  isWebAuthnAvailable,
  isValidEnrollment,
  WebAuthnNotAvailableError,
  WebAuthnCancelledError,
  WebAuthnMultiDeviceError,
} from '../src/index.js'
import type { WebAuthnEnrollment } from '../src/index.js'
import type { UnlockedKeyring } from '@noy-db/hub'

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeDek(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
}

async function makeKeyring(): Promise<UnlockedKeyring> {
  const dek = await makeDek()
  return {
    userId: 'alice',
    displayName: 'Alice',
    role: 'owner',
    permissions: { invoices: 'rw' },
    deks: new Map([['invoices', dek]]),
    kek: null as unknown as CryptoKey,
    salt: new Uint8Array(32).fill(5),
  }
}

/**
 * Build authenticator data bytes with a configurable flags byte at position 32.
 * The flags byte layout (bit 3 = BE):
 *   0b00000101 = UP(1) + UV(1) — no BE
 *   0b00001101 = UP(1) + UV(1) + BE(1)
 */
function makeAuthData(beFlag = false): ArrayBuffer {
  const bytes = new Uint8Array(37)
  bytes[32] = beFlag ? 0b00001101 : 0b00000101
  return bytes.buffer
}

/** A fixed PRF output value — 32 random-ish bytes */
const FIXED_PRF_OUTPUT = new Uint8Array(32).map((_, i) => i * 7 + 11).buffer

/** Build a mock PublicKeyCredential for `navigator.credentials.create` */
function mockCreateCredential({
  rawId = new Uint8Array(16).fill(0xab).buffer,
  beFlag = false,
  prfOutput = FIXED_PRF_OUTPUT as ArrayBuffer | null,
} = {}): PublicKeyCredential {
  return {
    id: 'mock-credential-id',
    type: 'public-key',
    rawId,
    response: {
      clientDataJSON: new ArrayBuffer(0),
      attestationObject: new ArrayBuffer(0),
      getAuthenticatorData: () => makeAuthData(beFlag),
      getPublicKey: () => null,
      getPublicKeyAlgorithm: () => -7,
      getTransports: () => [],
    } as unknown as AuthenticatorAttestationResponse,
    getClientExtensionResults: () => ({
      prf: prfOutput != null ? { results: { first: prfOutput } } : undefined,
    }),
    authenticatorAttachment: 'platform' as AuthenticatorAttachment,
    toJSON: () => ({}) as unknown as PublicKeyCredentialJSON,
  } as unknown as PublicKeyCredential
}

/** Build a mock PublicKeyCredential for `navigator.credentials.get` */
function mockGetCredential({
  rawId = new Uint8Array(16).fill(0xab).buffer,
  beFlag = false,
  prfOutput = FIXED_PRF_OUTPUT as ArrayBuffer | null,
} = {}): PublicKeyCredential {
  return {
    id: 'mock-credential-id',
    type: 'public-key',
    rawId,
    response: {
      clientDataJSON: new ArrayBuffer(0),
      authenticatorData: makeAuthData(beFlag),
      signature: new ArrayBuffer(0),
      userHandle: null,
    } as unknown as AuthenticatorAssertionResponse,
    getClientExtensionResults: () => ({
      prf: prfOutput != null ? { results: { first: prfOutput } } : undefined,
    }),
    authenticatorAttachment: 'platform' as AuthenticatorAttachment,
    toJSON: () => ({}) as unknown as PublicKeyCredentialJSON,
  } as unknown as PublicKeyCredential
}

// ─── Test setup ───────────────────────────────────────────────────────────────

function stubWebAuthn({
  createReturn = mockCreateCredential(),
  getReturn = mockGetCredential(),
}: {
  createReturn?: PublicKeyCredential | null
  getReturn?: PublicKeyCredential | null
} = {}) {
  const credsMock = {
    create: vi.fn().mockResolvedValue(createReturn),
    get: vi.fn().mockResolvedValue(getReturn),
    preventSilentAccess: vi.fn(),
    store: vi.fn(),
  }
  vi.stubGlobal('navigator', { ...navigator, credentials: credsMock })
  vi.stubGlobal('PublicKeyCredential', class PublicKeyCredential {})
  return credsMock
}

beforeEach(() => {
  // Reset stubs before each test
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ─── isWebAuthnAvailable ───────────────────────────────────────────────────

describe('isWebAuthnAvailable', () => {
  it('returns false when PublicKeyCredential is missing', () => {
    // happy-dom doesn't define PublicKeyCredential by default
    expect(isWebAuthnAvailable()).toBe(false)
  })

  it('returns true when navigator.credentials and PublicKeyCredential are present', () => {
    stubWebAuthn()
    expect(isWebAuthnAvailable()).toBe(true)
  })
})

// ─── isValidEnrollment ─────────────────────────────────────────────────────

describe('isValidEnrollment', () => {
  it('returns false for null / non-object', () => {
    expect(isValidEnrollment(null)).toBe(false)
    expect(isValidEnrollment(undefined)).toBe(false)
    expect(isValidEnrollment('string')).toBe(false)
  })

  it('returns false when magic field is missing', () => {
    expect(isValidEnrollment({ vault: 'a', userId: 'b', credentialId: 'c', wrappedPayload: 'd', wrapIv: 'e' })).toBe(false)
  })

  it('returns true for a well-formed enrollment', () => {
    const e: WebAuthnEnrollment = {
      _noydb_webauthn: 1,
      vault: 'company-a',
      userId: 'alice',
      credentialId: 'abc',
      prfUsed: true,
      beFlag: false,
      requireSingleDevice: false,
      wrappedPayload: 'payload',
      wrapIv: 'iv',
      enrolledAt: new Date().toISOString(),
    }
    expect(isValidEnrollment(e)).toBe(true)
  })
})

// ─── enrollWebAuthn ────────────────────────────────────────────────────────

describe('enrollWebAuthn', () => {
  it('throws WebAuthnNotAvailableError when WebAuthn is not available', async () => {
    // No stubWebAuthn() — navigator.credentials absent
    const keyring = await makeKeyring()
    await expect(
      enrollWebAuthn(keyring, 'company-a'),
    ).rejects.toThrow(WebAuthnNotAvailableError)
  })

  it('throws WebAuthnCancelledError when navigator.credentials.create returns null', async () => {
    stubWebAuthn({ createReturn: null })
    const keyring = await makeKeyring()
    await expect(
      enrollWebAuthn(keyring, 'company-a'),
    ).rejects.toThrow(WebAuthnCancelledError)
  })

  it('returns an enrollment with prfUsed: true when PRF is available', async () => {
    stubWebAuthn()
    const keyring = await makeKeyring()
    const enrollment = await enrollWebAuthn(keyring, 'company-a')

    expect(enrollment._noydb_webauthn).toBe(1)
    expect(enrollment.vault).toBe('company-a')
    expect(enrollment.userId).toBe('alice')
    expect(enrollment.prfUsed).toBe(true)
    expect(enrollment.beFlag).toBe(false)
    expect(enrollment.requireSingleDevice).toBe(false)
    expect(typeof enrollment.wrappedPayload).toBe('string')
    expect(typeof enrollment.wrapIv).toBe('string')
    expect(typeof enrollment.credentialId).toBe('string')
  })

  it('returns an enrollment with prfUsed: false when PRF is absent (rawId fallback)', async () => {
    stubWebAuthn({
      createReturn: mockCreateCredential({ prfOutput: null }),
    })
    const keyring = await makeKeyring()
    const enrollment = await enrollWebAuthn(keyring, 'company-a')
    expect(enrollment.prfUsed).toBe(false)
  })

  it('captures beFlag: true when authenticator data has BE bit set', async () => {
    stubWebAuthn({
      createReturn: mockCreateCredential({ beFlag: true }),
    })
    const keyring = await makeKeyring()
    const enrollment = await enrollWebAuthn(keyring, 'company-a')
    expect(enrollment.beFlag).toBe(true)
  })

  it('throws WebAuthnMultiDeviceError when requireSingleDevice and BE flag set', async () => {
    stubWebAuthn({
      createReturn: mockCreateCredential({ beFlag: true }),
    })
    const keyring = await makeKeyring()
    await expect(
      enrollWebAuthn(keyring, 'company-a', { requireSingleDevice: true }),
    ).rejects.toThrow(WebAuthnMultiDeviceError)
  })

  it('succeeds when requireSingleDevice is true and BE flag is NOT set', async () => {
    stubWebAuthn({ createReturn: mockCreateCredential({ beFlag: false }) })
    const keyring = await makeKeyring()
    const enrollment = await enrollWebAuthn(keyring, 'company-a', { requireSingleDevice: true })
    expect(enrollment.requireSingleDevice).toBe(true)
    expect(enrollment.beFlag).toBe(false)
  })
})

// ─── enrollWebAuthn → unlockWebAuthn round-trip ────────────────────────────

describe('enrollWebAuthn + unlockWebAuthn round-trip', () => {
  it('PRF path: enroll then unlock returns equivalent keyring', async () => {
    const rawId = new Uint8Array(16).fill(0xcd).buffer

    // Enroll
    stubWebAuthn({
      createReturn: mockCreateCredential({ rawId, prfOutput: FIXED_PRF_OUTPUT }),
    })
    const keyring = await makeKeyring()
    const enrollment = await enrollWebAuthn(keyring, 'company-a')

    // Unlock
    vi.unstubAllGlobals()
    stubWebAuthn({
      getReturn: mockGetCredential({ rawId, prfOutput: FIXED_PRF_OUTPUT }),
    })
    const unlocked = await unlockWebAuthn(enrollment)

    expect(unlocked.userId).toBe('alice')
    expect(unlocked.displayName).toBe('Alice')
    expect(unlocked.role).toBe('owner')
    expect(unlocked.deks.size).toBe(1)
    expect(unlocked.deks.has('invoices')).toBe(true)
  })

  it('rawId fallback path: enroll then unlock returns equivalent keyring', async () => {
    const rawId = new Uint8Array(16).fill(0xef).buffer

    // Enroll without PRF
    stubWebAuthn({
      createReturn: mockCreateCredential({ rawId, prfOutput: null }),
    })
    const keyring = await makeKeyring()
    const enrollment = await enrollWebAuthn(keyring, 'company-a')
    expect(enrollment.prfUsed).toBe(false)

    // Unlock — rawId must match
    vi.unstubAllGlobals()
    stubWebAuthn({
      getReturn: mockGetCredential({ rawId, prfOutput: null }),
    })
    const unlocked = await unlockWebAuthn(enrollment)
    expect(unlocked.userId).toBe('alice')
    expect(unlocked.deks.size).toBe(1)
  })

  it('reconstructed DEK encrypts and decrypts correctly', async () => {
    const rawId = new Uint8Array(16).fill(0x77).buffer
    stubWebAuthn({
      createReturn: mockCreateCredential({ rawId, prfOutput: FIXED_PRF_OUTPUT }),
    })
    const keyring = await makeKeyring()
    const enrollment = await enrollWebAuthn(keyring, 'company-a')

    vi.unstubAllGlobals()
    stubWebAuthn({
      getReturn: mockGetCredential({ rawId, prfOutput: FIXED_PRF_OUTPUT }),
    })
    const unlocked = await unlockWebAuthn(enrollment)

    const dek = unlocked.deks.get('invoices')!
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
    const ct = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      dek,
      new TextEncoder().encode('sensitive-data'),
    )
    const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, dek, ct)
    expect(new TextDecoder().decode(pt)).toBe('sensitive-data')
  })
})

// ─── unlockWebAuthn error cases ────────────────────────────────────────────

describe('unlockWebAuthn error cases', () => {
  it('throws WebAuthnNotAvailableError when WebAuthn is absent', async () => {
    const fakeEnrollment: WebAuthnEnrollment = {
      _noydb_webauthn: 1,
      vault: 'x',
      userId: 'u',
      credentialId: 'abc',
      prfUsed: false,
      beFlag: false,
      requireSingleDevice: false,
      wrappedPayload: 'x',
      wrapIv: 'x',
      enrolledAt: new Date().toISOString(),
    }
    await expect(unlockWebAuthn(fakeEnrollment)).rejects.toThrow(WebAuthnNotAvailableError)
  })

  it('throws WebAuthnCancelledError when navigator.credentials.get returns null', async () => {
    stubWebAuthn({ getReturn: null })
    const rawId = new Uint8Array(16).fill(0xaa).buffer
    stubWebAuthn({
      createReturn: mockCreateCredential({ rawId }),
      getReturn: null,
    })
    const keyring = await makeKeyring()
    const enrollment = await enrollWebAuthn(keyring, 'company-a')

    vi.unstubAllGlobals()
    stubWebAuthn({ getReturn: null })
    await expect(unlockWebAuthn(enrollment)).rejects.toThrow(WebAuthnCancelledError)
  })

  it('throws WebAuthnMultiDeviceError at assertion when requireSingleDevice and BE set', async () => {
    const rawId = new Uint8Array(16).fill(0xbb).buffer
    stubWebAuthn({
      createReturn: mockCreateCredential({ rawId, beFlag: false }),
    })
    const keyring = await makeKeyring()
    const enrollment = await enrollWebAuthn(keyring, 'company-a', { requireSingleDevice: true })

    vi.unstubAllGlobals()
    // At assertion time, BE flag is now set (credential was synced)
    stubWebAuthn({
      getReturn: mockGetCredential({ rawId, beFlag: true, prfOutput: FIXED_PRF_OUTPUT }),
    })
    await expect(unlockWebAuthn(enrollment)).rejects.toThrow(WebAuthnMultiDeviceError)
  })
})
