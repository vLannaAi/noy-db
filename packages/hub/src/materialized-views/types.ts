import type { Query } from '../query/builder.js'
import type { Collection } from '../collection.js'
import type { AggregateSpec } from '../aggregate/aggregation.js'
import type { JoinStrategy } from '../query/join.js'
import type { MoneyDescriptor } from '../money/descriptor.js'

/**
 * Minimal vault-shaped accessor passed to the MV `query()` callback.
 * Defined as a structural interface so the strategy types don't have
 * to import the full `Vault` class (avoids a circular import). The
 * Vault implements this shape natively.
 */
export interface MVQueryContext {
   
  collection<T extends Record<string, unknown>>(name: string): Collection<T>
}

/**
 * Metadata that travels inside the `_data` payload of a materialized
 * row. Lives in encrypted payload, not in the unencrypted envelope —
 * the storage backend cannot infer the MV graph from listing.
 *
 * Extends the `_derivedFrom` precedent from v1: same encryption shape,
 * same "metadata-inside-data" location.
 */
export interface MaterializedFromMeta {
  /** Stable identity for the MV that emitted this row. */
  readonly mvName: string
  /**
   * SHA-256 of (mvName + canonical query plan + dependency-set).
   * Changes when the query structure changes → forces refresh on
   * next visit (parallels v1's `strategyHash`).
   */
  readonly queryHash: string
  /**
   * Map from source collection name → `_v` of the source row(s) that
   * contributed to this MV row at materialization time. For aggregates
   * over many rows, this is `max(_v)` per source collection — coarse
   * but sufficient for stale detection.
   */
  readonly sourceVersions: Record<string, number>
  /** ISO timestamp when this row was materialized. */
  readonly materializedAt: string
}

/** Output routing for an MV. Optional — when omitted, writes to a collection named after `name`. */
export interface MaterializedViewOutput {
  /** Output collection name. Defaults to `name`. */
  collection?: string
  /**
   * For same-collection-as-source MVs — see § Same-collection partition
   * discriminator in the v2 spec. The cycle detector resolves the
   * same-collection edge IFF the query has a where-clause that
   * provably excludes `partition.value` (supports `==` against a
   * different value, `!=` against the value, and `in` lists that
   * don't contain it). Naïve same-collection MVs without a disjoint
   * clause throw `MaterializedViewCycleError` at vault open.
   */
  partition?: { field: string; value: unknown }
}

/**
 * One arm of a UNION materialized view. Reads rows from `collection`,
 * then maps each into the MV's row shape via `map`.
 *
 * The per-source `map` is the schema-unification boundary — sibling
 * collections can have different schemas, and `map` is where they
 * meet the MV's row type. The hub does NOT compare schemas across
 * arms; consumer responsibility is that every arm's `map` returns
 * the same shape (the strategy's `TRow` type parameter enforces this
 * at compile time).
 */
export interface UnionSource<TRow extends Record<string, unknown>> {
  /** Source collection name. Must exist in the vault. */
  readonly collection: string
  /**
   * Pure function from a source row to the unified MV row shape.
   * Called once per source row at materialization time. Each arm's
   * mapped output is concatenated into a single stream before
   * `groupBy` + `aggregate` run.
   *
   * Returning `null` or `undefined` **omits** the source row from the
   * materialized output entirely — the row is not pushed into the
   * unified stream and never reaches `groupBy` / `aggregate`. This
   * removes the need for sentinel rows (e.g. `{ amount: 0 }`) whose
   * sole purpose is to be aggregated away (#297).
   *
   * When this arm declares {@link join}, the aliased right-side
   * record(s) are attached to the source row under each leg's `as`
   * BEFORE `map` runs, so `map` can read `sourceRow[leg.as]`.
   */
  readonly map: (sourceRow: Record<string, unknown>) => TRow | null | undefined
  /**
   * Optional FK joins to apply to this arm's rows before {@link map}.
   * Each leg resolves a `ref()`-declared foreign key on the arm's
   * source collection into an attached right-side record under
   * `as` — the same machinery as the query-form `Query.join()`.
   *
   * The right-side collections must be listed in the strategy's
   * {@link MaterializedViewStrategy.sources} so writes to them trigger
   * MV refresh — registration throws `MaterializedViewConfigError`
   * otherwise (the union dependency set comes from arm `collection`s
   * alone, which would not include join targets).
   */
  readonly join?: ReadonlyArray<UnionArmJoin>
}

