/**
 * Tier-2 authenticator slot management.
 *
 * Each slot independently wraps the SAME KEK under a method-specific
 * derived key (LUKS pattern). Enrolling adds a slot; removing drops
 * one. Both are constant-time keyring writes — no DEK re-keying.
 *
 * The crypto for each method lives in its `@noy-db/on-*` package
 * (`on-webauthn`, `on-oidc`, `on-password`); this module accepts the
 * package's `wrapped_kek` ciphertext + `meta` payload and persists it.
 *
 * @see https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/session-tiers.md → Tier 2 — Authenticate
 *
 * @module
 */
import type { NoydbStore, KeyringAuthenticator } from '../../kernel/types.js'
import { NoAccessError, ValidationError } from '../../kernel/errors.js'
import type { UnlockedKeyring } from './keyring.js'
import { persistKeyring, rotateKeys } from './keyring.js'
import { rotateSecret, type SlotRewrapCeremony } from './rotate-recover.js'
import { ROSTER_KEY_ID, BLOB_ADDRESS_KEY_ID } from '../../kernel/constants.js'
import type { RotateSecretInput } from './rotate-recover.js'

/** Fields shared across both wrap-KEK and wrap-DEKs enroll inputs. */
interface EnrollAuthenticatorBase {
  readonly id: string
  readonly method: KeyringAuthenticator['method']
  /** Method-specific metadata (cred id, salt, …). */
  readonly meta: Record<string, unknown>
  /** Tier the active session held when enrolling. Defaults to 1. */
  readonly enrolled_via_tier?: 1 | 2
}

/** Wrap-KEK enroll input (WebAuthn, OIDC). */
export interface EnrollAuthenticatorWrappingKEKOptions extends EnrollAuthenticatorBase {
  /** Already-wrapped KEK ciphertext (base64) — produced by the on-* package. */
  readonly wrapped_kek: string
  readonly wrapKind?: 'kek'
}

/** Wrap-DEKs enroll input (password, future on-* using the unified wrap-DEKs primitive). */
export interface EnrollAuthenticatorWrappingDEKsOptions extends EnrollAuthenticatorBase {
  readonly wrapKind: 'deks'
  /** Base64 AES-GCM ciphertext of `{ deks: { collection: base64rawDek } }`. */
  readonly wrapped_deks: string
  /** Base64 AES-GCM IV used for the `wrapped_deks` ciphertext. */
  readonly iv: string
}

/** Discriminated union over the two enroll input shapes. */
export type EnrollAuthenticatorOptions =
  | EnrollAuthenticatorWrappingKEKOptions
  | EnrollAuthenticatorWrappingDEKsOptions

/**
 * Append a new authenticator slot to the keyring file. Throws
 * `ValidationError` if a slot with the same id already exists — the
 * caller decides whether to remove + re-enroll.
 *
 * Accepts either wrap-KEK (WebAuthn, OIDC) or wrap-DEKs (password)
 * input. The variant is preserved verbatim into `KeyringAuthenticator`.
 */
export async function enrollAuthenticator(
  store: NoydbStore,
  vault: string,
  keyring: UnlockedKeyring,
  options: EnrollAuthenticatorOptions,
): Promise<UnlockedKeyring> {
  assertSlotListVisible(keyring, 'enrollAuthenticator', vault)
  const existing = keyring.authenticators.find((a) => a.id === options.id)
  if (existing) {
    throw new ValidationError(
      `enrollAuthenticator: slot id "${options.id}" already exists in vault "${vault}". ` +
        'Remove the slot first or pick a unique id.',
    )
  }

  const base = {
    id: options.id,
    method: options.method,
    enrolled_at: new Date().toISOString(),
    enrolled_via_tier: options.enrolled_via_tier ?? 1,
    meta: options.meta,
  } as const

  const slot: KeyringAuthenticator = options.wrapKind === 'deks'
    ? {
        ...base,
        wrapKind: 'deks',
        wrapped_deks: options.wrapped_deks,
        iv: options.iv,
      }
    : {
        ...base,
        wrapped_kek: options.wrapped_kek,
      }

  const next = appendSlot(keyring, slot)
  await persistKeyring(store, vault, next)
  return next
}

