/**
 * #1458 — the **Reduce** half of `ScanBuilder`.
 *
 * `aggregate` · `groupBy` · the grouped-scan handle they return.
 *
 * See `../relate/scan-methods.ts` for why `ScanBuilder` is split at all.
 *
 * ⭐ **The streaming memory property travels with the code.**
 * `scan().aggregate()` is O(reducers), not O(records) — it steps every reducer
 * per record and never collects the stream — and `groupBy().aggregate()` is
 * O(groups). That is a code-level invariant visible in the bodies below, so
 * moving them wholesale is what preserves it; re-expressing them over the
 * eager reducers would have quietly turned an unbounded scan into an array.
 */
import type { MultiReduceResult, ScanPageProvider } from '../scan-builder.js'
import type { QueryField } from '../../types.js'
import type { Clause } from '../predicate.js'
import { readPath } from '../predicate.js'
import type { ViaPipeline } from '../../via/pipeline.js'
import type { JoinContext, JoinLeg } from '../relate/join.js'
import type { ReducerBuilder } from '../../../with-lookup/reduce/reducers.js'
import { bindDistinctReducers, reducerBuilder } from '../../../with-lookup/reduce/reducers.js'
import type { ReduceSpec, ReduceResult } from '../../../with-lookup/reduce/reduction.js'
import type { DateTruncKey } from './date-trunc.js'
import { groupKeyName, isDateTruncKey, projectDateTruncKeys } from './date-trunc.js'
import { GroupCardinalityError } from '../../errors.js'

/** @internal — the mixin whose prototype `./index.ts` copies onto `ScanBuilder`. */
export class ScanReduceMethods<T, S extends keyof T = never, M extends keyof T & string = never> {
  declare protected readonly pageProvider: ScanPageProvider<T>
  declare protected readonly pageSize: number
  declare protected readonly clauses: readonly Clause[]
  declare protected readonly joins: readonly JoinLeg[]
  declare protected readonly joinContext: JoinContext | undefined
  declare protected readonly via: ViaPipeline | undefined
  declare protected decodeVia: (record: T) => T
  declare protected recordMatches: (record: T, clauses?: readonly Clause[]) => boolean
  declare [Symbol.asyncIterator]: () => AsyncIterator<T>

  async aggregate<const Specs extends readonly ReduceSpec[]>(specs: Specs): Promise<MultiReduceResult<Specs>>
  async aggregate<Spec extends ReduceSpec>(spec: Spec): Promise<ReduceResult<Spec>>
  async aggregate<Spec extends ReduceSpec>(build: (b: ReducerBuilder<T, S, M>) => Spec): Promise<ReduceResult<Spec>>
  async aggregate<Spec extends ReduceSpec>(
    specOrBuild: Spec | readonly ReduceSpec[] | ((b: ReducerBuilder<T, S, M>) => Spec),
  ): Promise<ReduceResult<Spec> | unknown[]> {
    // #1340 — the multi-spec form. N independent specs, ONE pass: the states
    // for every spec are stepped from the same yielded record, so the page
    // provider is walked exactly once no matter how many specs are passed.
    // (Calling `.aggregate(specA)` then `.aggregate(specB)` costs two full
    // scans — the immutable-builder docs above say so, and this is the fix.)
    if (Array.isArray(specOrBuild)) return this.aggregateMany(specOrBuild as readonly ReduceSpec[])
    // Opt-in builder form `aggregate(b => spec)`: `b`'s field args are
    // `QueryField<T, S>`, refusing sensitive fields (the standalone-spec form
    // stays unrefused for back-compat), and `sum`/`min`/`max` over a declared
    // `moneyFields` (`M`) member return a `MoneyString`. Mirrors `Query.aggregate`.
    const spec: Spec = typeof specOrBuild === 'function'
      ? (specOrBuild as (b: ReducerBuilder<T, S, M>) => Spec)(reducerBuilder as unknown as ReducerBuilder<T, S, M>)
      // `Array.isArray` above does not narrow a READONLY array out of the
      // union, so the array arm is already returned and this cast is the
      // remainder — a plain spec.
      : (specOrBuild as Spec)
    this.via?.refuseUnqueryableReducers(spec)
    const keys = Object.keys(spec)
    // Per-reducer state. Exactly |keys| entries, never grows with
    // the record count — that's the O(reducers) memory guarantee.
    const state: Record<string, unknown> = {}
    for (const key of keys) {
      state[key] = spec[key]!.init()
    }

    // Record-by-record streaming step. `for await (… of this)`
    // invokes the Symbol.asyncIterator above, which honors the
    // clause list, so filtered-out records never reach the step
    // loop — they're dropped at the iterator boundary.
    for await (const record of this) {
      for (const key of keys) {
        state[key] = spec[key]!.step(state[key], record)
      }
    }

    const result: Record<string, unknown> = {}
    for (const key of keys) {
      result[key] = spec[key]!.finalize(state[key])
    }
    return result as ReduceResult<Spec>
  }