/**
 * One FK join leg on a UNION arm. Mirrors the option shape of the
 * query-form `Query.join(field, { as, maxRows?, strategy? })`.
 */
export interface UnionArmJoin {
  /** FK field on the arm's source collection (must have a `ref()` declared). */
  readonly field: string
  /** Alias under which the resolved right-side record attaches on the source row. */
  readonly as: string
  /** Per-side row ceiling override. `undefined` → the join default. */
  readonly maxRows?: number
  /** Planner strategy override. `undefined` → auto-select. */
  readonly strategy?: JoinStrategy
}

/**
 * Registration shape passed to `withMaterializedView()`.
 *
 * @typeParam TRow - the materialized row type (the query's result row)
 */
export interface MaterializedViewStrategy<TRow extends Record<string, unknown>> {
  /**
   * Stable identity for this view. Used as the output collection name
   * unless `output.collection` overrides. Must be unique within the vault.
   */
  name: string
  /**
   * Declared query (single-source mode). Called at registration time
   * with a vault-shaped accessor so the closure can compose collections
   * without pre-existing in-scope references; called again at each
   * refresh.
   *
   * Built via the same `Query<T>` chainable builder used elsewhere —
   * `.where()`, `.join()`, `.groupBy()`, `.aggregate()`. The
   * dependency analyzer walks the returned plan to determine source
   * collections.
   *
   * Mutually exclusive with {@link unionSources}: a strategy must
   * declare exactly one of `query` (single-source) or `unionSources`
   * (multi-source UNION). Registration throws
   * `MaterializedViewConfigError` if both are set or neither is set.
   */
  query?: (db: MVQueryContext) => Query<TRow>
  /**
   * UNION-form sources: an explicit list of sibling collections
   * that contribute rows to a single MV. Each arm's `map` projects a
   * source row into the MV's unified row shape; the mapped streams are
   * concatenated, then {@link groupBy} + {@link aggregate} run on the
   * combined output.
   *
   * Mutually exclusive with {@link query}. Registration throws
   * `MaterializedViewConfigError` if both are set, if `unionSources`
   * is empty, or if two arms name the same `collection`.
   *
   * A SINGLE arm is valid (#331): it expresses map→group→aggregate
   * over one collection with a COMPUTED bucket key (e.g. a month
   * sliced from a date field). The query form's `.groupBy()` accepts
   * stored field names only, so a derived key needs the arm's `map`.
   *
   * UNION mode replaces the dependency-analyzer path: the source
   * collections come directly from `unionSources[].collection`, and
   * {@link sources} is ignored.
   */
  unionSources?: ReadonlyArray<UnionSource<TRow>>
  /**
   * Group-key field(s) for UNION mode. Applied to the
   * concatenated mapped-row stream from {@link unionSources} before
   * {@link aggregate} runs. Accepts a single field name or a tuple of
   * field names for multi-key grouping (same shape as
   * `Query.groupBy(...fields)`).
   *
   * UNION-mode only. Ignored if {@link query} is set — single-source
   * grouping is expressed inside the `Query<T>` returned from `query()`
   * via `.groupBy(...).aggregate(...)`.
   */
  groupBy?: string | ReadonlyArray<string>
  /**
   * Aggregation spec for UNION mode. Applied per-group after
   * {@link groupBy} buckets the concatenated mapped-row stream from
   * {@link unionSources}. Same shape as the `AggregateSpec` passed to
   * `Query.aggregate()`.
   *
   * UNION-mode only. Ignored if {@link query} is set.
   */
  aggregate?: AggregateSpec
  /**
   * Money descriptors for the UNION-mode aggregate, keyed by the
   * OUTPUT/intermediate field name as it appears in the mapped row and
   * in {@link aggregate} (NOT the source collection's field name). When
   * declared, any `sum` / `min` / `max` over a keyed field is rewritten
   * into an exact per-currency BigInt reducer — without this, money
   * aggregation in UNION mode silently runs in float (since the
   * concatenated mapped stream is a plain array with no collection
   * money context to inherit).
   *
   * UNION-mode only — the query form inherits its money descriptors
   * from the source collection automatically. The descriptor's
   * currency/scale must match what the arms' `map()` emits for that
   * field (each arm maps into the same unified shape, so one descriptor
   * per output field covers all arms). Meaningless without
   * {@link aggregate}; registration throws `MaterializedViewConfigError`
   * if declared alone.
   */
  moneyFields?: Record<string, MoneyDescriptor>
  /**
   * Pure function from a materialized row → stable id used in the
   * output collection. Required — explicit always beats default-with-pitfalls
   * (explicit always beats default-with-pitfalls; see the slash-collision rationale).
   */
  rowKey: (row: TRow) => string
  /**
   * Explicit source collections. Required when `query()` returns
   * an `Aggregation` or `GroupedAggregation` rather than a `Query<T>`
   * — the dependency analyzer can't introspect through `groupBy().aggregate()`
   * back to the source. Optional for plain `Query<T>` results — the
   * analyzer extracts dependencies automatically from the query plan.
   *
   * When set, takes precedence over auto-analysis.
   */
  sources?: ReadonlyArray<string>
  /**
   * Declared deterministic predicates. Each entry pairs a
   * consumer-stable `hash` with a function. The `query()` callback's
   * Query<T> can invoke them via `.wherePredicate(name, ctx?)`. The
   * predicate's `hash` + a canonical-JSON hash of `ctx` both fold
   * into `queryHash` — bumping either forces refresh on next visit.
   *
   * Consumer responsibility: bump `hash` when the function's semantics
   * change. Failing to bump after a non-equivalent change leaves
   * stale rows around until the next explicit refresh.
   */
  predicates?: {
    [name: string]: {
      hash: string
      fn: (row: TRow, ctx?: unknown) => boolean
    }
  }
  /**
   * Refresh policy.
   *
   * - `'eager'` — re-materialize synchronously inside the source-write
   *   transaction (composes with `withTransactions` for strict-mode
   *   rollback).
   * - `'lazy'` — mark stale on source-change; materialize on first
   *   read of the MV.
   * - `'manual'` — only materializes when `vault.refreshView(name)` is
   *   called. Useful for very expensive MVs or time-dependent queries
   *   whose `ctx` changes externally.
   */
  refresh: 'eager' | 'lazy' | 'manual'
  /** Output routing. Optional; defaults to writing the collection named after `name`. */
  output?: MaterializedViewOutput
  /**
   * What to do when a re-materialization produces zero rows for a key
   * that previously had rows.
   *
   * - `'delete'` (default) — tombstone the prior MV row via
   *   `Collection._internalDelete` (system housekeeping bypasses user
   *   `onDelete` guards on the output collection — the housekeeping
   *   bypass composition fix).
   * - `'keep'` — leave the prior MV row in place. Useful when zero
   *   is a meaningful state.
   */
  onEmpty?: 'delete' | 'keep'
  /**
   * `true` re-throws on any row-write failure → composes with
   * `withTransactions` to roll back the source-write atomically via
   * `revertExecuted`. Default `false` (failed rows are
   * isolated; other rows commit).
   */
  strict?: boolean
  /**
   * Row-count ceiling for the materialized output. Throws
   * `MaterializedViewTooLargeError` before any writes when exceeded
   * — keeps the rollback clean. Default `100_000`; override per-MV
   * when the domain warrants it.
   */
  maxRows?: number
}

/** Returned by `withMaterializedView()` and consumed by `createNoydb`. */
export interface MaterializedViewStrategyHandle {
  readonly __noydb_strategy: 'materialized-view'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly spec: MaterializedViewStrategy<any>
}
