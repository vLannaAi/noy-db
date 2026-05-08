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
    // Peer-recovery is a high-trust intentional op — co-owners
    // recovering each other should not need an off-device factor in
    // the personal/SMB threat model (the partner is already vetted by
    // virtue of being a co-owner). Tier-1 unlock is the floor; the
    // STRICT preset adds a recovery/email-OTP requirement.
    'peer-recover-user': { minTier: 1 },
    'export-bundle': { minTier: 1 },
    'export-plaintext': {
      minTier: 1,
      factors: [{ anyOf: ['totp', 'email-otp'] }],
    },
    'view-user-auth': {
      minTier: 1,
      enabled: false,
    },
    // ─── User envelope gates (#22) ────────────────────────────────────
    // edit-own-profile: tier 3 floor — any active session can edit their
    //   own profile/preferences. Tightening to require a TOTP for
    //   profile changes is a one-line override.
    // view-team-profiles: tier 2 floor — an authenticated session can
    //   read teammates' profiles (display names, avatars, locales).
    //   Setting `enabled: false` makes vault.user.list() return only
    //   self (privacy-strict opt-out).
    'edit-own-profile': { minTier: 3 },
    'view-team-profiles': { minTier: 2 },
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
    // STRICT peer-recovery: the issuer must present a recovery code
    // OR a fresh second factor at the moment of recovery. This binds
    // the high-trust operation to a verifiable proof (recovery sheet
    // photographed by an attacker won't suffice — they'd also need
    // tier-1 unlock first; this gate is the freshness binding on top).
    'peer-recover-user': {
      minTier: 1,
      factors: [{ anyOf: ['recovery', 'totp', 'email-otp'] }],
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
    // ─── User envelope gates (#22) ────────────────────────────────────
    // STRICT: profile edits require a TOTP/email-OTP factor (typical
    // shared-workstation hardening — your name/avatar shouldn't change
    // without a fresh second-factor proof).
    'edit-own-profile': {
      minTier: 2,
      factors: [{ anyOf: ['totp', 'email-otp'] }],
    },
    'view-team-profiles': { minTier: 2 },
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
