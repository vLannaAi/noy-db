/**
 * Policy gate DSL types — issue #9.
 *
 * Sensitive operations (rotate the passphrase, enroll an authenticator,
 * export plaintext, grant a user, …) are gated by a typed policy
 * object. The developer supplies a {@link VaultPolicy} at vault
 * creation; the hub merges it onto a built-in preset and persists the
 * merged document at `_meta/policy`.
 *
 * @see docs/subsystems/session-tiers.md → Policy gates DSL
 *
 * @module
 */
import type { PassphrasePolicy } from '../validation.js'

/**
 * A single factor surface — the proof an actor presents at gate time.
 *
 * | Kind | Source | Off-device? |
 * |---|---|---|
 * | `totp` | RFC 6238 authenticator app (Google Auth, 1Password) | yes |
 * | `email-otp` | one-time code mailed to the user | yes |
 * | `recovery` | printable Base32 code (`@noy-db/on-recovery`) | yes (paper) |
 * | `shamir` | k-of-n threshold share (`@noy-db/on-shamir`) | yes |
 * | `webauthn-roaming` | hardware key (YubiKey, SoloKey, Titan) | yes (key portable) |
 * | `webauthn-platform` | platform passkey (Touch ID, Face ID, Hello) | no (device-bound) |
 * | `password` | tier-2 daily password (`@noy-db/on-password`) | no |
 * | `pin` | tier-3 quick-resume PIN (`@noy-db/on-pin`) | no |
 *
 * Off-device kinds (TOTP, email-OTP, recovery, shamir, roaming WebAuthn)
 * are the strongest factor proofs because they require something
 * separate from the device the user just unlocked. Platform / password /
 * PIN are useful for "fresh proof of *this* user" but don't bind across
 * devices — policies can require ANY of them or insist on a count of 2
 * to force a mix.
 *
 * Added in pre.8 (#30): `webauthn-platform`, `password`, `pin` —
 * previously consumers with no off-device infrastructure (no TOTP,
 * no email-OTP, paper recovery not enrolled) had to disable the
 * factor requirement entirely on `rotate-passphrase`. Now they can
 * pin "any second factor I have wired" without losing the freshness
 * guarantee.
 */
export type FactorKind =
  | 'totp'
  | 'email-otp'
  | 'recovery'
  | 'shamir'
  | 'webauthn-roaming'
  | 'webauthn-platform'
  | 'password'
  | 'pin'

/**
 * One factor requirement entry. The default is "any one of the listed
 * factors, fresh within the last 5 minutes". Bumping `count` requires N
 * distinct fresh proofs; bumping `freshnessMs` widens the acceptance
 * window.
 */
export interface FactorRequirement {
  readonly anyOf: ReadonlyArray<FactorKind>
  /** Number of distinct factors required. Default 1. */
  readonly count?: number
  /** How recent each proof must be. Default 5 minutes. */
  readonly freshnessMs?: number
}

/** Soft signals layered on top of the gate verdict — never block on their own. */
export interface WarningRules {
  /** Behavior on shared-device tier-1 ops. `'block'` raises a `PolicyDeniedError`. */
  readonly sharedDevice?: 'warn' | 'block'
  /** Behavior on weak tier-2 (e.g. password-only) for sensitive ops. */
  readonly weakAuthenticator?: 'warn' | 'block'
}

/**
 * Policy applied to one named gate. `enabled: false` disables the
 * action entirely (useful in managed-passphrase mode where rotation is
 * impossible by construction).
 */
export interface GatePolicy {
  /** Minimum tier the active session must hold. */
  readonly minTier: 1 | 2 | 3
  /** Extra freshness-bound proofs required at gate time. */
  readonly factors?: ReadonlyArray<FactorRequirement>
  readonly warn?: WarningRules
  readonly enabled?: boolean
}

/**
 * Built-in gate names. App-defined gates live in the `app:*` namespace
 * and use the same engine; the engine treats unknown names with no
 * configured policy as "no gate" (no-op).
 */
export type BuiltInGateName =
  | 'rotate-passphrase'
  | 'recover-passphrase'
  | 'enroll-authenticator'
  | 'remove-authenticator'
  | 'rotate-unlock'
  | 'enroll-user'
  | 'revoke-user'
  | 'export-bundle'
  | 'export-plaintext'
  | 'view-user-auth'
  /** Authorize a write to one's own user envelope (#22). */
  | 'edit-own-profile'
  /** Authorize reading other principals' user envelopes (#22). */
  | 'view-team-profiles'
  /**
   * Authorize an atomic peer-recovery — `db.recoverUser` (#33, #34).
   * Distinct from `revoke-user` because peer-recovery is intentional
   * re-issuance of someone's keyring under a temp passphrase, NOT
   * removal. Allows owner→owner natively (matches the threat model:
   * a co-owner explicitly recovering another co-owner). Ships with a
   * factor-proof default in `STRICT_POLICY` so the issuer must
   * affirmatively prove identity at the moment of recovery.
   */
  | 'peer-recover-user'
  /**
   * Authorize a post-grant identity mutation — `db.updateUser` (#54).
   * Covers `role`, `displayName`, `permissions` changes on an existing
   * keyring. Pure plaintext-header rewrite — no DEKs touched, no KEK
   * required. The role-elevation guard inside the implementation
   * mirrors `db.grant`'s hierarchy (admin cannot promote to owner)
   * regardless of this gate's settings.
   */
  | 'update-user'

/** Either a built-in gate name or an `app:*` custom gate. */
export type GateName = BuiltInGateName | `app:${string}`

/**
 * Top-level policy object. Persisted at `_meta/policy` once at vault
 * creation. The `passphrase` block configures the strength rules
 * applied at every passphrase ingress (issue #7); `gates` configures
 * the action-level requirements.
 */
export interface VaultPolicy {
  readonly passphrase?: PassphrasePolicy
  readonly gates: Partial<Record<GateName, GatePolicy>>
}

/** Concrete proof an actor presents to {@link checkGate}. */
export interface FactorProof {
  readonly kind: FactorKind
  /** ISO-8601 timestamp the proof was minted at. Compared against `freshnessMs`. */
  readonly mintedAt?: string
  /** Method-specific payload. The engine treats it as opaque — verification is delegated. */
  readonly payload?: unknown
}

/** Active session tier — what the engine compares against `gate.minTier`. */
export type ActiveTier = 1 | 2 | 3