/**
 * Caller payload for {@link updateAuthenticator}. Mutates only
 * `meta` — the slot's id, method, and wrap material are immutable
 * through this primitive, preserving the anti-slot-swap guard.
 *
 * `meta` is **merged** at the top level: keys absent from the patch
 * are preserved, keys present overwrite. To clear a meta key, pass
 * `null` for that key explicitly. (Same top-level merge semantics as
 * `UserApi.updateMe`, non-recursive — meta is a flat label bag.)
 */
export interface UpdateAuthenticatorOptions {
  readonly meta?: Record<string, unknown>
}

/**
 * Mutate a tier-2 authenticator slot's `meta` blob (slot rename,
 * label changes). The slot's `id`, `method`, and wrap material
 * (`wrapped_kek` for wrap-KEK; `wrapped_deks` + `iv` for wrap-DEKs)
 * are immutable through this entry point — the anti-slot-swap guard
 * is structural, not gate-driven, so even if the policy gate is
 * weakened a future caller cannot use this path to swap one slot's
 * crypto for another's.
 *
 * `meta` patch semantics:
 *   - Top-level merge — absent keys preserved, present keys overwrite
 *   - `null` value — delete that meta key
 *   - Non-object values (string, number, boolean, array) — replace verbatim
 *
 * @throws `NoAccessError` when no slot with the given id exists.
 * @throws `ValidationError` when no patch field is provided.
 *
 */
export async function updateAuthenticator(
  store: NoydbStore,
  vault: string,
  keyring: UnlockedKeyring,
  slotId: string,
  options: UpdateAuthenticatorOptions,
): Promise<UnlockedKeyring> {
  if (options.meta === undefined) {
    throw new ValidationError(
      `updateAuthenticator: at least one of meta must be provided ` +
        `(slotId: "${slotId}").`,
    )
  }

  assertSlotListVisible(keyring, 'updateAuthenticator', vault)
  const idx = keyring.authenticators.findIndex((a) => a.id === slotId)
  if (idx === -1) {
    throw new NoAccessError(
      `updateAuthenticator: slot "${slotId}" not found in vault "${vault}".`,
    )
  }
  const existing = keyring.authenticators[idx]!

  // Merge at the top level. Absent keys preserved (non-recursive —
  // meta is a flat label bag in practice, no consumer nests it).
  const mergedMeta: Record<string, unknown> = { ...existing.meta }
  for (const [k, v] of Object.entries(options.meta)) {
    if (v === undefined) continue // skip
    if (v === null) {
      delete mergedMeta[k]
      continue
    }
    mergedMeta[k] = v
  }

  // Reconstruct the slot preserving wrapKind discrimination. The
  // immutable fields (id, method, wrapped_kek / wrapped_deks + iv,
  // enrolled_at, enrolled_via_tier) all flow through ...existing.
  const next: KeyringAuthenticator = { ...existing, meta: mergedMeta }
  const nextSlots = [...keyring.authenticators]
  nextSlots[idx] = next

  const nextKeyring: UnlockedKeyring = {
    ...keyring,
    authenticators: nextSlots,
  }
  await persistKeyring(store, vault, nextKeyring)
  return nextKeyring
}

/**
 * Refuse any slot-list decision taken from a keyring that cannot be
 * persisted (#1426).
 *
 * `UnlockedKeyring.authenticators` is a snapshot, and a tier-3
 * PIN-resumed / session-restored keyring carries an EMPTY one
 * alongside `kek === null` — not because the vault has no slots, but
 * because that session never unwrapped the KEK and so never read
 * them. Deciding "the slot isn't there" from that snapshot answers a
 * question the session cannot see the answer to.
 *
 * `persistKeyring` already refuses a null KEK, so every write path
 * here ends in a throw regardless. What this guard buys is that the
 * throw happens BEFORE the decision instead of after it — otherwise
 * `removeAuthenticator` short-circuits on the empty list and returns
 * a successful no-op, and `updateAuthenticator` reports the slot as
 * "not found" when the truthful answer is "not visible from here".
 *
 * Same class as the `echo` / `granted_by` / `expires_at` carry-forward
 * comments in `persistKeyring`: an UnlockedKeyring is a partial view,
 * and treating an absent field as a known-empty one silently destroys
 * or misreports state.
 */
