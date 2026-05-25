/**
 * Partition-extraction dry-run (#202). Read-only preview of what an
 * `extractPartition` would move: record counts, byte totals, and the
 * timestamp span per collection — computed from raw encrypted
 * envelopes WITHOUT decrypting them. Writes nothing, mutates nothing.
 *
 * @module
 */
import type { Vault } from '../vault.js'
import { walkClosure, type WalkClosureOptions } from './walk-closure.js'

export interface ExtractionPreview {
  readonly totalRecords: number
  /** Sum of serialized encrypted-envelope sizes (bytes). */
  readonly totalBytes: number
  readonly byCollection: ReadonlyArray<{
    readonly name: string
    readonly recordCount: number
    readonly bytes: number
    /** Earliest envelope `_ts` in this collection (lexicographic). */
    readonly oldestTs?: string
    readonly newestTs?: string
  }>
  readonly graph: { readonly depth: number; readonly cyclesDetected: boolean }
  /** Records the walk reached but whose envelope couldn't be read. */
  readonly inaccessible: ReadonlyArray<{ readonly collection: string; readonly id: string }>
}

export async function describeExtraction(
  vault: Vault,
  opts: WalkClosureOptions,
): Promise<ExtractionPreview> {
  const { closure, graph } = await walkClosure(vault, opts)

  const { name: vaultName, adapter } = vault._introspectState()
  const encoder = new TextEncoder()

  const byCollection: Array<{
    name: string; recordCount: number; bytes: number; oldestTs?: string; newestTs?: string
  }> = []
  const inaccessible: Array<{ collection: string; id: string }> = []
  let totalBytes = 0
  let totalRecords = 0

  for (const [collectionName, ids] of closure) {
    let bytes = 0
    let oldestTs: string | undefined
    let newestTs: string | undefined
    let recordCount = 0

    for (const id of ids) {
      const env = await adapter.get(vaultName, collectionName, id)
      if (!env) {
        // Walk reached it (via decrypted list) but the raw store read
        // returned nothing — surface rather than miscount.
        inaccessible.push({ collection: collectionName, id })
        continue
      }
      recordCount++
      bytes += encoder.encode(JSON.stringify(env)).length
      const ts = env._ts
      if (oldestTs === undefined || ts < oldestTs) oldestTs = ts
      if (newestTs === undefined || ts > newestTs) newestTs = ts
    }

    byCollection.push({ name: collectionName, recordCount, bytes, oldestTs, newestTs })
    totalBytes += bytes
    totalRecords += recordCount
  }

  byCollection.sort((a, b) => a.name.localeCompare(b.name))

  return Object.freeze({
    totalRecords,
    totalBytes,
    byCollection,
    graph,
    inaccessible,
  })
}
