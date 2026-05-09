/**
 * Tier-1 change flows — `rotatePassphrase` (user remembers old) and
 * `recoverPassphrase` (user supplies a recovery proof). Issue #10.
 *
 * The two flows share the post-verification half — fresh salt, fresh
 * KEK, rewrap every DEK — and differ only in how they re-derive the
 * old KEK:
 *
 * - **Rotate**: derive from the supplied `oldPassphrase`.
 * - **Recover (paper)**: unwrap from a `RecoveryCodeEntry` using a
 *   user-supplied recovery code. The entry is burned on success.
 *
 * The non-paper recovery profiles (Shamir, multi-channel,
 * admin-mediated) are not yet wired — calling them throws
 * {@link RecoveryProfileNotImplementedError} with a tracking link.
 *
 * @module
 */
import type { NoydbStore, KeyringFile } from '../types.js'
import { NOYDB_KEYRING_VERSION } from '../types.js'
import {
  deriveKey,
  generateSalt,
  wrapKey,
  unwrapKey,
  bufferToBase64,
  base64ToBuffer,
} from '../crypto.js'
import { InvalidKeyError, NoAccessError } from '../errors.js'
import {
  RecoveryProfileNotImplementedError,
} from '../policy/errors.js'
import {
  loadPaperRecoveryEntries,
  burnPaperRecoveryEntry,
  unwrapDeksFromPaperEntry,
  type PaperRecoveryEntry,
} from './recovery.js'
import { assertStrongPassphrase, type PassphrasePolicy } from '../validation.js'
import type { UnlockedKeyring } from './keyring.js'
import type { KeyringAuthenticator } from '../types.js'
import type { EnrollAuthenticatorOptions } from './authenticators.js'
import { ValidationError } from '../errors.js'

/**
 * Context handed to a {@link SlotRewrapCeremony} when `rotatePassphrase`
 * preserves a tier-2 slot. The ceremony's job is to re-derive its
 * method-specific wrapping material (PRF assertion, PBKDF2 of a
 * daily-password, etc.) and wrap the freshly rewrapped DEK set under
 * the new wrapping key.
 *
 * Two surfaces are exposed:
 *
 *   - `newDeks` — the rewrapped (extractable) DEK set the slot will
 *     wrap. This is what `mintPaperRecoveryEntry` / `enrollPassword-
 *     Authenticator` / `wrapKeyringSummary` (in `@noy-db/on-webauthn`)
 *     all consume; effectively the canonical input for every
 *     post-Path C tier-2 ceremony.
 *
 *   - `newKek` — the freshly-derived KEK (extractable for the
 *     ceremony scope only). Only relevant for forward-compatibility
 *     with a hypothetical future on-* package that wants to wrap the
 *     KEK itself under a method-derived key. None of the shipped
 *     on-* packages need this; they all operate on `newDeks`.
 *
 * The ceremony MUST preserve `oldSlot.id` and `oldSlot.method` in the
 * returned `EnrollAuthenticatorOptions`. Hub validates these — a
 * mismatch throws `ValidationError` (prevents slot-type swap mid-
 * rotation, e.g. converting a webauthn slot to a password slot under
 * cover of preservation).
 */
export interface SlotRewrapContext {
  readonly newKek: CryptoKey
  readonly newDeks: Map<string, CryptoKey>
  readonly oldSlot: KeyringAuthenticator
}

/**
 * Callback that re-enrolls one tier-2 slot during `rotatePassphrase`.
 * Returns the new slot's `EnrollAuthenticatorOptions` — same shape
 * the consumer would pass to `db.enrollAuthenticator` for a fresh
 * enrollment. Hub persists the result atomically with the rotation.
 */
export type SlotRewrapCeremony = (
  ctx: SlotRewrapContext,
) => Promise<EnrollAuthenticatorOptions>

/** Caller payload for {@link rotatePassphrase}. */
export interface RotatePassphraseInput {
  readonly oldPassphrase: string
  readonly newPassphrase: string
  readonly passphrasePolicy?: PassphrasePolicy
  readonly allowWeakPassphrase?: boolean
  /**
   * Map of slot id → re-enrolment ceremony. Slots whose id appears
   * here are PRESERVED across rotation (the ceremony re-derives the
   * method-specific wrapping under the new keyring); slots whose id
   * is absent are DROPPED (the pre-#29 behavior).
   *
   * Without this map, `rotatePassphrase` retains the pre-pre.8
   * behavior of wiping every tier-2 slot. Consumers building a
   * "rotate without losing my biometric" flow supply ceremonies for
   * each slot they want to keep.
   *
   * If a ceremony throws, the entire rotation throws — no partial
   * state. Callers wrap individual ceremonies in try/catch + return
   * a sentinel if they want graceful degradation per slot.
   *
   * Added in pre.8 (#29).
   */
  readonly slotCeremonies?: { readonly [slotId: string]: SlotRewrapCeremony }
}

