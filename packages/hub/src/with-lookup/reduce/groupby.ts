/**
 * Query DSL `.groupBy()` —.
 *
 * Chains after `.where()` / `.filter()` / `.or()` / `.and()` on a
 * Query and before a reducer spec, so consumers can compute
 * per-bucket aggregates without folding in userland:
 *
 * ```ts
 * const byClient = invoices.query()
 *   .where('status', '==', 'open')
 *   .groupBy('clientId')
 *   .aggregate({ total: sum('amount'), n: count() })
 *   .run()
 * // → [ { clientId: 'c1', total: 5250, n: 3 }, … ]
 * ```
 *
 * Execution pipeline:
 *
 *   1. Run the query's where/filter clauses (same candidate /
 *      filter pipeline as `.aggregate()` directly on Query).
 *   2. Partition the matching records into buckets keyed by
 *      `readPath(record, field)`. JS `Map` preserves insertion
 *      order, so the first-seen key for a bucket determines its
 *      position in the result array — consumers who want a
 *      specific ordering should `.sort()` downstream.
 *   3. Enforce cardinality: warn once per field at 10% of the cap
 *      (10_000 buckets), throw `GroupCardinalityError` at 100% of
 *      the cap (100_000 buckets).
 *   4. For each bucket, build a per-group reducer state and
 *      step every record in the bucket through it.
 *   5. Emit one result row per bucket, shaped as
 *      `{ [field]: key, ...reduced }`.
 *
 * **Null / undefined keys:** `Map` distinguishes `null` from
 * `undefined`, so records with a missing group field get their own
 * bucket, and records with an explicit `null` value get a separate
 * bucket from that. Consumers who want them merged can coalesce
 * upstream with `.filter()`.
 *
 * **Live mode:** `.groupBy().aggregate().live()` maintains its buckets
 * incrementally (#1341, grouped half). A change event patches the match set
 * and then re-folds only the one or two buckets it touched; every other bucket
 * serves the row it already computed. See `incremental-group.ts` — including
 * why reducer states are re-folded rather than inverted through the protocol's
 * `remove()` hook. A plan `canMaintainIncrementally()` refuses, and any
 * notification arriving without a delta, still re-runs the whole pipeline.
 *
 * **Type-level stable-key narrowing:** when
 * `dictKey` lands, `groupBy<DictField>()` will narrow the group key
 * type to the stable dictionary key rather than the resolved locale
 * label. That prevents grouping by the locale-resolved label,
 * which would produce different buckets per reader. types the
 * key as `unknown` at the result shape; the dictKey narrowing
 * layers on top without an API break.
 *
 * Partition-awareness seam: when partitioned collections land,
 * per-partition grouping will need to merge sub-results across
 * partitions. The reducer protocol's `{ seed }` parameter
 * (already plumbed through in `reducers.ts`) is the mechanism —
 * groupBy doesn't need its own seam for the moment, because it
 * delegates to the reducer protocol for all per-bucket state.
 */

import { readPath } from '../../kernel/query/predicate.js'
import type {
  ReduceSpec,
  ReduceResult,
  ReductionUpstream,
  LiveReduction,
} from './reduction.js'
import { buildLiveReduction } from './reduction.js'
import type { ReducerBuilder } from './reducers.js'
import { bindDistinctReducers, reducerBuilder } from './reducers.js'
import { canonicalGroupKey } from './canonical-key.js'
import { GroupCardinalityError } from '../../kernel/errors.js'
import {
  GROUPBY_MAX_CARDINALITY,
  GROUPBY_WARN_CARDINALITY,
  groupFieldLabel,
  reduceGroupRow,
  warnCardinalityApproaching,
} from './group-core.js'
import { GroupedMaintainer } from './incremental-group.js'
import type { GroupMaintenanceStats } from './incremental-group.js'
import type { GroupMaintenanceSource, SourceChange } from '../../kernel/query/incremental.js'
import type { MoneyDescriptor } from '../../via/money/descriptor.js'
import type { ViaPipeline } from '../../kernel/via/pipeline.js'
import { viaBinder } from '../../kernel/via/index.js'
import { applyI18nLocale, type I18nTextDescriptor } from '../../via/i18n/core.js'

