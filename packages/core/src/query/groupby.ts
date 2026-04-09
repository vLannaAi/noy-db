/**
 * Query DSL `.groupBy()` — v0.6 #98.
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
 * protocol's `remove()` hook admits it, but v0.6 ships naive
 * re-grouping for simplicity.
 *
 * **Type-level stable-key narrowing (v0.8 #85 prep):** when
 * `dictKey` lands, `groupBy<DictField>()` will narrow the group key
 * type to the stable dictionary key rather than the resolved locale
 * label. That prevents grouping by the locale-resolved label,
 * which would produce different buckets per reader. v0.6 types the
 * key as `unknown` at the result shape; the dictKey narrowing
 * layers on top without an API break.
 *
 * Partition-awareness seam (#87 constraint #1 applies to groupBy
 * too): when v0.10 partitioned collections land, per-partition
 * grouping will need to merge sub-results across partitions. The
 * reducer protocol's `{ seed }` parameter (#87 constraint #2,
 * already plumbed through in `reducers.ts`) is the mechanism —
 * groupBy doesn't need its own seam for the moment, because it
 * delegates to the reducer protocol for all per-bucket state.
 */

import { readPath } from './predicate.js'
import type {
  AggregateSpec,
  AggregateResult,
  AggregationUpstream,
  LiveAggregation,
} from './aggregate.js'
import { buildLiveAggregation } from './aggregate.js'
import { GroupCardinalityError } from '../errors.js'

/**
 * Cardinality thresholds for `.groupBy()`. The warn threshold gives
 * consumers a heads-up before the hard error; the cap is a fixed
 * constant in v0.6 (not overridable). A `{ maxGroups }` override
 * can be added later without a break if a real consumer asks.
 */
export const GROUPBY_WARN_CARDINALITY = 10_000
export const GROUPBY_MAX_CARDINALITY = 100_000

/**
 * One-shot warning dedup per-field — reactive dashboards
 * re-executing the same grouped query should produce the warning
 * once, not once per re-fire. Keyed on the grouping field name
 * because "this field has high cardinality on your current data"
 * is a field-level property, not a per-query one.
 */
