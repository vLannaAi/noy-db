/**
 * **@noy-db/on-pin** — session-resume PIN quick-lock for noy-db.
 *
 * The use case: after the user unlocks a vault with the full passphrase,
 * the session goes idle (screen lock, tab switch). Instead of re-entering
 * the full passphrase, the user types a 4–6 digit PIN (or taps their
 * device biometric) to **resume the already-open session**.
 *
 * ## What this is NOT
 *
 * This is **NOT** a passphrase replacement. If the vault is cold-started
 * (fresh app launch, no prior unlock), a PIN alone cannot open it — the
 * KEK must be re-derived from the real passphrase via PBKDF2-600K.
 *
 * ## Security model
 *
 * 1. **PIN never derives the KEK.** The PIN derives a transient wrapping
 *    key via PBKDF2 (100k iterations, not 600k — the protection window is
 *    short, so fewer iterations are acceptable).
 * 2. **The transient key wraps only the DEKs.** A `PinResumeState` carries
 *    the encrypted DEK map but NOT the KEK. Even if the PIN is
 *    compromised, an attacker cannot re-derive the KEK or unwrap a cold
 *    keyring — they can only re-open THIS session's cached DEKs.
 * 3. **TTL-bounded.** Every `PinResumeState` has an `expiresAt`. After
 *    expiry, `resumePin()` throws; the user must re-enter the full
 *    passphrase.
 * 4. **Attempt-bounded.** After `maxAttempts` wrong PINs, the state
 *    refuses further attempts until re-enrolment.
 * 5. **Memory-scoped by convention.** The caller is responsible for
 *    storing the `PinResumeState` appropriately — ideally in memory
 *    (lost when the process exits). Writing it to `localStorage` is
 *    allowed but defeats the short-lived-session property, so it is
 *    flagged here as a design decision the caller owns.
 *
 * ## Limits (read before shipping)
 *
 * - The `attempts` counter lives inside the `PinResumeState` object.
 *   An attacker with a stale copy of the state can "reset" attempts
 *   by reverting their copy. Real lockout enforcement needs a trusted
 *   counter (server-side or OS secure enclave). Document this to
 *   consumers.
 * - Offline brute-force is bounded by PBKDF2 cost + the secrecy of the
 *   state blob. Do not persist the state to a public location.
 * - A 4-digit numeric PIN has only 10,000 possibilities. With 100k
 *   PBKDF2 iterations each, a GPU attacker needs ~10^9 hash ops to
 *   exhaust the space — roughly hours. Combined with the short TTL
 *   and the attempts counter, this is acceptable for UX convenience
 *   but NOT for primary authentication.
 *
 * ## API shape (mirrors @noy-db/on-* siblings)
 *
 * ```ts
 * import { enrollPin, resumePin } from '@noy-db/on-pin'
 *
 * // After the user has opened the vault with the full passphrase:
 * const state = await enrollPin(keyring, { pin: '1234', ttlMs: 15 * 60 * 1000 })
 * // Keep `state` in memory. Do not write it anywhere durable.
 *
 * // Later, when session resumes:
 * const keyring = await resumePin(state, { pin: '1234' })
 * ```
 *
 * @packageDocumentation
 */

import type { Role, Permissions, UnlockedKeyring } from '@noy-db/hub'

// ─── Constants ──────────────────────────────────────────────────────────

/** Default TTL: 15 minutes. Short by design — PIN resumes, doesn't replace. */
export const PIN_DEFAULT_TTL_MS = 15 * 60 * 1000

/** Default max attempts before state refuses further unlock. */
export const PIN_DEFAULT_MAX_ATTEMPTS = 5

/**
 * PBKDF2 iteration count for the PIN. Lower than the 600k used for
 * passphrase KEK derivation because (a) the window is short, (b) the
 * attempt counter bounds online attacks, (c) the state is not
 * persisted in a public location. Do not lower this further without
 * also raising attempt-counter rigour.
 */