/**
 * The cardinality guards and the warning-reset hook live in `group-core.ts`
 * — shared verbatim with the incremental maintainer so the eager and
 * delta-maintained paths cannot enforce different caps — and are re-exported
 * here so every existing import site is unchanged.
 */
export {
  GROUPBY_WARN_CARDINALITY,
  GROUPBY_MAX_CARDINALITY,
  resetGroupByWarnings,
} from './group-core.js'

/**
 * Result row shape for a grouped reduction. Each row carries the
 * group key value under the grouping field name plus every reducer
 * output from the spec.
 *
 * types the group key as `unknown` at the result shape — the
 * runtime read via `readPath` can return any value, and narrowing
 * to a specific type would require the caller to assert at the
 * call site. `dictKey` narrowing layers on top of this by
 * adding an overload that constrains `F` when the grouping field
 * is a `dictKey`.
 */
export type GroupedRow<F extends string, R> = { [K in F]: unknown } & R

/**
 * Multi-key variant — result-row shape for variadic
 * `.groupBy(...fields)`. Every grouped field name appears on the row
 * (typed as `unknown` for the same reason as `GroupedRow`), plus the
 * reducer outputs from the spec.
 */
export type GroupedRowN<F extends readonly string[], R> =
  { [K in F[number]]: unknown } & R

/**
 * Shared base class for the chainable grouped-query wrappers. Holds
 * the constructor + protected fields that both single-key
 * `GroupedQuery<T, F>` and variadic `GroupedQueryN<T, F>` need; each
 * subclass only overrides `aggregate()` with its own result-row
 * generic.
 *
 * Not exported — implementation detail. Adding `.having()` /
 * `.live()` / `.orderByGroup()` etc. in the future lands here once
 * and both subclasses pick it up automatically.
 *
 * @internal
 */
abstract class GroupedQueryBase {
  /**
   * Field set this grouped query buckets on. Stored in declaration
   * order — the same order is preserved on every result row by
   * `groupAndReduce`. For the single-field constructor, this is
   * `[field]`.
   */
  protected readonly fields: readonly string[]

  constructor(
    protected readonly executeRecords: () => readonly unknown[],
    fieldOrFields: string | readonly string[],
    protected readonly upstreams: readonly ReductionUpstream[],
    /**
     * Optional dict label resolver attached by the query builder when
     * the grouping field is a dictKey. Variadic groupings always pass
     * `undefined` — `<field>Label` projection has no meaningful shape
     * for composite keys.
     */
    protected readonly dictLabelResolver?: (
      key: string,
      locale: string,
      fallback?: string | readonly string[],
    ) => Promise<string | undefined>,
    /**
     * The backing collection's compiled Via pipeline — used to rewrite
     * `sum`/`min`/`max` over Via-covered fields (e.g. money) into exact
     * BigInt reducers when `.aggregate(spec)` is terminated.
     */
    protected readonly via?: ViaPipeline,
    /**
     * The #1341 delta-maintenance seam, supplied by `Query.groupBy()` when the
     * plan admits incremental maintenance and withheld when it does not.
     * `undefined` is the pre-#1341 behaviour: `.live()` re-runs in full.
     */
    protected readonly maintenance?: GroupMaintenanceSource,
  ) {
    this.fields =
      typeof fieldOrFields === 'string' ? [fieldOrFields] : [...fieldOrFields]
  }

  /** Apply Via-aware reducer rewriting (e.g. money) when the source declares one. */
  protected wrapSpec<Spec extends ReduceSpec>(spec: Spec): Spec {
    // #1347 — `countDistinct` is rebound to the collection's index-key
    // canonicalizer here too, so a grouped distinct count agrees with an
    // ungrouped one over the same Via-covered field.
    return bindDistinctReducers(this.via ? this.via.wrapReducers(spec) : spec, this.via)
  }
}

