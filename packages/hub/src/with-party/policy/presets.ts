import type { VaultPolicy } from '../../kernel/types.js'

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
 * @see https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/session-tiers.md → Built-in gates
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
      // Any second factor satisfies the gate — off-device kinds (TOTP,
      // email-OTP, paper recovery, roaming WebAuthn) are the strongest;
      // platform-bound kinds (platform WebAuthn, password, PIN) are
      // accepted because requiring "something off-device" is overkill
      // for personal/SMB threat models. Consumers needing the off-device
      // guarantee should use STRICT_POLICY or override this gate.
      factors: [{
        anyOf: [
          'totp', 'email-otp', 'recovery',
          'webauthn-roaming', 'webauthn-platform',
          'password', 'pin',
        ],
      }],
    },
    'recover-passphrase': {
      minTier: 1,
      enabled: true,
    },
    // rotate-recovery: deliberate paper-sheet regeneration
    // when the user remembers their passphrase. PERSONAL allows tier-1 —
    // knowing the passphrase is enough.
    'rotate-recovery': { minTier: 1 },
    'enroll-authenticator': { minTier: 1 },
    'remove-authenticator': { minTier: 1 },
    // update-authenticator: meta-only mutation (slot rename, label
    // changes). Symmetric with enroll/remove under PERSONAL — tier-1
    // unlock alone. The structural anti-slot-swap guard inside the
    // implementation enforces wrap-material/id/method immutability
    // regardless of this gate's settings.
    'update-authenticator': { minTier: 1 },
    'rotate-unlock': { minTier: 2 },
    'enroll-user': { minTier: 1 },
    'revoke-user': { minTier: 1 },
    // Peer-recovery is a high-trust intentional op — co-owners
    // recovering each other should not need an off-device factor in
    // the personal/SMB threat model (the partner is already vetted by
    // virtue of being a co-owner). Tier-1 unlock is the floor; the
    // STRICT preset adds a recovery/email-OTP requirement.
    'peer-recover-user': { minTier: 1 },
    // update-user: post-grant identity mutation (role/displayName/
    // permissions). PERSONAL_POLICY treats this on par with enroll-user
    // / revoke-user — tier-1 unlock alone. The role-elevation guard
    // inside the implementation is the structural backstop that this
    // gate's settings cannot weaken.
    'update-user': { minTier: 1 },
    'export-bundle': { minTier: 1 },
    'export-plaintext': {
      minTier: 1,
      factors: [{ anyOf: ['totp', 'email-otp'] }],
    },
    'view-user-auth': {
      minTier: 1,
      enabled: false,
    },
    // ─── User envelope gates ──────────────────────────────────────────
    // edit-own-profile: tier 3 floor — any active session can edit their
    //   own profile/preferences. Tightening to require a TOTP for
    //   profile changes is a one-line override.
    // view-team-profiles: tier 2 floor — an authenticated session can
    //   read teammates' profiles (display names, avatars, locales).
    //   Setting `enabled: false` makes vault.user.list() return only
    //   self (privacy-strict opt-out).
    'edit-own-profile': { minTier: 3 },
    'view-team-profiles': { minTier: 2 },
    // client-unilateral-withdraw: a non-owner's self-service DESTRUCTIVE
    // withdrawal (export-and-delete/freeze). Fail-closed by default —
    // the firm opts in per jurisdiction/contract (e.g. GDPR Art. 17).
    // Listed explicitly (not just relying on the built-in default) so it is
    // discoverable in describeGate / policy dumps.
    'client-unilateral-withdraw': { minTier: 1, enabled: false },
    // Two-party withdrawal: filing a request is non-destructive
    // (tier-1, enabled so a read-only client can ask); deciding it is the
    // destructive step (tier-2 floor + owner/admin role, enforced in code).
    'user-request-withdrawal': { minTier: 1 },
    'approve-user-withdrawal': { minTier: 2 },
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
    // rotate-recovery: STRICT requires an off-device factor —
    // rotating recovery is an off-site-trust event; a stolen unlocked
    // laptop must not be able to silently mint a new sheet for the
    // attacker. Matches the `peer-recover-user` STRICT default.
    'rotate-recovery': {
      minTier: 1,
      factors: [{ anyOf: ['totp', 'email-otp', 'webauthn-roaming'] }],
    },
    'enroll-authenticator': {
      minTier: 1,
      factors: [{ anyOf: ['totp', 'email-otp'] }],
    },
    'remove-authenticator': {
      minTier: 1,
      factors: [{ anyOf: ['totp', 'email-otp'] }],
    },
    // STRICT update-authenticator: same factor floor as enroll/remove.
    // Even though meta changes don't touch wrap material, a malicious
    // rename could mislead the user about which device a slot
    // corresponds to ("MacBook Touch ID" → "iPhone Touch ID" on a
    // shared workstation). STRICT requires a fresh factor proof.
    'update-authenticator': {
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
    // OR a fresh off-device second factor at the moment of recovery.
    // This binds the high-trust operation to a verifiable proof
    // (recovery sheet photographed by an attacker won't suffice —
    // they'd also need tier-1 unlock first; this gate is the freshness
    // binding on top). Roaming WebAuthn (YubiKey-class hardware key)
    // accepted; platform-bound kinds (Touch ID, password, PIN)
    // intentionally excluded under STRICT because they don't survive
    // device theft — the off-device requirement is the whole point.
    'peer-recover-user': {
      minTier: 1,
      factors: [{ anyOf: ['recovery', 'totp', 'email-otp', 'webauthn-roaming'] }],
    },
    // STRICT update-user: matches the enroll-user / revoke-user shape
    // (off-device factor required). Update-user is admin-shaped — it
    // mutates someone else's role/permissions; STRICT requires a fresh
    // off-device factor proof so the operator affirmatively re-asserts
    // identity at the moment of mutation. Platform-bound factors
    // (Touch ID / password / PIN) intentionally excluded: same logic as
    // peer-recover-user — the off-device requirement is the whole
    // point under STRICT.
    'update-user': {
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
    // ─── User envelope gates ──────────────────────────────────────────
    // STRICT: profile edits require a TOTP/email-OTP factor (typical
    // shared-workstation hardening — your name/avatar shouldn't change
    // without a fresh second-factor proof).
    'edit-own-profile': {
      minTier: 2,
      factors: [{ anyOf: ['totp', 'email-otp'] }],
    },
    'view-team-profiles': { minTier: 2 },
    // STRICT: still fail-closed, but if a regulated firm flips enabled:true
    // they inherit a two-factor proof + shared-device block for the
    // destructive withdrawal (mirrors export-plaintext's hardening).
    'client-unilateral-withdraw': {
      minTier: 1,
      enabled: false,
      factors: [{ anyOf: ['totp', 'email-otp'], count: 2 }],
      warn: { sharedDevice: 'block' },
    },
    // STRICT: filing stays tier-1; the destructive APPROVE demands an
    // off-device factor + shared-device block (mirrors export-bundle).
    'user-request-withdrawal': { minTier: 1 },
    'approve-user-withdrawal': {
      minTier: 2,
      factors: [{ anyOf: ['totp', 'email-otp'] }],
      warn: { sharedDevice: 'block' },
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
