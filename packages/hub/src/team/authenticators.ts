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
 * @see docs/subsystems/session-tiers.md → Tier 2 — Authenticate
 *
 * @module
 */
import type { NoydbStore, KeyringAuthenticator } from '../types.js'
import { NoAccessError, ValidationError } from '../errors.js'
import type { UnlockedKeyring } from './keyring.js'
import { persistKeyring } from './keyring.js'

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
 * Drop a slot by id. No-op if the slot doesn't exist (idempotent —
 * removing a non-existent slot is a recoverable retry, not an error).
 */
export async function removeAuthenticator(
  store: NoydbStore,
  vault: string,
  keyring: UnlockedKeyring,
  slotId: string,
): Promise<UnlockedKeyring> {
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
