/**
 * Orphan blob-chunk REPORT (#1133) — the read-only half of the residue #1127
 * stopped producing.
 *
 * Before #1127, `releaseRef` deleted a blob's index row BEFORE its chunks, so a
 * crash in between stranded chunk bodies nothing can ever reach: `loadBlobObject`
 * returns null so no reader addresses them, and `rekeyBlobSet` derives its chunk
 * ids from each index entry's `chunkCount` so a rotation never visits them. For a
 * LEGACY blob (bytes under the shared `_blob` DEK rather than a per-blob content
 * CEK) those bodies then stay openable under the retired DEK indefinitely.
 *
 * #1127 reversed the order, which removes the class at the source. It does
 * nothing for orphans created before the fix, and this module does not delete
 * them either. It counts them.
 *
 * ## Why this REPORTS and does not RECLAIM
 *
 * Deciding "orphaned" requires `store.list(_blob_index)`, and the store is
 * untrusted — that is the premise of the product, not a caveat on it. A store
 * that withholds a single index row makes a LIVE blob's chunks look orphaned. A
 * reclaim pass acting on that would convert **withholding**, which is reversible
 * the moment the store stops lying, into **permanent destruction** — handing an
 * untrusted store a data-loss primitive it does not currently have, in order to
 * tidy up residue.
 *
 * Reporting inverts the risk to something harmless: a lying store can only
 * inflate this count. Nothing is deleted on its word, so the worst outcome is an
 * operator investigating residue that turns out not to exist.
 *
 * Re-keying is not an alternative either: the chunk AAD is
 * `{eTag}:{chunkIndex}:{chunkCount}`, and `chunkCount` lives only in the index
 * row that is already gone — an orphan's AAD is unreconstructable, so it cannot
 * be decrypted-and-re-encrypted at all.
 */

import type { NoydbStore } from '../../kernel/types.js'
import { BLOB_INDEX_COLLECTION, BLOB_CHUNKS_COLLECTION } from './blob-set.js'

/** How many distinct orphaned eTags to name in the report. */
const SAMPLE_LIMIT = 10

export interface OrphanChunkReport {
  /** Chunk rows whose eTag has no `_blob_index` entry. */
  readonly chunks: number
  /** Distinct eTags those chunks belong to. */
  readonly eTags: number
  /**
   * Up to {@link SAMPLE_LIMIT} of those eTags, so an operator can inspect a real
   * one rather than only a count. Deterministic (store list order), not random.
   */
  readonly sampleETags: readonly string[]
  /**
   * Chunk ids that do not match the `{eTag}_{index}` grammar at all. Counted
   * rather than skipped: an id this module cannot parse is a thing it cannot
   * classify either way, and reporting zero orphans while silently dropping
   * such ids would be the reassuring-but-wrong answer.
   */
  readonly unparseable: number
}

/**
 * Split a chunk id into `{eTag, index}`, or `null` if it does not fit the
 * grammar `BlobSet` writes (`${eTag}_${i}`).
 *
 * Splits on the LAST underscore and requires a digits-only suffix. eTags are
 * HMAC-SHA-256 hex today and contain no underscore, so a simpler split would
 * work — but it would break silently if that ever changed, and this rule holds
 * either way.
 */
function parseChunkId(id: string): { eTag: string; index: number } | null {
  const cut = id.lastIndexOf('_')
  if (cut <= 0 || cut === id.length - 1) return null
  const suffix = id.slice(cut + 1)
  if (!/^\d+$/.test(suffix)) return null
  return { eTag: id.slice(0, cut), index: Number(suffix) }
}

/**
 * Count chunk rows with no surviving index row. Read-only: two `list` calls and
 * no `get`, no `delete`, and no decryption — an orphan cannot be opened anyway.
 *
 * A store that cannot list either collection yields an empty report rather than
 * throwing: this is a diagnostic riding along with a maintenance pass, and it
 * must not be able to fail one.
 */
export async function reportOrphanBlobChunks(
  adapter: NoydbStore,
  vault: string,
): Promise<OrphanChunkReport> {
  const empty: OrphanChunkReport = { chunks: 0, eTags: 0, sampleETags: [], unparseable: 0 }
  let liveETags: Set<string>
  let chunkIds: string[]
  try {
    liveETags = new Set(await adapter.list(vault, BLOB_INDEX_COLLECTION))
    chunkIds = await adapter.list(vault, BLOB_CHUNKS_COLLECTION)
  } catch {
    return empty
  }

  let chunks = 0
  let unparseable = 0
  const orphanETags = new Set<string>()
  for (const id of chunkIds) {
    const parsed = parseChunkId(id)
    if (parsed === null) { unparseable += 1; continue }
    if (liveETags.has(parsed.eTag)) continue
    chunks += 1
    orphanETags.add(parsed.eTag)
  }

  return {
    chunks,
    eTags: orphanETags.size,
    sampleETags: [...orphanETags].slice(0, SAMPLE_LIMIT),
    unparseable,
  }
}
