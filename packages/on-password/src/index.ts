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
 *   derives a wrapping key that wraps the SAME KEK in its own
 *   keyring slot (LUKS pattern).
 *
 * The slot is added to the keyring via `db.enrollAuthenticator`; the
 * KEK is recovered via `db.unlockViaAuthenticator` — both routes hit
 * the policy gate engine (issue #9).
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
 * Usage:
 *
 * ```ts
 * import { enrollPasswordAuthenticator } from '@noy-db/on-password'
 *
 * const slot = await enrollPasswordAuthenticator(unlocked, {
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

  if (!keyring.kek) {
    throw new Error(
      'enrollPasswordAuthenticator: the supplied keyring has no KEK in memory. ' +
        'Tier-3 quick-resume keyrings cannot enrol new tier-2 slots; re-authenticate at tier 1 first.',
    )
  }

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const wrappingKey = await derivePasswordWrappingKey(options.password, salt)
  const wrapped = await subtle.wrapKey('raw', keyring.kek, wrappingKey, 'AES-KW')

  return {
    id: options.id ?? 'password-daily',
    method: 'password',
    wrapped_kek: bytesToBase64(new Uint8Array(wrapped)),
    meta: {
      salt: bytesToBase64(salt),
      minLength,
      ...(options.pattern !== undefined ? { pattern: options.pattern.source } : {}),
    },
    enrolled_via_tier: options.enrolledViaTier ?? 1,
  }
}

/**
 * Recover the KEK from a password slot's `wrapped_kek` ciphertext.
 * Returns the unwrapped KEK as a non-extractable `CryptoKey` ready for
 * AES-KW unwrap of DEKs. Used inside the verify callback passed to
 * `db.unlockViaAuthenticator`.
 *
 * @throws {@link PasswordInvalidError} when the password is wrong.
 */
export async function unwrapKekWithPassword(
  slot: KeyringAuthenticator,
  password: string,
): Promise<CryptoKey> {
  const meta = slot.meta as { salt?: unknown }
  if (typeof meta.salt !== 'string') {
    throw new PasswordInvalidError(
      'Password slot is missing the per-slot salt — keyring may be corrupted.',
    )
  }
  const salt = base64ToBytes(meta.salt)
  const wrappingKey = await derivePasswordWrappingKey(password, salt)
  try {
    return await subtle.unwrapKey(
      'raw',
      base64ToBytes(slot.wrapped_kek) as BufferSource,
      wrappingKey,
      'AES-KW',
      { name: 'AES-KW', length: 256 },
      false,
      ['wrapKey', 'unwrapKey'],
    )
  } catch {
    throw new PasswordInvalidError()
  }
}

/**
 * Hub-friendly verify callback. Pass to `db.unlockViaAuthenticator`:
 *
 * ```ts
 * const unlocked = await db.unlockViaAuthenticator('acme', 'password-daily',
 *   (slot) => verifyPasswordSlot(slot, 'daily-password-2026', { adapter: store, vault: 'acme', userId: 'alice' }),
 * )
 * ```
 *
 * The callback re-loads the keyring file via the supplied adapter,
 * unwraps every DEK with the recovered KEK, and returns the
 * `UnlockedKeyring` the hub installs in its keyring cache.
 *
 * @throws {@link PasswordInvalidError} when the password is wrong.
 */
export async function verifyPasswordSlot(
  slot: KeyringAuthenticator,
  password: string,
  options: VerifyPasswordSlotOptions,
): Promise<UnlockedKeyring> {
  const kek = await unwrapKekWithPassword(slot, password)
  return options.materialize(kek)
}

/** Adapter shape required by {@link verifyPasswordSlot}. */
export interface VerifyPasswordSlotOptions {
  /**
   * Caller-supplied "given the recovered KEK, build the
   * `UnlockedKeyring`" routine. The hub provides the standard
   * implementation in {@link buildUnlockedKeyringFromKek}; consumers
   * with non-standard storage (e.g. encrypted browser-extension
   * stores) can pass their own.
   */
  readonly materialize: (kek: CryptoKey) => Promise<UnlockedKeyring>
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
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
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