function assertSlotListVisible(
  keyring: UnlockedKeyring,
  op: string,
  vault: string,
): void {
  if (keyring.kek) return
  throw new ValidationError(
    `${op}: keyring.kek is null, so the authenticator slot list for vault ` +
      `"${vault}" is not readable from this session and no slot decision can ` +
      'be made. This typically means the keyring was opened via tier-3 PIN ' +
      'resume, session restore, or a wrap-DEKs tier-2 unlock. Re-authenticate ' +
      'at tier 1 (secret) before enrolling, updating or removing a slot.',
  )
}

/**
 * Drop a slot by id. No-op if the slot doesn't exist (idempotent —
 * removing a non-existent slot is a recoverable retry, not an error).
 *
 * ⛔ **THIS HIDES A CREDENTIAL. IT DOES NOT REVOKE ONE.** (#1445) The slot
 * leaves the keyring file and nothing else happens — no key material moves. A
 * slot blob captured before removal, or cached by an honest client earlier in
 * the same session, still unwraps the FULL LIVE DEK SET and reads every record,
 * for as long as those DEKs remain current.
 *
 * That is not a leak in one `on-*` package. `@noy-db/on-password`'s
 * `unwrapDeksWithPassword` and `@noy-db/on-webauthn`'s `unwrapKeyringSummary`
 * both carry the DEK map inside the blob and need no store, no keyring and no
 * network — the blob authenticates itself. A membership check inside a verifier
 * cannot close it, because a blob holder calls the primitive directly and never
 * reaches the verifier.
 *
 * ⭐ To actually revoke, see {@link revokeAuthenticator} — removal, then a DEK
 * rotation, then a re-wrap of the slots that stay. Every step is required and
 * the reasons are measured, not assumed; read that doc before assembling the
 * sequence by hand.
 *
 * ⚠️ Idempotency is only sound when the slot list is actually
 * visible — see {@link assertSlotListVisible} (#1426).
 *
 * @throws `ValidationError` when the session cannot see the slot list.
 */
export async function removeAuthenticator(
  store: NoydbStore,
  vault: string,
  keyring: UnlockedKeyring,
  slotId: string,
): Promise<UnlockedKeyring> {
  assertSlotListVisible(keyring, 'removeAuthenticator', vault)
  const filtered = keyring.authenticators.filter((a) => a.id !== slotId)
  if (filtered.length === keyring.authenticators.length) {
    return keyring // idempotent — nothing to do
  }
  const next: UnlockedKeyring = {
    ...keyring,
    authenticators: filtered,
  }
  await persistKeyring(store, vault, next)
  return next
}

/**
 * Look up a slot by id. Returns `undefined` when no slot matches.
 * Used by tier-2 unlock dispatchers to fetch the wrapped KEK + meta
 * before invoking the method-specific verifier.
 */
export function findAuthenticator(
  keyring: UnlockedKeyring,
  slotId: string,
): KeyringAuthenticator | undefined {
  return keyring.authenticators.find((a) => a.id === slotId)
}

function appendSlot(
  keyring: UnlockedKeyring,
  slot: KeyringAuthenticator,
): UnlockedKeyring {
  return {
    ...keyring,
    authenticators: [...keyring.authenticators, slot],
  }
}

/** Inputs for {@link revokeAuthenticator}. */
export interface RevokeAuthenticatorOptions {
  /** The slot to revoke. */
  readonly slotId: string
  /**
   * The vault owner's CURRENT secret. Passed as both `oldSecret` and
   * `newSecret` to `rotateSecret`, which accepts them being equal — measured,
   * so revoking one credential does not force everyone onto a new phrase.
   */
  readonly secret: RotateSecretInput['oldSecret']
  /**
   * A re-wrap ceremony for EVERY slot that stays, keyed by slot id.
   *
   * ⛔ A slot with no ceremony is DROPPED, not preserved — that is
   * `rotateSecret`'s existing behaviour (#29 / PR5: "without `slotCeremonies`,
   * rotation drops every slot"), and it is the honest outcome, because after
   * step 2 its blob wraps DEKs that no longer exist. Supplying one requires
   * that credential to be present: the password for `on-password`, a live
   * assertion for `on-webauthn`. There is no way around that — re-wrapping a
   * credential is the credential's own operation.
   */
  readonly slotCeremonies?: { readonly [slotId: string]: SlotRewrapCeremony }
}

