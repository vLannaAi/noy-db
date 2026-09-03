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
 *    the same rows the stable scan-and-sort would. An in-place UPDATE
 *    reinstates the rank it held rather than appending (#1369): the record
 *    cache does not move a re-`put` record, so neither may the index.
 *
 * Keys canonicalise through the SAME per-field closure the hash index
 * uses (`ViaPipeline.canonicalizeIndexKey`), so a Via-covered field's
 * entries live in one key space here too. Range DISPATCH for a
 * Via-covered clause is nevertheless declined by the query builder (a
 * money operand has no ordered stored-form probe) — see
 * `kernel/query/builder.ts`'s `candidateRecords`.
 *
 * PERSISTENCE (#1359) is OPT-IN, via `{ persist: true }` on the declaration.
 * {@link SortedIndex.toSnapshot} / {@link SortedIndex.loadSnapshot} are the
 * whole of this class's part in it — the encrypted sidecar, the freshness
 * stamp and the debounce live in `persisted-field-indexes.ts`. Without the
 * opt-in the index is in memory only and rebuilt on hydrate, as before.
 */

import { readPath } from '../../kernel/query/predicate.js'
import { KIND_STRING, compareKeys, toSortKey, type KeyKind, type SortKey } from '../../kernel/query/sort-key.js'
import {
  FIELD_INDEX_SNAPSHOT_VERSION,
  type FieldIndexSnapshot,
  type SortedIndexSnapshot,
  type WireSortedEntry,
} from './index-snapshot.js'

/** Range operators a sorted index can answer. */
export type RangeOperator = '<' | '<=' | '>' | '>=' | 'between' | 'startsWith'

// The ordered-key encoding itself moved to `kernel/query/sort-key.ts` (#1339):
// #1339's declared joins key on it too, and the kernel spine may not
// statically import a `with-*` service (`check-architecture.mjs`'s
// port-layering ratchet). Re-exported here so every existing importer of this
// module is unchanged, and so there is still exactly ONE definition of what
// makes two stored values comparable.
export { KIND_STRING, compareKeys, toSortKey, type KeyKind, type SortKey } from '../../kernel/query/sort-key.js'

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

  /**
   * Insert one record. No-op when the value has no order-defined kind.
   *
   * `seq` REINSTATES a rank a previous entry for this id held — see
   * {@link remove}'s return value and `CollectionIndexes.upsert`. Omit it
   * for a fresh insert, which appends after every existing tie.
   */
  add(id: string, value: unknown, canonicalKey: string | undefined, seq?: number): void {
    const sk = toSortKey(value, canonicalKey)
    if (!sk) return
    const entry: Entry = { ...sk, seq: seq ?? this.nextSeq++, id }
    this.entries.splice(this.insertionPoint(entry), 0, entry)
  }

  /**
   * Remove one record, addressed by the value it was indexed under.
   * Returns the rank it held, so an UPDATE can reinstate it (#1369):
   * `sortRecords()` sorts a snapshot whose order does not change when a
   * record is written in place, so a tie-breaking rank that drifted to the
   * back on every `put` would make an index-served page disagree with the
   * scan it must match. Same contract as `CompoundIndex.remove`.
   */
  remove(id: string, value: unknown, canonicalKey: string | undefined): number | undefined {
    const sk = toSortKey(value, canonicalKey)
    if (!sk) return undefined
    // Every entry sharing this key is contiguous; walk that run for the id.
    for (let i = this.lowerBound(sk); i < this.entries.length; i++) {
      const e = this.entries[i]!
      if (compareKeys(e, sk) !== 0) break
      if (e.id === id) {
        this.entries.splice(i, 1)
        return e.seq
      }
    }
    return undefined
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

  /**
   * The persistable form of this index (#1359). `kind` travels with every
   * key: entries rank by runtime kind first, so an encoding that dropped it
   * would let a `string` probe reach `number` entries on the way back in.
   */
  toSnapshot(): SortedIndexSnapshot {
    return {
      v: FIELD_INDEX_SNAPSHOT_VERSION,
      t: 'sorted',
      field: this.field,
      nextSeq: this.nextSeq,
      entries: this.entries.map(e => [e.kind, e.key, e.seq, e.id] as WireSortedEntry),
    }
  }

  /**
   * Adopt a validated snapshot, or refuse it. Refusal (`false`) means the
   * caller rebuilds — it NEVER means a partial index: the entries are staged
   * and only swapped in once every one of them is accepted.
   *
   * `isLive` is the caller's liveness predicate over the record cache. An
   * entry naming a record the cache does not hold means the blob and the
   * collection have diverged (a crash between the two writes, say), so the
   * whole blob is discarded. Crash residue must be a rebuild, never a wrong
   * answer.
   */
  loadSnapshot(snap: FieldIndexSnapshot, isLive: (id: string) => boolean): boolean {
    if (snap.t !== 'sorted' || snap.field !== this.field) return false
    const staged: Entry[] = []
    for (const [kind, key, seq, id] of snap.entries) {
      if (!isLive(id)) return false
      staged.push({ kind: kind as KeyKind, key, seq, id })
    }
    this.entries.length = 0
    for (const e of staged) this.entries.push(e)
    this.nextSeq = snap.nextSeq
    return true
  }

  /**
   * Insertion point that keeps ties in `seq` order. A fresh entry lands at
   * the end of its tie run; a REINSTATED one (see {@link add}) lands back at
   * its own rank inside it.
   */
  private insertionPoint(entry: Entry): number {
    let i = this.upperBound(entry)
    while (i > 0 && compareKeys(this.entries[i - 1]!, entry) === 0 && this.entries[i - 1]!.seq > entry.seq) {
      i--
    }
    return i
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

