import { NoydbError } from '../errors.js'
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
 * The error references issue #10 in its message so a developer hitting
 * it gets a one-line pointer to the design.
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
 * Raised by `db.recoverPassphrase` when the developer requests a
 * recovery profile other than `'paper'` in v0.1.0-pre.5. The other
 * three profiles (Shamir, multi-channel, admin-mediated) ship the API
 * shape now; their per-profile dispatch lands in follow-up issues.
 *
 * The carried `profile` and `tracking` fields let consumers steer the
 * UI ("Shamir recovery is not yet wired up — open issue #N to follow").
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