/**
 * Actually revoke an authenticator slot: remove it, mint fresh DEKs, and
 * re-wrap the slots that stay (#1445).
 *
 * ## Why this is three steps and not one
 *
 * Each was measured, because the composition looks obvious and the obvious
 * compositions do not work:
 *
 * 1. **{@link removeAuthenticator}** hides the slot. On its own it revokes
 *    nothing — the captured blob carries its own DEKs.
 * 2. **`rotateKeys`** is the step that revokes. It is the ONLY one that calls
 *    `generateDEK()`. Measured: a collection's DEK is byte-identical across a
 *    `rotateSecret` and different across a `rotateKeys`.
 *    ⚠️ `rotateSecret` alone does NOT revoke, however it reads:
 *    it unwraps every DEK with the old KEK and rewraps THE SAME KEY MATERIAL
 *    under the new one. A captured blob holds DEK VALUES and records are
 *    encrypted with DEKs, so rewrapping them changes nothing the holder needs.
 * 3. **`rotateSecret` with `slotCeremonies`** re-wraps the remaining slots
 *    around the new DEKs. Without it they survive step 2 BYTE-IDENTICAL
 *    (measured: `rotateKeys` never touches `authenticators[]`) and therefore
 *    silently wrap keys that no longer exist — every other credential in the
 *    vault dies quietly. This step is what makes the operation safe for
 *    everyone who was not being revoked.
 *
 * ⭐ Neither primitive is sufficient alone and they are not interchangeable:
 * `rotateKeys` mints keys but cannot re-wrap slots; `rotateSecret` re-wraps
 * slots but cannot mint keys.
 *
 * ## Cost
 *
 * Step 2 re-encrypts every record in every affected collection, and every
 * remaining credential holder must be present for step 3. This is expensive on
 * purpose: it is what revocation costs when the credential is a bearer token.
 *
 * @throws `ValidationError` when the session cannot see the slot list
 *   ({@link assertSlotListVisible}) — a tier-1 unlock is required, and #1432
 *   guarantees the KEK rotation needs is present at this point.
 */
export async function revokeAuthenticator(
  store: NoydbStore,
  vault: string,
  keyring: UnlockedKeyring,
  options: RevokeAuthenticatorOptions,
): Promise<UnlockedKeyring> {
  // 1. Hide it. Also runs the #1426 visibility guard, so everything below is
  //    reached only from a session that can actually see (and persist) slots.
  const next = await removeAuthenticator(store, vault, keyring, options.slotId)

  // 2. Mint fresh DEKs — the step that revokes.
  //    The set is derived from the DEK map the way `revoke` derives its own,
  //    minus the two reserved keys that are not collections: the roster key
  //    (rotating it makes the vault unopenable for every other member) and the
  //    blob addressing root (rotating it invalidates every stored blob eTag).
  //    `rotateKeys` throws on either if named explicitly, so they are dropped
  //    here at the site that gathers them implicitly.
  const collections = new Set(next.deks.keys())
  collections.delete(ROSTER_KEY_ID)
  collections.delete(BLOB_ADDRESS_KEY_ID)
  if (collections.size > 0) {
    await rotateKeys(store, vault, next, { collections: [...collections] })
  }

  // 3. Re-wrap the slots that stay, around the DEKs step 2 just minted.
  //    `oldSecret === newSecret` is accepted (measured), so this re-wraps
  //    without forcing a phrase change. A slot with no ceremony is dropped —
  //    see `slotCeremonies`.
  return rotateSecret(store, vault, next.userId, {
    oldSecret: options.secret,
    newSecret: options.secret,
    ...(options.slotCeremonies !== undefined && { slotCeremonies: options.slotCeremonies }),
  })
}
