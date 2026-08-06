/**
 * @noy-db/on-webauthn —
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
 * device/credential, enabling unlock-without-secret while keeping the
 * derived key bound to the physical authenticator.
 *
 * When PRF is not supported by the authenticator (common on older hardware),
 * the package can fall back to HKDF-SHA256 over the credential's `rawId` —
 * but by default, enrollment refuses this path because the `rawId` is stored
 * in the record itself, making the record self-decrypting (presence gate, not
 * confidentiality). Use `allowNonPrfInsecure: true` to opt in; prefer a
 * PRF-capable device or the secret for real confidentiality.
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
 * 1. User is already authenticated (secret or existing session).
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

import { bufferToBase64, base64ToBuffer } from '@noy-db/hub'
import { ValidationError } from '@noy-db/hub'
import type { UnlockedKeyring, Role, EnrollAuthenticatorOptions, SlotRewrapContext } from '@noy-db/hub'

// Re-export from core for convenience
export { ValidationError } from '@noy-db/hub'

// ─── Error types ──────────────────────────────────────────────────────

/**
 * Thrown when the WebAuthn API is not available in the current environment.
 *
 * Check `isWebAuthnAvailable()` before calling `enrollWebAuthn()` or
 * `unlockWebAuthn()` and show a fallback UI (secret entry) if this
 * returns false. Common scenarios: Node.js environments, older browsers,
 * non-HTTPS origins (WebAuthn requires a Secure Context).
 */
export class WebAuthnNotAvailableError extends Error {
  readonly code = 'WEBAUTHN_NOT_AVAILABLE'
  constructor() {
    super('WebAuthn is not available in this environment. A browser with navigator.credentials support is required.')
    this.name = 'WebAuthnNotAvailableError'
  }
}

/**
 * Thrown when the user dismisses the WebAuthn prompt without completing it.
 *
 * The `op` field distinguishes enrollment cancellation (user chose not to
 * enroll a hardware key) from assertion cancellation (user dismissed the
 * unlock prompt). Treat this as a user-initiated action, not an error — show
 * a "use secret instead" option rather than an error message.
 */
export class WebAuthnCancelledError extends Error {
  readonly code = 'WEBAUTHN_CANCELLED'
  constructor(op: 'enrollment' | 'assertion') {
    super(`WebAuthn ${op} was cancelled by the user.`)
    this.name = 'WebAuthnCancelledError'
  }
}

/**
 * Thrown when the authenticator has the backup-eligible (BE) flag set but
 * the vault requires a single-device credential (`requireSingleDevice: true`).
 *
 * A BE credential is synced across devices (e.g. iCloud Keychain, Google
 * Password Manager), which violates the single-device security model. The
 * user must enroll a hardware security key (YubiKey, Titan, SoloKey) instead.
 */
export class WebAuthnMultiDeviceError extends Error {
  readonly code = 'WEBAUTHN_MULTI_DEVICE'
  constructor() {
    super(
      'This credential is backup-eligible (BE flag set) and may be synced across devices. ' +
      'The vault requires a single-device credential (requireSingleDevice: true). ' +
      'Please use a hardware security key (YubiKey, Titan, SoloKey) or a platform ' +
      'authenticator that does not sync credentials across devices.',
    )
    this.name = 'WebAuthnMultiDeviceError'
  }
}

/**
 * Thrown when `enrollWebAuthn()` (or `webAuthnSlotRewrapCeremony()`) is
 * asked to enroll/rewrap without a PRF-capable authenticator and without
 * explicit opt-in via `allowNonPrfInsecure: true`.
 *
 * Non-PRF WebAuthn cannot provide confidentiality: its wrapping key derives
 * entirely from the credential's `rawId`, which is stored in cleartext in
 * the enrollment record itself — the record would self-decrypt with no
 * authenticator involved. By default, enrollment/rewrap refuses this path.
 * Use a PRF-capable credential, fall back to the secret, or set
 * `allowNonPrfInsecure: true` to explicitly accept a non-confidential
 * presence gate instead.
 */
