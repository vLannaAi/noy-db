/**
 * **@noy-db/on-password** — tier-2 password authenticator slot.
 *
 * The user's tier-1 *phrase* is the rarely-typed master that derives
 * the KEK. This package adds a SEPARATE secret — a password the user
 * types at each unlock — as a tier-2 slot in the multi-slot keyring.
 * The two credentials have:
 *
 * - **Different lifecycles** — the phrase rotates yearly; the password
 *   rotates per the developer's policy.
 * - **Different strength rules** — the phrase is validated against the
 *   phrase format; the password is validated against a
 *   length / regex rule the developer chooses.
 * - **Different storage** — the phrase derives the KEK; the password
 *   derives a wrapping key that wraps the SAME DEK SET in its own
 *   keyring slot (LUKS-like multi-slot, wrap-DEKs variant).
 *
 * ## Wrap-DEKs format (Path C)
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
import {
  base64ToBuffer,
  mintWrappedDeksBlob,
  unwrapDeksFromBlob,
  ValidationError,
  type EnrollAuthenticatorOptions,
  type KeyringAuthenticator,
  type KeyringFile,
  type NoydbStore,
  type SlotRewrapCeremony,
  type SlotRewrapContext,
  type UnlockedKeyring,
} from '@noy-db/hub'

/**
 * PBKDF2 iteration count — matches the tier-1 phrase derivation.
 * Exported as a documented invariant; the actual derivation lives
 * in hub's canonical wrap-DEKs primitive.
 */
export const PASSWORD_PBKDF2_ITERATIONS = 600_000

/** Default minimum password length. Override per-app via `enrollPasswordAuthenticator`. */
export const PASSWORD_DEFAULT_MIN_LENGTH = 12

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
  /** Slot id. Default: `'password'`. */
  readonly id?: string
  /** Password the user will type at unlock. Distinct from the tier-1 phrase. */
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
 *   password: 'strong-password-2026',
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

  // Delegate the wrap-DEKs crypto to the canonical hub primitive.
  // The slot envelope still stores `salt` inside `meta` for backward
  // compatibility with the legacy slot format; moving it to top-level
  // for parity with PaperRecoveryEntry is deferred.
  const blob = await mintWrappedDeksBlob(keyring.deks, options.password)

  return {
    id: options.id ?? 'password',
    method: 'password',
    wrapKind: 'deks',
    wrapped_deks: blob.wrappedDeks,
    iv: blob.iv,
    meta: {
      salt: blob.salt,
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
 *   legacy wrap-KEK slots — those need re-enrollment).
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

  // Delegate to the canonical wrap-DEKs primitive. The blob's
  // three fields (salt / iv / wrappedDeks) are reconstructed from
  // the slot's split layout: salt lives in meta, iv + wrappedDeks
  // at top level. Previously, this code re-implemented the same crypto
  // inline.
  try {
    return await unwrapDeksFromBlob(
      { salt: meta.salt, iv: slot.iv, wrappedDeks: slot.wrapped_deks },
      password,
    )
  } catch {
    throw new PasswordInvalidError()
  }
}

/**
 * Hub-friendly verify callback. Pass to `db.unlockViaAuthenticator`:
 *
 * ```ts
 * import { verifyPasswordSlot } from '@noy-db/on-password'
 *
 * const unlocked = await db.unlockViaAuthenticator('acme', 'password',
 *   (slot) => verifyPasswordSlot(slot, 'strong-password-2026',
 *     { store, vault: 'acme', userId: 'alice' }),
 * )
 * ```
 *
 * Unwraps the DEK set with the supplied password and returns an
 * `UnlockedKeyring` the hub installs in its keyring cache. The
 * returned keyring has `kek: null` — sensitive operations (enrol new
 * slot, rotate phrase) require a tier-1 unlock from the master phrase.
 *
 * The `{ store, vault, userId }` shape works in both contexts:
 *   - **Warm re-unlock** — db is alive; consumer already has identity
 *     in memory but pays one cheap `_keyring/<userId>` read.
 *   - **Cold-start** (`createNoydb({ getKeyring: ... })`) — consumer
 *     does NOT have a keyring yet; the verifier loads identity from
 *     disk before returning the unlocked keyring. This is the
 *     primary cold-start tier-2 path (Niwat tier-2b uses this).
 *
 * Identity fields (userId, displayName, role, permissions,
 * authenticators, salt, capability bits, per-keyring policy) are read
 * directly from the `_keyring/<userId>` envelope's plaintext header —
 * those fields are not encrypted because the sync engine + grant flow
 * need them without a key.
 *
 * @throws {@link PasswordInvalidError} when the password is wrong or
 *   the keyring file is missing.
 */
export async function verifyPasswordSlot(
  slot: KeyringAuthenticator,
  password: string,
  options: VerifyPasswordSlotOptions,
): Promise<UnlockedKeyring> {
  const deks = await unwrapDeksWithPassword(slot, password)

  const env = await options.store.get(options.vault, '_keyring', options.userId)
  if (!env) {
    throw new PasswordInvalidError(
      `verifyPasswordSlot: no keyring found at "${options.vault}/_keyring/${options.userId}". ` +
        'Verify the vault and userId are correct.',
    )
  }
  const file = JSON.parse(env._data) as KeyringFile
  const salt = new Uint8Array(base64ToBuffer(file.salt))

  return {
    userId: file.user_id,
    displayName: file.display_name,
    role: file.role,
    permissions: file.permissions,
    authenticators: file.authenticators ?? [],
    salt,
    ...(file.export_capability !== undefined && { exportCapability: file.export_capability }),
    ...(file.import_capability !== undefined && { importCapability: file.import_capability }),
    ...(file.policy !== undefined && { policy: file.policy }),
    deks,
    // Wrap-DEKs unlock cannot recover the KEK. Sensitive ops route
    // through tier-1 via re-entry of the master phrase. Matches the
    // existing tier-3 (`@noy-db/on-pin`) pattern.
    kek: null,
  }
}