/**
 * Chainable wrapper returned by `Query.groupBy(field)`. Terminates
 * with `.aggregate(spec)` which returns a `GroupedReduction`.
 *
 * Kept minimal — the only operation on a grouped query is
 * reduction. Ordering, limiting and further filtering of the
 * REDUCED rows live one step further along the chain, on the
 * `GroupedReduction` that `.aggregate()` returns (`.having()`,
 * `.orderBy()`, `.limit()` — #1336); ordering and limiting of the
 * SOURCE RECORDS stays on the underlying `Query`, before
 * `.groupBy()`. The two are different operations and neither
 * substitutes for the other.
 */
export class GroupedQuery<T, F extends string, S extends keyof T = never, M extends keyof T & string = never> extends GroupedQueryBase {
  /**
   * Build a grouped reduction. Returns a `GroupedReduction`
   * with `.run()`, `.runAsync()`, and `.live()` terminals — same shape
   * as the non-grouped `.aggregate()` wrapper, just with an array
   * result (one row per bucket) instead of a single reduced object.
   *
   * The builder overload `aggregate(b => spec)` types `b` as
   * `ReducerBuilder<T, S, M>`, so field-taking reducers (`sum`, `avg`,
   * `min`, `max`) refuse any field listed in the collection's
   * `sensitive` option at compile time, and `sum`/`min`/`max` over a
   * declared `moneyFields` (`M`) member return a `MoneyString`. The
   * bare-spec overload is preserved for backward compatibility.
   */
  aggregate<Spec extends ReduceSpec>(spec: Spec): GroupedReduction<GroupedRow<F, ReduceResult<Spec>>>
  aggregate<Spec extends ReduceSpec>(build: (b: ReducerBuilder<T, S, M>) => Spec): GroupedReduction<GroupedRow<F, ReduceResult<Spec>>>
  aggregate<Spec extends ReduceSpec>(
    specOrBuild: Spec | ((b: ReducerBuilder<T, S, M>) => Spec),
  ): GroupedReduction<GroupedRow<F, ReduceResult<Spec>>> {
    const spec: Spec = typeof specOrBuild === 'function'
      ? (specOrBuild as (b: ReducerBuilder<T, S, M>) => Spec)(reducerBuilder as unknown as ReducerBuilder<T, S, M>)
      : specOrBuild
    // T is phantom on the wrapper so consumers can still see the
    // source row type on hover. Reference it to keep lint quiet.
    void undefined as T | undefined
    return new GroupedReduction<GroupedRow<F, ReduceResult<Spec>>>(
      this.executeRecords,
      this.fields,
      this.wrapSpec(spec),
      this.upstreams,
      this.dictLabelResolver,
      NO_POST_GROUP,
      this.maintenance,
    )
  }
}

/**
 * Variadic-keyed sibling of `GroupedQuery<T, F>`. Constructed by the
 * multi-arg `Query.groupBy(...fields)` overload. The runtime shape is
 * identical — only the type-level result-row narrowing differs.
 */
export class GroupedQueryN<T, F extends readonly string[], S extends keyof T = never, M extends keyof T & string = never> extends GroupedQueryBase {
  aggregate<Spec extends ReduceSpec>(spec: Spec): GroupedReduction<GroupedRowN<F, ReduceResult<Spec>>>
  aggregate<Spec extends ReduceSpec>(build: (b: ReducerBuilder<T, S, M>) => Spec): GroupedReduction<GroupedRowN<F, ReduceResult<Spec>>>
  aggregate<Spec extends ReduceSpec>(
    specOrBuild: Spec | ((b: ReducerBuilder<T, S, M>) => Spec),
  ): GroupedReduction<GroupedRowN<F, ReduceResult<Spec>>> {
    const spec: Spec = typeof specOrBuild === 'function'
      ? (specOrBuild as (b: ReducerBuilder<T, S, M>) => Spec)(reducerBuilder as unknown as ReducerBuilder<T, S, M>)
      : specOrBuild
    void undefined as T | undefined
    return new GroupedReduction<GroupedRowN<F, ReduceResult<Spec>>>(
      this.executeRecords,
      this.fields,
      this.wrapSpec(spec),
      this.upstreams,
      this.dictLabelResolver,
      NO_POST_GROUP,
      this.maintenance,
    )
  }
}