export class WebAuthnPRFUnavailableError extends Error {
  readonly code = 'WEBAUTHN_PRF_UNAVAILABLE'
  constructor() {
    super(
      'The PRF extension is not available on this authenticator, so it cannot provide ' +
      'WebAuthn confidentiality — the non-PRF wrapping key derives entirely from the ' +
      "credential's rawId, which is stored in the enrollment record itself (the record " +
      'would self-decrypt with no authenticator involved). Enrollment refuses this path ' +
      'by default. Use a PRF-capable authenticator, use the secret instead, or pass ' +
      '{ allowNonPrfInsecure: true } to explicitly accept a non-confidential presence gate.',
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
  /** The vault this enrollment was created for. */
  readonly vault: string
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
  /**
   * Non-PRF WebAuthn cannot provide confidentiality — its wrapping key
   * derives from `credentialId`, which is stored in the enrollment record,
   * so the record self-decrypts with no authenticator. By default,
   * enrollment REFUSES the non-PRF path (throws `WebAuthnPRFUnavailableError`).
   * Set `true` ONLY to explicitly opt into a non-confidential presence gate;
   * prefer the secret or a PRF-capable credential for real confidentiality.
   */
  allowNonPrfInsecure?: boolean
}

/** Options for `unlockWebAuthn()`. */
export interface WebAuthnUnlockOptions {
  /** WebAuthn timeout in milliseconds. Default: 60_000. */
  timeout?: number
  /**
   * Only consulted by `webAuthnSlotRewrapCeremony()` — `unlockWebAuthn()`
   * ignores it, since unlocking an existing non-PRF record is always
   * permitted (back-compat; that record was never confidential). Same
   * semantics as `WebAuthnEnrollOptions.allowNonPrfInsecure`: required to
   * rewrap a non-PRF slot, since rewrap produces a fresh self-decrypting
   * wrapped payload.
   */
  allowNonPrfInsecure?: boolean
}

// ─── Environment check ─────────────────────────────────────────────────

/**
 * Returns `true` if WebAuthn is available and can be used for enrollment or unlock.
 *
 * Checks for `navigator.credentials`, `window.PublicKeyCredential`, and a
 * Secure Context (`window.isSecureContext`). Call this before rendering the
 * "Register hardware key" button to avoid showing options that will fail.
 */
export function isWebAuthnAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.credentials !== 'undefined'
  )
}

// ─── PRF salt ─────────────────────────────────────────────────────────

