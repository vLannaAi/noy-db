/**
 * #1453 — count, and optionally reclaim, legacy blobs nothing references.
 *
 * A legacy blob (no per-blob `_cek`) is left at refCount 0 "for deferred GC"
 * by `releaseRef`; before this the deferred GC had no verb outside
 * `forget()` (which needs `withForget`), and `orphanBlobChunks` could not see
 * these rows because they keep their index entry — so `vault.compact()`
 * reported clean over a vault whose blob storage grew on every overwrite.
 *
 * Reclaiming here is SAFE where reclaiming orphans is not (see
 * `orphan-report.ts`): the decision reads `refCount` off an AAD-bound index
 * row the hub decrypted itself, never the store's `list()`. A withholding
 * store cannot make a live blob look unreferenced; it can only hide a row from
 * this sweep, which then does nothing to it.
 *
 * Rows sealed at an elevated tier do not open under the flat `_blob` DEK and
 * are skipped, not counted: this is a tier-0 pass.
 */
import type { NoydbStore, BlobObject } from '../../kernel/types.js'
import { openEnvelopeJson, type EnclaveKey } from '../../kernel/enclave/index.js'
import { TamperedError } from '../../kernel/errors.js'
import { BLOB_COLLECTION, BLOB_INDEX_COLLECTION, BLOB_CHUNKS_COLLECTION } from './blob-set.js'

/** What `vault.compact()` reports (and, on request, reclaims) about legacy blobs. */
export interface UnreferencedLegacyBlobReport {
  /** `_blob_index` rows with no `_cek` (legacy) and `refCount <= 0`. */
  readonly blobs: number
  /** Chunk rows those blobs still hold. */
  readonly chunks: number
  /** How many of those blobs this run deleted (chunks first, then the index row). */
  readonly reclaimed: number
}

export async function sweepUnreferencedLegacyBlobs(
  ctx: { adapter: NoydbStore; vault: string; getDEK: (name: string) => Promise<EnclaveKey>; encrypted: boolean },
  reclaim: boolean,
): Promise<UnreferencedLegacyBlobReport> {
  let blobs = 0, chunks = 0, reclaimed = 0
  const eTags = await ctx.adapter.list(ctx.vault, BLOB_INDEX_COLLECTION)
  const dek = ctx.encrypted ? await ctx.getDEK(BLOB_COLLECTION) : null
  for (const eTag of eTags) {
    const env = await ctx.adapter.get(ctx.vault, BLOB_INDEX_COLLECTION, eTag)
    if (!env) continue
    let blob: BlobObject
    try {
      // `encrypt: false` stores the body as plaintext JSON; read it as the
      // opaque string it is (no enclave field is interpreted here).
      const json = dek ? await openEnvelopeJson({ collection: BLOB_INDEX_COLLECTION, id: eTag }, env, dek) : env['_data']
      blob = JSON.parse(json) as BlobObject
    } catch (err) {
      if (err instanceof TamperedError) continue // elevated-tier row: not this pass's
      throw err
    }
    // A BlobObject with a wrapped content key is erasable and shreds eagerly at
    // refCount 0; only the key-less legacy shape ever lingers.
    if (Object.hasOwn(blob, '_cek') || blob.refCount > 0) continue
    blobs += 1
    chunks += blob.chunkCount
    if (!reclaim) continue
    // CHUNKS BEFORE INDEX — same ordering rule as `deleteChunksThenIndex` (#1127).
    for (let i = 0; i < blob.chunkCount; i++) {
      await ctx.adapter.delete(ctx.vault, BLOB_CHUNKS_COLLECTION, `${eTag}_${i}`)
    }
    await ctx.adapter.delete(ctx.vault, BLOB_INDEX_COLLECTION, eTag)
    reclaimed += 1
  }
  return { blobs, chunks, reclaimed }
}
