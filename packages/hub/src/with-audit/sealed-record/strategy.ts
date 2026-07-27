/**
 * Sealed-record (grantor-side) capability strategy — the three on-demand vault
 * methods the record-scoped CEK sealing surface routes through. The active
 * engine ({@link withSealedRecord}) dynamically imports the `record-keys`
 * grantor cores (keeping them reachable only via opt-in); {@link NO_SEALED_RECORD}
 * throws. The vault always assembles the per-call {@link SealingContext} and
 * delegates here, so an un-opted-in caller hits `NO_SEALED_RECORD`'s throw.
 *
 * Note: the recipient-host opener (`openSealedRecord`) is a pure decrypt
 * function exported from this subpath and is NOT gated — it runs on a remote
 * host with no `createNoydb` instance (the same way the attestation verifier
 * stays ungated). Only the vault-side grantor operations are the capability.
 * @internal
 */
import type { SealingContext } from '../../kernel/enclave/index.js'
import type { RecipientSealer } from '../../with-party/team/managed-secret.js'
import { SealedRecordNotEnabledError } from '../../kernel/errors.js'

export interface SealedRecordStrategy {
  sealRecordToHost(
    ctx: SealingContext,
    collection: string,
    id: string,
    hostSealer: RecipientSealer,
    opts: { expiresAt: string },
  ): Promise<{ pid: string; envelopeKey: string }>
  revokeSealedRecord(
    ctx: SealingContext,
    collection: string,
    id: string,
    pid: string,
    opts?: { hard?: boolean },
  ): Promise<void>
  rotateRecordCek(ctx: SealingContext, collection: string, id: string): Promise<void>
}

/**
 * No-op stub — the floor default. Every grantor method throws
 * {@link SealedRecordNotEnabledError}; opt in with
 * `sealedRecordStrategy: withSealedRecord()` in createNoydb. @internal
 */
export const NO_SEALED_RECORD: SealedRecordStrategy = {
  async sealRecordToHost() { throw new SealedRecordNotEnabledError() },
  async revokeSealedRecord() { throw new SealedRecordNotEnabledError() },
  async rotateRecordCek() { throw new SealedRecordNotEnabledError() },
}