export const PIN_PBKDF2_ITERATIONS = 100_000

// ─── Errors ─────────────────────────────────────────────────────────────

export class PinInvalidError extends Error {
  readonly code = 'PIN_INVALID' as const
  constructor(message = 'PIN is incorrect.') {
    super(message)
    this.name = 'PinInvalidError'
  }
}

export class PinExpiredError extends Error {
  readonly code = 'PIN_EXPIRED' as const
  constructor(message = 'PIN resume window has expired; re-enter full passphrase.') {
    super(message)
    this.name = 'PinExpiredError'
  }
}

export class PinAttemptsExceededError extends Error {
  readonly code = 'PIN_ATTEMPTS_EXCEEDED' as const
  constructor(message = 'Too many wrong PIN attempts; re-enter full passphrase.') {
    super(message)
    this.name = 'PinAttemptsExceededError'
  }
}

export class PinEnrollmentError extends Error {
  readonly code = 'PIN_ENROLLMENT_FAILED' as const
  constructor(message = 'PIN enrolment failed.') {
    super(message)
    this.name = 'PinEnrollmentError'
  }
}

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * Opaque serializable state produced by `enrollPin()`. Hand it to
 * `resumePin()` to unlock. Callers keep this in memory (not on disk /
 * sessionStorage in general) per the security model above.
 *
 * `attempts` is the only mutable field; incremented on wrong-PIN
 * failures. Callers should treat the rest as immutable.
 */
export interface PinResumeState {
  /** Schema marker. */
  readonly _noydb_on_pin: 1
  /** Base64 PBKDF2 salt (32 random bytes). */
  readonly salt: string
  /** Base64 AES-GCM IV (12 random bytes) used to encrypt the wrapped payload. */
  readonly iv: string
  /** Base64 AES-GCM ciphertext — serialized keyring wrapped with the PIN-derived key. */
  readonly wrappedKeyring: string
  /** ISO-8601 timestamp after which `resumePin()` refuses. */
  readonly expiresAt: string
  /** Mutable counter — incremented on each wrong-PIN attempt. */
  attempts: number
  /** Upper bound; when `attempts >= maxAttempts`, resume throws. */
  readonly maxAttempts: number
}

export interface EnrollPinOptions {
  /** The short secret. Typically 4–6 digits, but any string works. */
  readonly pin: string
  /** Resume window length. Default: 15 minutes. */
  readonly ttlMs?: number
  /** Max wrong-PIN attempts before the state is dead. Default: 5. */
  readonly maxAttempts?: number
}

export interface ResumePinOptions {
  readonly pin: string
}

// ─── Implementation ─────────────────────────────────────────────────────

/**
 * Enrol a PIN for session-resume against an already-unlocked keyring.
 *
 * Requires the keyring's DEKs to be extractable (`crypto.subtle.exportKey('raw', dek)`
 * must succeed). The hub creates DEKs with `extractable: true` by default.
 *
 * @throws `PinEnrollmentError` if any DEK is non-extractable.
 */
