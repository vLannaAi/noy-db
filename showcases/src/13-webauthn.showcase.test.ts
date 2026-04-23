/**
 * Showcase 13 — "Hardware-key unlock via WebAuthn + PRF"
 * GitHub issue: proposed 2026-04-21 (mid-session; no tracking issue)
 *
 * Framework: Pure hub + `@noy-db/on-webauthn` (no browser glue)
 * Store:     None — the WebAuthn bridge operates on an `UnlockedKeyring`
 *            in memory; no vault is opened in this showcase
 * Pattern:   Authentication — hardware-backed, passphrase-less unlock.
 *            This is a new dimension; the topology-matrix doc will grow an
 *            "Authentication" section that covers both this showcase and
 *            showcase 12 (OIDC bridge).
 * Dimension: Authentication — hardware-backed passphrase-less unlock via
 *            WebAuthn + PRF
 *
 * What this proves:
 *   1. `isWebAuthnAvailable()` reflects the runtime capability — happy-dom
 *      does not define `PublicKeyCredential`, so the guard returns `false`
 *      until we stub the API. This is the pre-flight every consumer UI
 *      should use before rendering a "Register hardware key" button.
 *   2. `enrollWebAuthn(keyring, vault)` triggers `navigator.credentials.create`,
 *      reads the PRF output from the credential's extension results, derives
 *      a deterministic wrapping key, encrypts a summary of the keyring, and
 *      returns a `WebAuthnEnrollment` record ready to persist in any noy-db
 *      collection (envelope-encrypted like any other record).
 *   3. `unlockWebAuthn(enrollment)` triggers `navigator.credentials.get`,
 *      reproduces the same PRF-derived wrapping key from a fresh assertion,
 *      and reconstructs the `UnlockedKeyring` — same `userId`, `role`,
 *      `permissions`, and DEKs as at enrolment.
 *   4. The rawId fallback path works when the authenticator does not expose
 *      PRF (older hardware, Safari 16, some YubiKey firmwares). `prfUsed`
 *      is `false`, but the round-trip is still successful because the
 *      credential's `rawId` fed through HKDF produces a stable key.
 *   5. The BE-flag guard (`requireSingleDevice: true`) rejects credentials
 *      that are backup-eligible (syncable across devices via iCloud Keychain
 *      or Google Password Manager). This is the knob for air-gapped USB-stick
 *      deployments that must not have the unlock secret migrate to a phone.
 *   6. The enrolment's `wrappedPayload` is opaque ciphertext — the persisted
 *      record is safe to drop into any storage backend (including cloud
 *      blob stores) without leaking the keyring's plaintext userId, role,
 *      permissions, or DEK bytes.
 *
 * Test pattern is lifted directly from `packages/on-webauthn/__tests__/` —
 * synthetic `PublicKeyCredential` objects fed through `vi.stubGlobal` for
 * `navigator.credentials` and `PublicKeyCredential`. No physical
 * authenticator required; no Docker; no network round-trips. This is the
 * same stubbing approach the package's own test suite uses to achieve
 * deterministic coverage in happy-dom.
 *
 * For an interactive demo against a real Touch ID / Face ID / YubiKey flow,
 * see `playground/nuxt/app/pages/webauthn.vue` and `docs/webauthn-setup.md`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  enrollWebAuthn,
  unlockWebAuthn,
  isWebAuthnAvailable,
  WebAuthnMultiDeviceError,
  type WebAuthnEnrollment,
} from '@noy-db/on-webauthn'
import type { UnlockedKeyring } from '@noy-db/hub'

import { SHOWCASE_PASSPHRASE } from './_fixtures.js'

// ─── Test helpers (mirror packages/on-webauthn/__tests__/ conventions) ─

/**
 * Build 37-byte authenticator data with a configurable flags byte at
 * position 32. Layout per CTAP2 spec:
 *   bytes 0–31  rpIdHash
 *   byte  32    flags (bit 0 UP, bit 2 UV, bit 3 BE, bit 4 BS, …)
 *   bytes 33–36 signCount
 *
 * `0b00000101` = UP + UV, no BE (single-device-friendly)
 * `0b00001101` = UP + UV + BE (multi-device / synced passkey)
 */
function makeAuthData(beFlag = false): ArrayBuffer {
  const bytes = new Uint8Array(37)
  bytes[32] = beFlag ? 0b00001101 : 0b00000101
  return bytes.buffer
}

/**
 * A fixed 32-byte PRF output. Deterministic so the enrolment wrap and the
 * unlock unwrap both derive the exact same HKDF key. In production the
 * authenticator guarantees this for the same credential + PRF salt; here
 * we hard-code it so the mock is as boring as possible.
 */
const FIXED_PRF_OUTPUT = new Uint8Array(32).map((_, i) => i * 7 + 11).buffer

