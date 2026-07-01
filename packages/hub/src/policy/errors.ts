import { NoydbError } from '../kernel/errors.js'
import type { GateName, GatePolicy } from './types.js'

/**
 * Why a gate denied a request. Stable across hub versions so consumers
 * can switch on the value in error UIs.
 */
export type PolicyDenyReason =
  | 'insufficient-tier'
  | 'missing-factor'
  | 'stale-proof'
  | 'disabled'
  | 'shared-device-blocked'

/**
 * Thrown by {@link checkGate} when the active session does not meet
 * the gate's requirements. Carries the gate name, the reason, and the
 * full required {@link GatePolicy} so error UIs can prompt the user
 * for the missing factor without re-reading the policy document.
 */
export class PolicyDeniedError extends NoydbError {
  readonly gate: GateName
  readonly reason: PolicyDenyReason
  readonly required: GatePolicy
  constructor(gate: GateName, reason: PolicyDenyReason, required: GatePolicy, message?: string) {
    super(
      'POLICY_DENIED',
      message ?? `Gate "${gate}" denied: ${reason}.`,
    )
    this.name = 'PolicyDeniedError'
    this.gate = gate
    this.reason = reason
    this.required = required
  }
}

/**
 * Raised by `createNoydb({ ... })` when the developer omits a recovery
 * profile and `recover-passphrase` is not explicitly disabled. Vaults
 * MUST have at least one recovery path enrolled before being
 * production-ready (paper, shamir, multi-channel, or admin-mediated).
 *
 * The error message carries a pointer to the recovery design docs.
 */
export class RecoveryNotEnrolledError extends NoydbError {
  constructor(
    message =
      'Recovery profile not enrolled. Pass `recovery: [{ profile: "paper", codes: 10 }]` ' +
      'to `createNoydb()`, or set `policy.gates["recover-passphrase"].enabled = false` to ' +
      'opt out of recovery (passphrase loss = data loss). See docs/subsystems/session-tiers.md.',
  ) {
    super('RECOVERY_NOT_ENROLLED', message)
    this.name = 'RecoveryNotEnrolledError'
  }
}

/**
 * Raised by `openVault` when a managed-passphrase-mode vault has no
 * STRONG recovery profile enrolled.
 *
 * Managed mode means the user never types a passphrase — the unlock
 * material lives in a `SealingKeyProvider` (`at-*` package). If that
 * provider's key is lost AND no strong recovery is enrolled, the
 * vault is irrecoverable. To prevent that footgun, managed-mode vaults
 * require at least one strong recovery profile (Shamir today;
 * multi-channel / admin-mediated when those ship).
 *
 * Paper recovery alone is NOT strong under managed mode: the user has
 * no memorized passphrase to fall back on, so losing the paper sheet =
 * losing every record permanently.
 *
 * Bootstrap with `db.openVaultAndEnrollRecovery(vault, { recovery: [{ profile: "shamir", k, n }] })`
 * to atomically create-and-enroll, or call `db.enrollRecovery(vault, { profile: "shamir", ... })`
 * separately before re-attempting `openVault`.
 */
export class ManagedRecoveryNotEnrolledError extends NoydbError {
  readonly vault: string
  constructor(vault: string) {
    super(
      'MANAGED_RECOVERY_NOT_ENROLLED',
      `Managed-mode vault "${vault}" requires at least one strong recovery profile `
      + '(Shamir today; multi-channel / admin-mediated when they ship). Paper alone is '
      + 'NOT strong under managed mode — losing the paper sheet would mean losing every '
      + 'record permanently. '
      + `Bootstrap with \`db.openVaultAndEnrollRecovery("${vault}", { recovery: [{ profile: "shamir", k: 2, n: 3 }] })\`, `
      + 'or call `db.enrollRecovery(vault, { profile: "shamir", k, n })` separately, '
      + 'then re-attempt `openVault`.',
    )
    this.name = 'ManagedRecoveryNotEnrolledError'
    this.vault = vault
  }
}

/**
 * Raised by `db.recoverPassphrase` / `db.enrollRecovery` /
 * `db.rotateRecovery` when the developer requests a recovery profile
 * not yet wired in this hub release.
 *
 * Implemented: `paper` and `shamir`.
 * Pending: `multi-channel` and `admin-mediated` (follow-up slices).
 *
 * The carried `profile` and `tracking` fields let consumers steer the
 * UI ("multi-channel recovery is not yet wired up — open issue #N to follow").
 */
export class RecoveryProfileNotImplementedError extends NoydbError {
  readonly profile: string
  readonly tracking: string
  constructor(profile: string, tracking: string) {
    super(
      'RECOVERY_PROFILE_NOT_IMPLEMENTED',
      `Recovery profile "${profile}" is not yet implemented in this hub release. ` +
        `Tracking: ${tracking}. Use the "paper" profile via @noy-db/on-recovery in the meantime.`,
    )
    this.name = 'RecoveryProfileNotImplementedError'
    this.profile = profile
    this.tracking = tracking
  }
}
