import type { Query } from '../query/builder.js'
import type { Collection } from '../collection.js'

/**
 * Minimal vault-shaped accessor passed to the MV `query()` callback.
 * Defined as a structural interface so the strategy types don't have
 * to import the full `Vault` class (avoids a circular import). The
 * Vault implements this shape natively.
 */
export interface MVQueryContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
   * discriminator in the v2 spec. Deferred to subtask #152; declared
   * here so the type is stable across PRs.
   */
  partition?: { field: string; value: unknown }
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
   * Declared query. Called at registration time with a vault-shaped
   * accessor so the closure can compose collections without
   * pre-existing in-scope references; called again at each refresh.
   *
   * Built via the same `Query<T>` chainable builder used elsewhere —
   * `.where()`, `.join()`, `.groupBy()`, `.aggregate()`. The
   * dependency analyzer walks the returned plan to determine source
   * collections.
   */
  query: (db: MVQueryContext) => Query<TRow>
  /**
   * Pure function from a materialized row → stable id used in the
   * output collection. Required — explicit always beats default-with-pitfalls
   * (see niwat-review of #149 round 1 for the slash-collision rationale).
   */
  rowKey: (row: TRow) => string
  /**
   * Explicit source collections (#152). Required when `query()` returns
   * an `Aggregation` or `GroupedAggregation` rather than a `Query<T>`
   * — the dependency analyzer can't introspect through `groupBy().aggregate()`
   * back to the source. Optional for plain `Query<T>` results — the
   * analyzer extracts dependencies automatically from the query plan.
   *
   * When set, takes precedence over auto-analysis.
   */
  sources?: ReadonlyArray<string>
  /**
   * Refresh policy. Foundation sub-issue (#150) implements `'eager'`;
   * `'lazy'` and `'manual'` are wired in sub-issues #151.
   */
  refresh: 'eager' | 'lazy' | 'manual'
  /** Output routing. Optional; defaults to writing the collection named after `name`. */
  output?: MaterializedViewOutput
  /**
   * What to do when a re-materialization produces zero rows for a key
   * that previously had rows. Deferred to subtask #152.
   */
  onEmpty?: 'delete' | 'keep'
  /**
   * Strict-mode rollback inside `withTransactions`. Deferred to subtask #152.
   */
  strict?: boolean
  /**
   * Row-count ceiling for the materialized output. Deferred to subtask #152.
   */
  maxRows?: number
}

/** Returned by `withMaterializedView()` and consumed by `createNoydb`. */
export interface MaterializedViewStrategyHandle {
  readonly __noydb_strategy: 'materialized-view'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly spec: MaterializedViewStrategy<any>
}
