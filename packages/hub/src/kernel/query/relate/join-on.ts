/**
 * Declared non-equi and composite joins — `.joinOn(target, { on })` (#1339).
 *
 * `join.ts` resolves a `ref()`-declared FK against the target's `id`. That is
 * one shape of join. This module is the other two the query DSL could not
 * express at all:
 *
 *   - **composite equality** — `on: [['clientId','clientId'], ['year','year']]`
 *   - **range / theta**      — `on: { left: 'date', op: 'between', right: ['from','to'] }`
 *
 * ⭐ THE DECLARED FORM IS THE WHOLE POINT, and it is the only reason this is
 * not `crossJoin({ on: fn })` with extra steps. `crossJoin`'s `on` is a
 * closure: it pairs arbitrary rows perfectly and serializes to the sentinel
 * `'[inline]'`, which is why a materialized view over one has its drift
 * detection disabled. A `JoinOnPlan` is plain JSON, so `serializePlan()`
 * emits it verbatim, `summarizeQueryPlan()` folds it into the MV
 * `queryHash`, and two plans differing only in their `on` are two different
 * queries — pinned by `__tests__/query-join-on.test.ts`.
 *
 * ⛔ THE NORMAL FORM IS PART OF THE HASH. `normalizeJoinOn` is the ONLY place
 * a `JoinOnSpec` becomes a `JoinOnPlan`, and it sorts composite pairs so two
 * logically identical joins hash identically (an AND of equalities is
 * commutative). Changing the normal form moves every stored `queryHash` for a
 * `joinOn` MV. Adding a new `on` KIND does not, because the leg is omitted
 * entirely when absent — the same discipline `direction` (#1289) and `inner`
 * (#1361) follow.
 *
 * **Key encoding.** Both strategies key on {@link SortKey} — the per-component
 * ordered key #1345's `CompoundIndex` already uses — rather than a second,
 * hand-rolled encoding. That buys the kind-ranking invariant for free: the
 * string `'2026'` and the number `2026` live in different kinds and never
 * match, exactly as `predicate.ts`'s `isComparable` refuses to compare them.
 * A component whose value has no order-defined type (nullish, boolean,
 * object, array) makes the whole record unkeyable and it drops out of the
 * probe — same rule as `CompoundIndex`, where a record is indexed only when
 * EVERY component has an ordered value.
 *
 * **Cost, stated honestly:**
 *
 * | strategy | build | per left row | total |
 * |---|---|---|---|
 * | `join:composite-hash` | O(m) one pass | O(1) + matches | **O(n + m + output)** |
 * | `join:sorted-range` (`< <= > >=`) | O(m log m) one sort | O(log m) + matches | **O(m log m + n log m + output)** |
 * | `join:sorted-range` (`between`) | O(m log m) | O(log m + p), p = rights whose `from` ≤ probe | **O(m log m + n·p)** — degrades to O(n·m) when every interval starts early |
 *
 * ⚠️ Neither is index-aware in the `lookupRange`/`lookupCompound` sense: a
 * `JoinableSource` exposes `snapshot()` and `lookupById()` and nothing else,
 * so the right collection's declared indexes are not reachable from here.
 * The sort/hash is built per execution over the right SNAPSHOT. Reaching a
 * real index would mean widening the published `JoinableSource` seam and
 * taking a kernel→`with-lookup` runtime edge for a service that is opt-in;
 * that is a separate decision, not a detail of this one.
 *
 * ⚠️ **A theta join EXPANDS rows**, which the ref join never does — so the
 * per-side `maxRows` ceilings are not sufficient on their own. The OUTPUT is
 * checked against the same ceiling as it is produced, and the join throws
 * `JoinTooLargeError` with `side: 'output'` rather than allocating an
 * unbounded cartesian product. That check is the difference between an error
 * and a hang.
 */

import { readPath } from '../predicate.js'
import { compareKeys, toSortKey, type SortKey } from '../sort-key.js'

