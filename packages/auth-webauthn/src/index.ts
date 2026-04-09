/**
 * @noy-db/auth-webauthn — v0.7 #111
 *
 * Hardware-key keyring for noy-db using the WebAuthn API.
 *
 * Covers every form factor:
 *   - Platform authenticators: Touch ID, Face ID, Windows Hello, Android biometric
 *   - Roaming authenticators: YubiKey (5C NFC, Bio), SoloKey, Titan, any FIDO2 key
 *   - Passkey-capable platform authenticators: iCloud Keychain, Google Password Manager
 *
 * Key derivation model
 * ────────────────────
 * This package uses the **PRF (Pseudo-Random Function) extension** when
 * available to derive a deterministic wrapping key from the WebAuthn
 * credential. The PRF output is consistent across assertions on the same
 * device/credential, enabling unlock-without-passphrase while keeping the
 * derived key bound to the physical authenticator.
 *
 * When PRF is not supported by the authenticator (common on older hardware),
 * the package falls back to HKDF-SHA256 over the credential's `rawId` —
 * the same approach as the pre-existing `@noy-db/core` biometric module.
 *
 * The derived key is NEVER persisted. It exists only in memory during the
 * unlock operation. What IS persisted (in the noy-db adapter, not in browser
 * storage) is the wrapped KEK: `encrypt(KEK, derivedKey)`.
 *
 * BE-flag guards
 * ──────────────
 * The backup-eligibility (BE) flag in a WebAuthn authenticator data signals
 * that the credential is (or can be) synced across devices — e.g. stored in
 * iCloud Keychain. For single-device security policies (air-gapped USB sticks,
 * high-security terminals), this is a threat: the credential is available on
 * any device where the user's iCloud account is signed in.
 *
 * The `requireSingleDevice: true` option rejects credentials with the BE flag
 * set during enrollment. Existing enrollments are checked at assertion time —
 * if the authenticator data shows BE=1 but `requireSingleDevice` was set at
 * enrollment, the assertion throws `WebAuthnMultiDeviceError`.
 *
 * Enrollment flow
 * ───────────────
 * 1. User is already authenticated (passphrase or existing session).
 * 2. Call `enrollWebAuthn(keyring, options)`.
 * 3. WebAuthn credential is created; PRF or rawId-derived key wraps the KEK.
 * 4. Returns a `WebAuthnEnrollment` — persist this to the noy-db adapter
 *    via `saveEnrollment()`, or store it yourself in any encrypted collection.
 *
 * Unlock flow
 * ───────────
 * 1. Load the `WebAuthnEnrollment` via `loadEnrollment()`.
 * 2. Call `unlockWebAuthn(enrollment, keyring)` — triggers the WebAuthn
 *    assertion prompt.
 * 3. On success, returns the unwrapped `CryptoKey` (the KEK) — use it to
 *    re-hydrate the session via `createSession()`.
 */

import { bufferToBase64, base64ToBuffer } from '@noy-db/core'
import { ValidationError } from '@noy-db/core'
import type { UnlockedKeyring, Role } from '@noy-db/core'

// Re-export from core for convenience
export { ValidationError } from '@noy-db/core'

// ─── Error types ──────────────────────────────────────────────────────

export class WebAuthnNotAvailableError extends Error {
  readonly code = 'WEBAUTHN_NOT_AVAILABLE'
  constructor() {
    super('WebAuthn is not available in this environment. A browser with navigator.credentials support is required.')
    this.name = 'WebAuthnNotAvailableError'
  }
}

export class WebAuthnCancelledError extends Error {
  readonly code = 'WEBAUTHN_CANCELLED'
  constructor(op: 'enrollment' | 'assertion') {
    super(`WebAuthn ${op} was cancelled by the user.`)
    this.name = 'WebAuthnCancelledError'
  }
}

export class WebAuthnMultiDeviceError extends Error {
  readonly code = 'WEBAUTHN_MULTI_DEVICE'
  constructor() {
    super(
      'This credential is backup-eligible (BE flag set) and may be synced across devices. ' +
      'The compartment requires a single-device credential (requireSingleDevice: true). ' +
      'Please use a hardware security key (YubiKey, Titan, SoloKey) or a platform ' +
      'authenticator that does not sync credentials across devices.',
    )
    this.name = 'WebAuthnMultiDeviceError'
  }
}

export class WebAuthnPRFUnavailableError extends Error {
  readonly code = 'WEBAUTHN_PRF_UNAVAILABLE'
  constructor() {
    super(
      'The PRF extension is not available on this authenticator. ' +
      'Enrollment will fall back to rawId-based key derivation. ' +
      'This provides weaker binding to the specific authenticator.',
    )
    this.name = 'WebAuthnPRFUnavailableError'
  }
}

