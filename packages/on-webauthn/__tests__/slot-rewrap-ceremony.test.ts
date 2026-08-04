/**
 * #56 — webAuthnSlotRewrapCeremony helper for rotateSecret slotCeremonies.
 *
 * Pinned behaviors:
 *   1. End-to-end — enrollWebAuthn produces a slot whose wrappedPayload
 *      decrypts back to the original keyring; webAuthnSlotRewrapCeremony
 *      produces a NEW slot whose wrappedPayload decrypts back to the
 *      same identity but with the supplied `ctx.newDeks`.
 *   2. Identity carry-through — userId, displayName, role, permissions,
 *      salt all flow through from the old payload to the new (these
 *      don't change on phrase rotate).
 *   3. Anti-slot-swap — returned slot has same `id` and `method` as
 *      `oldSlot`. Hub validates these at slotCeremonies time.
 *   4. Wrong method (e.g. `password`) → ValidationError.
 *   5. wrap-DEKs variant → ValidationError (this helper handles wrap-KEK only).
 *   6. Missing meta.credentialId / meta.wrapIv → ValidationError.
 *   7. WebAuthnNotAvailable / Cancelled / MultiDevice errors propagate
 *      from the inner assertion.
 *   8. PRF and rawId-fallback paths both produce a working rewrap.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  enrollWebAuthn,
  unlockWebAuthn,
  webAuthnSlotRewrapCeremony,
  WebAuthnCancelledError,
  WebAuthnMultiDeviceError,
  WebAuthnNotAvailableError,
  WebAuthnPRFUnavailableError,
} from '../src/index.js'
import { ValidationError } from '@noy-db/hub'
import type { UnlockedKeyring, KeyringAuthenticator, SlotRewrapContext, WebAuthnEnrollment } from '../src/index.js'

// ─── Fixtures ────────────────────────────────────────────────────────────

async function makeDek(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
}

async function makeKeyring(deks: Map<string, CryptoKey>): Promise<UnlockedKeyring> {
  return {
    userId: 'alice',
    displayName: 'Alice',
    role: 'owner',
    permissions: { invoices: 'rw', clients: 'ro' },
    deks,
    kek: null,
    salt: new Uint8Array(32).fill(5),
    authenticators: [],
  }
}

function makeAuthData(beFlag = false): ArrayBuffer {
  const bytes = new Uint8Array(37)
  bytes[32] = beFlag ? 0b00001101 : 0b00000101
  return bytes.buffer
}

const FIXED_PRF_OUTPUT = new Uint8Array(32).map((_, i) => i * 7 + 11).buffer

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

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Build the on-disk `KeyringAuthenticator` slot from a `WebAuthnEnrollment`,
 * matching how `db.enrollWebAuthn` shapes it (noydb.ts:1178).
 */
function slotFromEnrollment(enrollment: WebAuthnEnrollment): KeyringAuthenticator {
  return {
    id: `webauthn-${enrollment.credentialId.slice(0, 8)}`,
    method: 'webauthn',
    enrolled_at: enrollment.enrolledAt,
    enrolled_via_tier: 1,
    wrapKind: 'kek',
    wrapped_kek: enrollment.wrappedPayload,
    meta: {
      credentialId: enrollment.credentialId,
      wrapIv: enrollment.wrapIv,
      prfUsed: enrollment.prfUsed,
      beFlag: enrollment.beFlag,
      requireSingleDevice: enrollment.requireSingleDevice,
    },
  }
}

// ─── Round-trip ──────────────────────────────────────────────────────────

