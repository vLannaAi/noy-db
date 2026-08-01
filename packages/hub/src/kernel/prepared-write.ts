/**
 * Carrier types for the prepare/commit write split (#893, #904, #905).
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

/**
 * @internal Everything `_commitDelete` needs after `_prepareDelete` decided the
 * delete goes ahead (#905). A deliberately separate carrier from
 * {@link PreparedPut}: the delete path differs in hydration, in the
 * history-read gate, and in the #589 marker rules.
 */
export interface PreparedDelete<T> {
  readonly id: string
  /** System-internal delete — skips the user-facing MV/derivation/rollup dispatch. */
  readonly internal: boolean
  /** Prior live version, for the history snapshot / ledger version / index teardown. */
  readonly existing: { record: T; version: number } | undefined
  /** Payload hash of the pre-delete envelope, captured for the ledger entry. */
  readonly previousPayloadHash: string
  /**
   * #589 delete marker, minted at `live._v + 1` but NOT yet written. Present
   * only under sync (`onDirty`); `undefined` means the delete is a physical
   * `adapter.delete`.
   */
  readonly marker: EncryptedEnvelope | undefined
}
