/**
 * Compound (multi-field) sorted indexes — the tuple-keyed sibling of
 * `sorted-indexes.ts` (#1345).
 *
 * A compound index is an array of `{ keys, seq, id }` entries kept in
 * ascending `(keys[0], keys[1], …, seq)` order, where each `keys[i]` is
 * the SAME `SortKey` the single-field sorted index builds — so the tuple
 * encoding is order-preserving per component BY CONSTRUCTION rather than
 * by a second, hand-rolled serialization. Nothing is flattened into a
 * delimited string: a string component can therefore contain any byte
 * without colliding with a separator, and a money field canonicalized to
 * a scaled-integer string (`ViaPipeline.canonicalizeIndexKey`) or a date
 * stored as ISO text sorts inside its own component exactly as it does in
 * the single-field index.
 *
 * The two load-bearing properties of #1344 hold PER COMPONENT:
 *
 *  - **Kind-partitioned.** `compareKeys` ranks by runtime kind first, so
 *    within any equality-prefix run a `string` probe on the next
 *    component cannot reach `number` entries — mirroring `predicate.ts`'s
 *    `isComparable`, exactly as the linear scan behaves.
 *  - **Ties keep insertion order** in both directions. `orderedIds()`
 *    walks equal-key runs forward even when emitting descending, because
 *    `sortRecords()` negates its comparator over a STABLE sort.
 *
 * **A record is indexed only when EVERY component has an order-defined
 * value.** One nullish or non-orderable component and the record is
 * absent — which is why the query builder compares {@link
 * CompoundIndex.size} against the snapshot size before dispatching, and
 * falls back to the scan when the index does not cover the collection.
 *
 * PERSISTENCE IS OUT OF SCOPE (#1359), same as its single-field sibling.
 */

import { readPath } from '../../kernel/query/predicate.js'
import { KIND_STRING, compareKeys, toSortKey, type RangeOperator, type SortKey } from './sorted-indexes.js'

/** A range constraint on the component just past the equality prefix. */
export interface CompoundRangeProbe {
  readonly op: RangeOperator
  readonly value: unknown
}

interface CompoundEntry {
  readonly keys: readonly SortKey[]
  readonly seq: number
  readonly id: string
}

/** One collection's index over an ordered field tuple. */
export class CompoundIndex {
  private readonly entries: CompoundEntry[] = []
  private nextSeq = 0

  constructor(readonly fields: readonly string[]) {}

  get size(): number {
    return this.entries.length
  }

  clear(): void {
    this.entries.length = 0
    this.nextSeq = 0
  }

  /**
   * Insert one record. No-op unless every component has an ordered key.
   *
   * `seq` REINSTATES a rank a previous entry for this id held — see
   * {@link remove}'s return value and `CollectionIndexes.upsert`. Omit it
   * for a fresh insert, which appends after every existing tie.
   */
  add(id: string, keys: readonly SortKey[] | undefined, seq?: number): void {
    if (!keys) return
    const entry: CompoundEntry = { keys, seq: seq ?? this.nextSeq++, id }
    this.entries.splice(this.insertionPoint(entry), 0, entry)
  }

  /**
   * Remove one record, addressed by the tuple it was indexed under.
   * Returns the rank it held, so an UPDATE can reinstate it: `sortRecords()`
   * sorts a snapshot whose order does not change when a record is written in
   * place, so a tie-breaking rank that drifted to the back on every `put`
   * would make an index-served page disagree with the scan it must match.
   */
  remove(id: string, keys: readonly SortKey[] | undefined): number | undefined {
    if (!keys) return undefined
    const [from, to] = this.run(keys, keys.length)
    for (let i = from; i < to; i++) {
      if (this.entries[i]!.id === id) {
        const [gone] = this.entries.splice(i, 1)
        return gone!.seq
      }
    }
    return undefined
  }

  /**
   * Ids matching an equality prefix, optionally narrowed by a range on
   * the next component. An empty set is authoritative: the index covers
   * these fields and nothing matches.
   */
  lookup(prefix: readonly SortKey[], range?: CompoundRangeProbe): Set<string> {
    const [from, to] = this.run(prefix, prefix.length)
    if (!range) return this.slice(from, to)
    const k = prefix.length
    if (k >= this.fields.length) return new Set()

    if (range.op === 'startsWith') {
      if (typeof range.value !== 'string') return new Set()
      const out = new Set<string>()
      const start = this.lowerBound([...prefix, { kind: KIND_STRING, key: range.value }], k + 1, from, to)
      for (let i = start; i < to; i++) {
        const key = this.entries[i]!.keys[k]!
        if (key.kind !== KIND_STRING) break
        if (!(key.key as string).startsWith(range.value)) break
        out.add(this.entries[i]!.id)
      }
      return out
    }

    if (range.op === 'between') {
      if (!Array.isArray(range.value) || range.value.length !== 2) return new Set()
      const lo = toSortKey(range.value[0], undefined)
      const hi = toSortKey(range.value[1], undefined)
      if (!lo || !hi || lo.kind !== hi.kind) return new Set()
      return this.slice(
        this.lowerBound([...prefix, lo], k + 1, from, to),
        this.upperBound([...prefix, hi], k + 1, from, to),
      )
    }

    const probe = toSortKey(range.value, undefined)
    if (!probe) return new Set()
    // Kind-partitioned per component: an open-ended bound stays inside the
    // probe's own kind run, so `< '5'` never sweeps up numeric entries.
    const [kindStart, kindEnd] = this.kindRun(from, to, k, probe.kind)
    const lo = this.lowerBound([...prefix, probe], k + 1, from, to)
    const hi = this.upperBound([...prefix, probe], k + 1, from, to)
    switch (range.op) {
      case '<':
        return this.slice(kindStart, lo)
      case '<=':
        return this.slice(kindStart, hi)
      case '>':
        return this.slice(hi, kindEnd)
      case '>=':
        return this.slice(lo, kindEnd)
      default: {
        const _exhaustive: never = range.op
        void _exhaustive
        return new Set()
      }
    }
  }