/**
 * Execute the group-and-reduce pipeline. Pure function over a
 * record array and a spec — shared by `GroupedReduction.run()`
 * and the live-mode refresh path. Exported for tests and for any
 * future `scan().groupBy().aggregate()` reuse.
 *
 * Enforces the cardinality cap incrementally during the partition
 * loop, so a runaway grouping throws at the moment the 100_001st
 * bucket would be created — the consumer doesn't have to wait for
 * the full partition to materialize before the error fires.
 */
export function groupAndReduce<R>(
  records: readonly unknown[],
  fieldOrFields: string | readonly string[],
  spec: ReduceSpec,
  moneyFields?: Record<string, MoneyDescriptor>,
): R[] {
  const fields: readonly string[] =
    typeof fieldOrFields === 'string' ? [fieldOrFields] : fieldOrFields
  if (fields.length === 0) {
    throw new Error('.groupBy() requires at least one field')
  }

  // Money-aware reduction: when the caller declares money descriptors
  // for output/intermediate fields, rewrite any `sum`/`min`/`max` over
  // them into exact BigInt reducers before bucketing. Omitted → spec
  // passes through unchanged (backward compatible). The chainable
  // `GroupedQuery` path already wraps upstream via `wrapSpec`; this
  // covers direct `groupAndReduce` callers (UNION-form MVs) that have
  // no Query wrapper to do it. Builds a transient money binding via the
  // kernel's Via port rather than a Query-attached pipeline — `moneyFields`
  // here is the MV spec's OWN descriptor map, not a collection's.
  if (moneyFields) {
    const binding = viaBinder('money')({ moneyFields })
    spec = binding.wrapReducers!(spec) as ReduceSpec
    // #1347 — same binding, the other half: `countDistinct` over a declared
    // money field must dedup on the BigInt-normalized scaled int, or a UNION
    // MV counts `'0100'` and `'100'` as two values of one amount.
    spec = bindDistinctReducers(spec, {
      canonicalizeIndexKey: (f, v) => binding.canonicalizeIndexKey?.(f, v),
    })
  }

  // Bucket value is { keyValues, records } so the output row can stamp
  // every grouped field in DECLARATION ORDER. Map preserves insertion
  // order natively (ES2015), so first-seen keys determine ordering.
  interface Bucket {
    keyValues: Record<string, unknown>
    records: unknown[]
  }
  const buckets = new Map<string, Bucket>()
  // Field-label string for error messages — matches the variadic
  // surface (`[a, b]` for multi-key, `"k"` for single-key back-compat).
  const fieldLabel = groupFieldLabel(fields)

  for (const record of records) {
    // Read each field's value into a row object, then canonicalise.
    const keyValues: Record<string, unknown> = {}
    for (const f of fields) {
      keyValues[f] = readPath(record, f)
    }
    const dedupKey = canonicalGroupKey(fields, keyValues)
    let bucket = buckets.get(dedupKey)
    if (bucket === undefined) {
      if (buckets.size >= GROUPBY_MAX_CARDINALITY) {
        throw new GroupCardinalityError(
          fieldLabel,
          buckets.size + 1,
          GROUPBY_MAX_CARDINALITY,
        )
      }
      bucket = { keyValues, records: [] }
      buckets.set(dedupKey, bucket)
    }
    bucket.records.push(record)
  }

  if (buckets.size >= GROUPBY_WARN_CARDINALITY) {
    warnCardinalityApproaching(fields, buckets.size)
  }

  // Reduce each bucket through the spec — `reduceGroupRow` is the SAME fold
  // the incremental maintainer runs for a dirty bucket, which is what makes an
  // incrementally maintained row identical to this one rather than merely
  // equal to it. `Object.keys(spec)` is hoisted out of the loop; calling
  // `reduceRecords` per bucket would recompute it per bucket.
  const reducerKeys = Object.keys(spec)
  const out: R[] = []
  for (const bucket of buckets.values()) {
    out.push(reduceGroupRow<R>(fields, bucket.keyValues, bucket.records, spec, reducerKeys))
  }
  return out
}