/**
 * Re-derive the user's KEK from `oldPassphrase`, rewrap every DEK
 * under a freshly-derived KEK from `newPassphrase`, and persist.
 *
 * Tier-2 authenticator slots are dropped UNLESS the caller supplies
 * a `slotCeremonies` map (#29) — each ceremony re-derives its
 * method-specific wrapping under the new keyring, and hub persists
 * the rewrapped slots atomically with the rotation. Slots whose id
 * isn't in the map are still dropped (pre-pre.8 behavior).
 *
 * @throws `InvalidKeyError` if `oldPassphrase` does not unwrap the keyring.
 * @throws `WeakPassphraseError` if `newPassphrase` fails the strength rule.
 * @throws `ValidationError` if a ceremony's result mismatches the
 *         slot's id or method (anti-slot-swap guard).
 */
export async function rotatePassphrase(
  store: NoydbStore,
  vault: string,
  userId: string,
  input: RotatePassphraseInput,
): Promise<UnlockedKeyring> {
  if (!input.allowWeakPassphrase) {
    assertStrongPassphrase(input.newPassphrase, input.passphrasePolicy)
  }

  const env = await store.get(vault, '_keyring', userId)
  if (!env) {
    throw new NoAccessError(`No keyring found for user "${userId}" in vault "${vault}".`)
  }
  const file = JSON.parse(env._data) as KeyringFile
  const oldSalt = base64ToBuffer(file.salt)
  const oldKek = await deriveKey(input.oldPassphrase, oldSalt)

  // Unwrap every DEK with the OLD KEK first — this also validates the
  // passphrase (a bad KEK throws InvalidKeyError on the first unwrap).
  const deks = new Map<string, CryptoKey>()
  for (const [coll, wrapped] of Object.entries(file.deks)) {
    deks.set(coll, await unwrapKey(wrapped, oldKek))
  }

  const newSalt = generateSalt()
  const newKek = await deriveKey(input.newPassphrase, newSalt)

  // Rewrap with the new KEK.
  const wrappedDeks: Record<string, string> = {}
  for (const [coll, dek] of deks) {
    wrappedDeks[coll] = await wrapKey(dek, newKek)
  }

  // Slot rewrap (#29). Without slotCeremonies, we drop every existing
  // slot — the pre-pre.8 behavior. With a ceremony map, slots whose
  // id appears in the map are preserved; the rest are dropped.
  const oldSlots = file.authenticators ?? []
  const newSlots: KeyringAuthenticator[] = []
  if (input.slotCeremonies && oldSlots.length > 0) {
    for (const oldSlot of oldSlots) {
      const ceremony = input.slotCeremonies[oldSlot.id]
      if (!ceremony) continue // drop — same as pre-#29 behavior

      const result = await ceremony({ newKek, newDeks: deks, oldSlot })

      // Anti-slot-swap guard. The ceremony MUST preserve identity —
      // a mismatch would let the consumer convert a webauthn slot to
      // a password slot mid-rotation, which would silently change
      // the security profile of the slot under cover of "rotation."
      if (result.id !== oldSlot.id) {
        throw new ValidationError(
          `slotCeremonies['${oldSlot.id}'] returned id="${result.id}". ` +
            'The id must match the rotated slot — a ceremony cannot ' +
            'change a slot\'s identity.',
        )
      }
      if (result.method !== oldSlot.method) {
        throw new ValidationError(
          `slotCeremonies['${oldSlot.id}'] returned method="${result.method}", ` +
            `expected "${oldSlot.method}". The method must match the rotated ` +
            'slot — a ceremony cannot change the auth method (e.g. webauthn ' +
            '→ password) under cover of rotation.',
        )
      }
      // wrapKind absent on legacy slots / wrap-KEK enroll inputs; treat as 'kek'.
      const oldWrapKind = oldSlot.wrapKind ?? 'kek'
      const newWrapKind = result.wrapKind ?? 'kek'
      if (oldWrapKind !== newWrapKind) {
        throw new ValidationError(
          `slotCeremonies['${oldSlot.id}'] returned wrapKind="${newWrapKind}", ` +
            `expected "${oldWrapKind}". The wrap format must match the rotated ` +
            'slot — a ceremony cannot change the wrap shape (e.g. wrap-KEK → ' +
            'wrap-DEKs) under cover of rotation, since that would silently ' +
            'change the session tier produced at unlock.',
        )
      }

      // Build the persisted slot from the ceremony result. Mirrors
      // the same construction `enrollAuthenticator` does — wrap-DEKs
      // variants carry { wrapped_deks, iv }; wrap-KEK variants
      // carry { wrapped_kek }.
      const baseFields = {
        id: result.id,
        method: result.method,
        // Preserve original enrolled_at — rotation is rewrapping, not
        // re-enrollment. The slot's enrolment timestamp tracks when
        // the user originally added the slot, not when it was last
        // rewrapped. Forensics consumers reading enrolled_at are
        // tracking the slot's ORIGIN, not its CURRENT wrapping.
        enrolled_at: oldSlot.enrolled_at,
        enrolled_via_tier: result.enrolled_via_tier ?? oldSlot.enrolled_via_tier,
        meta: result.meta,
      } as const
      const newSlot: KeyringAuthenticator = result.wrapKind === 'deks'
        ? {
            ...baseFields,
            wrapKind: 'deks',
            wrapped_deks: result.wrapped_deks,
            iv: result.iv,
          }
        : {
            ...baseFields,
            wrapped_kek: result.wrapped_kek,
          }
      newSlots.push(newSlot)
    }
  }

  const next: KeyringFile = {
    ...file,
    _noydb_keyring: NOYDB_KEYRING_VERSION,
    deks: wrappedDeks,
    salt: bufferToBase64(newSalt),
    authenticators: newSlots,
  }

  await writeKeyringFile(store, vault, userId, next)

  return {
    userId: file.user_id,
    displayName: file.display_name,
    role: file.role,
    permissions: file.permissions,
    deks,
    kek: newKek,
    salt: newSalt,
    authenticators: newSlots,
    ...(file.export_capability !== undefined && { exportCapability: file.export_capability }),
    ...(file.import_capability !== undefined && { importCapability: file.import_capability }),
  }
}