describe('webAuthnSlotRewrapCeremony — end-to-end (PRF path)', () => {
  it('rewrap produces a slot whose payload decrypts to ctx.newDeks (rotation simulation)', async () => {
    const rawId = new Uint8Array(16).fill(0xcd).buffer

    // 1. Enroll under the OLD DEK set.
    const oldDek = await makeDek()
    const oldKeyring = await makeKeyring(new Map([['invoices', oldDek]]))
    stubWebAuthn({
      createReturn: mockCreateCredential({ rawId, prfOutput: FIXED_PRF_OUTPUT }),
    })
    const enrollment = await enrollWebAuthn(oldKeyring, 'acme')
    const oldSlot = slotFromEnrollment(enrollment)

    // 2. Simulate rotateSecret: hub generates fresh DEKs (rewrapped
    //    under the new KEK in the keyring file). The ceremony receives
    //    these via ctx.newDeks.
    const newDek = await makeDek()
    const newDeks = new Map([['invoices', newDek]])
    const ctx: SlotRewrapContext = {
      newKek: oldKeyring.salt as unknown as CryptoKey, // unused by webauthn ceremony
      newDeks,
      oldSlot,
    }

    // Re-stub for the rewrap ceremony's assertion.
    vi.unstubAllGlobals()
    stubWebAuthn({
      getReturn: mockGetCredential({ rawId, prfOutput: FIXED_PRF_OUTPUT }),
    })
    const rewrapped = await webAuthnSlotRewrapCeremony(ctx)

    // Anti-slot-swap — id + method preserved.
    expect(rewrapped.id).toBe(oldSlot.id)
    expect(rewrapped.method).toBe('webauthn')
    expect(rewrapped.wrapKind).not.toBe('deks') // wrap-KEK preserved

    // 3. Build a "new" enrollment record from the ceremony output and
    //    unlock — should return ctx.newDeks, NOT the old ones.
    if ('wrapped_kek' in rewrapped) {
      const newEnrollment: WebAuthnEnrollment = {
        _noydb_webauthn: 1,
        vault: 'acme',
        userId: 'alice',
        credentialId: enrollment.credentialId,
        prfUsed: true,
        beFlag: false,
        requireSingleDevice: false,
        wrappedPayload: rewrapped.wrapped_kek,
        wrapIv: (rewrapped.meta as { wrapIv: string }).wrapIv,
        enrolledAt: enrollment.enrolledAt,
      }

      vi.unstubAllGlobals()
      stubWebAuthn({
        getReturn: mockGetCredential({ rawId, prfOutput: FIXED_PRF_OUTPUT }),
      })
      const unlocked = await unlockWebAuthn(newEnrollment)

      // Identity carry-through.
      expect(unlocked.userId).toBe('alice')
      expect(unlocked.displayName).toBe('Alice')
      expect(unlocked.role).toBe('owner')
      expect(unlocked.permissions).toEqual({ invoices: 'rw', clients: 'ro' })

      // The unlocked DEK must match ctx.newDeks (NOT oldDek).
      const unlockedRaw = await globalThis.crypto.subtle.exportKey('raw', unlocked.deks.get('invoices')!)
      const newRaw = await globalThis.crypto.subtle.exportKey('raw', newDek)
      expect(new Uint8Array(unlockedRaw)).toEqual(new Uint8Array(newRaw))

      // Sanity: it is NOT the old DEK.
      const oldRaw = await globalThis.crypto.subtle.exportKey('raw', oldDek)
      expect(new Uint8Array(unlockedRaw)).not.toEqual(new Uint8Array(oldRaw))
    } else {
      throw new Error('expected wrap-KEK rewrapped slot')
    }
  })
})