// ─── Types ────────────────────────────────────────────────────────────

/**
 * A persisted WebAuthn enrollment record. Store this in a noy-db
 * collection (encrypted like any other record) or return it from
 * `saveEnrollment()` / `loadEnrollment()` helpers.
 */
export interface WebAuthnEnrollment {
  /** Enrollment format version. */
  readonly _noydb_webauthn: 1
  /** The compartment this enrollment was created for. */
  readonly compartment: string
  /** The user ID this enrollment belongs to. */
  readonly userId: string
  /** WebAuthn credential ID (base64). Use for allowCredentials in assertions. */
  readonly credentialId: string
  /** Whether PRF was used for key derivation (vs rawId HKDF fallback). */
  readonly prfUsed: boolean
  /** Whether the BE (backup-eligibility) flag was present at enrollment time. */
  readonly beFlag: boolean
  /** Whether single-device was required at enrollment time. */
  readonly requireSingleDevice: boolean
  /** The wrapped KEK: encrypt(exportedDekMap, derivedKey). Base64. */
  readonly wrappedPayload: string
  /** IV used for the wrapping. Base64. */
  readonly wrapIv: string
  /** ISO timestamp of enrollment. */
  readonly enrolledAt: string
}

/** Options for `enrollWebAuthn()`. */
export interface WebAuthnEnrollOptions {
  /**
   * Relying party ID and name for the WebAuthn credential.
   * Defaults to `{ id: window.location.hostname, name: 'NOYDB' }`.
   */
  rp?: { id?: string; name: string }
  /**
   * If `true`, refuse to enroll credentials with the BE flag set
   * (multi-device / syncable passkeys). Defaults to `false`.
   *
   * Set to `true` for high-security deployments where the credential
   * must be bound to a single physical device (YubiKey, Titan, etc.).
   */
  requireSingleDevice?: boolean
  /**
   * WebAuthn timeout in milliseconds. Default: 60_000.
   */
  timeout?: number
  /**
   * If `true`, prefer a cross-platform authenticator (roaming security key).
   * If `false`, prefer a platform authenticator (Touch ID, Face ID).
   * If undefined, let the browser choose.
   */
  preferCrossPlatform?: boolean
}

/** Options for `unlockWebAuthn()`. */
export interface WebAuthnUnlockOptions {
  /** WebAuthn timeout in milliseconds. Default: 60_000. */
  timeout?: number
}

// ─── Environment check ─────────────────────────────────────────────────

export function isWebAuthnAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.credentials !== 'undefined'
  )
}

// ─── PRF salt ─────────────────────────────────────────────────────────

const PRF_SALT = new TextEncoder().encode('noydb-v0.7-webauthn-kek-derive')

// ─── Key derivation helpers ────────────────────────────────────────────

/**
 * Derive a wrapping key from PRF output.
 * PRF output is 32 bytes of authenticator-bound pseudo-random data.
 */
async function deriveKeyFromPRF(prfOutput: ArrayBuffer): Promise<CryptoKey> {
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    prfOutput,
    'HKDF',
    false,
    ['deriveKey'],
  )
  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: PRF_SALT,
      info: new TextEncoder().encode('noydb-kek-wrap-v1'),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Derive a wrapping key from the credential's rawId (fallback when PRF unavailable).
 * Weaker than PRF (rawId may be observable to the server) but universally supported.
 */
async function deriveKeyFromRawId(rawId: ArrayBuffer): Promise<CryptoKey> {
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    rawId,
    'HKDF',
    false,
    ['deriveKey'],
  )
  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('noydb-webauthn-rawid-fallback'),
      info: new TextEncoder().encode('noydb-kek-wrap-v1'),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// ─── BE flag extraction ────────────────────────────────────────────────

/**
 * Extract the BE (backup-eligibility) flag from WebAuthn authenticator data.
 * Authenticator data byte layout (CTAP2 spec):
 *   bytes 0-31:  rpIdHash
 *   byte  32:    flags byte
 *   bytes 33-36: signCount
 *   ...
 *
 * Flags byte bit layout (bit 0 = LSB):
 *   bit 0 (UP):  user presence
 *   bit 2 (UV):  user verification
 *   bit 3 (BE):  backup eligibility
 *   bit 4 (BS):  backup state
 *   bit 6 (AT):  attested credential data present
 *   bit 7 (ED):  extension data present
 */