/** Comparison operators a declared range join understands. */
export type JoinOnOp = '<' | '<=' | '>' | '>=' | 'between'

/**
 * The consumer-facing `on`, in either of the two shapes #1339 proposed.
 *
 *   - `[['clientId','clientId'], ['year','year']]` — composite equality; every
 *     pair must match. Each pair is `[leftField, rightField]`.
 *   - `{ left, op, right }` — a comparison of ONE left field against one right
 *     field (`< <= > >=`), or against a right INTERVAL for `between`, where
 *     `right` names the two boundary fields `[fromField, toField]` and the
 *     bounds are inclusive.
 */
export type JoinOnSpec =
  | readonly (readonly [string, string])[]
  | {
      readonly left: string
      readonly op: Exclude<JoinOnOp, 'between'>
      readonly right: string
    }
  | {
      readonly left: string
      readonly op: 'between'
      readonly right: readonly [string, string]
    }

/**
 * The normalised, serialisable form stored on the {@link JoinLeg}. This is
 * what lands in `toPlan()` and in the MV `queryHash` — see the module header
 * before changing its shape.
 */
export type JoinOnPlan =
  | {
      readonly kind: 'composite'
      /** `[leftField, rightField]` pairs, sorted by left then right field. */
      readonly pairs: readonly (readonly [string, string])[]
    }
  | {
      readonly kind: 'range'
      readonly left: string
      readonly op: JoinOnOp
      /** One right field, or the two inclusive boundary fields for `between`. */
      readonly right: readonly string[]
    }

const RANGE_OPS: ReadonlySet<string> = new Set(['<', '<=', '>', '>=', 'between'])

function isField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Validate and normalise a consumer `on` into its plan form.
 *
 * Every refusal is at PLAN time, with the offending shape named: an `on` that
 * cannot be serialised deterministically must never reach a `queryHash`,
 * because a hash over an invalid plan is a hash nothing can reproduce.
 */
export function normalizeJoinOn(on: JoinOnSpec, target: string): JoinOnPlan {
  if (Array.isArray(on)) {
    const pairs = on as readonly unknown[]
    if (pairs.length === 0) {
      throw new Error(
        `.joinOn("${target}"): a composite \`on\` needs at least one [leftField, rightField] pair. ` +
          `Pass e.g. on: [['clientId', 'clientId'], ['year', 'year']].`,
      )
    }
    const normalized: [string, string][] = []
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2 || !isField(pair[0]) || !isField(pair[1])) {
        throw new Error(
          `.joinOn("${target}"): every composite \`on\` entry must be a [leftField, rightField] pair of ` +
            `non-empty field names. Received: ${JSON.stringify(pair)}.`,
        )
      }
      normalized.push([pair[0], pair[1]])
    }
    // Sorted so a caller reordering the pairs does not change the queryHash —
    // an AND of equalities is commutative, so two such plans ARE the same
    // query and a reorder must not force every MV row to rebuild.
    normalized.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
    return { kind: 'composite', pairs: normalized }
  }

  const spec = on as { left?: unknown; op?: unknown; right?: unknown }
  if (!isField(spec.left)) {
    throw new Error(`.joinOn("${target}"): a range \`on\` needs a non-empty \`left\` field name.`)
  }
  if (typeof spec.op !== 'string' || !RANGE_OPS.has(spec.op)) {
    throw new Error(
      `.joinOn("${target}"): unknown \`on\` operator ${JSON.stringify(spec.op)}. ` +
        `Supported operators are ${[...RANGE_OPS].join(', ')}.`,
    )
  }
  if (spec.op === 'between') {
    if (!Array.isArray(spec.right) || spec.right.length !== 2 || !isField(spec.right[0]) || !isField(spec.right[1])) {
      throw new Error(
        `.joinOn("${target}"): \`between\` needs exactly two right-side boundary field names — ` +
          `on: { left: 'date', op: 'between', right: ['from', 'to'] }.`,
      )
    }
    return { kind: 'range', left: spec.left, op: 'between', right: [spec.right[0], spec.right[1]] }
  }
  if (!isField(spec.right)) {
    throw new Error(`.joinOn("${target}"): the \`${spec.op}\` operator needs a single right-side field name.`)
  }
  return { kind: 'range', left: spec.left, op: spec.op as JoinOnOp, right: [spec.right] }
}

