/**
 * **@noy-db/on-password** — tier-2 daily-password authenticator slot.
 *
 * The user's tier-1 *phrase* is the rarely-typed master that derives
 * the KEK. This package adds a SEPARATE secret — a daily-typed
 * password — as a tier-2 slot in the multi-slot keyring. The two
 * credentials have:
 *
 * - **Different lifecycles** — the phrase rotates yearly; the password
 *   rotates per the developer's policy.
 * - **Different strength rules** — the phrase is validated against the
 *   phrase format (issue #7); the password is validated against a
 *   length / regex rule the developer chooses.
 * - **Different storage** — the phrase derives the KEK; the password
 *   derives a wrapping key that wraps the SAME DEK SET in its own
 *   keyring slot (LUKS-like multi-slot, wrap-DEKs variant).
 *
 * ## Wrap-DEKs format (#26 Path C)
 *
 * Slots produced by this package use the wrap-DEKs variant of
 * `KeyringAuthenticator` — they encrypt the serialized DEK set under
 * a password-derived AES-GCM key, NOT the KEK. This unifies tier-2
 * password slots with the tier-0 (paper recovery, `mintPaperRecoveryEntry`)
 * and tier-3 (`@noy-db/on-pin`'s `wrappedKeyring`) primitives — all
 * three sidestep the non-extractable-KEK constraint by wrapping the
 * DEK set rather than the KEK itself.
 *
 * Trade-off: an `UnlockedKeyring` produced via password-slot unlock
 * has `kek: null`. Sensitive operations (`enrollAuthenticator`,
 * `rotatePassphrase`) require a tier-1 unlock anyway — re-enter the
 * master phrase.
 *
 * @see docs/subsystems/session-tiers.md → Tier 2 — `on-password`
 *
 * @packageDocumentation
 */
import type {
  EnrollAuthenticatorOptions,
  KeyringAuthenticator,
  UnlockedKeyring,
} from '@noy-db/hub'

/** PBKDF2 iteration count — matches the tier-1 phrase derivation. */
export const PASSWORD_PBKDF2_ITERATIONS = 600_000

/** Default minimum password length. Override per-app via `enrollPasswordAuthenticator`. */
export const PASSWORD_DEFAULT_MIN_LENGTH = 12

/** Per-slot salt size. */
const SALT_BYTES = 32
/** AES-GCM IV size. */
const IV_BYTES = 12

const subtle = globalThis.crypto.subtle

// ─── Errors ────────────────────────────────────────────────────────────

export class PasswordTooWeakError extends Error {
  readonly code = 'PASSWORD_TOO_WEAK' as const
  readonly minLength: number
  constructor(minLength: number, message?: string) {
    super(
      message ??
        `Password must be at least ${String(minLength)} characters. ` +
          'For accounts with a separate tier-1 phrase, prefer a longer password ' +
          'or pair with TOTP/email-OTP via @noy-db/on-totp or @noy-db/on-email-otp.',
    )
    this.name = 'PasswordTooWeakError'
    this.minLength = minLength
  }
}

export class PasswordInvalidError extends Error {
  readonly code = 'PASSWORD_INVALID' as const
  constructor(message = 'Password does not unlock this slot.') {
    super(message)
    this.name = 'PasswordInvalidError'
  }
}

// ─── Public API ────────────────────────────────────────────────────────

/** Options for {@link enrollPasswordAuthenticator}. */
export interface EnrollPasswordOptions {
  /** Slot id. Default: `'password-daily'`. */
  readonly id?: string
  /** Daily password the user will type. Distinct from the tier-1 phrase. */
  readonly password: string
  /** Minimum length. Default 12. */
  readonly minLength?: number
  /** Optional regex the password must satisfy in addition to length. */
  readonly pattern?: RegExp
  /** Tier the active session held when enrolling. Default 1. */
  readonly enrolledViaTier?: 1 | 2
}

/**
 * Build the keyring slot for a tier-2 password authenticator. Returns
 * an `EnrollAuthenticatorOptions` value the caller hands to
 * `db.enrollAuthenticator(vault, slot)` — separating the cryptographic
 * step (this function) from the persistence step (the hub) keeps the
 * package small and lets the hub's policy gate run between the two.
 *
 * The slot uses the **wrap-DEKs** variant of `KeyringAuthenticator`:
 * the DEK set is serialized to JSON and encrypted with AES-GCM under
 * a PBKDF2-derived key. No requirement on `keyring.kek` — works with
 * tier-1 unlocked keyrings; throws if `keyring.deks` is empty.
 *
 * Usage:
 *
 * ```ts
 * import { enrollPasswordAuthenticator } from '@noy-db/on-password'
 *
 * const keyring = await db.getKeyring('acme')
 * const slot = await enrollPasswordAuthenticator(keyring, {
 *   password: 'daily-password-2026',
 *   minLength: 14,
 * })
 * await db.enrollAuthenticator('acme', slot, {
 *   factors: [{ kind: 'totp' }],
 * })
 * ```
 */
