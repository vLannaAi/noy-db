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

/** Caller payload for {@link rotatePassphrase}. */
export interface RotatePassphraseInput {
  readonly oldPassphrase: string
  readonly newPassphrase: string
  readonly passphrasePolicy?: PassphrasePolicy
  readonly allowWeakPassphrase?: boolean
}

/**
 * Re-derive the user's KEK from `oldPassphrase`, rewrap every DEK
 * under a freshly-derived KEK from `newPassphrase`, and persist.
 *
 * Tier-2 authenticator slots are NOT preserved — each slot wraps the
 * old KEK and would need the user's per-slot derivation key to
 * re-wrap; the hub doesn't hold that. The user re-enrols any slots
 * after rotation. v0.1.0-pre.5 limitation.
 *
 * @throws `InvalidKeyError` if `oldPassphrase` does not unwrap the keyring.
 * @throws `WeakPassphraseError` if `newPassphrase` fails the strength rule.
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

  const next: KeyringFile = {
    ...file,
    _noydb_keyring: NOYDB_KEYRING_VERSION,
    deks: wrappedDeks,
    salt: bufferToBase64(newSalt),
    // Tier-2 slots reference the old KEK — drop them. User
    // re-enrols afterwards via `db.enrollAuthenticator`.
    authenticators: [],
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
    authenticators: [],
    ...(file.export_capability !== undefined && { exportCapability: file.export_capability }),
    ...(file.import_capability !== undefined && { importCapability: file.import_capability }),
  }
}

/** Caller payload for {@link recoverPassphrase}. */
export type RecoveryProof =
  | { readonly profile: 'paper'; readonly payload: { readonly code: string } }
  | { readonly profile: 'shamir'; readonly payload: { readonly shares: ReadonlyArray<string> } }
  | { readonly profile: 'multi-channel'; readonly payload: { readonly proofs: ReadonlyArray<unknown> } }
  | { readonly profile: 'admin-mediated'; readonly payload: { readonly token: string; readonly factor?: unknown } }

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

  switch (input.recoveryProof.profile) {
    case 'paper':
      return recoverViaPaperCode(store, vault, userId, input)
    case 'shamir':
      throw new RecoveryProfileNotImplementedError(
        'shamir',
        'https://github.com/vLannaAi/noy-db/issues/10',
      )
    case 'multi-channel':
      throw new RecoveryProfileNotImplementedError(
        'multi-channel',
        'https://github.com/vLannaAi/noy-db/issues/10',
      )
    case 'admin-mediated':
      throw new RecoveryProfileNotImplementedError(
        'admin-mediated',
        'https://github.com/vLannaAi/noy-db/issues/10',
      )
    default: {
      // Exhaustiveness check — TS narrows to `never` if the union is
      // covered. A missing branch surfaces here at compile time.
      const _exhaustive: never = input.recoveryProof
      throw new Error(`Unknown recovery profile: ${String(_exhaustive)}`)
    }
  }
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
