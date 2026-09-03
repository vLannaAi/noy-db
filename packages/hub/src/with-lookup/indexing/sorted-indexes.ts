/**
 * Sorted (range) secondary indexes — the ordered sibling of the hash
 * index in `eager-indexes.ts` (#1344).
 *
 * A sorted index is an array of `{ kind, key, seq, id }` entries kept in
 * ascending `(kindRank, key, seq)` order. Binary search then answers
 * `<`, `<=`, `>`, `>=`, `between` and `startsWith` as a contiguous slice,
 * and `orderedIds()` walks the array for `orderBy(field).limit(n)`.
 *
 * Three properties are load-bearing, each mirroring the linear scan this
 * replaces (`kernel/query/predicate.ts`):
 *
 *  - **Kind-partitioned.** `evaluateFieldClause`'s `isComparable` refuses
 *    to order two values of different runtime types, so entries are ranked
 *    by kind FIRST. A `string` probe therefore cannot reach `number`
 *    entries, exactly as the scan cannot. Values with no order-defined
 *    type (booleans, objects, arrays) are not indexed at all.
 *  - **Nullish is not indexed**, same as the hash index.
 *  - **Ties keep insertion order** (`seq`), which after a `build()` is
 *    snapshot order — so an index-served `orderBy(...).limit(n)` returns
 *    the same rows the stable scan-and-sort would.
 *
 * Keys canonicalise through the SAME per-field closure the hash index
 * uses (`ViaPipeline.canonicalizeIndexKey`), so a Via-covered field's
 * entries live in one key space here too. Range DISPATCH for a
 * Via-covered clause is nevertheless declined by the query builder (a
 * money operand has no ordered stored-form probe) — see
 * `kernel/query/builder.ts`'s `candidateRecords`.
 *
 * PERSISTENCE IS OUT OF SCOPE (#1359). This index lives in memory and is
 * rebuilt on hydrate, like its hash sibling.
 */

import { readPath } from '../../kernel/query/predicate.js'

/** Range operators a sorted index can answer. */
export type RangeOperator = '<' | '<=' | '>' | '>=' | 'between' | 'startsWith'

/**
 * Order-defined key kinds. The numeric value IS the sort rank, so entries
 * of different kinds never interleave and a probe only ever compares
 * against its own kind.
 */
export type KeyKind = 0 | 1 | 2
const KIND_NUMBER: KeyKind = 0
export const KIND_STRING: KeyKind = 1
const KIND_DATE: KeyKind = 2

export interface SortKey {
  readonly kind: KeyKind
  /** `number` for {@link KIND_NUMBER} and {@link KIND_DATE}, `string` otherwise. */
  readonly key: number | string
}

interface Entry extends SortKey {
  readonly seq: number
  readonly id: string
}

/** A single field's sorted index. */
export class SortedIndex {
  private readonly entries: Entry[] = []
  private nextSeq = 0

  constructor(readonly field: string) {}

  get size(): number {
    return this.entries.length
  }

  clear(): void {
    this.entries.length = 0
    this.nextSeq = 0
  }

  /** Insert one record. No-op when the value has no order-defined kind. */
  add(id: string, value: unknown, canonicalKey: string | undefined): void {
    const sk = toSortKey(value, canonicalKey)
    if (!sk) return
    const entry: Entry = { ...sk, seq: this.nextSeq++, id }
    this.entries.splice(this.insertionPoint(entry), 0, entry)
  }

  /** Remove one record, addressed by the value it was indexed under. */
  remove(id: string, value: unknown, canonicalKey: string | undefined): void {
    const sk = toSortKey(value, canonicalKey)
    if (!sk) return
    // Every entry sharing this key is contiguous; walk that run for the id.
    for (let i = this.lowerBound(sk); i < this.entries.length; i++) {
      const e = this.entries[i]!
      if (compareKeys(e, sk) !== 0) break
      if (e.id === id) {
        this.entries.splice(i, 1)
        return
      }
    }
  }

  /**
   * Ids in ascending (or descending) key order. Ties keep INSERTION order
   * in both directions — `sortRecords()` negates its comparator over a
   * stable sort, which reverses the key order but not the order of equal
   * keys. A plain `.reverse()` here would disagree on ties.
   */
  orderedIds(direction: 'asc' | 'desc'): string[] {
    if (direction === 'asc') return this.entries.map(e => e.id)
    const out: string[] = []
    let end = this.entries.length
    while (end > 0) {
      let start = end - 1
      while (start > 0 && compareKeys(this.entries[start - 1]!, this.entries[end - 1]!) === 0) start--
      for (let i = start; i < end; i++) out.push(this.entries[i]!.id)
      end = start
    }
    return out
  }