describe('webAuthnSlotRewrapCeremony — rawId fallback path (acknowledged-insecure)', () => {
  it('rewraps correctly when prfUsed: false and allowNonPrfInsecure: true (rawId-derived wrapping key)', async () => {
    const rawId = new Uint8Array(16).fill(0xef).buffer

    const oldDek = await makeDek()
    const oldKeyring = await makeKeyring(new Map([['invoices', oldDek]]))
    stubWebAuthn({
      createReturn: mockCreateCredential({ rawId, prfOutput: null }),
    })
    const enrollment = await enrollWebAuthn(oldKeyring, 'acme', { allowNonPrfInsecure: true })
    expect(enrollment.prfUsed).toBe(false)
    const oldSlot = slotFromEnrollment(enrollment)

    const newDek = await makeDek()
    const newDeks = new Map([['invoices', newDek]])
    const ctx: SlotRewrapContext = {
      newKek: oldKeyring.salt as unknown as CryptoKey,
      newDeks,
      oldSlot,
    }

    vi.unstubAllGlobals()
    stubWebAuthn({
      getReturn: mockGetCredential({ rawId, prfOutput: null }),
    })
    const rewrapped = await webAuthnSlotRewrapCeremony(ctx, { allowNonPrfInsecure: true })
    expect(rewrapped.id).toBe(oldSlot.id)
    expect(rewrapped.method).toBe('webauthn')

    if ('wrapped_kek' in rewrapped) {
      const newEnrollment: WebAuthnEnrollment = {
        _noydb_webauthn: 1,
        vault: 'acme',
        userId: 'alice',
        credentialId: enrollment.credentialId,
        prfUsed: false,
        beFlag: false,
        requireSingleDevice: false,
        wrappedPayload: rewrapped.wrapped_kek,
        wrapIv: (rewrapped.meta as { wrapIv: string }).wrapIv,
        enrolledAt: enrollment.enrolledAt,
      }
      // Unlock of the rewrapped (still non-PRF) record still works —
      // unlockWebAuthn never changed, back-compat for migrators.
      vi.unstubAllGlobals()
      stubWebAuthn({
        getReturn: mockGetCredential({ rawId, prfOutput: null }),
      })
      const unlocked = await unlockWebAuthn(newEnrollment)
      const unlockedRaw = await globalThis.crypto.subtle.exportKey('raw', unlocked.deks.get('invoices')!)
      const newRaw = await globalThis.crypto.subtle.exportKey('raw', newDek)
      expect(new Uint8Array(unlockedRaw)).toEqual(new Uint8Array(newRaw))
    } else {
      throw new Error('expected wrap-KEK rewrapped slot')
    }
  })

  it('rejects with WebAuthnPRFUnavailableError when the old slot is non-PRF and allowNonPrfInsecure is not set', async () => {
    const rawId = new Uint8Array(16).fill(0xef).buffer

    const oldDek = await makeDek()
    const oldKeyring = await makeKeyring(new Map([['invoices', oldDek]]))
    stubWebAuthn({
      createReturn: mockCreateCredential({ rawId, prfOutput: null }),
    })
    const enrollment = await enrollWebAuthn(oldKeyring, 'acme', { allowNonPrfInsecure: true })
    const oldSlot = slotFromEnrollment(enrollment)

    const newDek = await makeDek()
    const ctx: SlotRewrapContext = {
      newKek: oldKeyring.salt as unknown as CryptoKey,
      newDeks: new Map([['invoices', newDek]]),
      oldSlot,
    }

    vi.unstubAllGlobals()
    stubWebAuthn({
      getReturn: mockGetCredential({ rawId, prfOutput: null }),
    })
    await expect(webAuthnSlotRewrapCeremony(ctx)).rejects.toThrow(WebAuthnPRFUnavailableError)
  })
})

// ─── Validation ──────────────────────────────────────────────────────────

