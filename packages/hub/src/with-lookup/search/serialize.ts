/**
 * (De)serialize an InvertedIndex to/from a JSON string for persistence (L1.5).
 *
 * ## Why a validator, and why its failure mode is "rebuild" (#1354)
 *
 * Positional postings changed the persisted shape, so this module adopts the
 * discipline #1359 established for the field-index sidecars: a blob is used
 * only if it is EXACTLY the current format, and anything else is discarded
 * whole and rebuilt from the record cache. There is no migration path and no
 * partial load, because a half-trusted index answers confidently and wrongly —
 * a pre-#1354 blob read leniently would report "no positions here", which a
 * phrase query cannot distinguish from "your phrase is not in this record".
 *
 * ⭐ An out-of-order position list is REJECTED, not re-sorted. Re-sorting would
 * launder a corrupt blob into a plausible-looking answer; the cache can always
 * rebuild the truth.
 */
import { InvertedIndex, INDEX_SNAPSHOT_VERSION, type IndexSnapshot } from './inverted-index.js'

export function serializeIndex(idx: InvertedIndex): string {
  return JSON.stringify(idx.toSnapshot())
}

/** `null` ⇒ the blob is unusable and the caller must rebuild. Never throws. */
export function deserializeIndex(json: string): InvertedIndex | null {
  const snap = parseIndexSnapshot(json)
  return snap === null ? null : InvertedIndex.fromSnapshot(snap)
}

/**
 * Decode + structurally validate a persisted index snapshot. Returns `null` for
 * anything that is not exactly the current format: torn JSON, a stamp from
 * another release, a shape mismatch, a position list that is not strictly
 * ascending or that names a token the doc does not have, or a `pos`/`posFields`
 * disagreement (a doc whose field opted in but carries no positions would make
 * every phrase query silently miss it).
 */
export function parseIndexSnapshot(json: string): IndexSnapshot | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o['v'] !== INDEX_SNAPSHOT_VERSION) return null
  if (!isStringArray(o['posFields'])) return null
  if (!Array.isArray(o['fieldStats']) || !Array.isArray(o['docs'])) return null
  const posFields = new Set(o['posFields'])

  const fieldStats: Array<IndexSnapshot['fieldStats'][number]> = []
  for (const e of o['fieldStats'] as unknown[]) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string') return null
    const s = e[1] as Record<string, unknown> | null
    if (typeof s !== 'object' || s === null) return null
    if (!isCountPairs(s['df']) || !isNonNegInt(s['n']) || !isNonNegInt(s['totalLen'])) return null
    fieldStats.push([e[0], { df: s['df'], n: s['n'], totalLen: s['totalLen'] }])
  }

  const docs: Array<IndexSnapshot['docs'][number]> = []
  for (const e of o['docs'] as unknown[]) {
    if (typeof e !== 'object' || e === null) return null
    const d = e as Record<string, unknown>
    if (typeof d['id'] !== 'string' || typeof d['field'] !== 'string' || typeof d['text'] !== 'string') return null
    if (!isNonNegInt(d['len'])) return null
    if (d['locale'] !== undefined && typeof d['locale'] !== 'string') return null
    if (!isCountPairs(d['tf']) || !isCountPairs(d['firstOffset'])) return null
    const wantsPos = posFields.has(d['field'])
    if (wantsPos !== (d['pos'] !== undefined)) return null
    let pos: [string, number[]][] | undefined
    if (d['pos'] !== undefined) {
      if (!isPositionPairs(d['pos'], d['len'])) return null
      pos = d['pos'] as [string, number[]][]
    }
    docs.push({
      id: d['id'], field: d['field'], text: d['text'], len: d['len'],
      tf: d['tf'], firstOffset: d['firstOffset'],
      ...(d['locale'] !== undefined ? { locale: d['locale'] } : {}),
      ...(pos !== undefined ? { pos } : {}),
    })
  }

  return { v: INDEX_SNAPSHOT_VERSION, posFields: o['posFields'], fieldStats, docs }
}

function isNonNegInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((s) => typeof s === 'string')
}

/** `[term, count]` pairs — the tf and firstOffset maps' wire form. */
function isCountPairs(x: unknown): x is [string, number][] {
  return Array.isArray(x) && x.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && isNonNegInt(p[1]))
}

/** `[term, ordinals]` pairs; ordinals strictly ascending and inside the doc. */
function isPositionPairs(x: unknown, len: number): boolean {
  if (!Array.isArray(x)) return false
  for (const p of x) {
    if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'string') return false
    const list = p[1] as unknown
    if (!Array.isArray(list) || list.length === 0) return false
    let prev = -1
    for (const n of list) {
      if (!isNonNegInt(n) || n <= prev || n >= len) return false
      prev = n
    }
  }
  return true
}
