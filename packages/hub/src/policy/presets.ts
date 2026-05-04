import type { VaultPolicy } from './types.js'

/**
 * Default policy for personal vaults and SMB deployments — the gates
 * that need an off-device factor get one (TOTP / email-OTP / paper
 * recovery), the rest take a tier-1 unlock alone. Tier-3 (PIN) is the
 * floor only for `rotate-unlock` because that's the
 * "change my PIN" flow.
 *
 * The unspecified gates (e.g. `view-user-auth`) inherit the engine
 * default of `{ enabled: false, minTier: 1 }` — they fail closed.
 *
 * @see docs/subsystems/session-tiers.md → Built-in gates
 */
export const PERSONAL_POLICY: VaultPolicy = Object.freeze({
  passphrase: {
    minWords: 6,
    minWordLength: 3,
    rejectRepeatedAdjacent: true,
  },
  gates: {
    'rotate-passphrase': {
      minTier: 1,
      factors: [{ anyOf: ['totp', 'email-otp', 'recovery'] }],
    },
    'recover-passphrase': {
      minTier: 1,
      enabled: true,
    },
    'enroll-authenticator': { minTier: 1 },
    'remove-authenticator': { minTier: 1 },
    'rotate-unlock': { minTier: 2 },
    'enroll-user': { minTier: 1 },
    'revoke-user': { minTier: 1 },
    'export-bundle': { minTier: 1 },
    'export-plaintext': {
      minTier: 1,
      factors: [{ anyOf: ['totp', 'email-otp'] }],
    },
    'view-user-auth': {
      minTier: 1,
      enabled: false,
    },
  },
}) as VaultPolicy

/**
 * Strict policy for regulated deployments and shared workstations —
 * raises the phrase floor to 8 words, demands two distinct factors for
 * exports, and blocks export-on-shared-device. Use as a base for
 * `policy: { ...STRICT_POLICY, gates: { ...STRICT_POLICY.gates, ... } }`
 * tweaks.
 */
export const STRICT_POLICY: VaultPolicy = Object.freeze({
  passphrase: {
    minWords: 8,
    minWordLength: 3,
    rejectRepeatedAdjacent: true,
  },
  gates: {
    'rotate-passphrase': {
      minTier: 1,
      factors: [{ anyOf: ['totp', 'email-otp', 'recovery'], count: 2 }],
    },
    'recover-passphrase': {
      minTier: 1,
      enabled: true,
    },
    'enroll-authenticator': {
      minTier: 1,
      factors: [{ anyOf: ['totp', 'email-otp'] }],
    },
    'remove-authenticator': {
      minTier: 1,
      factors: [{ anyOf: ['totp', 'email-otp'] }],
    },
    'rotate-unlock': { minTier: 1 },
    'enroll-user': {
      minTier: 1,
      factors: [{ anyOf: ['totp', 'email-otp'] }],
    },
    'revoke-user': {
      minTier: 1,
      factors: [{ anyOf: ['totp', 'email-otp'] }],
    },
    'export-bundle': {
      minTier: 1,
      factors: [{ anyOf: ['totp', 'email-otp'] }],
      warn: { sharedDevice: 'block' },
    },
    'export-plaintext': {
      minTier: 1,
      factors: [{ anyOf: ['totp', 'email-otp'], count: 2 }],
      warn: { sharedDevice: 'block' },
    },
    'view-user-auth': {
      minTier: 1,
      enabled: false,
    },
  },
}) as VaultPolicy

/**
 * Merge a developer override onto a preset. Unspecified gates inherit;
 * specified gates fully replace the preset's entry for that gate.
 *
 * Example:
 *
 * ```ts
 * mergePolicy(PERSONAL_POLICY, {
 *   gates: {
 *     'app:approve-large-payment': { minTier: 2, factors: [{ anyOf: ['totp'] }] },
 *   },
 * })
 * // → PERSONAL_POLICY plus the new app gate; existing gates intact.
 * ```
 */
export function mergePolicy(
  base: VaultPolicy,
  override?: Partial<VaultPolicy>,
): VaultPolicy {
  if (!override) return base
  const passphrase = override.passphrase ?? base.passphrase
  return {
    ...(passphrase !== undefined ? { passphrase } : {}),
    gates: {
      ...base.gates,
      ...(override.gates ?? {}),
    },
  }
}