describe('webAuthnSlotRewrapCeremony — validation', () => {
  it('throws ValidationError when oldSlot.method is not webauthn', async () => {
    stubWebAuthn()
    const oldDek = await makeDek()
    const oldKeyring = await makeKeyring(new Map([['invoices', oldDek]]))

    // Construct a non-webauthn slot to confirm the method check fires.
    const wrongSlot: KeyringAuthenticator = {
      id: 'password-x',
      method: 'password',
      enrolled_at: new Date().toISOString(),
      enrolled_via_tier: 1,
      wrapKind: 'deks',
      wrapped_deks: 'YWFhYWE=',
      iv: 'YWFhYQ==',
      meta: { salt: 'cw==' },
    }

    await expect(
      webAuthnSlotRewrapCeremony({
        newKek: oldKeyring.salt as unknown as CryptoKey,
        newDeks: oldKeyring.deks,
        oldSlot: wrongSlot,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('throws ValidationError when oldSlot is wrap-DEKs variant', async () => {
    stubWebAuthn()
    const oldDek = await makeDek()
    const oldKeyring = await makeKeyring(new Map([['invoices', oldDek]]))

    // method is 'webauthn' but wrapKind is 'deks' — pathological mix
    // that should be rejected so the helper doesn't try to decrypt
    // a non-existent wrapped_kek field.
    const wrongSlot: KeyringAuthenticator = {
      id: 'webauthn-bad',
      method: 'webauthn',
      enrolled_at: new Date().toISOString(),
      enrolled_via_tier: 1,
      wrapKind: 'deks',
      wrapped_deks: 'YWFhYWE=',
      iv: 'YWFhYQ==',
      meta: { credentialId: 'cred-bad', wrapIv: 'aXY=' },
    }

    await expect(
      webAuthnSlotRewrapCeremony({
        newKek: oldKeyring.salt as unknown as CryptoKey,
        newDeks: oldKeyring.deks,
        oldSlot: wrongSlot,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('throws ValidationError when meta.credentialId is missing', async () => {
    stubWebAuthn()
    const oldDek = await makeDek()
    const oldKeyring = await makeKeyring(new Map([['invoices', oldDek]]))
    const enrollment = await enrollWebAuthn(oldKeyring, 'acme')
    const slot = slotFromEnrollment(enrollment)
    // Strip credentialId.
    const stripped: KeyringAuthenticator = {
      ...slot,
      meta: { wrapIv: (slot.meta as { wrapIv: string }).wrapIv },
    }

    await expect(
      webAuthnSlotRewrapCeremony({
        newKek: oldKeyring.salt as unknown as CryptoKey,
        newDeks: oldKeyring.deks,
        oldSlot: stripped,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('throws ValidationError when meta.wrapIv is missing (pre-#16 synthetic-keyring shape)', async () => {
    stubWebAuthn()
    const oldDek = await makeDek()
    const oldKeyring = await makeKeyring(new Map([['invoices', oldDek]]))
    const enrollment = await enrollWebAuthn(oldKeyring, 'acme')
    const slot = slotFromEnrollment(enrollment)
    const stripped: KeyringAuthenticator = {
      ...slot,
      meta: { credentialId: (slot.meta as { credentialId: string }).credentialId },
    }

    await expect(
      webAuthnSlotRewrapCeremony({
        newKek: oldKeyring.salt as unknown as CryptoKey,
        newDeks: oldKeyring.deks,
        oldSlot: stripped,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('propagates WebAuthnNotAvailableError when env lacks navigator.credentials', async () => {
    // Build a valid slot first (with stubs), then drop the stubs and
    // call the ceremony — env check fires before any other validation.
    stubWebAuthn()
    const oldDek = await makeDek()
    const oldKeyring = await makeKeyring(new Map([['invoices', oldDek]]))
    const enrollment = await enrollWebAuthn(oldKeyring, 'acme')
    const slot = slotFromEnrollment(enrollment)

    vi.unstubAllGlobals()
    await expect(
      webAuthnSlotRewrapCeremony({
        newKek: oldKeyring.salt as unknown as CryptoKey,
        newDeks: oldKeyring.deks,
        oldSlot: slot,
      }),
    ).rejects.toBeInstanceOf(WebAuthnNotAvailableError)
  })

  it('propagates WebAuthnCancelledError when navigator.credentials.get returns null', async () => {
    const rawId = new Uint8Array(16).fill(0xab).buffer
    stubWebAuthn({
      createReturn: mockCreateCredential({ rawId, prfOutput: FIXED_PRF_OUTPUT }),
    })
    const oldDek = await makeDek()
    const oldKeyring = await makeKeyring(new Map([['invoices', oldDek]]))
    const enrollment = await enrollWebAuthn(oldKeyring, 'acme')
    const slot = slotFromEnrollment(enrollment)

    vi.unstubAllGlobals()
    stubWebAuthn({ getReturn: null })
    await expect(
      webAuthnSlotRewrapCeremony({
        newKek: oldKeyring.salt as unknown as CryptoKey,
        newDeks: oldKeyring.deks,
        oldSlot: slot,
      }),
    ).rejects.toBeInstanceOf(WebAuthnCancelledError)
  })

  it('propagates WebAuthnMultiDeviceError when requireSingleDevice && BE=1 at rewrap time', async () => {
    const rawId = new Uint8Array(16).fill(0xab).buffer
    stubWebAuthn({
      createReturn: mockCreateCredential({ rawId, prfOutput: FIXED_PRF_OUTPUT, beFlag: false }),
    })
    const oldDek = await makeDek()
    const oldKeyring = await makeKeyring(new Map([['invoices', oldDek]]))
    const enrollment = await enrollWebAuthn(oldKeyring, 'acme', { requireSingleDevice: true })
    const slot = slotFromEnrollment(enrollment)

    // At rewrap time, the authenticator now reports BE=1 (e.g. Touch ID
    // got synced through iCloud since enrollment) — must reject.
    vi.unstubAllGlobals()
    stubWebAuthn({
      getReturn: mockGetCredential({ rawId, prfOutput: FIXED_PRF_OUTPUT, beFlag: true }),
    })
    await expect(
      webAuthnSlotRewrapCeremony({
        newKek: oldKeyring.salt as unknown as CryptoKey,
        newDeks: oldKeyring.deks,
        oldSlot: slot,
      }),
    ).rejects.toBeInstanceOf(WebAuthnMultiDeviceError)
  })
})