const warnedCardinalityFields = new Set<string>()
function warnCardinalityApproaching(field: string, observed: number): void {
  if (warnedCardinalityFields.has(field)) return
  warnedCardinalityFields.add(field)
  console.warn(
    `[noy-db] .groupBy("${field}") produced ${observed} distinct groups, ` +
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
 * Result row shape for a grouped aggregation. Each row carries the
 * group key value under the grouping field name plus every reducer
 * output from the spec.
 *
 * v0.6 types the group key as `unknown` at the result shape — the
 * runtime read via `readPath` can return any value, and narrowing
 * to a specific type would require the caller to assert at the
 * call site. v0.8 `dictKey` narrowing layers on top of this by
 * adding an overload that constrains `F` when the grouping field
 * is a `dictKey`.
 */
export type GroupedRow<F extends string, R> = { [K in F]: unknown } & R

/**
 * Chainable wrapper returned by `Query.groupBy(field)`. Terminates
 * with `.aggregate(spec)` which returns a `GroupedAggregation`.
 *
 * Kept minimal — the only operation on a grouped query is
 * aggregation. Ordering, limiting, and further filtering belong on
 * the underlying `Query` before `.groupBy()` is called; applying
 * them post-group would be a different operation (`having` /
 * `groupOrderBy`), out of scope for v0.6.
 */
export class GroupedQuery<T, F extends string> {
  constructor(
    private readonly executeRecords: () => readonly unknown[],
    private readonly field: F,
    private readonly upstreams: readonly AggregationUpstream[],
    /**
     * Optional dict label resolver attached by the query builder when
     * the grouping field is a dictKey (v0.8 #85).
     */
    private readonly dictLabelResolver?: (
      key: string,
      locale: string,
      fallback?: string | readonly string[],
    ) => Promise<string | undefined>,
  ) {
    // T is phantom on the wrapper so consumers can still see the
    // source row type on hover. Reference it to keep lint quiet.
    void undefined as T | undefined
  }

  /**
   * Build a grouped aggregation. Returns a `GroupedAggregation`
   * with `.run()`, `.runAsync()`, and `.live()` terminals — same shape
   * as the non-grouped `.aggregate()` wrapper, just with an array
   * result (one row per bucket) instead of a single reduced object.
   */
  aggregate<Spec extends AggregateSpec>(
    spec: Spec,
  ): GroupedAggregation<GroupedRow<F, AggregateResult<Spec>>> {
    return new GroupedAggregation<GroupedRow<F, AggregateResult<Spec>>>(
      this.executeRecords,
      this.field,
      spec,
      this.upstreams,
      this.dictLabelResolver,
    )
  }
}

/**
 * Execute the group-and-reduce pipeline. Pure function over a
 * record array and a spec — shared by `GroupedAggregation.run()`
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
  field: string,
  spec: AggregateSpec,
): R[] {
  // Map preserves insertion order natively (ES2015), so first-seen
  // keys determine output ordering without a parallel order array.
  const buckets = new Map<unknown, unknown[]>()
  for (const record of records) {
    const key = readPath(record, field)
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      if (buckets.size >= GROUPBY_MAX_CARDINALITY) {
        throw new GroupCardinalityError(
          field,
          buckets.size + 1,
          GROUPBY_MAX_CARDINALITY,
        )
      }
      bucket = []
      buckets.set(key, bucket)
    }
    bucket.push(record)
  }

  if (buckets.size >= GROUPBY_WARN_CARDINALITY) {
    warnCardinalityApproaching(field, buckets.size)
  }

  // Reduce each bucket through the spec. Same init/step/finalize
  // pipeline as `reduceRecords` in aggregate.ts, but one state per
  // bucket. Inlining the loop here keeps the per-bucket path tight
  // — calling `reduceRecords` per bucket would recompute
  // `Object.keys(spec)` once per bucket unnecessarily.
  const keys = Object.keys(spec)
  const out: R[] = []
  for (const [groupKey, bucketRecords] of buckets) {
    const state: Record<string, unknown> = {}
    for (const key of keys) {
      state[key] = spec[key]!.init()
    }
    for (const record of bucketRecords) {
      for (const key of keys) {
        state[key] = spec[key]!.step(state[key], record)
      }
    }
    const row: Record<string, unknown> = { [field]: groupKey }
    for (const key of keys) {
      row[key] = spec[key]!.finalize(state[key])
    }
    out.push(row as unknown as R)
  }
  return out
}

/**
 * Grouped aggregation wrapper — the `.groupBy(field).aggregate(spec)`
 * terminal. Shape mirrors `Aggregation<R>` from aggregate.ts: two
 * terminals (`.run()` and `.live()`), spec bound at construction
 * time, upstreams collected for live mode.
 *
 * The generic `R` is the per-row result shape (i.e. a single
 * grouped row), and the terminals return `R[]` — one row per
 * bucket.
 */
export class GroupedAggregation<R> {
  constructor(
    private readonly executeRecords: () => readonly unknown[],
    private readonly field: string,
    private readonly spec: AggregateSpec,
    private readonly upstreams: readonly AggregationUpstream[],
    /**
     * Optional dict label resolver for `<field>Label` projection
     * (v0.8 #85). Present when the grouping field is a dictKey.
     */
    private readonly dictLabelResolver?: (
      key: string,
      locale: string,
      fallback?: string | readonly string[],
    ) => Promise<string | undefined>,
  ) {}

  /** Execute the query, group, reduce, and return an array of rows. */
  run(): R[] {
    return groupAndReduce<R>(this.executeRecords(), this.field, this.spec)
  }

  /**
   * Execute the query, group, reduce, and resolve `<field>Label` for
   * each result row when the grouping field is a `dictKey` and a
   * `locale` is provided (v0.8 #85). Returns `R[]` synchronously when
   * no locale is specified (identical to `.run()`).
   *
   * The `<field>Label` field is appended to each row. Rows whose group
   * key has no dictionary entry get `<field>Label: undefined`.
   */
  async runAsync(opts?: {
    locale?: string
    fallback?: string | readonly string[]
  }): Promise<R[]> {
    const rows = groupAndReduce<R>(this.executeRecords(), this.field, this.spec)
    if (!opts?.locale || !this.dictLabelResolver) return rows

    const resolve = this.dictLabelResolver
    const locale = opts.locale
    const fallback = opts.fallback
    const labelKey = `${this.field}Label`

    return Promise.all(
      rows.map(async (row) => {
        const key = (row as Record<string, unknown>)[this.field]
        if (typeof key !== 'string') return row
        const label = await resolve(key, locale, fallback)
        return { ...(row as Record<string, unknown>), [labelKey]: label } as unknown as R
      }),
    )
  }

  /**
   * Build a reactive `LiveAggregation<R[]>` that re-runs the full
   * group-and-reduce pipeline whenever any upstream source notifies
   * of a change. Same error-isolation and idempotent-stop contract
   * as `Aggregation.live()` — the implementation delegates to the
   * same `LiveAggregationImpl` class by threading a fresh
   * recompute closure through the existing constructor.
   *
   * v0.6 uses naive full re-run on every change. Incremental
   * per-bucket maintenance (apply `step` on inserted records,
   * `remove` on deleted records, route by bucket key) is a future
   * optimization — the reducer protocol admits it, but wiring
   * delta-aware source subscriptions is a separate PR.
   *
   * Always call `live.stop()` when finished.
   */
  live(): LiveAggregation<R[]> {
    const recompute = (): R[] =>
      groupAndReduce<R>(this.executeRecords(), this.field, this.spec)
    return buildLiveAggregation<R[]>(recompute, this.upstreams)
  }
}