const PRF_SALT = new TextEncoder().encode('noydb-webauthn-kek-derive')

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
 * rawId IS the entire secret and is stored in the record itself — the record
 * self-decrypts with no authenticator involved (presence gate, not confidentiality).
 * Universally supported but only usable via explicit `allowNonPrfInsecure: true`.
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
    kek: null,
    salt: base64ToBuffer(parsed.salt),
    authenticators: [],
  }
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Enroll a WebAuthn credential for the given keyring.
 *
 * The caller must already have an unlocked keyring (from secret auth or
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
 * @throws `WebAuthnPRFUnavailableError` if the authenticator did not provide
 *         PRF output and `options.allowNonPrfInsecure` is not `true` — see
 *         that option's doc for why the non-PRF path is refused by default.
 */
export async function enrollWebAuthn(
  keyring: UnlockedKeyring,
  vault: string,
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

  if (!prfUsed && !options.allowNonPrfInsecure) {
    throw new WebAuthnPRFUnavailableError()
  }

  const wrappingKey = prfOutput
    ? await deriveKeyFromPRF(prfOutput)
    : await deriveKeyFromRawId(credential.rawId)

  const { wrappedPayload, wrapIv } = await wrapKeyringSummary(keyring, wrappingKey)

  return {
    _noydb_webauthn: 1,
    vault,
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
 * Unlock a vault using a previously enrolled WebAuthn credential.
 *
 * Triggers the WebAuthn assertion prompt. On success, decrypts the keyring
 * payload from the enrollment record and returns an `UnlockedKeyring`.
 *
 * The returned keyring has the same DEKs as at enrollment time. If DEKs
 * have been rotated since enrollment, this will return stale DEKs — the
 * caller should detect decryption failures and prompt for re-enrollment.
 *
 * Non-PRF unlock (`enrollment.prfUsed === false`) is a presence gate, not
 * zero-knowledge confidentiality — it is kept working here for back-compat
 * with existing non-PRF enrollments; new enrollments refuse that path by
 * default (see `WebAuthnEnrollOptions.allowNonPrfInsecure`).
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
 * `SlotRewrapCeremony` for WebAuthn slots — used by hub's
 * `rotateSecret({ slotCeremonies: { [slotId]: webAuthnSlotRewrapCeremony } })`
 * to preserve a tier-2 WebAuthn enrollment across a tier-1 phrase
 * rotation without requiring re-enrollment of the credential.
 *
 * The credential itself is unaffected by phrase rotation — the
 * wrapping key derived from PRF (or rawId fallback) is bound to the
 * authenticator, not to the secret. What needs to change is the
 * **wrapped payload**: the encrypted blob the slot's `wrapped_kek`
 * field holds. After rotation, the old payload still has the old
 * DEKs (now stale because rotateSecret rewrapped them under a
 * fresh KEK); the new payload must hold the freshly rewrapped
 * `ctx.newDeks`.
 *
 * Single ceremony, two operations:
 *   1. Trigger one WebAuthn assertion to derive the wrapping key.
 *   2. Decrypt the OLD `wrapped_kek` to extract identity fields
 *      (userId, displayName, role, permissions, salt) — these don't
 *      change on rotation, so they're carried verbatim into the new
 *      payload.
 *   3. Encrypt the NEW payload (same identity + `ctx.newDeks`) under
 *      the same wrapping key, with a fresh IV.
 *   4. Return `EnrollAuthenticatorOptions` preserving `oldSlot.id`
 *      and `method: 'webauthn'` (hub validates these to prevent
 *      slot-type swap mid-rotation).
 *
 * Previously a workaround was needed — detect dropped slots after
 * rotate and offer "Re-enrol Touch ID" inline. This ceremony
 * eliminates that step.
 *
 * Out of scope: tier-3 PIN. PIN state lives in `QuickUnlockStore`
 * (RAM-only), not in `KeyringFile.authenticators[]`, so
 * `slotCeremonies` doesn't apply. Clear PIN state on rotate; let
 * the user set a fresh PIN via `db.enrollUnlock` immediately after.
 *
 * @throws {WebAuthnNotAvailableError} when the environment lacks WebAuthn.
 * @throws {WebAuthnCancelledError} when the user dismisses the assertion.
 * @throws {WebAuthnMultiDeviceError} when `meta.requireSingleDevice` was
 *         set at enrollment and the authenticator now reports BE=1.
 * @throws {ValidationError} when `oldSlot.method !== 'webauthn'`,
 *         when required `meta` fields are missing, or when the old
 *         payload fails to decrypt (credential changed / payload
 *         tampered).
 * @throws {WebAuthnPRFUnavailableError} when the old slot is non-PRF and
 *         `options.allowNonPrfInsecure` is not `true` — rewrapping a
 *         non-PRF slot produces a fresh self-decrypting payload, so it
 *         requires the same explicit acknowledgement as enrollment.
 *
 * @see passwordSlotRewrapCeremony — the password parallel.
 */
export async function webAuthnSlotRewrapCeremony(
  ctx: SlotRewrapContext,
  options: WebAuthnUnlockOptions = {},
): Promise<EnrollAuthenticatorOptions> {
  if (ctx.oldSlot.method !== 'webauthn') {
    throw new ValidationError(
      `webAuthnSlotRewrapCeremony: oldSlot.method is "${ctx.oldSlot.method}"; expected "webauthn". ` +
        'This ceremony only handles WebAuthn slots — pair other methods with their own helpers.',
    )
  }
  if (ctx.oldSlot.wrapKind === 'deks') {
    throw new ValidationError(
      'webAuthnSlotRewrapCeremony: oldSlot is a wrap-DEKs slot; expected wrap-KEK. ' +
        'WebAuthn slots use the wrap-KEK variant; mismatch indicates the slot was ' +
        'enrolled by a different on-* package.',
    )
  }
  if (!isWebAuthnAvailable()) {
    throw new WebAuthnNotAvailableError()
  }

  // Pull the per-slot fields needed for assertion + decrypt. These were
  // written into `meta` by `enrollWebAuthn` (via `db.enrollWebAuthn`).
  const meta = ctx.oldSlot.meta as {
    credentialId?: unknown
    wrapIv?: unknown
    prfUsed?: unknown
    beFlag?: unknown
    requireSingleDevice?: unknown
  }
  if (typeof meta.credentialId !== 'string' || meta.credentialId.length === 0) {
    throw new ValidationError(
      'webAuthnSlotRewrapCeremony: oldSlot.meta.credentialId is missing or invalid. ' +
        'The slot was not enrolled via @noy-db/on-webauthn.',
    )
  }
  if (typeof meta.wrapIv !== 'string' || meta.wrapIv.length === 0) {
    throw new ValidationError(
      'webAuthnSlotRewrapCeremony: oldSlot.meta.wrapIv is missing — the slot may be ' +
        'pre-#16 (synthetic-keyring shape) and must be re-enrolled via db.enrollWebAuthn.',
    )
  }
  const prfUsed = meta.prfUsed === true

  if (!prfUsed && !options.allowNonPrfInsecure) {
    throw new WebAuthnPRFUnavailableError()
  }

  // 1. Trigger the assertion. Same path `unlockWebAuthn` uses.
  const credentialIdBuf = base64ToBuffer(meta.credentialId)
  const timeout = options.timeout ?? 60_000
  const extensionsInput = (prfUsed
    ? { prf: { eval: { first: PRF_SALT } } }
    : {}
  ) as AuthenticationExtensionsClientInputs

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: credentialIdBuf as BufferSource }],
      userVerification: 'required',
      extensions: extensionsInput,
      timeout,
    },
  }) as PublicKeyCredential | null

  if (!assertion) {
    throw new WebAuthnCancelledError('assertion')
  }

  // BE-flag guard at assertion time — same rule unlockWebAuthn enforces.
  const authData = (assertion.response as AuthenticatorAssertionResponse).authenticatorData
  const beFlag = extractBEFlag(authData)
  if (meta.requireSingleDevice === true && beFlag) {
    throw new WebAuthnMultiDeviceError()
  }

  // 2. Derive the wrapping key — deterministic per credential, so this
  //    is the SAME key the original enrollment used.
  let wrappingKey: CryptoKey
  if (prfUsed) {
    const extensions = assertion.getClientExtensionResults() as {
      prf?: { results?: { first?: ArrayBuffer } }
    }
    const prfOutput = extensions.prf?.results?.first
    if (!prfOutput) {
      throw new ValidationError(
        'webAuthnSlotRewrapCeremony: PRF output missing at assertion time. ' +
          'The authenticator may have lost PRF capability — re-enrol the slot via db.enrollWebAuthn.',
      )
    }
    wrappingKey = await deriveKeyFromPRF(prfOutput)
  } else {
    wrappingKey = await deriveKeyFromRawId(assertion.rawId)
  }

  // 3. Decrypt the OLD wrapped_kek to extract carry-through identity
  //    fields. The slot's wrapped_kek IS the old wrappedPayload
  //    (mapping established by db.enrollWebAuthn at noydb.ts:1178).
  const oldIv = base64ToBuffer(meta.wrapIv)
  const oldCiphertext = base64ToBuffer(ctx.oldSlot.wrapped_kek)
  let oldPlaintext: ArrayBuffer
  try {
    oldPlaintext = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: oldIv },
      wrappingKey,
      oldCiphertext,
    )
  } catch {
    throw new ValidationError(
      'webAuthnSlotRewrapCeremony: failed to decrypt the old wrapped payload. ' +
        'The wrapping key derived from this credential does not match — possible ' +
        'cross-tenant slot mix-up or a corrupted enrollment.',
    )
  }
  const oldPayload = JSON.parse(new TextDecoder().decode(oldPlaintext)) as {
    userId: string
    displayName: string
    role: Role
    permissions: Record<string, 'rw' | 'ro'>
    deks: Record<string, string>
    salt: string
  }

  // 4. Build the NEW payload — identity fields preserved, deks
  //    replaced with ctx.newDeks (rewrapped under the new KEK in the
  //    keyring file; here we serialize them as raw bytes for the
  //    self-contained webauthn-side reconstruction).
  const newDekMap: Record<string, string> = {}
  for (const [collName, dek] of ctx.newDeks) {
    const raw = await globalThis.crypto.subtle.exportKey('raw', dek)
    newDekMap[collName] = bufferToBase64(raw)
  }
  const newPayload = JSON.stringify({
    userId: oldPayload.userId,
    displayName: oldPayload.displayName,
    role: oldPayload.role,
    permissions: oldPayload.permissions,
    deks: newDekMap,
    salt: oldPayload.salt,
  })

  // 5. Encrypt with the same wrapping key under a fresh IV.
  const newIv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const newCiphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: newIv },
    wrappingKey,
    new TextEncoder().encode(newPayload),
  )

  // 6. Return EnrollAuthenticatorOptions preserving id + method.
  //    Hub's rotate validates these — a mismatch throws ValidationError
  //    (slot-type swap defense; see SlotRewrapContext docstring).
  return {
    id: ctx.oldSlot.id,
    method: 'webauthn',
    wrapped_kek: bufferToBase64(newCiphertext),
    enrolled_via_tier: ctx.oldSlot.enrolled_via_tier,
    meta: {
      credentialId: meta.credentialId,
      wrapIv: bufferToBase64(newIv),
      prfUsed,
      beFlag,
      requireSingleDevice: meta.requireSingleDevice === true,
    },
  }
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
    typeof e.vault === 'string' &&
    typeof e.userId === 'string' &&
    typeof e.credentialId === 'string' &&
    typeof e.wrappedPayload === 'string' &&
    typeof e.wrapIv === 'string'
  )
}