/** A short, stable rendering of the predicate for `explain()`'s detail line. */
export function describeJoinOn(on: JoinOnPlan): string {
  if (on.kind === 'composite') return on.pairs.map(([l, r]) => `${l} = ${r}`).join(' AND ')
  if (on.op === 'between') return `${on.left} between [${on.right.join(', ')}]`
  return `${on.left} ${on.op} ${on.right[0]}`
}

/** `explain()`'s dispatch label for a declared-`on` leg. */
export function joinOnDispatch(on: JoinOnPlan): 'join:composite-hash' | 'join:sorted-range' {
  return on.kind === 'composite' ? 'join:composite-hash' : 'join:sorted-range'
}

/**
 * Length-prefixed tuple key. `${kind}:${len}:${value}` per component means a
 * string component may contain any byte — including the separator — without
 * colliding with a neighbouring component, which a plain `join(' ')`
 * cannot promise. `undefined` when ANY component has no ordered key, matching
 * `CompoundIndex`: a record with one unkeyable component is not in the index.
 */
function tupleKey(values: readonly unknown[]): string | undefined {
  let out = ''
  for (const value of values) {
    const sk = toSortKey(value, undefined)
    if (!sk) return undefined
    const text = String(sk.key)
    out += `${sk.kind}:${text.length}:${text}|`
  }
  return out
}

/** One row the declared join produced: the left row and its matched right record. */
export interface JoinOnMatch {
  readonly left: unknown
  /** `undefined` when this left row matched nothing — the left-outer row. */
  readonly right: unknown
}

/**
 * Run a declared `on` against the right snapshot, emitting one
 * {@link JoinOnMatch} per matched pair plus one `right: undefined` match per
 * left row that matched nothing (the caller applies ref-mode / inner-drop
 * semantics, exactly as it does for the ref join).
 *
 * `onOverflow` is called the moment the produced row count would exceed the
 * ceiling; it is expected to throw. Passing the check as a callback keeps the
 * error's wording — which names the leg and the ceiling — with the leg.
 */
export function matchDeclaredJoin(
  leftRows: readonly unknown[],
  on: JoinOnPlan,
  rightSnapshot: readonly unknown[],
  maxRows: number,
  onOverflow: (produced: number) => never,
): JoinOnMatch[] {
  const out: JoinOnMatch[] = []
  const push = (left: unknown, right: unknown): void => {
    if (out.length >= maxRows) onOverflow(out.length + 1)
    out.push({ left, right })
  }
  if (on.kind === 'composite') {
    compositeHashJoin(leftRows, on, rightSnapshot, push)
  } else {
    sortedRangeJoin(leftRows, on, rightSnapshot, push)
  }
  return out
}

/** Hash join over a tuple key — O(n + m + output). */
function compositeHashJoin(
  leftRows: readonly unknown[],
  on: Extract<JoinOnPlan, { kind: 'composite' }>,
  rightSnapshot: readonly unknown[],
  push: (left: unknown, right: unknown) => void,
): void {
  const leftFields = on.pairs.map(p => p[0])
  const rightFields = on.pairs.map(p => p[1])
  const buckets = new Map<string, unknown[]>()
  for (const record of rightSnapshot) {
    const key = tupleKey(rightFields.map(f => readPath(record, f)))
    if (key === undefined) continue
    const bucket = buckets.get(key)
    if (bucket) bucket.push(record)
    else buckets.set(key, [record])
  }
  for (const left of leftRows) {
    const key = tupleKey(leftFields.map(f => readPath(left, f)))
    const bucket = key === undefined ? undefined : buckets.get(key)
    if (!bucket || bucket.length === 0) {
      push(left, undefined)
      continue
    }
    for (const right of bucket) push(left, right)
  }
}

