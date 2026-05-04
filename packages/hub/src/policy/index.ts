/**
 * Policy gate DSL — barrel export for the `@noy-db/hub/policy` surface.
 *
 * @see docs/subsystems/session-tiers.md → Policy gates DSL
 *
 * @module
 */
export type {
  FactorKind,
  FactorRequirement,
  FactorProof,
  GatePolicy,
  WarningRules,
  GateName,
  BuiltInGateName,
  VaultPolicy,
  ActiveTier,
} from './types.js'

export {
  PolicyDeniedError,
  RecoveryNotEnrolledError,
  RecoveryProfileNotImplementedError,
} from './errors.js'
export type { PolicyDenyReason } from './errors.js'

export { PERSONAL_POLICY, STRICT_POLICY, mergePolicy } from './presets.js'

export { checkGate, describeGate, DEFAULT_FRESHNESS_MS } from './engine.js'
export type { CheckGateContext } from './engine.js'

export {
  loadVaultPolicy,
  saveVaultPolicy,
  META_COLLECTION,
  POLICY_RECORD_ID,
} from './storage.js'
