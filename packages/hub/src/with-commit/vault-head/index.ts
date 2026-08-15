/**
 * `@noy-db/hub/vault-head` — detect a store that WITHHOLDS (#1044).
 *
 * @packageDocumentation
 */
export { withVaultHead } from './active.js'
export { verifyVaultHead, type HeadDiscrepancy, type HeadVerifyResult } from './verify.js'
export {
  NO_VAULT_HEAD,
  VAULT_HEAD_COLLECTION,
  DEFAULT_HEAD_BUCKETS,
  type VaultHeadStrategy,
  type WithVaultHeadOptions,
  type HeadEntry,
} from './strategy.js'

// `verifyVaultHead` and the strategy methods take a store and a key, so a
// consumer must be able to NAME them without reaching for another entry point
// (check:types / type-reachability).
export type { NoydbStore, EncryptedEnvelope } from '../../kernel/types.js'
export type { EnclaveKey } from '../../kernel/enclave/index.js'