/**
 * The post-group stage (#1336): `having` predicates, an ordering spec over the
 * reduced rows, and a row cap. Immutable — every builder method returns a new
 * `GroupedReduction` carrying a new `PostGroup`.
 *
 * @internal — not exported; `GroupedReduction`'s public signatures name only
 * inline function/union types, so no consumer needs this shape.
 */
interface PostGroup {
  readonly having: readonly ((row: unknown) => boolean)[]
  readonly orderBy: readonly { readonly key: string; readonly direction: 'asc' | 'desc' }[]
  readonly limit: number | undefined
}

const NO_POST_GROUP: PostGroup = { having: [], orderBy: [], limit: undefined }

/**
 * Decimal-numeral test for the post-group comparator. Matches the exact
 * canonical decimal strings a Via-dressed reducer finalizes to — money's
 * `sum`/`min`/`max` return `'10004.00'`, not a number and not a formatted,
 * grouped-and-symbolised label.
 */
const DECIMAL_NUMERAL = /^[+-]?\d+(\.\d+)?$/

/**
 * Compare two REDUCED values for post-group ordering.
 *
 * Deliberately NOT the row-pipeline comparator in `kernel/query/builder.ts`,
 * and one rule apart from it: when both sides are strings that are plain
 * decimal numerals, they compare by MAGNITUDE. That rule exists for exactly
 * one reason — a money `sum` finalizes to an exact decimal string, and lexical
 * order gets it wrong in the ordinary case (`'9882.00' > '10004.00'`). The
 * pre-group path solves the same problem by asking the Via pipeline
 * (`compareForOrder`), which cannot serve here: it reads the STORED
 * scaled-integer form, and a reduced value is already decoded to decimal.
 *
 * The divergence is confined to a surface introduced by #1336 — no pre-group
 * ordering changes — and it only reaches values that are numerals end to end,
 * so a group key like `'c1'` still sorts lexically.
 * ⭐ SHARED, not private: `.window()`'s in-partition ordering (#1349) faces the
 * identical exposure over the identical values — its rows are decoded, so a
 * money field is a decimal string there too — and imports this rather than
 * growing a second rule that could drift from it.
 *
 * @internal
 */
export function compareReduced(a: unknown, b: unknown): number {
  // Nullish last in asc order — same convention as the row pipeline.
  if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1
  if (b === undefined || b === null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'string' && typeof b === 'string') {
    if (DECIMAL_NUMERAL.test(a) && DECIMAL_NUMERAL.test(b)) {
      const an = Number(a)
      const bn = Number(b)
      // Number() is lossy past 2^53; fall through to the lexical branch rather
      // than order two indistinguishable floats arbitrarily.
      if (an !== bn) return an < bn ? -1 : 1
    }
    return a < b ? -1 : a > b ? 1 : 0
  }
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  // Mixed / unsupported: equal, so the sort stays stable. Same choice the row
  // pipeline makes.
  return 0
}

/**
 * Apply the post-group stage to a reduced row array, in the order the docs
 * promise: `having` (all predicates ANDed) → `orderBy` (successive calls are
 * tie-breakers, stable) → `limit`.
 */
function applyPostGroup<R>(rows: R[], post: PostGroup): R[] {
  let out = rows
  for (const pred of post.having) {
    out = out.filter((row) => pred(row))
  }
  if (post.orderBy.length > 0) {
    // Array.prototype.sort has been stable since ES2019, so bucket
    // first-seen order survives as the final tie-break.
    out = [...out].sort((x, y) => {
      for (const { key, direction } of post.orderBy) {
        const cmp = compareReduced(
          (x as Record<string, unknown>)[key],
          (y as Record<string, unknown>)[key],
        )
        if (cmp !== 0) return direction === 'asc' ? cmp : -cmp
      }
      return 0
    })
  }
  if (post.limit !== undefined && post.limit < out.length) out = out.slice(0, post.limit)
  return out
}