function extractBEFlag(authData: ArrayBuffer): boolean {
  const bytes = new Uint8Array(authData)
  if (bytes.length < 33) return false
  const flagsByte = bytes[32]!
  return (flagsByte & 0b00001000) !== 0 // bit 3
}

// ─── Payload wrap/unwrap ───────────────────────────────────────────────

/**
 * Serialize and encrypt the DEK map from `keyring` using `wrappingKey`.
 * The wrapped payload is what gets stored in the enrollment record.
 */
async function wrapKeyringSummary(
  keyring: UnlockedKeyring,
  wrappingKey: CryptoKey,
): Promise<{ wrappedPayload: string; wrapIv: string }> {
  const dekMap: Record<string, string> = {}
  for (const [collName, dek] of keyring.deks) {
    const raw = await globalThis.crypto.subtle.exportKey('raw', dek)
    dekMap[collName] = bufferToBase64(raw)
  }

  const payload = JSON.stringify({
    userId: keyring.userId,
    displayName: keyring.displayName,
    role: keyring.role,
    permissions: keyring.permissions,
    deks: dekMap,
    salt: bufferToBase64(keyring.salt),
  })

  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    new TextEncoder().encode(payload),
  )

  return { wrappedPayload: bufferToBase64(encrypted), wrapIv: bufferToBase64(iv) }
}

/**
 * Decrypt and deserialize the keyring payload using `wrappingKey`.
 */
async function unwrapKeyringSummary(
  enrollment: WebAuthnEnrollment,
  wrappingKey: CryptoKey,
): Promise<UnlockedKeyring> {
  const iv = base64ToBuffer(enrollment.wrapIv)
  const ciphertext = base64ToBuffer(enrollment.wrappedPayload)

  let plaintext: ArrayBuffer
  try {
    plaintext = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      wrappingKey,
      ciphertext,
    )
  } catch {
    throw new ValidationError('WebAuthn decryption failed — the authenticator may have changed or the enrollment may be corrupt.')
  }

  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as {
    userId: string
    displayName: string
    role: Role
    permissions: Record<string, 'rw' | 'ro'>
    deks: Record<string, string>
    salt: string
  }

  const deks = new Map<string, CryptoKey>()
  for (const [collName, rawBase64] of Object.entries(parsed.deks)) {
    const dek = await globalThis.crypto.subtle.importKey(
      'raw',
      base64ToBuffer(rawBase64),
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
    deks.set(collName, dek)
  }

  return {
    userId: parsed.userId,
    displayName: parsed.displayName,
    role: parsed.role,
    permissions: parsed.permissions,
    deks,
    kek: null as unknown as CryptoKey,
    salt: base64ToBuffer(parsed.salt),
  }
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Enroll a WebAuthn credential for the given keyring.
 *
 * The caller must already have an unlocked keyring (from passphrase auth or
 * an existing session). The WebAuthn credential creation prompt is triggered
 * by this call.
 *
 * Returns a `WebAuthnEnrollment` that should be persisted — typically via
 * `saveEnrollment()` into a noy-db collection.
 *
 * @throws `WebAuthnNotAvailableError` if the environment doesn't support WebAuthn.
 * @throws `WebAuthnCancelledError` if the user cancels the credential creation.
 * @throws `WebAuthnMultiDeviceError` if `requireSingleDevice` is true and the
 *         authenticator returned a credential with the BE flag set.
 */
export async function enrollWebAuthn(
  keyring: UnlockedKeyring,
  compartment: string,
  options: WebAuthnEnrollOptions = {},
): Promise<WebAuthnEnrollment> {
  if (!isWebAuthnAvailable()) {
    throw new WebAuthnNotAvailableError()
  }

  const rpId = options.rp?.id ?? (typeof window !== 'undefined' ? window.location.hostname : 'localhost')
  const rpName = options.rp?.name ?? 'NOYDB'
  const timeout = options.timeout ?? 60_000

  const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32))
  const userIdBytes = new TextEncoder().encode(keyring.userId)

  const authenticatorSelection: AuthenticatorSelectionCriteria = {
    userVerification: 'required',
    residentKey: 'preferred',
  }
  if (options.preferCrossPlatform === true) {
    authenticatorSelection.authenticatorAttachment = 'cross-platform'
  } else if (options.preferCrossPlatform === false) {
    authenticatorSelection.authenticatorAttachment = 'platform'
  }

  // Request PRF extension for deterministic key derivation
  const extensionsInput = {
    prf: { eval: { first: PRF_SALT } },
  } as AuthenticationExtensionsClientInputs

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { id: rpId, name: rpName },
      user: {
        id: userIdBytes,
        name: keyring.userId,
        displayName: keyring.displayName,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },   // ES256
        { type: 'public-key', alg: -257 },  // RS256
        { type: 'public-key', alg: -8 },    // EdDSA
      ],
      authenticatorSelection,
      extensions: extensionsInput,
      timeout,
    },
  }) as PublicKeyCredential | null

  if (!credential) {
    throw new WebAuthnCancelledError('enrollment')
  }

  const authData = (credential.response as AuthenticatorAttestationResponse).getAuthenticatorData()
  const beFlag = extractBEFlag(authData)

  if (options.requireSingleDevice && beFlag) {
    throw new WebAuthnMultiDeviceError()
  }

  // Try to get PRF output from extensions
  const extensions = credential.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } }
  }
  const prfOutput = extensions.prf?.results?.first
  const prfUsed = !!prfOutput

  const wrappingKey = prfOutput
    ? await deriveKeyFromPRF(prfOutput)
    : await deriveKeyFromRawId(credential.rawId)

  const { wrappedPayload, wrapIv } = await wrapKeyringSummary(keyring, wrappingKey)

  return {
    _noydb_webauthn: 1,
    compartment,
    userId: keyring.userId,
    credentialId: bufferToBase64(credential.rawId),
    prfUsed,
    beFlag,
    requireSingleDevice: options.requireSingleDevice ?? false,
    wrappedPayload,
    wrapIv,
    enrolledAt: new Date().toISOString(),
  }
}

