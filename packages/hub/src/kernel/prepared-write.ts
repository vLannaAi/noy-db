/**
 * Carrier types for the prepare/commit write split (#893, #904).
 *
 * `Collection._preparePut` runs every pre-envelope stage and stops holding an
 * encrypted envelope with ZERO observable side effects; `_commitPut` (or
 * `_finalizePut`, when the store already persisted the bytes inside a
 * `store.tx()`) turns that into a committed write. Everything the commit half
 * still needs from the prepare half travels in the structures below.
 *
 * Type-only by design — this module erases at runtime and stays out of the
 * kernel-surface line budget.
 */
import type { EncryptedEnvelope } from './types.js'
import type { EnclaveKey } from './enclave/index.js'

/** @internal Everything `_commitPut` needs after `_preparePut` produced the envelope. */
export interface PreparedPut<T> {
  readonly id: string
  readonly envelope: EncryptedEnvelope
  readonly version: number
  /** Record as caches/indexes/ledger-delta see it. */
  readonly indexed: T
  /** Record as `_onRecordMutated` reports it (drives events). */
  readonly event: T
  readonly prior: { record: T; version: number } | undefined
  readonly cek: EnclaveKey | undefined
  readonly vdigCtx: { id: string; prev: EncryptedEnvelope | null } | undefined
  readonly reason: string | undefined
}