/**
 * Grouped reduction wrapper — the `.groupBy(field).aggregate(spec)`
 * terminal. Shape mirrors `Reduction<R>` from aggregate.ts: two
 * terminals (`.run()` and `.live()`), spec bound at construction
 * time, upstreams collected for live mode.
 *
 * The generic `R` is the per-row result shape (i.e. a single
 * grouped row), and the terminals return `R[]` — one row per
 * bucket.
 *
 * `.having()` / `.orderBy()` / `.limit()` (#1336) post-process that array.
 * ⛔ **They do not appear in `Query.explain()` (#1348), and that is not an
 * omission.** `explain()` is a terminal on `Query`; `.groupBy()` leaves
 * `Query` for `GroupedQuery` and then `GroupedReduction`, so by the time these
 * three are reachable there is no `explain()` in the chain to add a node to.
 * Adding one would mean putting `explain()` on `GroupedReduction` — a new
 * surface, and a plan for a stage with nothing to choose: `having`/`orderBy`/
 * `limit` here have exactly one dispatch (a filter, a stable sort, a slice)
 * over rows already in memory. File an issue if a real consumer wants it.
 * ⚠️ They are POST-processing, never a memory optimization: the group pass has
 * already built and reduced every bucket by the time a `having` predicate is
 * called, so `GROUPBY_WARN_CARDINALITY` / `GROUPBY_MAX_CARDINALITY` see the
 * UNFILTERED bucket count and `having` cannot buy headroom under them. Narrow
 * with `.where()` before `.groupBy()` for that.
 */
/**
 * What `GroupedReduction.live()` returns: a `LiveReduction` plus one window
 * onto how it is being kept up to date (#1341).
 */
export interface LiveGroupedReduction<R> extends LiveReduction<R> {
  /**
   * Delta-maintenance counters for this live reduction, or `undefined` when
   * the plan was refused and every change re-runs the whole grouping.
   *
   * `patches` counts change events folded in per group; `rebuilds` counts
   * falls back to a full bucket rebuild. A live reduction that reports a
   * maintainer but never patches is a live reduction whose fallback is
   * swallowing everything — which is exactly the failure this exists to make
   * visible.
   */
  maintenanceStats(): GroupMaintenanceStats | undefined
}

export class GroupedReduction<R> {
  private readonly fields: readonly string[]

  constructor(
    private readonly executeRecords: () => readonly unknown[],
    fields: string | readonly string[],
    private readonly spec: ReduceSpec,
    private readonly upstreams: readonly ReductionUpstream[],
    /**
     * Optional dict label resolver for `<field>Label` projection
     *. Present when the grouping field is a dictKey.
     */
    private readonly dictLabelResolver?: (
      key: string,
      locale: string,
      fallback?: string | readonly string[],
    ) => Promise<string | undefined>,
    /**
     * The post-group stage (#1336). Optional and defaulted so every existing
     * construction site — `GroupedQuery.aggregate()`, `GroupedQueryN`, the MV
     * executor — is unchanged.
     */
    private readonly post: PostGroup = NO_POST_GROUP,
    /**
     * The #1341 delta-maintenance seam (see `GroupedQueryBase`). Present only
     * for a plan `canMaintainIncrementally()` admits.
     */
    private readonly maintenance?: GroupMaintenanceSource,
  ) {
    this.fields = typeof fields === 'string' ? [fields] : [...fields]
  }

  /** Clone with a replaced post-group stage. */
  private withPost(post: PostGroup): GroupedReduction<R> {
    return new GroupedReduction<R>(
      this.executeRecords,
      this.fields,
      this.spec,
      this.upstreams,
      this.dictLabelResolver,
      post,
      this.maintenance,
    )
  }

  /**
   * Keep only the reduced rows a predicate accepts — SQL's `HAVING` (#1336).
   *
   * ```ts
   * invoices.query()
   *   .groupBy('clientId')
   *   .aggregate({ total: sum('amount') })
   *   .having(r => (r.total as number) > 10_000)
   *   .orderBy('total', 'desc')
   *   .limit(20)
   *   .run()
   * ```
   *
   * The predicate sees the WHOLE reduced row — group keys (including a
   * `dateTrunc()`-derived one) and reducer outputs alike — with each value in
   * its exact reduced form: a money `sum` arrives as its canonical decimal
   * string (`'10004.00'`), never as a locale-formatted label, so comparing on
   * it is exact. Successive calls AND.
   *
   * ⚠️ Not a memory optimization. See the class docs — the buckets exist
   * already; `having` only decides what is returned.
   */
  having(predicate: (row: R) => boolean): GroupedReduction<R> {
    return this.withPost({
      ...this.post,
      having: [...this.post.having, predicate as (row: unknown) => boolean],
    })
  }