/**
 * Unlock a compartment using a previously enrolled WebAuthn credential.
 *
 * Triggers the WebAuthn assertion prompt. On success, decrypts the keyring
 * payload from the enrollment record and returns an `UnlockedKeyring`.
 *
 * The returned keyring has the same DEKs as at enrollment time. If DEKs
 * have been rotated since enrollment, this will return stale DEKs — the
 * caller should detect decryption failures and prompt for re-enrollment.
 *
 * @throws `WebAuthnNotAvailableError` if the environment doesn't support WebAuthn.
 * @throws `WebAuthnCancelledError` if the user cancels the assertion.
 * @throws `WebAuthnMultiDeviceError` if `requireSingleDevice` was set at
 *         enrollment and the authenticator data now shows BE=1.
 * @throws `ValidationError` if decryption of the keyring payload fails.
 */
export async function unlockWebAuthn(
  enrollment: WebAuthnEnrollment,
  options: WebAuthnUnlockOptions = {},
): Promise<UnlockedKeyring> {
  if (!isWebAuthnAvailable()) {
    throw new WebAuthnNotAvailableError()
  }

  const timeout = options.timeout ?? 60_000
  const credentialId = base64ToBuffer(enrollment.credentialId)

  const extensionsInput = (enrollment.prfUsed
    ? { prf: { eval: { first: PRF_SALT } } }
    : {}
  ) as AuthenticationExtensionsClientInputs

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: credentialId as BufferSource }],
      userVerification: 'required',
      extensions: extensionsInput,
      timeout,
    },
  }) as PublicKeyCredential | null

  if (!assertion) {
    throw new WebAuthnCancelledError('assertion')
  }

  // BE-flag guard at assertion time
  const authData = (assertion.response as AuthenticatorAssertionResponse).authenticatorData
  const beFlag = extractBEFlag(authData)
  if (enrollment.requireSingleDevice && beFlag) {
    throw new WebAuthnMultiDeviceError()
  }

  // Derive the wrapping key using the same method as enrollment
  let wrappingKey: CryptoKey
  if (enrollment.prfUsed) {
    const extensions = assertion.getClientExtensionResults() as {
      prf?: { results?: { first?: ArrayBuffer } }
    }
    const prfOutput = extensions.prf?.results?.first
    if (!prfOutput) {
      throw new ValidationError(
        'PRF extension output not available at assertion time. ' +
        'The authenticator may not support PRF. Re-enroll without PRF support.',
      )
    }
    wrappingKey = await deriveKeyFromPRF(prfOutput)
  } else {
    wrappingKey = await deriveKeyFromRawId(assertion.rawId)
  }

  return unwrapKeyringSummary(enrollment, wrappingKey)
}

/**
 * Check whether a `WebAuthnEnrollment` record looks well-formed.
 * Does not perform any cryptographic verification.
 */
export function isValidEnrollment(value: unknown): value is WebAuthnEnrollment {
  if (!value || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  return (
    e._noydb_webauthn === 1 &&
    typeof e.compartment === 'string' &&
    typeof e.userId === 'string' &&
    typeof e.credentialId === 'string' &&
    typeof e.wrappedPayload === 'string' &&
    typeof e.wrapIv === 'string'
  )
}
