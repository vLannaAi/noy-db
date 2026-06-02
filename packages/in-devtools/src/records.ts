import type { Vault } from '@noy-db/hub'
import type { RecordPage } from './types.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

function clampLimit(n: number | undefined): number {
  if (n === undefined || Number.isNaN(n)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)))
}

function clampOffset(n: number | undefined): number {
  if (n === undefined || Number.isNaN(n) || n < 0) return 0
  return Math.floor(n)
}

export async function records(
  vault: Vault,
  collection: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<RecordPage> {
  const limit = clampLimit(opts.limit)
  const offset = clampOffset(opts.offset)
  // Eager collections only — `list()` throws on lazy (prefetch:false). The
  // error propagates to the caller, which decides how to surface it.
  const all = await vault.collection(collection).list()
  return {
    rows: all.slice(offset, offset + limit),
    total: all.length,
    limit,
    offset,
  }
}
