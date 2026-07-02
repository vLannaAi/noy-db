/**
 * Read-side counterpart to `extractPartition`: decrypt an
 * extracted-partition bundle's records to plaintext using its transfer
 * key, WITHOUT adopting it into a vault. Used by an outward
 * orchestration layer's reconcile/merge and field-authority flows to
 * compare incoming records against a receiver. The transfer key validates the bundle
 * (wrong key throws).
 * @module
 */
import type { EncryptedEnvelope } from '../kernel/types.js'
import { decrypt } from '../kernel/enclave/crypto.js'
import { unwrapCek } from '../kernel/enclave/record-keys/index.js'
import { readPodHeader, readPod, parseExtractedPartitionBody } from '../with-pod/bundle.js'
import { unsealDeks } from './adopt-partition.js'

/** One decrypted record from an extracted-partition compartment. */
export interface DecryptedRecord {
  readonly id: string
  readonly record: Record<string, unknown>
  /** Source envelope write timestamp (ISO) — for last-write-wins merges. */
  readonly ts: string
  /** Source envelope version. */
  readonly version: number
  /** Provenance source id (FR-5). Present only when the source collection had provenance:true and a source was supplied on put. */
  readonly source?: string
  /** ISO-8601 timestamp the provenance source was recorded (FR-5). */
  readonly sourceTs?: string
}

/**
 * Decrypt every record of an extracted-partition bundle to plaintext,
 * grouped by collection. Throws if the bundle isn't an
 * extracted-partition or the transfer key is wrong.
 */
export async function decryptExtractedPartition(
  bundleBytes: Uint8Array,
  transferKey: Uint8Array,
): Promise<Record<string, DecryptedRecord[]>> {
  const header = readPodHeader(bundleBytes)
  if (header.bundleKind !== 'extracted-partition' || header.transferSeal === undefined) {
    throw new Error('decryptExtractedPartition: bundle is not an extracted-partition.')
  }
  const { dumpJson } = await readPod(bundleBytes)
  const { dump, seal } = parseExtractedPartitionBody(dumpJson)
  const deks = await unsealDeks(seal, transferKey) // throws TransferSealError on wrong key
  const backup = JSON.parse(dump) as { collections: Record<string, Record<string, EncryptedEnvelope>> }
  const out: Record<string, DecryptedRecord[]> = {}
  for (const [collection, byId] of Object.entries(backup.collections)) {
    const dek = deks.get(collection)
    if (dek === undefined) continue // no DEK sealed for this collection — skip
    const recs: DecryptedRecord[] = []
    for (const [id, env] of Object.entries(byId)) {
      const plaintext = env._cek !== undefined
        ? await decrypt(env._iv, env._data, await unwrapCek(env._cek, dek))
        : await decrypt(env._iv, env._data, dek)
      const body = JSON.parse(plaintext) as Record<string, unknown>
      recs.push({
        id,
        record: { ...body, id },
        ts: env._ts,
        version: env._v,
        ...(env._source !== undefined ? { source: env._source } : {}),
        ...(env._sourceTs !== undefined ? { sourceTs: env._sourceTs } : {}),
      })
    }
    out[collection] = recs
  }
  return out
}
