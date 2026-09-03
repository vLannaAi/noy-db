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
 * **Live mode:** `.groupBy().aggregate().live()` re-runs the full
 * grouping pipeline on every source change. Per-bucket incremental
 * delta maintenance is a future optimization — the reducer
 * protocol's `remove()` hook admits it, but ships naive
 * re-grouping for simplicity.
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
import type { MoneyDescriptor } from '../../via/money/descriptor.js'
import type { ViaPipeline } from '../../kernel/via/pipeline.js'
import { viaBinder } from '../../kernel/via/index.js'
import { applyI18nLocale, type I18nTextDescriptor } from '../../via/i18n/core.js'

/**
 * Cardinality thresholds for `.groupBy()`. The warn threshold gives
 * consumers a heads-up before the hard error; the cap is a fixed
 * constant in (not overridable). A `{ maxGroups }` override
 * can be added later without a break if a real consumer asks.
 */
export const GROUPBY_WARN_CARDINALITY = 10_000
export const GROUPBY_MAX_CARDINALITY = 100_000

/**
 * One-shot warning dedup per-field-set — reactive dashboards
 * re-executing the same grouped query should produce the warning
 * once, not once per re-fire. Keyed on the sorted JSON of grouping
 * field names so `.groupBy('a', 'b')` and `.groupBy('b', 'a')`
 * share the same dedup slot (their result tuples are isomorphic).
 */
const warnedCardinalityFields = new Set<string>()
function warnCardinalityApproaching(
  fields: readonly string[],
  observed: number,
): void {
  const key = JSON.stringify([...fields].sort())
  if (warnedCardinalityFields.has(key)) return
  warnedCardinalityFields.add(key)
  const label = `[${fields.join(', ')}]`
  console.warn(
    `[noy-db] .groupBy(${label}) produced ${observed} distinct groups, ` +
      `${Math.round((observed / GROUPBY_MAX_CARDINALITY) * 100)}% of the ` +
      `${GROUPBY_MAX_CARDINALITY}-group ceiling. Narrow the query with ` +
      `.where() before grouping, or switch to a lower-cardinality field.`,
  )
}

/**
 * Test-only: clear the per-field cardinality warning dedup between
 * tests. Production code never calls this — matching the
 * `resetJoinWarnings` pattern in `join.ts`.
 */
export function resetGroupByWarnings(): void {
  warnedCardinalityFields.clear()
}

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
 * reduction. Ordering, limiting, and further filtering belong on
 * the underlying `Query` before `.groupBy()` is called; applying
 * them post-group would be a different operation (`having` /
 * `groupOrderBy`), out of scope for.
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
  const fieldLabel = fields.length === 1 ? fields[0]! : `[${fields.join(', ')}]`

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

  // Reduce each bucket through the spec. Same init/step/finalize
  // pipeline as `reduceRecords` in aggregate.ts, but one state per
  // bucket. Inlining the loop here keeps the per-bucket path tight
  // — calling `reduceRecords` per bucket would recompute
  // `Object.keys(spec)` once per bucket unnecessarily.
  const reducerKeys = Object.keys(spec)
  const out: R[] = []
  for (const bucket of buckets.values()) {
    const state: Record<string, unknown> = {}
    for (const rk of reducerKeys) {
      state[rk] = spec[rk]!.init()
    }
    for (const record of bucket.records) {
      for (const rk of reducerKeys) {
        state[rk] = spec[rk]!.step(state[rk], record)
      }
    }
    // Stamp grouped fields FIRST, in declaration order — this is
    // tested via `Object.keys(row).slice(0, fields.length)`.
    const row: Record<string, unknown> = {}
    for (const f of fields) {
      row[f] = bucket.keyValues[f]
    }
    for (const rk of reducerKeys) {
      row[rk] = spec[rk]!.finalize(state[rk])
    }
    out.push(row as unknown as R)
  }
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
 */
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
  ) {
    this.fields = typeof fields === 'string' ? [fields] : [...fields]
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
    return groupAndReduce<R>(records, this.fields, this.spec)
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
    const rows = groupAndReduce<R>(this.executeRecords(), this.fields, this.spec)
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
   * Build a reactive `LiveReduction<R[]>` that re-runs the full
   * group-and-reduce pipeline whenever any upstream source notifies
   * of a change. Same error-isolation and idempotent-stop contract
   * as `Reduction.live()` — the implementation delegates to the
   * same `LiveAggregationImpl` class by threading a fresh
   * recompute closure through the existing constructor.
   *
   * uses naive full re-run on every change. Incremental
   * per-bucket maintenance (apply `step` on inserted records,
   * `remove` on deleted records, route by bucket key) is a future
   * optimization — the reducer protocol admits it, but wiring
   * delta-aware source subscriptions is a separate PR.
   *
   * Always call `live.stop()` when finished.
   */
  live(): LiveReduction<R[]> {
    const recompute = (): R[] =>
      groupAndReduce<R>(this.executeRecords(), this.fields, this.spec)
    return buildLiveReduction<R[]>(recompute, this.upstreams)
  }
}
