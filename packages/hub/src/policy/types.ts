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

/** A single off-device factor surface — the proof an actor presents at gate time. */
export type FactorKind =
  | 'totp'
  | 'email-otp'
  | 'recovery'
  | 'shamir'
  | 'webauthn-roaming'

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