/** Adapter shape required by {@link verifyPasswordSlot}. */
export interface VerifyPasswordSlotOptions {
  /** The vault's NoydbStore — used to load `_keyring/<userId>`. */
  readonly store: NoydbStore
  /** Vault name — same value passed to `db.openVault(name)`. */
  readonly vault: string
  /** User id — same value passed to `createNoydb({ user })`. */
  readonly userId: string
}

/**
 * `SlotRewrapCeremony` factory for password slots — the password parallel
 * to `webAuthnSlotRewrapCeremony`. Used by hub's
 * `rotatePassphrase({ slotCeremonies: { [slotId]: passwordSlotRewrapCeremony(pwd) } })`
 * to preserve a tier-2 password enrollment across a tier-1 phrase
 * rotation without forcing the user to re-enroll the password.
 *
 * Returns a closure capturing the password so the result matches
 * hub's `SlotRewrapCeremony` signature `(ctx) => Promise<EnrollAuthenticatorOptions>`
 * directly. Pass into `slotCeremonies` keyed by the existing slot id:
 *
 * ```ts
 * import { passwordSlotRewrapCeremony } from '@noy-db/on-password'
 *
 * await db.rotatePassphrase('acme', {
 *   oldPassphrase: oldPhrase,
 *   newPassphrase: newPhrase,
 *   slotCeremonies: {
 *     'password': passwordSlotRewrapCeremony('strong-password-2026'),
 *   },
 * })
 * ```
 *
 * The password itself is unaffected by phrase rotation — what needs to
 * change is the **wrapped DEK set**: the encrypted blob the slot's
 * `wrapped_deks` field holds. After rotation, the old blob still has
 * the old DEKs (now stale because rotatePassphrase rewrapped them
 * under a fresh KEK); the new blob must hold the freshly rewrapped
 * `ctx.newDeks`.
 *
 * Single ceremony, one operation:
 *   1. Validate `oldSlot.method === 'password'` and `oldSlot.wrapKind === 'deks'`.
 *   2. Re-mint the wrap-DEKs blob via {@link enrollPasswordAuthenticator}
 *      using the supplied password against `ctx.newDeks`.
 *   3. Return `EnrollAuthenticatorOptions` preserving `oldSlot.id`,
 *      `method: 'password'`, and the strength config (`minLength`,
 *      `pattern`) carried in the old slot's `meta`. Hub validates
 *      `id` + `method` + `wrapKind` to prevent slot-type swap mid-
 *      rotation.
 *
 * Legacy wrap-KEK password slots cannot be rewrapped via
 * this ceremony — they must be re-enrolled fresh via
 * {@link enrollPasswordAuthenticator}. The validation throws
 * {@link ValidationError} for those.
 *
 * @throws {ValidationError} when `oldSlot.method !== 'password'` or
 *         `oldSlot.wrapKind !== 'deks'`.
 * @throws {PasswordTooWeakError} when the supplied password fails the
 *         strength rules carried in `oldSlot.meta` (minLength, pattern).
 *
 * @see webAuthnSlotRewrapCeremony — the WebAuthn parallel.
 */
export function passwordSlotRewrapCeremony(password: string): SlotRewrapCeremony {
  return async (ctx: SlotRewrapContext): Promise<EnrollAuthenticatorOptions> => {
    if (ctx.oldSlot.method !== 'password') {
      throw new ValidationError(
        `passwordSlotRewrapCeremony: oldSlot.method is "${ctx.oldSlot.method}"; expected "password". ` +
          'This ceremony only handles password slots — pair other methods with their own helpers.',
      )
    }
    if (ctx.oldSlot.wrapKind !== 'deks') {
      throw new ValidationError(
        'passwordSlotRewrapCeremony: oldSlot is a wrap-KEK slot; expected wrap-DEKs. ' +
          'Password slots use the wrap-DEKs variant since #26 Path C; legacy wrap-KEK ' +
          'password slots are not supported here — re-enrol via enrollPasswordAuthenticator.',
      )
    }

    // Preserve the strength config the slot was originally enrolled with —
    // a rotation should not silently downgrade minLength or drop a pattern.
    const oldMeta = ctx.oldSlot.meta as { minLength?: unknown; pattern?: unknown }
    const minLength = typeof oldMeta.minLength === 'number' ? oldMeta.minLength : undefined
    const pattern = typeof oldMeta.pattern === 'string' ? new RegExp(oldMeta.pattern) : undefined

    return enrollPasswordAuthenticator(
      // enrollPasswordAuthenticator only reads `keyring.deks`, so a
      // synthetic minimal keyring is enough. The freshly-rewrapped DEKs
      // come from hub via `ctx.newDeks`.
      { deks: ctx.newDeks } as UnlockedKeyring,
      {
        id: ctx.oldSlot.id,
        password,
        ...(minLength !== undefined && { minLength }),
        ...(pattern !== undefined && { pattern }),
        // Carry the original tier so hub's anti-slot-swap guard plus
        // the rotate-recover preservation rule keep the slot's
        // provenance honest.
        enrolledViaTier: ctx.oldSlot.enrolled_via_tier,
      },
    )
  }
}

// All wrap-DEKs crypto helpers (PBKDF2 derivation, base64
// codecs) live in hub's `team/wrapped-deks.ts` — both this
// package and `mintPaperRecoveryEntry` share one implementation.