export async function enrollPin(
  keyring: UnlockedKeyring,
  options: EnrollPinOptions,
): Promise<PinResumeState> {
  const ttlMs = options.ttlMs ?? PIN_DEFAULT_TTL_MS
  const maxAttempts = options.maxAttempts ?? PIN_DEFAULT_MAX_ATTEMPTS

  const salt = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))

  const wrappingKey = await deriveWrappingKey(options.pin, salt)

  let serialized: Uint8Array
  try {
    serialized = await serializeKeyring(keyring)
  } catch (err) {
    throw new PinEnrollmentError(
      'Failed to serialize keyring — DEK not extractable. ' +
      `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    wrappingKey,
    serialized as BufferSource,
  )

  return {
    _noydb_on_pin: 1,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    wrappedKeyring: bytesToBase64(new Uint8Array(ciphertext)),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    attempts: 0,
    maxAttempts,
  }
}

/**
 * Resume a session from a previously-enrolled `PinResumeState`.
 *
 * The returned keyring has `kek: null` — PIN resume does NOT reconstruct
 * the KEK (by design). The DEKs are sufficient for normal reads and
 * writes; operations that require a KEK (opening additional vaults,
 * re-enrolling, key rotation) still need the full passphrase flow.
 *
 * @throws `PinExpiredError` if the resume window has elapsed.
 * @throws `PinAttemptsExceededError` if `attempts >= maxAttempts`.
 * @throws `PinInvalidError` if the PIN is wrong (state.attempts incremented).
 */
export async function resumePin(
  state: PinResumeState,
  options: ResumePinOptions,
): Promise<UnlockedKeyring> {
  if (Date.now() > new Date(state.expiresAt).getTime()) {
    throw new PinExpiredError()
  }
  if (state.attempts >= state.maxAttempts) {
    throw new PinAttemptsExceededError()
  }

  const salt = base64ToBytes(state.salt)
  const iv = base64ToBytes(state.iv)
  const ciphertext = base64ToBytes(state.wrappedKeyring)

  const wrappingKey = await deriveWrappingKey(options.pin, salt)

  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      wrappingKey,
      ciphertext as BufferSource,
    )
  } catch {
    // AES-GCM auth failure. Increment the attempts counter before
    // throwing so repeated wrong PINs progressively lock the state.
    state.attempts = state.attempts + 1
    throw new PinInvalidError()
  }

  return deserializeKeyring(new Uint8Array(plaintext))
}

/** Fast TTL check without attempting decrypt. */
export function isPinStateValid(state: PinResumeState): boolean {
  return (
    Date.now() <= new Date(state.expiresAt).getTime() &&
    state.attempts < state.maxAttempts
  )
}

/**
 * Zero the state in place. After this, `resumePin()` will fail.
 * Use on explicit logout.
 */
export function clearPinState(state: PinResumeState): void {
  // Overwrite the attempts counter past the max + expire the state.
  ;(state as { attempts: number }).attempts = state.maxAttempts
  ;(state as { expiresAt: string }).expiresAt = new Date(0).toISOString()
  ;(state as { wrappedKeyring: string }).wrappedKeyring = ''
}

// ─── Helpers ────────────────────────────────────────────────────────────

async function deriveWrappingKey(
  pin: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PIN_PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

interface SerializedKeyring {
  userId: string
  displayName: string
  role: Role
  permissions: Permissions
  salt: string
  deks: Record<string, string>
}

async function serializeKeyring(k: UnlockedKeyring): Promise<Uint8Array> {
  const deks: Record<string, string> = {}
  for (const [collection, key] of k.deks) {
    const raw = await crypto.subtle.exportKey('raw', key)
    deks[collection] = bytesToBase64(new Uint8Array(raw))
  }
  const json: SerializedKeyring = {
    userId: k.userId,
    displayName: k.displayName,
    role: k.role,
    permissions: k.permissions,
    salt: bytesToBase64(k.salt),
    deks,
  }
  return new TextEncoder().encode(JSON.stringify(json))
}

async function deserializeKeyring(bytes: Uint8Array): Promise<UnlockedKeyring> {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as SerializedKeyring
  const deks = new Map<string, CryptoKey>()
  for (const [coll, b64] of Object.entries(parsed.deks)) {
    const raw = base64ToBytes(b64)
    const key = await crypto.subtle.importKey(
      'raw',
      raw as BufferSource,
      { name: 'AES-GCM' },
      true,
      ['encrypt', 'decrypt'],
    )
    deks.set(coll, key)
  }
  return {
    userId: parsed.userId,
    displayName: parsed.displayName,
    role: parsed.role,
    permissions: parsed.permissions,
    salt: base64ToBytes(parsed.salt),
    deks,
    // KEK is deliberately null — PIN-resume returns a keyring that can
    // read/write but cannot open additional vaults or rotate keys.
    kek: null as unknown as CryptoKey,
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
