/**
 * Policy gate DSL — barrel export for the `@noy-db/hub/policy` surface.
 *
 * @see https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/session-tiers.md → Policy gates DSL
 *
 * @module
 */
export type {
  FactorKind,
  FactorRequirement,
  FactorProof,
  FactorProofBundle,
  GatePolicy,
  WarningRules,
  GateName,
  BuiltInGateName,
  VaultPolicy,
  ActiveTier,
} from '../../kernel/types.js'

export {
  PolicyDeniedError,
  RecoveryNotEnrolledError,
  RecoveryProfileNotImplementedError,
  ManagedRecoveryNotEnrolledError,
} from '../../kernel/errors.js'
export type { PolicyDenyReason } from '../../kernel/errors.js'

export { PERSONAL_POLICY, STRICT_POLICY, mergePolicy } from './presets.js'

export { checkGate, describeGate, DEFAULT_FRESHNESS_MS } from './engine.js'
export type { CheckGateContext } from './engine.js'

export {
  loadVaultPolicy,
  saveVaultPolicy,
  META_COLLECTION,
  POLICY_RECORD_ID,
} from './storage.js'

// `createNoydb()` pre-resolves this via a dynamic import to build
// `Noydb`'s `policyManager` synchronously — mirrors the
// `with-party/directory/user-envelope/api.js#createUserApi` pre-resolve.
export { createNoydbPolicy } from './noydb-facade.js'