  /**
   * Ids matching an equality prefix, in the order of the remaining
   * components. Ties keep INSERTION order in both directions — a plain
   * `.reverse()` would disagree with `sortRecords()` on equal keys.
   */
  orderedIds(prefix: readonly SortKey[], direction: 'asc' | 'desc'): string[] {
    const [from, to] = this.run(prefix, prefix.length)
    const out: string[] = []
    if (direction === 'asc') {
      for (let i = from; i < to; i++) out.push(this.entries[i]!.id)
      return out
    }
    let end = to
    while (end > from) {
      let start = end - 1
      while (start > from && this.compare(this.entries[start - 1]!, this.entries[end - 1]!.keys, this.fields.length) === 0) {
        start--
      }
      for (let i = start; i < end; i++) out.push(this.entries[i]!.id)
      end = start
    }
    return out
  }

  private slice(from: number, to: number): Set<string> {
    const out = new Set<string>()
    for (let i = from; i < to; i++) out.add(this.entries[i]!.id)
    return out
  }

  /** [start, end) of the entries whose first `upto` components equal `probe`. */
  private run(probe: readonly SortKey[], upto: number): [number, number] {
    return [
      this.lowerBound(probe, upto, 0, this.entries.length),
      this.upperBound(probe, upto, 0, this.entries.length),
    ]
  }

  /** [start, end) of the entries in [from,to) whose component `k` has this kind. */
  private kindRun(from: number, to: number, k: number, kind: number): [number, number] {
    return [
      this.kindBoundary(from, to, k, x => x < kind),
      this.kindBoundary(from, to, k, x => x <= kind),
    ]
  }

  private kindBoundary(from: number, to: number, k: number, before: (kind: number) => boolean): number {
    let lo = from
    let hi = to
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (before(this.entries[mid]!.keys[k]!.kind)) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** First index in [from,to) whose first `upto` components are >= `probe`. */
  private lowerBound(probe: readonly SortKey[], upto: number, from: number, to: number): number {
    let lo = from
    let hi = to
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.compare(this.entries[mid]!, probe, upto) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** First index in [from,to) whose first `upto` components are > `probe`. */
  private upperBound(probe: readonly SortKey[], upto: number, from: number, to: number): number {
    let lo = from
    let hi = to
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.compare(this.entries[mid]!, probe, upto) <= 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /**
   * Insertion point that keeps ties in `seq` order. A fresh entry lands at
   * the end of its tie run; a REINSTATED one (see {@link add}) lands back at
   * its own rank inside it.
   */
  private insertionPoint(entry: CompoundEntry): number {
    const to = this.upperBound(entry.keys, this.fields.length, 0, this.entries.length)
    let i = to
    while (i > 0 && this.compare(this.entries[i - 1]!, entry.keys, this.fields.length) === 0
      && this.entries[i - 1]!.seq > entry.seq) {
      i--
    }
    return i
  }

  private compare(entry: CompoundEntry, probe: readonly SortKey[], upto: number): number {
    for (let i = 0; i < upto; i++) {
      const c = compareKeys(entry.keys[i]!, probe[i]!)
      if (c !== 0) return c
    }
    return 0
  }
}

/**
 * The tuple key for one record, or `undefined` when any component is
 * nullish or has no order-defined runtime type. Canonicalizes through the
 * same per-field closure the hash and sorted indexes use, so a Via-covered
 * component lives in one key space across all three.
 */
export function tupleKeyOf<T>(
  fields: readonly string[],
  record: T,
  canonicalize?: (field: string, value: unknown) => string | undefined,
): SortKey[] | undefined {
  const keys: SortKey[] = []
  for (const field of fields) {
    const value = readPath(record, field)
    if (value === null || value === undefined) return undefined
    const key = toSortKey(value, canonicalize?.(field, value))
    if (!key) return undefined
    keys.push(key)
  }
  return keys
}

/** Probe keys for an equality prefix, or `undefined` if any operand is unorderable. */
export function probeKeysOf(values: readonly unknown[]): SortKey[] | undefined {
  const keys: SortKey[] = []
  for (const value of values) {
    const key = toSortKey(value, undefined)
    if (!key) return undefined
    keys.push(key)
  }
  return keys
}

/** Build the whole index from a snapshot. Entry seqs follow snapshot order. */
export function buildCompoundIndex<T>(
  idx: CompoundIndex,
  records: ReadonlyArray<{ id: string; record: T }>,
  canonicalize?: (field: string, value: unknown) => string | undefined,
): void {
  idx.clear()
  for (const { id, record } of records) {
    idx.add(id, tupleKeyOf(idx.fields, record, canonicalize))
  }
}

/** Stable map key for a field tuple. `\0` cannot appear in a field path. */
export function compoundKey(fields: readonly string[]): string {
  return fields.join('\u0000')
}
