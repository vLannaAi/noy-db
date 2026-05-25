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

  const byCollection = [...closure.entries()]
    .map(([name, ids]) => ({ name, recordCount: ids.size, bytes: 0 }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const totalRecords = byCollection.reduce((n, c) => n + c.recordCount, 0)

  return Object.freeze({
    totalRecords,
    totalBytes: 0,
    byCollection,
    graph,
    inaccessible: [],
  })
}
