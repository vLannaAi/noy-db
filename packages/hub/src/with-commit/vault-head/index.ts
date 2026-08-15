/**
 * `@noy-db/hub/vault-head` — detect a store that WITHHOLDS (#1044).
 *
 * @packageDocumentation
 */
export { withVaultHead } from './active.js'
export {
  NO_VAULT_HEAD,
  VAULT_HEAD_COLLECTION,
  DEFAULT_HEAD_BUCKETS,
  type VaultHeadStrategy,
  type WithVaultHeadOptions,
  type HeadEntry,
} from './strategy.js'
