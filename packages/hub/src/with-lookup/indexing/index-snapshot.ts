/**
 * The on-disk shape of a persisted field index (#1359) — the format both
 * `SortedIndex` (#1344) and `CompoundIndex` (#1345) round-trip through, plus
 * the structural validator every load must pass.
 *
 * ⭐ **Nothing is flattened into a delimited string.** A compound entry keeps
 * its tuple as an ARRAY of per-component keys, each carrying its runtime KIND
 * alongside its value — which is the whole point of #1345's in-memory shape
 * and would be destroyed by a `join()`. Two properties depend on it:
 *
 *  - **Kind survives.** Entries rank by runtime kind FIRST (mirroring
 *    `predicate.ts`'s `isComparable`), so a `string` probe must not reach
 *    `number` entries. An encoding that wrote only the value would collapse
 *    `1` and `'1'` into one key space on the way back in.
 *  - **Per-component ordering survives.** A string component may contain any
 *    byte, including whatever a separator would have been.
 *
 * The validator is deliberately paranoid and its failure mode is a REBUILD,
 * never a partial load: a blob that is truncated, from a future format, or
 * internally out of order is rejected whole. See
 * {@link parseFieldIndexSnapshot}.
 */

/** Bump on ANY incompatible change to the shapes below. An older stamp is rejected, not migrated. */
export const FIELD_INDEX_SNAPSHOT_VERSION = 1

/** One `SortKey`, wire form: `[kind, key]`. `kind` IS the sort rank. */
export type WireKey = readonly [kind: number, key: number | string]

/** One `SortedIndex` entry: `[kind, key, seq, id]`. */
export type WireSortedEntry = readonly [kind: number, key: number | string, seq: number, id: string]

/** One `CompoundIndex` entry: `[tupleKeys, seq, id]` — the tuple stays an ARRAY. */
export type WireCompoundEntry = readonly [keys: readonly WireKey[], seq: number, id: string]

export interface SortedIndexSnapshot {
  readonly v: number
  readonly t: 'sorted'
  readonly field: string
  readonly nextSeq: number
  readonly entries: readonly WireSortedEntry[]
}

export interface CompoundIndexSnapshot {
  readonly v: number
  readonly t: 'compound'
  readonly fields: readonly string[]
  readonly nextSeq: number
  readonly entries: readonly WireCompoundEntry[]
}

export type FieldIndexSnapshot = SortedIndexSnapshot | CompoundIndexSnapshot

/**
 * Sidecar key for a single-field sorted index. Field paths are
 * percent-encoded so no field name can collide with the `,` the compound
 * form joins on, nor with the `s:` / `c:` discriminator.
 */
export function sortedIndexKey(field: string): string {
  return `s:${encodeURIComponent(field)}`
}

/** Sidecar key for a compound index over an ordered field tuple. */
export function compoundIndexKey(fields: readonly string[]): string {
  return `c:${fields.map(encodeURIComponent).join(',')}`
}

/** A key is well-formed only if its declared kind matches its value's runtime type. */
function isWireKey(x: unknown): x is WireKey {
  if (!Array.isArray(x) || x.length !== 2) return false
  const [kind, key] = x as [unknown, unknown]
  // 0 = number, 1 = string, 2 = Date-as-epoch-millis. See `sorted-indexes.ts`.
  if (kind === 0 || kind === 2) return typeof key === 'number' && Number.isFinite(key)
  if (kind === 1) return typeof key === 'string'
  return false
}

function isSeq(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0
}

/**
 * Decode + validate a persisted snapshot. Returns `null` — meaning "rebuild"
 * — for anything that is not exactly the current format: bad JSON (a torn
 * write), a version stamp from another release, a shape mismatch, a
 * malformed key, or entries out of the order the index's binary searches
 * require. A caller must never repair a snapshot; the source of truth is the
 * cache, and rebuilding from it is always available.
 */
export function parseFieldIndexSnapshot(json: string): FieldIndexSnapshot | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o['v'] !== FIELD_INDEX_SNAPSHOT_VERSION) return null
  if (!isSeq(o['nextSeq']) || !Array.isArray(o['entries'])) return null
  const nextSeq = o['nextSeq']
  const entries = o['entries'] as unknown[]

  if (o['t'] === 'sorted') {
    if (typeof o['field'] !== 'string') return null
    const out: WireSortedEntry[] = []
    for (const e of entries) {
      if (!Array.isArray(e) || e.length !== 4) return null
      const [kind, key, seq, id] = e as [unknown, unknown, unknown, unknown]
      if (!isWireKey([kind, key])) return null
      if (!isSeq(seq) || seq >= nextSeq || typeof id !== 'string') return null
      out.push([kind as number, key as number | string, seq, id])
    }
    if (!isAscending(out.map(e => [[e[0], e[1]] as WireKey]), out.map(e => e[2]))) return null
    return { v: FIELD_INDEX_SNAPSHOT_VERSION, t: 'sorted', field: o['field'], nextSeq, entries: out }
  }

  if (o['t'] === 'compound') {
    const fields = o['fields']
    if (!Array.isArray(fields) || fields.length === 0 || !fields.every(f => typeof f === 'string')) return null
    const out: WireCompoundEntry[] = []
    for (const e of entries) {
      if (!Array.isArray(e) || e.length !== 3) return null
      const [keys, seq, id] = e as [unknown, unknown, unknown]
      if (!Array.isArray(keys) || keys.length !== fields.length || !keys.every(isWireKey)) return null
      if (!isSeq(seq) || seq >= nextSeq || typeof id !== 'string') return null
      out.push([keys as readonly WireKey[], seq, id])
    }
    if (!isAscending(out.map(e => e[0]), out.map(e => e[1]))) return null
    return { v: FIELD_INDEX_SNAPSHOT_VERSION, t: 'compound', fields, nextSeq, entries: out }
  }

  return null
}

/**
 * Every binary search in both index classes assumes `(keys…, seq)` ascending.
 * A blob that is not sorted would not merely be slow — it would answer
 * WRONGLY, so it is rejected rather than re-sorted (re-sorting would launder
 * a corrupt blob into a plausible-looking answer).
 */
function isAscending(keys: ReadonlyArray<readonly WireKey[]>, seqs: readonly number[]): boolean {
  for (let i = 1; i < keys.length; i++) {
    const c = compareWireTuples(keys[i - 1]!, keys[i]!)
    if (c > 0) return false
    if (c === 0 && seqs[i - 1]! >= seqs[i]!) return false
  }
  return true
}

function compareWireTuples(a: readonly WireKey[], b: readonly WireKey[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x[0] !== y[0]) return x[0] - y[0]
    if (typeof x[1] === 'number' && typeof y[1] === 'number') {
      if (x[1] !== y[1]) return x[1] - y[1]
    } else if (x[1] !== y[1]) {
      return x[1] < y[1] ? -1 : 1
    }
  }
  return 0
}
