/**
 * The ORDERED KEY — one encoding of "what does it mean for two stored values
 * to be comparable, and in what order".
 *
 * ⭐ This lives in the kernel, not in `with-lookup/indexing/`, because it is
 * the machine-readable half of a KERNEL rule: `predicate.ts`'s `isComparable`
 * refuses to order two values of different runtime types, and every structure
 * that claims to answer a range or an equality faster than the linear scan
 * must reproduce that refusal exactly or it will serve rows the scan would
 * not. #1344's `SortedIndex`, #1345's `CompoundIndex` and #1339's declared
 * joins all key on this, so there is ONE definition to disagree with rather
 * than three.
 *
 * `with-lookup/indexing/sorted-indexes.ts` re-exports the whole of this
 * module, so its existing importers are unchanged; the direction of the
 * dependency is the point — an opt-in service may reach into the kernel
 * spine, and `check-architecture.mjs`'s `port-layering` ratchet is what stops
 * the reverse.
 *
 * Two properties are load-bearing and belong to the scan, not to any index:
 *
 *  - **Kind-partitioned.** The numeric `kind` IS the sort rank, so a `string`
 *    probe can never reach `number` entries.
 *  - **No order-defined type, no key.** Booleans, objects, arrays, `NaN` and
 *    nullish values produce `undefined` and are absent from every structure
 *    built on this — which is why a caller that removed clauses from a plan
 *    must compare an index's size against the snapshot size before trusting
 *    it to cover the collection.
 */

/**
 * Order-defined key kinds. The numeric value IS the sort rank, so entries
 * of different kinds never interleave and a probe only ever compares
 * against its own kind.
 */
export type KeyKind = 0 | 1 | 2
export const KIND_NUMBER: KeyKind = 0
export const KIND_STRING: KeyKind = 1
export const KIND_DATE: KeyKind = 2

export interface SortKey {
  readonly kind: KeyKind
  /** `number` for {@link KIND_NUMBER} and {@link KIND_DATE}, `string` otherwise. */
  readonly key: number | string
}

/** Total order over {@link SortKey}: by kind first, then within the kind. */
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