interface RangeEntry {
  readonly key: SortKey
  /** The upper boundary key, for `between` only. */
  readonly hi: SortKey | undefined
  readonly record: unknown
}

/**
 * Nested loop over a right side sorted ONCE by the probed field.
 *
 * Entries are ordered by `compareKeys`, which ranks by kind first, so the
 * slice a probe may reach is clamped to the probe's own kind band — a string
 * probe cannot walk into the number entries, mirroring the linear scan.
 */
function sortedRangeJoin(
  leftRows: readonly unknown[],
  on: Extract<JoinOnPlan, { kind: 'range' }>,
  rightSnapshot: readonly unknown[],
  push: (left: unknown, right: unknown) => void,
): void {
  const lowField = on.right[0]!
  const highField = on.op === 'between' ? on.right[1]! : undefined
  const entries: RangeEntry[] = []
  for (const record of rightSnapshot) {
    const key = toSortKey(readPath(record, lowField), undefined)
    if (!key) continue
    const hi = highField === undefined ? undefined : toSortKey(readPath(record, highField), undefined)
    if (highField !== undefined && !hi) continue
    entries.push({ key, hi, record })
  }
  entries.sort((a, b) => compareKeys(a.key, b.key))

  for (const left of leftRows) {
    const probe = toSortKey(readPath(left, on.left), undefined)
    if (!probe) {
      push(left, undefined)
      continue
    }
    // The contiguous run of entries sharing the probe's kind. Everything
    // outside it is incomparable, exactly as `isComparable` says.
    const [bandStart, bandEnd] = kindBand(entries, probe.kind)
    const lo = lowerBound(entries, probe, bandStart, bandEnd)
    const hi = upperBound(entries, probe, bandStart, bandEnd)

    let matched = false
    const emit = (from: number, to: number, keep?: (e: RangeEntry) => boolean): void => {
      for (let i = from; i < to; i++) {
        const entry = entries[i]!
        if (keep && !keep(entry)) continue
        matched = true
        push(left, entry.record)
      }
    }
    switch (on.op) {
      // `left.field < right.field` — the right keys strictly ABOVE the probe.
      case '<': emit(hi, bandEnd); break
      case '<=': emit(lo, bandEnd); break
      case '>': emit(bandStart, lo); break
      case '>=': emit(bandStart, hi); break
      // `right.from <= left.field <= right.to`. Sorted by `from`, so the
      // candidates are the prefix whose `from` is at or below the probe; the
      // `to` bound is then a filter over that prefix, which is what makes the
      // interval case O(p) per left row rather than O(log m).
      case 'between':
        emit(bandStart, hi, e => e.hi !== undefined && compareKeys(e.hi, probe) >= 0)
        break
    }
    if (!matched) push(left, undefined)
  }
}

/**
 * The half-open range of entries whose key has the given kind. Computed by
 * kind ALONE — a sentinel `SortKey` cannot express "smallest of this kind",
 * because `compareKeys` falls back to `<`/`>` on mixed key types and returns
 * 0 for a number sentinel against a string key, which would silently collapse
 * the band to nothing.
 */
function kindBand(entries: readonly RangeEntry[], kind: number): [number, number] {
  const bound = (strict: boolean): number => {
    let lo = 0
    let hi = entries.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const d = entries[mid]!.key.kind - kind
      if (strict ? d < 0 : d <= 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  return [bound(true), bound(false)]
}

function lowerBound(entries: readonly RangeEntry[], probe: SortKey, from = 0, to = entries.length): number {
  let lo = from
  let hi = to
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (compareKeys(entries[mid]!.key, probe) < 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

function upperBound(entries: readonly RangeEntry[], probe: SortKey, from = 0, to = entries.length): number {
  let lo = from
  let hi = to
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (compareKeys(entries[mid]!.key, probe) <= 0) lo = mid + 1
    else hi = mid
  }
  return lo
}