export async function enrollPasswordAuthenticator(
  keyring: UnlockedKeyring,
  options: EnrollPasswordOptions,
): Promise<EnrollAuthenticatorOptions> {
  const minLength = options.minLength ?? PASSWORD_DEFAULT_MIN_LENGTH
  if (options.password.length < minLength) {
    throw new PasswordTooWeakError(minLength)
  }
  if (options.pattern && !options.pattern.test(options.password)) {
    throw new PasswordTooWeakError(
      minLength,
      `Password does not match the configured pattern: ${options.pattern.toString()}.`,
    )
  }

  if (keyring.deks.size === 0) {
    throw new Error(
      'enrollPasswordAuthenticator: the supplied keyring has no DEKs in memory. ' +
        'Re-authenticate at tier 1 first.',
    )
  }

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const wrappingKey = await derivePasswordWrappingKey(options.password, salt)

  // Serialize the DEK set as JSON `{ deks: { collection: base64 } }`.
  const exported: Record<string, string> = {}
  for (const [coll, dek] of keyring.deks) {
    const raw = await subtle.exportKey('raw', dek)
    exported[coll] = bytesToBase64(new Uint8Array(raw))
  }
  const plaintext = new TextEncoder().encode(JSON.stringify({ deks: exported }))
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    wrappingKey,
    plaintext as BufferSource,
  )

  return {
    id: options.id ?? 'password-daily',
    method: 'password',
    wrapKind: 'deks',
    wrapped_deks: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
    meta: {
      salt: bytesToBase64(salt),
      minLength,
      ...(options.pattern !== undefined ? { pattern: options.pattern.source } : {}),
    },
    enrolled_via_tier: options.enrolledViaTier ?? 1,
  }
}

/**
 * Recover the DEK set from a wrap-DEKs password slot. Returns the raw
 * DEK map; the hub-friendly verifier {@link verifyPasswordSlot} wraps
 * this and produces a full `UnlockedKeyring`.
 *
 * @throws {@link PasswordInvalidError} when the password is wrong or
 *   the slot is not a wrap-DEKs slot (e.g. a legacy wrap-KEK password
 *   slot from before pre.8 — those need re-enrollment).
 */
export async function unwrapDeksWithPassword(
  slot: KeyringAuthenticator,
  password: string,
): Promise<Map<string, CryptoKey>> {
  if (slot.wrapKind !== 'deks') {
    throw new PasswordInvalidError(
      'Password slot is not a wrap-DEKs slot. Pre-pre.8 wrap-KEK password ' +
        'slots are no longer supported — re-enrol via enrollPasswordAuthenticator.',
    )
  }

  const meta = slot.meta as { salt?: unknown }
  if (typeof meta.salt !== 'string') {
    throw new PasswordInvalidError(
      'Password slot is missing the per-slot salt — keyring may be corrupted.',
    )
  }
  const salt = base64ToBytes(meta.salt)
  const wrappingKey = await derivePasswordWrappingKey(password, salt)

  let plaintext: ArrayBuffer
  try {
    plaintext = await subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(slot.iv) as BufferSource },
      wrappingKey,
      base64ToBytes(slot.wrapped_deks) as BufferSource,
    )
  } catch {
    throw new PasswordInvalidError()
  }

  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as { deks: Record<string, string> }
  const deks = new Map<string, CryptoKey>()
  for (const [coll, b64] of Object.entries(parsed.deks)) {
    const raw = base64ToBytes(b64)
    const key = await subtle.importKey(
      'raw',
      raw as BufferSource,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
    deks.set(coll, key)
  }
  return deks
}

/**
 * Hub-friendly verify callback. Pass to `db.unlockViaAuthenticator`:
 *
 * ```ts
 * import { verifyPasswordSlot } from '@noy-db/on-password'
 *
 * const unlocked = await db.unlockViaAuthenticator('acme', 'password-daily',
 *   (slot) => verifyPasswordSlot(slot, 'daily-password-2026', { keyring }),
 * )
 * ```
 *
 * Unwraps the DEK set with the supplied password and returns an
 * `UnlockedKeyring` the hub installs in its keyring cache. The
 * returned keyring has `kek: null` — sensitive operations (enrol new
 * slot, rotate phrase) require a tier-1 unlock from the master phrase.
 *
 * Pass the current `keyring` (from `db.getKeyring(vault)`) to copy
 * identity fields (userId, role, permissions, authenticators) onto
 * the recovered `UnlockedKeyring`. Those fields aren't recoverable
 * from the wrapped-DEKs ciphertext alone.
 *
 * @throws {@link PasswordInvalidError} when the password is wrong.
 */
export async function verifyPasswordSlot(
  slot: KeyringAuthenticator,
  password: string,
  options: VerifyPasswordSlotOptions,
): Promise<UnlockedKeyring> {
  const deks = await unwrapDeksWithPassword(slot, password)
  const reference = options.keyring
  return {
    userId: reference.userId,
    displayName: reference.displayName,
    role: reference.role,
    permissions: reference.permissions,
    authenticators: reference.authenticators,
    salt: reference.salt,
    ...(reference.exportCapability !== undefined && { exportCapability: reference.exportCapability }),
    ...(reference.importCapability !== undefined && { importCapability: reference.importCapability }),
    ...(reference.policy !== undefined && { policy: reference.policy }),
    deks,
    // Wrap-DEKs unlock cannot recover the KEK. Sensitive ops route
    // through tier-1 via re-entry of the master phrase. Matches the
    // existing tier-3 (`@noy-db/on-pin`) pattern.
    kek: null as unknown as CryptoKey,
  }
}

/** Adapter shape required by {@link verifyPasswordSlot}. */
export interface VerifyPasswordSlotOptions {
  /**
   * The current vault keyring (typically `await db.getKeyring(vault)`).
   * Identity fields (`userId`, `role`, `permissions`, `authenticators`,
   * `salt`) are copied onto the recovered `UnlockedKeyring`. The DEK
   * map is replaced with the unwrapped contents of the password slot.
   */
  readonly keyring: UnlockedKeyring
}

// ─── Helpers ───────────────────────────────────────────────────────────

async function derivePasswordWrappingKey(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const ikm = await subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PASSWORD_PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
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
