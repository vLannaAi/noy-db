/**
 * Secret-mode rules for `createNoydb` / keyring unlock — the option
 * cross-checks and the per-mode secret resolution for the three
 * {@link NoydbOptions.secretMode} values (`standard` / `managed` / `echo`).
 *
 * Extracted out of `kernel/noydb.ts` (which is under a line ceiling — see
 * `check-architecture`'s `kernel-surface` rule) when echo mode was wired in
 * (spec docs/superpowers/specs/2026-08-02-echo-secret-design.md, #940). The
 * managed-mode rules and their exact messages moved verbatim; the echo rules
 * are the addition.
 *
 * Nothing here is re-exported from a package barrel — it is kernel-internal.
 *
 * @module
 */

import type { NoydbOptions, NoydbStore } from './types.js'
import type { EchoSecretParts } from './enclave/index.js'
import { ValidationError } from './errors.js'

/**
 * Cross-check the secret-mode-related options at `createNoydb` time, before
 * any store touch. Throws `ValidationError` on the first violation.
 */
export function validateSecretModeOptions(options: NoydbOptions): void {
  const encrypted = options.encrypt !== false
  const managed = options.secretMode === 'managed'
  const echo = options.secretMode === 'echo'

  if (options.secret && options.getKeyring) {
    throw new ValidationError('Provide either `secret` or `getKeyring`, not both')
  }

  // Managed-secret mode — mutually exclusive with both
  // `secret` (the whole point is hub generates and seals; the user
  // doesn't supply one) and `getKeyring` (a custom unlock path that
  // bypasses the sealing flow entirely). Requires a SealingKeyProvider.
  if (managed) {
    if (options.secret) {
      throw new ValidationError(
        '`secretMode: "managed"` is mutually exclusive with `secret` — '
        + 'managed mode generates the secret itself. Drop `secret`.',
      )
    }
    if (options.getKeyring) {
      throw new ValidationError(
        '`secretMode: "managed"` is mutually exclusive with `getKeyring` — '
        + 'a custom unlock callback would bypass the sealing flow. Drop `getKeyring`.',
      )
    }
    if (!options.sealingKey) {
      throw new ValidationError(
        '`secretMode: "managed"` requires `sealingKey: SealingKeyProvider` '
        + '(see @noy-db/seal-macos-keychain / @noy-db/seal-aws-kms / etc.).',
      )
    }
  }

  // Echo mode (#940). AG-1: no single string is key-equivalent to the
  // 3-part secret, so the secret SHAPE and the mode must agree in both
  // directions — otherwise an `EchoSecretParts` object handed to a
  // string-only path would be coerced (`"[object Object]"`) into the same
  // guessable KEK for every such vault.
  if (echo && typeof options.secret === 'string') {
    throw new ValidationError(
      "secretMode 'echo' requires a structured { prompt, echo, key } secret — a single string can never unlock an echo vault (AG-1).",
    )
  }
  if (echo && typeof options.secret === 'object' && options.secret !== null) {
    const parts = options.secret as Partial<EchoSecretParts>
    if (typeof parts.prompt !== 'string' || typeof parts.echo !== 'string' || typeof parts.key !== 'string') {
      throw new ValidationError(
        "secretMode 'echo' requires a structured secret with all three fields present as strings: prompt, echo, key.",
      )
    }
  }
  if (!echo && options.secret !== undefined && typeof options.secret !== 'string') {
    throw new ValidationError("A { prompt, echo, key } secret requires secretMode: 'echo'.")
  }
  if (!echo && options.deviceSeal !== undefined) {
    throw new ValidationError("deviceSeal is only meaningful with secretMode: 'echo'.")
  }
  if (echo && options.sealingKey !== undefined) {
    throw new ValidationError(
      "secretMode 'echo' is mutually exclusive with `sealingKey` — that provider belongs to managed mode.",
    )
  }
  if (echo && options.secret === undefined && options.getKeyring === undefined) {
    throw new ValidationError(
      "secretMode 'echo' requires either a structured secret or a getKeyring ceremony hook.",
    )
  }

  if (encrypted && !managed && !options.secret && !options.getKeyring) {
    throw new ValidationError('A secret (secret) or getKeyring callback is required when encryption is enabled')
  }
}

/**
 * Resolve the secret that actually unlocks (or creates) `vault`'s keyring.
 *
 * Managed-secret mode resolves before falling into the normal load/create
 * path: the first call mints + seals + persists, subsequent calls unseal
 * what's there. The returned string takes the place of `options.secret` for
 * the rest of the unlock (and is NOT persisted on the options).
 *
 * Standard and echo mode both hand back `options.secret` unchanged — a
 * string for standard, an {@link EchoSecretParts} struct for echo; the KDF
 * dispatch on that shape happens in `deriveKekForKeyring`.
 */
export async function resolveEffectiveSecret(
  options: NoydbOptions,
  store: NoydbStore,
  vault: string,
): Promise<string | EchoSecretParts | undefined> {
  if (options.secretMode === 'managed') {
    // Dynamic import: the kernel spine may only reach a with-* service that
    // way (check-architecture's `port-layering` rule). Managed mode is the
    // only caller, so the service stays out of the always-on bundle.
    const { resolveManagedSecret } = await import('../with-party/team/managed-secret.js')
    // sealingKey presence was validated at createNoydb time.
    return resolveManagedSecret(store, vault, options.sealingKey!)
  }
  return options.secret
}

/**
 * Build the `createOwnerKeyring` bag for a first-boot (or `onInvalidKey:
 * 'reset'`) enrollment under the current secret mode.
 *
 * Managed mode generates 256-bit base64 strings that don't satisfy the
 * human-secret strength rules (no spaces, no "words"), so it skips
 * validation — the entropy floor is already 256 bits by construction. Echo
 * mode does NOT skip it: the parts are human-chosen, so `validateSecret`
 * applies exactly as it does in standard mode.
 *
 * The return type is inferred rather than annotated as
 * `CreateOwnerKeyringOptions` — naming that type here would be a static
 * spine→service import, which `port-layering` forbids even type-only. The
 * shape is still checked: `noydb.ts` passes the result straight into
 * `createOwnerKeyring`, so any drift fails typecheck at the call site.
 */
export function ownerKeyringOptions(
  options: NoydbOptions,
  secret: string | EchoSecretParts,
) {
  return {
    userId: options.user,
    secret,
    validate: options.secretMode === 'managed' ? false : options.validateSecret === true,
    ...(options.deviceSeal !== undefined && { deviceSeal: options.deviceSeal }),
  }
}
