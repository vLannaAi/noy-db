/**
 * Showcase 23 — WebAuthn passkey unlock
 *
 * What you'll learn
 * ─────────────────
 * `enrollWebAuthn(keyring, vault)` calls `navigator.credentials.create`,
 * reads the PRF extension output, derives a wrapping key with HKDF, and
 * encrypts a keyring summary into a persistable enrolment record.
 * `unlockWebAuthn(enrollment)` calls `navigator.credentials.get` and
 * reproduces the same wrapping key from the same authenticator —
 * reconstructing the full `UnlockedKeyring` (userId, role, permissions,
 * DEKs).
 *
 * Why it matters
 * ──────────────
 * Passkeys + PRF give you passphrase-less unlock with hardware-bound
 * secrecy: the wrapping key never leaves the authenticator, so the
 * enrolment record is opaque to any cloud blob store.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 22-on-passphrase (the keyring shape).
 *
 * What to read next
 * ─────────────────
 *   - showcase 24-on-oidc (federated unlock with split-key)
 *   - docs/subsystems/auth-webauthn.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → auths → on-webauthn
 *
 * Note: WebAuthn requires `navigator.credentials` and `PublicKeyCredential`.
 * happy-dom doesn't ship them, so this showcase installs a synthetic mock
 * — the same pattern the package's own tests use. For an interactive demo
 * against a real Touch ID / YubiKey, see the playground.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  enrollWebAuthn,
  unlockWebAuthn,
  isWebAuthnAvailable,
  WebAuthnMultiDeviceError,
} from '@noy-db/on-webauthn'
import type { UnlockedKeyring } from '@noy-db/hub'

const FIXED_PRF_OUTPUT = new Uint8Array(32).map((_, i) => i * 7 + 11).buffer

function makeAuthData(beFlag = false): ArrayBuffer {
  const bytes = new Uint8Array(37)
  bytes[32] = beFlag ? 0b00001101 : 0b00000101
  return bytes.buffer
}

function mockCredential(kind: 'create' | 'get', beFlag = false, prfOutput: ArrayBuffer | null = FIXED_PRF_OUTPUT) {
  const rawId = new Uint8Array(16).fill(0xab).buffer
  const response = kind === 'create'
    ? {
        clientDataJSON: new ArrayBuffer(0),
        attestationObject: new ArrayBuffer(0),
        getAuthenticatorData: () => makeAuthData(beFlag),
        getPublicKey: () => null,
        getPublicKeyAlgorithm: () => -7,
        getTransports: () => [],
      }
    : {
        clientDataJSON: new ArrayBuffer(0),
        authenticatorData: makeAuthData(beFlag),
        signature: new ArrayBuffer(0),
        userHandle: null,
      }
  return {
    id: 'mock-credential-id',
    type: 'public-key',
    rawId,
    response,
    getClientExtensionResults: () => ({
      prf: prfOutput != null ? { results: { first: prfOutput } } : undefined,
    }),
    authenticatorAttachment: 'platform',
    toJSON: () => ({}),
  } as unknown as PublicKeyCredential
}

function stubWebAuthn() {
  const mock = {
    create: vi.fn().mockResolvedValue(mockCredential('create')),
    get: vi.fn().mockResolvedValue(mockCredential('get')),
    preventSilentAccess: vi.fn(),
    store: vi.fn(),
  }
  vi.stubGlobal('navigator', { ...navigator, credentials: mock })
  vi.stubGlobal('PublicKeyCredential', class {})
  return mock
}

async function makeKeyring(userId: string): Promise<UnlockedKeyring> {
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  return {
    userId,
    displayName: userId.charAt(0).toUpperCase() + userId.slice(1),
    role: 'owner',
    permissions: { invoices: 'rw' },
    deks: new Map([['invoices', dek]]),
    kek: null as unknown as CryptoKey,
    salt: new Uint8Array(32).fill(7),
  }
}

describe('Showcase 23 — WebAuthn passkey unlock', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('isWebAuthnAvailable() is the pre-flight every UI should run', () => {
    expect(isWebAuthnAvailable()).toBe(false)
    stubWebAuthn()
    expect(isWebAuthnAvailable()).toBe(true)
  })

  it('enroll → unlock round-trip reproduces the same keyring', async () => {
    stubWebAuthn()
    const enrollment = await enrollWebAuthn(await makeKeyring('alice'), 'demo')

    expect(enrollment.userId).toBe('alice')
    expect(enrollment.prfUsed).toBe(true)
    // The wrapped payload is opaque ciphertext — safe to drop in any cloud store.
    expect(enrollment.wrappedPayload).not.toContain('alice')
    expect(enrollment.wrappedPayload).not.toContain('owner')

    const unlocked = await unlockWebAuthn(enrollment)
    expect(unlocked.userId).toBe('alice')
    expect(unlocked.role).toBe('owner')
    expect(unlocked.deks.size).toBe(1)
  })

  it('requireSingleDevice rejects backup-eligible (syncable) credentials', async () => {
    const mock = {
      create: vi.fn().mockResolvedValue(mockCredential('create', true)),
      get: vi.fn(),
      preventSilentAccess: vi.fn(),
      store: vi.fn(),
    }
    vi.stubGlobal('navigator', { ...navigator, credentials: mock })
    vi.stubGlobal('PublicKeyCredential', class {})

    await expect(
      enrollWebAuthn(await makeKeyring('alice'), 'demo', { requireSingleDevice: true }),
    ).rejects.toThrow(WebAuthnMultiDeviceError)
  })
})