  /**
   * Ids matching a range clause. Returns an empty set when the probe has
   * no comparable kind — which is what the linear scan would produce too.
   */
  lookup(op: RangeOperator, value: unknown): Set<string> {
    if (op === 'startsWith') return this.prefix(value)
    if (op === 'between') {
      if (!Array.isArray(value) || value.length !== 2) return new Set()
      const lo = toSortKey(value[0], undefined)
      const hi = toSortKey(value[1], undefined)
      if (!lo || !hi || lo.kind !== hi.kind) return new Set()
      return this.slice(this.lowerBound(lo), this.upperBound(hi))
    }
    const probe = toSortKey(value, undefined)
    if (!probe) return new Set()
    const lo = this.lowerBound(probe)
    const hi = this.upperBound(probe)
    // Kind-partitioned: `<`/`>` must stay inside the probe's own kind run.
    const [kindStart, kindEnd] = this.kindBounds(probe.kind)
    switch (op) {
      case '<':
        return this.slice(kindStart, lo)
      case '<=':
        return this.slice(kindStart, hi)
      case '>':
        return this.slice(hi, kindEnd)
      case '>=':
        return this.slice(lo, kindEnd)
      default: {
        const _exhaustive: never = op
        void _exhaustive
        return new Set()
      }
    }
  }

  private prefix(value: unknown): Set<string> {
    if (typeof value !== 'string') return new Set()
    const out = new Set<string>()
    const from = this.lowerBound({ kind: KIND_STRING, key: value })
    for (let i = from; i < this.entries.length; i++) {
      const e = this.entries[i]!
      if (e.kind !== KIND_STRING) break
      if (!(e.key as string).startsWith(value)) break
      out.add(e.id)
    }
    return out
  }

  private slice(from: number, to: number): Set<string> {
    const out = new Set<string>()
    for (let i = from; i < to; i++) out.add(this.entries[i]!.id)
    return out
  }

  /** [start, end) of the run of entries with the given kind — binary, not linear. */
  private kindBounds(kind: KeyKind): [number, number] {
    return [this.kindBoundary(k => k < kind), this.kindBoundary(k => k <= kind)]
  }

  private kindBoundary(before: (k: KeyKind) => boolean): number {
    let lo = 0
    let hi = this.entries.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (before(this.entries[mid]!.kind)) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** First index whose key is >= `probe`. */
  private lowerBound(probe: SortKey): number {
    let lo = 0
    let hi = this.entries.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (compareKeys(this.entries[mid]!, probe) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** First index whose key is > `probe`. */
  private upperBound(probe: SortKey): number {
    let lo = 0
    let hi = this.entries.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (compareKeys(this.entries[mid]!, probe) <= 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** Insertion point that keeps ties in `seq` order (stable append). */
  private insertionPoint(entry: Entry): number {
    let lo = 0
    let hi = this.entries.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (compareKeys(this.entries[mid]!, entry) <= 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }
}

/** Build the whole index from a snapshot. Entry seqs follow snapshot order. */
export function buildSortedIndex<T>(
  idx: SortedIndex,
  records: ReadonlyArray<{ id: string; record: T }>,
  canonicalize?: (field: string, value: unknown) => string | undefined,
): void {
  idx.clear()
  for (const { id, record } of records) {
    const value = readPath(record, idx.field)
    if (value === null || value === undefined) continue
    idx.add(id, value, canonicalize?.(idx.field, value))
  }
}

export function compareKeys(a: SortKey, b: SortKey): number {
  if (a.kind !== b.kind) return a.kind - b.kind
  if (typeof a.key === 'number' && typeof b.key === 'number') return a.key - b.key
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/**
 * Map a raw (or canonicalized) value onto its ordered key, or `undefined`
 * when the value has no order-defined runtime type — mirroring
 * `predicate.ts`'s `isComparable`, which refuses to order booleans,
 * objects and arrays.
 */
export function toSortKey(value: unknown, canonicalKey: string | undefined): SortKey | undefined {
  // A canonicalized key is a string by contract (`canonicalizeIndexKey`)
  // and shares the hash index's key space, so it sorts as a string.
  if (canonicalKey !== undefined) return { kind: KIND_STRING, key: canonicalKey }
  if (typeof value === 'number') return Number.isNaN(value) ? undefined : { kind: KIND_NUMBER, key: value }
  if (typeof value === 'string') return { kind: KIND_STRING, key: value }
  if (value instanceof Date) return { kind: KIND_DATE, key: value.getTime() }
  return undefined
}