  /**
   * Order the REDUCED rows by one of their keys (#1336). Successive calls are
   * tie-breakers; the sort is stable, so bucket first-seen order breaks a
   * final tie.
   *
   * ⭐ Distinguished from `Query.orderBy()` by POSITION, not by name: this one
   * exists only after `.aggregate()` and sorts result rows by a reduced key or
   * a group key; `Query.orderBy()` exists only before `.groupBy()` and sorts
   * SOURCE RECORDS, which (via `.limit()`) changes which records are grouped
   * at all. Both may appear in one chain and they do not interfere.
   */
  orderBy(key: string, direction: 'asc' | 'desc' = 'asc'): GroupedReduction<R> {
    return this.withPost({
      ...this.post,
      orderBy: [...this.post.orderBy, { key, direction }],
    })
  }

  /**
   * Cap the number of reduced rows returned (#1336) — applied AFTER `having`
   * and `orderBy`, so `.orderBy('total', 'desc').limit(20)` is a top-20.
   *
   * A later call replaces an earlier one.
   */
  limit(n: number): GroupedReduction<R> {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`.limit(${n}): a post-group limit must be a non-negative integer.`)
    }
    return this.withPost({ ...this.post, limit: n })
  }

  /**
   * Execute the query, group, reduce, and return an array of rows.
   *
   * `opts` (query-form MV grouping): when a `locale` + `i18nFields` are
   * given, the declared group-key `i18nText` fields are resolved to that locale
   * at the `mv` layer BEFORE bucketing — so an i18n group key is a stable string
   * instead of a raw `{locale}` map. The MV executor passes the MV's
   * `i18nLocale`/`i18nFields`; ordinary `.run()` callers pass nothing and are
   * unaffected.
   */
  run(opts?: { locale?: string; i18nFields?: Record<string, I18nTextDescriptor> }): R[] {
    let records = this.executeRecords()
    if (opts?.locale !== undefined && opts.i18nFields !== undefined) {
      const groupI18n: Record<string, I18nTextDescriptor> = {}
      for (const f of this.fields) {
        const d = opts.i18nFields[f]
        if (d !== undefined) groupI18n[f] = d
      }
      if (Object.keys(groupI18n).length > 0) {
        records = records.map((r) => applyI18nLocale(r as Record<string, unknown>, groupI18n, opts.locale!, undefined, 'mv'))
      }
    }
    return applyPostGroup(groupAndReduce<R>(records, this.fields, this.spec), this.post)
  }

  /**
   * Execute the query, group, reduce, and resolve `<field>Label` for
   * each result row when the grouping field is a `dictKey` and a
   * `locale` is provided. Returns `R[]` synchronously when
   * no locale is specified (identical to `.run()`).
   *
   * The `<field>Label` field is appended to each row. Rows whose group
   * key has no dictionary entry get `<field>Label: undefined`.
   *
   * Dict-label resolution is single-field only — multi-key groupings
   * do not produce a `<field>Label`. The resolver is only attached
   * by the builder when `fields.length === 1`.
   */
  async runAsync(opts?: {
    locale?: string
    fallback?: string | readonly string[]
  }): Promise<R[]> {
    // Post-group ops run BEFORE label resolution: `having`/`orderBy` address
    // the reduced keys, which exist already, and resolving a `<field>Label`
    // for a row that `having` then discards would be wasted async work.
    const rows = applyPostGroup(
      groupAndReduce<R>(this.executeRecords(), this.fields, this.spec),
      this.post,
    )
    if (!opts?.locale || !this.dictLabelResolver || this.fields.length !== 1) return rows

    const resolve = this.dictLabelResolver
    const locale = opts.locale
    const fallback = opts.fallback
    const field = this.fields[0]!
    const labelKey = `${field}Label`

    return Promise.all(
      rows.map(async (row) => {
        const key = (row as Record<string, unknown>)[field]
        if (typeof key !== 'string') return row
        const label = await resolve(key, locale, fallback)
        return { ...(row as Record<string, unknown>), [labelKey]: label } as unknown as R
      }),
    )
  }

  /**
   * Build a reactive `LiveReduction<R[]>` that updates whenever any upstream
   * source notifies of a change. Same error-isolation and idempotent-stop
   * contract as `Reduction.live()` — the implementation delegates to the same
   * `LiveAggregationImpl` class by threading a fresh recompute closure through
   * the existing constructor.
   *
   * **Incremental per-group maintenance (#1341, grouped half).** When
   * `Query.groupBy()` supplied a maintenance seam — a plan
   * `canMaintainIncrementally()` admits, over a source that can hand back a
   * snapshot and an id lookup — a change no longer re-runs the pipeline. The
   * delta patches the match set, then patches the ONE OR TWO buckets it
   * touches; every other bucket serves the row it already computed. See
   * `incremental-group.ts` for the correctness argument, including the three
   * membership transitions (a record changing group, a group emptying, a group
   * appearing) that a naive per-group patch gets wrong.
   *
   * Every other plan, and every notification that arrives without a delta,
   * re-runs the whole grouping exactly as before. Either way the emitted rows
   * are identical to `.run()`'s.
   *
   * ⚠️ `.run()` is deliberately NOT served from the maintained state: it is a
   * one-shot terminal that may be called long after a `.live()` was stopped,
   * and reading the snapshot is the only answer that cannot be stale.
   *
   * Always call `live.stop()` when finished.
   */
  live(): LiveGroupedReduction<R[]> {
    const maintainer = this.maintenance
      ? new GroupedMaintainer({
          source: this.maintenance,
          fields: this.fields,
          spec: this.spec,
        })
      : undefined
    if (!maintainer) {
      const recompute = (): R[] =>
        applyPostGroup(
          groupAndReduce<R>(this.executeRecords(), this.fields, this.spec),
          this.post,
        )
      return withStats(buildLiveReduction<R[]>(recompute, this.upstreams), undefined)
    }

    const recompute = (): R[] => applyPostGroup(maintainer.rows() as R[], this.post)
    // The maintainer folds the delta in BEFORE the reduction reads, which is
    // why the upstream is wrapped rather than subscribed separately —
    // callback order would otherwise decide whether the read saw the change.
    const upstreams: readonly ReductionUpstream[] = this.upstreams.map(upstream => ({
      subscribe: (cb: () => void) => {
        maintainer.attach()
        const unsubscribe = upstream.subscribe((change?: SourceChange) => {
          // A reducer or predicate that throws must not escape into the
          // emitter — the maintainer drops its state and the recompute below
          // raises the same error where `LiveReduction` can catch it.
          try {
            maintainer.apply(change)
          } catch {
            maintainer.invalidate()
          }
          cb()
        })
        // Detach on teardown: a maintainer with no subscription feeding it
        // would go quietly out of date.
        return () => {
          maintainer.detach()
          unsubscribe()
        }
      },
    }))
    return withStats(buildLiveReduction<R[]>(recompute, upstreams), maintainer)
  }
}

/**
 * Stamp the #1341 maintenance counters onto a live reduction.
 *
 * ⭐ The fallback has to be OBSERVABLE, not merely correct: a
 * correctness-preserving fallback that silently swallowed every case would
 * pass every behavioural test while delivering nothing. `maintenanceStats()`
 * is how a caller — and every test in `query-grouped-incremental*.test.ts` —
 * asks which path actually ran.
 */
function withStats<R>(
  live: LiveReduction<R>,
  maintainer: GroupedMaintainer | undefined,
): LiveGroupedReduction<R> {
  return Object.assign(live, {
    maintenanceStats: (): GroupMaintenanceStats | undefined => maintainer?.stats(),
  })
}