  /**
   * The multi-spec `.aggregate([specA, specB, …])` executor (#1340).
   *
   * One iteration of the scan, `Σ|spec|` reducer states — memory stays
   * O(reducers) exactly as the single-spec terminal's does, with the sum taken
   * across specs instead of within one. Every spec's state is stepped from the
   * SAME yielded record, so the page provider is read once per page.
   *
   * Semantics per spec are identical to the single-spec form, deliberately:
   * the posture gate is `refuseUnqueryableReducers` (metadata only), NOT the
   * full `wrapReducers` — so `aggregate([a, b])` returns exactly what
   * `aggregate(a)` and `aggregate(b)` return, and the array form is a pure
   * cost optimisation with no behavioural delta to reason about. (The grouped
   * scan path DOES wrap — it has to agree with the eager grouped path, which
   * wraps. See `scan-groupby.ts`.)
   */
  private async aggregateMany(specs: readonly ReduceSpec[]): Promise<unknown[]> {
    for (const spec of specs) this.via?.refuseUnqueryableReducers(spec)
    const keysPerSpec = specs.map((spec) => Object.keys(spec))
    const states: Record<string, unknown>[] = specs.map((spec, i) => {
      const state: Record<string, unknown> = {}
      for (const key of keysPerSpec[i]!) state[key] = spec[key]!.init()
      return state
    })

    for await (const record of this) {
      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i]!
        const state = states[i]!
        for (const key of keysPerSpec[i]!) state[key] = spec[key]!.step(state[key], record)
      }
    }

    return specs.map((spec, i) => {
      const result: Record<string, unknown> = {}
      for (const key of keysPerSpec[i]!) result[key] = spec[key]!.finalize(states[i]![key])
      return result
    })
  }

  /**
   * Group the scan stream and reduce each group — `#1340`.
   *
   * ```ts
   * const byClient = await invoices.scan()
   *   .where('status', '==', 'open')
   *   .groupBy('clientId', { maxGroups: 5_000 })
   *   .aggregate({ total: sum('amount'), n: count() })
   * ```
   *
   * ⚠️ **This is the one scan terminal whose memory is NOT O(pageSize).** It
   * holds one reducer state per group, which is why the budget is explicit:
   * `maxGroups` defaults to the eager path's 100_000-group ceiling and is
   * REFUSED — never truncated — the moment a scan would exceed it. Price the
   * budget before raising it: an exact `median`/`percentile`, a `mode` or a
   * `countDistinct` holds O(values) per group, so an unbounded scan wants
   * `{ approx: true }` on the quantiles. Full rationale in `scan-groupby.ts`.
   *
   * The key may be a field name or a `dateTrunc()` derived calendar key (the
   * monthly-rollup shape); grouping BY a `sensitive` field is refused at
   * compile time, same as `Query.groupBy()`.
   */
  groupBy<F extends QueryField<T, S>>(field: F, opts?: { maxGroups?: number }): ScanGroupedScan<T, F, S, M>
  groupBy(key: DateTruncKey, opts?: { maxGroups?: number }): ScanGroupedScan<T, string, S, M>
  groupBy(key: QueryField<T, S> | DateTruncKey, opts?: { maxGroups?: number }): ScanGroupedScan<T, string, S, M> {
    return new ScanGroupedScan<T, string, S, M>(
      this,
      key as string | DateTruncKey,
      opts?.maxGroups ?? SCAN_GROUPBY_DEFAULT_MAX_GROUPS,
      this.via,
    )
  }
}

/** The public Reduce surface of `ScanBuilder` — merged by `./index.ts`. */
export type ScanReduceSurface<
  T,
  S extends keyof T = never,
  M extends keyof T & string = never,
> = Pick<ScanReduceMethods<T, S, M>, 'aggregate' | 'groupBy'>

/**
 * Default group ceiling — the same constant the eager `.groupBy()` enforces.
 * Duplicated as a literal rather than imported from
 * `with-lookup/reduce/groupby.ts` on purpose: that module carries the eager
 * `groupAndReduce` + `GroupedReduction` classes, and the always-on kernel must
 * not pull them in to read one number. The pairing is asserted by a test.
 */
export const SCAN_GROUPBY_DEFAULT_MAX_GROUPS = 100_000

/**
 * Single-field spelling of `canonicalGroupKey` (`with-lookup/reduce/canonical-key.ts`).
 *
 * ⛔ Inlined, not imported, and not by preference: `check-architecture`'s
 * `port-layering` rule grandfathers this file for exactly two
 * `with-lookup/reduce/*` specifiers (`reducers.js`, `reduction.js`), and
 * `canonical-key.js` is not one of them — a new one may not be added
 * silently. The eager helper sorts its field list and serialises
 * each value — with exactly one field, that reduces to this line, including
 * the part that matters: `undefined` gets a sentinel so a MISSING key and an
 * explicit `null` land in different buckets, as they do under
 * `Query.groupBy()`. The agreement is held by test, not by comment
 * (`query-scan-groupby.test.ts` — null/undefined bucketing, and full equality
 * with the eager path).
 */