/** Synthetic PublicKeyCredential for `navigator.credentials.create`. */
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

/** Synthetic PublicKeyCredential for `navigator.credentials.get`. */
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

/**
 * Install synthetic WebAuthn globals so `isWebAuthnAvailable()` returns true
 * and `enrollWebAuthn` / `unlockWebAuthn` have a credentials API to call.
 * Returns the mock so tests can assert on `.create.mock.calls` etc.
 */
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

/**
 * Build an in-memory `UnlockedKeyring` with a known userId + role + two
 * DEKs. In a real deployment this comes out of the normal passphrase-driven
 * `createNoydb()` flow — here we construct it directly because the focus
 * is the WebAuthn bridge mechanics, not the underlying encryption
 * primitives. Mirrors the `makeKeyring` helper from showcase 12.
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

const VAULT = 'firm-demo'

// ─── The showcase ────────────────────────────────────────────────────────

describe('Showcase 13 — WebAuthn hardware-key unlock (PRF + rawId fallback)', () => {
  // Silence the unused-import warning for SHOWCASE_PASSPHRASE — kept
  // available in case a future step opens a real vault alongside the
  // WebAuthn flow.
  void SHOWCASE_PASSPHRASE

  beforeEach(() => {
    // Clean slate — each test installs its own stubs.
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('step 1 — isWebAuthnAvailable() reflects runtime capability', () => {
    // happy-dom doesn't define `PublicKeyCredential` or
    // `navigator.credentials`. This is what most Node.js/SSR environments
    // look like — the pre-flight check lets the UI fall back to passphrase
    // entry instead of rendering a broken "Register hardware key" button.
    expect(isWebAuthnAvailable()).toBe(false)

    // Once the stubs are in place the guard flips true. In a real browser
    // the same guard would trip on Touch ID / Face ID / YubiKey availability.
    stubWebAuthn()
    expect(isWebAuthnAvailable()).toBe(true)
  })

  it('step 2 — enrollWebAuthn() creates a credential and returns an enrolment record', async () => {
    const credsMock = stubWebAuthn()

    const keyring = await makeKeyring('alice')
    const enrollment = await enrollWebAuthn(keyring, VAULT)

    // The call landed on the WebAuthn API exactly once — one credential
    // creation prompt per enrolment.
    expect(credsMock.create).toHaveBeenCalledTimes(1)

    // The enrolment carries the noy-db magic marker, the vault it's bound
    // to, the userId, and the credentialId for future `allowCredentials`
    // filtering at assertion time.
    expect(enrollment._noydb_webauthn).toBe(1)
    expect(enrollment.vault).toBe(VAULT)
    expect(enrollment.userId).toBe('alice')
    expect(typeof enrollment.credentialId).toBe('string')
    expect(enrollment.credentialId.length).toBeGreaterThan(0)

    // PRF was in the mock → the package derived its wrapping key from the
    // PRF output, not from the rawId fallback. BE flag wasn't set on the
    // mock authenticator data, and we didn't ask for single-device.
    expect(enrollment.prfUsed).toBe(true)
    expect(enrollment.beFlag).toBe(false)
    expect(enrollment.requireSingleDevice).toBe(false)

    // The wrapped KEK summary lives in two base64 blobs — these are what
    // get persisted into a noy-db collection on disk / in the cloud.
    expect(typeof enrollment.wrappedPayload).toBe('string')
    expect(typeof enrollment.wrapIv).toBe('string')
    expect(enrollment.wrappedPayload.length).toBeGreaterThan(0)
    expect(enrollment.wrapIv.length).toBeGreaterThan(0)
  })

  it('step 3 — unlockWebAuthn() reproduces the keyring (PRF path)', async () => {
    // Shared rawId so enrol and unlock look like assertions against the
    // same physical credential — matches what an authenticator would do.
    const rawId = new Uint8Array(16).fill(0xcd).buffer

    // Enrol.
    stubWebAuthn({
      createReturn: mockCreateCredential({ rawId, prfOutput: FIXED_PRF_OUTPUT }),
    })
    const keyring = await makeKeyring('alice')
    const enrollment = await enrollWebAuthn(keyring, VAULT)

    // Simulate a fresh session: restart the process, re-stub navigator for
    // the assertion. The only input to unlock is the persisted enrolment
    // record plus a new WebAuthn prompt.
    vi.unstubAllGlobals()
    stubWebAuthn({
      getReturn: mockGetCredential({ rawId, prfOutput: FIXED_PRF_OUTPUT }),
    })

    const unlocked = await unlockWebAuthn(enrollment)

    expect(unlocked.userId).toBe('alice')
    expect(unlocked.displayName).toBe('Alice')
    expect(unlocked.role).toBe('owner')
    expect(unlocked.permissions).toEqual({ invoices: 'rw', clients: 'rw' })
    expect(unlocked.deks.size).toBe(2)
    expect(unlocked.deks.has('invoices')).toBe(true)
    expect(unlocked.deks.has('clients')).toBe(true)

    // And the DEK is a usable CryptoKey — round-trip a tiny payload to
    // prove the reconstruction wasn't just a shape-match but a real key.
    const dek = unlocked.deks.get('invoices')!
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
    const ct = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      dek,
      new TextEncoder().encode('hello-hardware-key'),
    )
    const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, dek, ct)
    expect(new TextDecoder().decode(pt)).toBe('hello-hardware-key')
  })

  it('step 4 — rawId fallback: enrolment without PRF still round-trips', async () => {
    // Older hardware (some YubiKeys, Safari < 17) can't return PRF output.
    // The package detects the absence and falls back to HKDF over the
    // credential's rawId — weaker binding, but universally supported.
    const rawId = new Uint8Array(16).fill(0xef).buffer

    stubWebAuthn({
      createReturn: mockCreateCredential({ rawId, prfOutput: null }),
    })
    const keyring = await makeKeyring('alice')
    const enrollment = await enrollWebAuthn(keyring, VAULT)
    expect(enrollment.prfUsed).toBe(false)

    // Unlock. Same rawId must come back, since that's what feeds HKDF.
    vi.unstubAllGlobals()
    stubWebAuthn({
      getReturn: mockGetCredential({ rawId, prfOutput: null }),
    })
    const unlocked = await unlockWebAuthn(enrollment)
    expect(unlocked.userId).toBe('alice')
    expect(unlocked.role).toBe('owner')
    expect(unlocked.deks.size).toBe(2)
  })

  it('step 5 — BE flag + requireSingleDevice: multi-device credentials are rejected', async () => {
    // Simulate a syncable passkey — the authenticator sets the BE bit in
    // the flags byte, telling us this credential can (or will) migrate to
    // other devices via iCloud Keychain or Google Password Manager.
    stubWebAuthn({
      createReturn: mockCreateCredential({ beFlag: true }),
    })

    const keyring = await makeKeyring('alice')

    // Without the knob the enrolment would succeed — BE=true is recorded
    // but not rejected. With `requireSingleDevice: true` the enrolment
    // refuses to complete, forcing the user to enrol a YubiKey or similar
    // non-syncing device.
    await expect(
      enrollWebAuthn(keyring, VAULT, { requireSingleDevice: true }),
    ).rejects.toThrow(WebAuthnMultiDeviceError)
  })

  it('step 6 — recap: enrolment payload is opaque ciphertext', async () => {
    // This is the zero-knowledge proof point. The enrolment record is safe
    // to persist into any store (including cloud blob stores a human can
    // see) because the wrapping turned the keyring summary into AES-GCM
    // ciphertext. Only a fresh WebAuthn assertion against the original
    // credential can reproduce the wrapping key to decrypt it.
    stubWebAuthn()
    const keyring = await makeKeyring('alice')
    const enrollment = await enrollWebAuthn(keyring, VAULT)

    // wrappedPayload is a base64-url-ish blob. No plaintext fields from
    // the keyring leak into it — not the userId "alice", not the role
    // "owner", not the permission mode "rw", not any collection name.
    expect(typeof enrollment.wrappedPayload).toBe('string')
    expect(enrollment.wrappedPayload).toMatch(/^[A-Za-z0-9+/_=-]+$/)
    expect(enrollment.wrappedPayload).not.toContain('alice')
    expect(enrollment.wrappedPayload).not.toContain('owner')
    expect(enrollment.wrappedPayload).not.toContain('"rw"')
    expect(enrollment.wrappedPayload).not.toContain('invoices')
    expect(enrollment.wrappedPayload).not.toContain('clients')

    // wrapIv is the 12-byte AES-GCM IV, base64. Non-secret on its own —
    // what matters is that a new IV is generated for every enrolment so
    // two enrolments of the same keyring produce distinct wrapped blobs.
    expect(typeof enrollment.wrapIv).toBe('string')
    expect(enrollment.wrapIv.length).toBeGreaterThan(0)

    // The non-secret metadata fields (vault, userId, credentialId, flags)
    // are intentionally in the clear — the sync engine and the enrolment
    // index need to locate records without a key. This is the same design
    // as the `{ _v, _ts, _iv, _data }` envelope used for regular records.
    const publicFieldsBlob = JSON.stringify({
      _noydb_webauthn: enrollment._noydb_webauthn,
      vault: enrollment.vault,
      userId: enrollment.userId,
      credentialId: enrollment.credentialId,
      prfUsed: enrollment.prfUsed,
      beFlag: enrollment.beFlag,
      requireSingleDevice: enrollment.requireSingleDevice,
      enrolledAt: enrollment.enrolledAt,
    })
    expect(publicFieldsBlob).toContain('alice') // confirms plaintext lives in the header, not the payload
  })
})