/**
 * Caller payload for {@link recoverPassphrase}.
 *
 * **Narrowed to `'paper'` only (#86).** The other three profiles
 * (`shamir`, `multi-channel`, `admin-mediated`) are documented in the
 * spec but not yet wired end-to-end. Matching the discipline of
 * {@link db.enrollRecovery}, the type rejects them at compile time
 * rather than accepting them and throwing at runtime. The runtime
 * guard ({@link RecoveryProfileNotImplementedError}) remains so
 * consumers who bypass TS via `as unknown as RecoveryProof` still
 * receive a clear error.
 */
export type RecoveryProof = { readonly profile: 'paper'; readonly payload: { readonly code: string } }

export interface RecoverPassphraseInput {
  readonly newPassphrase: string
  readonly recoveryProof: RecoveryProof
  readonly passphrasePolicy?: PassphrasePolicy
  readonly allowWeakPassphrase?: boolean
  /**
   * After a successful paper-recovery, replace ALL remaining recovery
   * entries with freshly-minted ones. Defaults to `true` (defensive).
   *
   * Rationale (issue #36): the user just demonstrated they had access
   * to AT LEAST one code. The remaining codes from the same printed
   * sheet may also be compromised — photographed, leaked via a
   * screen-share slip, or in the hands of whoever stole the sheet.
   * Auto-rotation closes the window without requiring consumer action.
   *
   * Set to `false` to preserve the original behavior (only the matched
   * code is burned; the rest stay valid).
   *
   * Hub-side orchestration is non-atomic with the recovery itself:
   * if the rotation step fails after a successful burn, the user
   * falls back to the pre-rotation state (remaining codes still
   * valid). Strictly safer than the previous default — a failed
   * rotation degrades gracefully rather than leaving the vault
   * locked or codes dual-existing.
   */
  readonly rotateRemainingCodes?: boolean
  /**
   * Number of fresh codes to mint when `rotateRemainingCodes` is on.
   * Defaults to the count of remaining entries POST-burn (e.g. if
   * the user enrolled 8 originally and just consumed 1, defaults to
   * 7). Pass an explicit number to mint a different count — useful
   * when the consumer wants to refresh to a target N regardless of
   * how many were left.
   */
  readonly newCodeCount?: number
  /**
   * Override the default raw-code generator. The default is hub's
   * {@link generateULID} — uppercase Crockford-Base32, 26 chars,
   * passes through `normalizePaperCode` untouched.
   *
   * Pass `() => generateRawCode()` from `@noy-db/on-recovery` when
   * the consumer prefers the Base32 + checksum format with hyphenated
   * display. The `mintPaperRecoveryEntry` helper accepts any string —
   * the generator just needs to produce a high-entropy unique value.
   */
  readonly codeGenerator?: () => string
}

/**
 * Return shape of `db.recoverPassphrase`. `newCodes` is populated when
 * `rotateRemainingCodes` was enabled and at least one entry was
 * rotated; an empty array means no rotation happened (rotation
 * disabled, or no remaining codes after burn). Show the codes to the
 * user once — they are the canonical credential for future recovery
 * and CANNOT be retrieved again.
 */