function scanGroupKey(field: string, value: unknown): string {
  return `${field}=${value === undefined ? 'undefined' : JSON.stringify(value)}`
}

/** Group-key result-row shape: the key under its own name, plus the reducers. */

export type ScanGroupedRow<F extends string, R> = { [K in F]: unknown } & R

/**
 * Chainable wrapper returned by `ScanBuilder.groupBy()`. The only operation on
 * it is `.aggregate()` — same minimal shape as `GroupedQuery`.
 */
export class ScanGroupedScan<
  T,
  F extends string,
  S extends keyof T = never,
  M extends keyof T & string = never,
> {
  constructor(
    private readonly stream: AsyncIterable<T>,
    private readonly key: string | DateTruncKey,
    private readonly maxGroups: number,
    private readonly via: ViaPipeline | undefined,
  ) {
    if (!Number.isInteger(maxGroups) || maxGroups < 1) {
      throw new Error(
        `scan().groupBy(): { maxGroups: ${String(maxGroups)} } must be a positive integer — ` +
          `it is the declared ceiling on how many reducer states the grouped scan may hold.`,
      )
    }
  }

  /**
   * Fold the scan into one row per group. Resolves to `R[]`, ordered by each
   * group's FIRST-SEEN position in the stream (`Map` insertion order), which
   * is the same ordering rule the eager path documents.
   *
   * ```ts
   * const byMonth = await invoices.scan()
   *   .where('status', '==', 'paid')
   *   .groupBy(dateTrunc('closedAt', 'month', { as: 'month', timeZone: 'UTC' }), { maxGroups: 240 })
   *   .aggregate({ total: sum('amount'), n: count() })
   * ```
   */
  async aggregate<Spec extends ReduceSpec>(spec: Spec): Promise<ScanGroupedRow<F, ReduceResult<Spec>>[]>
  async aggregate<Spec extends ReduceSpec>(
    build: (b: ReducerBuilder<T, S, M>) => Spec,
  ): Promise<ScanGroupedRow<F, ReduceResult<Spec>>[]>
  async aggregate<Spec extends ReduceSpec>(
    specOrBuild: Spec | ((b: ReducerBuilder<T, S, M>) => Spec),
  ): Promise<ScanGroupedRow<F, ReduceResult<Spec>>[]> {
    const raw: Spec =
      typeof specOrBuild === 'function'
        ? (specOrBuild as (b: ReducerBuilder<T, S, M>) => Spec)(reducerBuilder as unknown as ReducerBuilder<T, S, M>)
        : specOrBuild
    // Same reducer rewriting as the eager grouped path, and for the same
    // reason: a money `sum` must accumulate per-currency BigInt totals, and a
    // `countDistinct` must dedup on the canonical index key — otherwise a
    // grouped scan and a grouped query disagree on identical data.
    // `wrapReducers` runs the `queryable: 'none'` posture refusal itself.
    const spec: ReduceSpec = bindDistinctReducers(this.via ? this.via.wrapReducers(raw) : raw, this.via)
    const keys = Object.keys(spec)

    const field = groupKeyName(this.key)
    const derived: readonly DateTruncKey[] = isDateTruncKey(this.key) ? [this.key] : []
    const groups = new Map<string, { keyValue: unknown; state: Record<string, unknown> }>()

    for await (const record of this.stream) {
      // A derived calendar key is stamped onto a shallow copy before bucketing
      // — the reducers then see an ordinary row carrying an ordinary field,
      // exactly as they do under `Query.groupBy(dateTrunc(...))`.
      const row = derived.length === 0 ? record : projectDateTruncKeys([record], derived)[0]!
      const keyValue = readPath(row, field)
      const dedupKey = scanGroupKey(field, keyValue)
      let group = groups.get(dedupKey)
      if (group === undefined) {
        if (groups.size >= this.maxGroups) {
          // Loud and early: the state for this group is never allocated, so
          // the refusal fires at the budget, not after blowing through it.
          throw new GroupCardinalityError(field, groups.size + 1, this.maxGroups, 'scan')
        }
        const state: Record<string, unknown> = {}
        for (const k of keys) state[k] = spec[k]!.init()
        group = { keyValue, state }
        groups.set(dedupKey, group)
      }
      for (const k of keys) group.state[k] = spec[k]!.step(group.state[k], row)
    }

    const out: ScanGroupedRow<F, ReduceResult<Spec>>[] = []
    for (const group of groups.values()) {
      // Group key first, then the reducer outputs — same row shape as the
      // eager path, which tests assert by key order.
      const outRow: Record<string, unknown> = { [field]: group.keyValue }
      for (const k of keys) outRow[k] = spec[k]!.finalize(group.state[k])
      out.push(outRow as ScanGroupedRow<F, ReduceResult<Spec>>)
    }
    return out
  }
}
