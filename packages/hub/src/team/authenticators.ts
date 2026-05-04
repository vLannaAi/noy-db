/**
 * Tier-2 authenticator slot management — issue #11.
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
import { ValidationError } from '../errors.js'
import type { UnlockedKeyring } from './keyring.js'
import { persistKeyring } from './keyring.js'

/** Input shape for `enrollAuthenticator`. */
export interface EnrollAuthenticatorOptions {
  readonly id: string
  readonly method: KeyringAuthenticator['method']
  /** Already-wrapped KEK ciphertext (base64) — produced by the on-* package. */
  readonly wrapped_kek: string
  /** Method-specific metadata (cred id, salt, …). */
  readonly meta: Record<string, unknown>
  /** Tier the active session held when enrolling. Defaults to 1. */
  readonly enrolled_via_tier?: 1 | 2
}

/**
 * Append a new authenticator slot to the keyring file. Throws
 * `ValidationError` if a slot with the same id already exists — the
 * caller decides whether to remove + re-enroll.
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

  const slot: KeyringAuthenticator = {
    id: options.id,
    method: options.method,
    enrolled_at: new Date().toISOString(),
    enrolled_via_tier: options.enrolled_via_tier ?? 1,
    wrapped_kek: options.wrapped_kek,
    meta: options.meta,
  }

  const next = appendSlot(keyring, slot)
  await persistKeyring(store, vault, next)
  return next
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
