/**
 * Enable the sealed-record (grantor-side) capability.
 * Pass to `createNoydb({ sealedRecordStrategy: withSealedRecord() })` to make a
 * vault's `sealRecordToHost` / `revokeSealedRecord` / `rotateRecordCek` methods
 * live. The `record-keys` grantor engine is dynamically imported here, so it is
 * reached only via opt-in.
 */
import type { SealedRecordStrategy } from './strategy.js'

export function withSealedRecord(): SealedRecordStrategy {
  return {
    async sealRecordToHost(ctx, collection, id, hostSealer, opts) {
      const { sealRecordToHost } = await import('../../kernel/enclave/record-keys/index.js')
      return sealRecordToHost(ctx, collection, id, hostSealer, opts)
    },
    async revokeSealedRecord(ctx, collection, id, pid, opts) {
      const { revokeSealedRecord } = await import('../../kernel/enclave/record-keys/index.js')
      return revokeSealedRecord(ctx, collection, id, pid, opts)
    },
    async rotateRecordCek(ctx, collection, id) {
      const { rotateRecordCek } = await import('../../kernel/enclave/record-keys/index.js')
      return rotateRecordCek(ctx, collection, id)
    },
  }
}