export interface RecoverPassphraseResult {
  readonly newCodes: readonly string[]
}

/**
 * Reset the user's passphrase using a recovery proof. v0.1.0-pre.5
 * supports the `'paper'` profile via `@noy-db/on-recovery` entries
 * persisted in `_meta/recovery-paper`. The other three profiles throw
 * {@link RecoveryProfileNotImplementedError}.
 *
 * On success, the used recovery entry is burned (deleted from the
 * stored set).
 */
export async function recoverPassphrase(
  store: NoydbStore,
  vault: string,
  userId: string,
  input: RecoverPassphraseInput,
): Promise<UnlockedKeyring> {
  if (!input.allowWeakPassphrase) {
    assertStrongPassphrase(input.newPassphrase, input.passphrasePolicy)
  }

  // Runtime defense-in-depth: the type narrows to 'paper' (#86), but
  // a consumer bypassing TS via `as unknown as RecoveryProof` should
  // still hit a clear error rather than silently fall into the paper
  // handler with a malformed payload.
  const profile = (input.recoveryProof as { profile: string }).profile
  if (profile !== 'paper') {
    throw new RecoveryProfileNotImplementedError(
      profile,
      'https://github.com/vLannaAi/noy-db/issues/10',
    )
  }
  return recoverViaPaperCode(store, vault, userId, input)
}

async function recoverViaPaperCode(
  store: NoydbStore,
  vault: string,
  userId: string,
  input: RecoverPassphraseInput,
): Promise<UnlockedKeyring> {
  if (input.recoveryProof.profile !== 'paper') throw new Error('unreachable')
  const { code } = input.recoveryProof.payload

  const env = await store.get(vault, '_keyring', userId)
  if (!env) {
    throw new NoAccessError(`No keyring found for user "${userId}" in vault "${vault}".`)
  }
  const file = JSON.parse(env._data) as KeyringFile

  const entries = await loadPaperRecoveryEntries(store, vault)
  if (entries.length === 0) {
    throw new NoAccessError(
      `No paper-recovery entries enrolled for vault "${vault}". ` +
        'Enroll via `db.enrollRecovery({ profile: "paper", entries })` before relying on recovery.',
    )
  }

  const normalized = normalizePaperCode(code)
  let recovered: { deks: Map<string, CryptoKey>; entry: PaperRecoveryEntry } | undefined
  for (const entry of entries) {
    try {
      const deks = await unwrapDeksFromPaperEntry(entry, normalized)
      recovered = { deks, entry }
      break
    } catch {
      // wrong code for this entry — try the next one
    }
  }
  if (!recovered) {
    throw new InvalidKeyError(
      'Recovery code does not match any enrolled paper entry. The code may have been ' +
        'previously used (single-use) or typed incorrectly.',
    )
  }

  const deks = recovered.deks

  // Fresh salt + KEK from the new passphrase, rewrap.
  const newSalt = generateSalt()
  const newKek = await deriveKey(input.newPassphrase, newSalt)
  const wrappedDeks: Record<string, string> = {}
  for (const [coll, dek] of deks) {
    wrappedDeks[coll] = await wrapKey(dek, newKek)
  }

  const next: KeyringFile = {
    ...file,
    _noydb_keyring: NOYDB_KEYRING_VERSION,
    deks: wrappedDeks,
    salt: bufferToBase64(newSalt),
    authenticators: [], // tier-2 slots wrap old KEK, drop them
  }

  await writeKeyringFile(store, vault, userId, next)
  await burnPaperRecoveryEntry(store, vault, recovered.entry.codeId)

  return {
    userId: file.user_id,
    displayName: file.display_name,
    role: file.role,
    permissions: file.permissions,
    deks,
    kek: newKek,
    salt: newSalt,
    authenticators: [],
    ...(file.export_capability !== undefined && { exportCapability: file.export_capability }),
    ...(file.import_capability !== undefined && { importCapability: file.import_capability }),
  }
}

/**
 * Mirror of `@noy-db/on-recovery/parseRecoveryCode`. Inlined so the
 * hub does not gain a peer dep on on-recovery — both implementations
 * follow the same RFC 4648 Base32 + checksum format and round-trip
 * through the same KDF.
 *
 * Accepts hyphenated, lowercase, or whitespace-padded input.
 */
function normalizePaperCode(input: string): string {
  return input.toUpperCase().replace(/[\s\-_]/g, '')
}

async function writeKeyringFile(
  store: NoydbStore,
  vault: string,
  userId: string,
  file: KeyringFile,
): Promise<void> {
  const envelope = {
    _noydb: 1 as const,
    _v: 1,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: JSON.stringify(file),
  }
  await store.put(vault, '_keyring', userId, envelope)
}
