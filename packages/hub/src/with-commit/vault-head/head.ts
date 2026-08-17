/**
 * The vault head's storage layer (#1044).
 *
 * A bucket is an ordinary encrypted record at `_head/<collection>::<n>`, so it
 * inherits #1041's identity binding for free: the store cannot relocate a
 * bucket, re-author it, or serve one bucket's bytes as another's. What it can
 * still do is serve an OLD bucket, which is why {@link readBucket} enforces
 * monotonicity against the caller's own record of what it last wrote.
 *
 * @packageDocumentation
 */
import { encrypt, buildRecordAad, openEnvelopeJson, buildRecordEnvelope, type EnclaveKey } from '../../kernel/enclave/index.js'
import type { NoydbStore } from '../../kernel/types.js'
import { VAULT_HEAD_COLLECTION } from './strategy.js'

/** `{ recordId → version }` for one bucket. */
export type BucketBody = Record<string, number>

/**
 * FNV-1a over `collection/id`. A hash, not a cipher: the bucket a record lands
 * in is not secret — the store already sees which bucket was written, and it
 * already saw the record's own address. Choosing something stronger would buy
 * nothing and cost every write.
 */
export function bucketIndex(collection: string, id: string, buckets: number): number {
  let h = 0x811c9dc5
  const s = `${collection}/${id}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % buckets
}

export function bucketId(collection: string, id: string, buckets: number): string {
  return `${collection}::${String(bucketIndex(collection, id, buckets))}`
}

export async function readBucket(
  store: NoydbStore,
  vault: string,
  dek: EnclaveKey,
  bucket: string,
): Promise<{ body: BucketBody; version: number }> {
  const env = await store.get(vault, VAULT_HEAD_COLLECTION, bucket)
  if (!env) return { body: {}, version: 0 }
  const json = await openEnvelopeJson({ collection: VAULT_HEAD_COLLECTION, id: bucket }, env, dek)
  return { body: JSON.parse(json) as BucketBody, version: env._v }
}

export async function writeBucket(
  store: NoydbStore,
  vault: string,
  dek: EnclaveKey,
  bucket: string,
  body: BucketBody,
  expectedVersion: number,
): Promise<void> {
  const identity = { collection: VAULT_HEAD_COLLECTION, id: bucket, version: expectedVersion + 1 }
  const json = JSON.stringify(body)
  const { iv, data } = await encrypt(json, dek, buildRecordAad(identity))
  const env = buildRecordEnvelope(identity, { iv, data })
  // CAS: two writers racing on one bucket must not silently lose an entry.
  // A lost head entry is a record the sweep stops expecting — a false clean.
  await store.put(vault, VAULT_HEAD_COLLECTION, bucket, env, expectedVersion || undefined)
}
