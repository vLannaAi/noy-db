/**
 * Strategy seam between the core Query / ScanBuilder chain and the
 * optional aggregate / groupBy service. Core imports
 * `ReduceStrategy` as a TYPE-ONLY symbol and `NO_REDUCE` as a
 * tiny runtime stub.
 *
 * The heavy machinery — `Reduction`, `GroupedQuery`, the
 * reducer-step logic — is only reachable from `withReduce()` in
 * `./active.ts`, which is only exported through the
 * `@noy-db/hub/reduce` subpath. Consumers that don't import the
 * subpath ship none of the ~886 LOC.
 *
 * @internal
 */

import type {
  Reduction,
  ReduceSpec,
  ReduceResult,
  ReductionUpstream,
} from './reduction.js'
import type { GroupedQuery, GroupedQueryN } from './groupby.js'
import type { GroupMaintenanceSource } from '../../kernel/query/incremental.js'
import type { WindowFactory, WindowSpec, WindowedQuery } from './window.js'
/**
 * Re-exported so `kernel/query/builder.ts` can name `.window()`'s spec and
 * return type WITHOUT a second spine→service import specifier: this strategy
 * module is the seam the kernel is allowed to reach (`check-architecture.mjs`
 * → PRE_EXISTING_SPINE_SERVICE_IMPORTS), and adding a new grandfathered path
 * there for a type-only import would loosen the ratchet for no gain.
 */
export type { WindowSpec, WindowedQuery } from './window.js'

/**
 * Options for {@link withReduce}. `window` is the {@link WindowFactory}
 * returned by `withWindow()` — omitted, `.window()` throws and the window
 * engine stays out of the bundle entirely (see `window.ts` § "Opting in").
 */
export interface ReduceOptions {
  readonly window?: WindowFactory
}
import type { ViaPipeline } from '../../kernel/via/pipeline.js'

/**
 * Seam interface. `@internal` — will promote to public only when the
 * aggregate service is extracted into its own package.
 *
 * @internal
 */
export interface ReduceStrategy {
  /**
   * Build an `Reduction<R>` for `Query.aggregate(spec)`. `executeRecords`
   * is a closure that produces the matching record set when the
   * reduction runs. NO_REDUCE throws; the active strategy
   * constructs a real `Reduction`.
   */
  aggregate<Spec extends ReduceSpec>(
    executeRecords: () => readonly unknown[],
    spec: Spec,
    upstreams: readonly ReductionUpstream[],
  ): Reduction<ReduceResult<Spec>>

  /**
   * Build a `GroupedQuery<T, F, S>` for `Query.groupBy(field)`. Same
   * closure / upstream inputs as `aggregate` plus the group key field.
   */
  groupBy<T, F extends string, S extends keyof T = never, M extends keyof T & string = never>(
    executeRecords: () => readonly unknown[],
    field: F,
    upstreams: readonly ReductionUpstream[],
    dictLabelResolver?: (
      key: string,
      locale: string,
      fallback?: string | readonly string[],
    ) => Promise<string | undefined>,
    via?: ViaPipeline,
    /**
     * #1341 (grouped half) — the delta-maintenance seam. Supplied by
     * `Query.groupBy()` only for a plan `canMaintainIncrementally()` admits;
     * omitted, `.groupBy().aggregate().live()` re-runs in full as before.
     */
    maintenance?: GroupMaintenanceSource,
  ): GroupedQuery<T, F, S, M>

  /**
   * Variadic-keyed sibling — builds a `GroupedQueryN<T, F, S>` for
   * `Query.groupBy(...fields)`. No dictLabelResolver — `<field>Label`
   * projection only applies to single-field groupings, which dispatch
   * through `groupBy` above.
   */
  groupByN<T, F extends readonly string[], S extends keyof T = never, M extends keyof T & string = never>(
    executeRecords: () => readonly unknown[],
    fields: F,
    upstreams: readonly ReductionUpstream[],
    via?: ViaPipeline,
    /** #1341 (grouped half) — see `groupBy` above. */
    maintenance?: GroupMaintenanceSource,
  ): GroupedQueryN<T, F, S, M>

  /**
   * Build a `WindowedQuery<T>` for `Query.window(spec)` (#1349). Same closure
   * / upstream inputs as `groupBy`, plus the window definition. The Via
   * pipeline is threaded so `.select()` gets the same money/distinct reducer
   * rewriting `.aggregate()` gets.
   *
   * Throws unless the strategy was built as `withReduce({ window: withWindow() })`
   * — the second opt-in exists so the window engine is not charged to a
   * consumer who only aggregates. See `window.ts` § "Opting in".
   */
  window<T>(
    executeRecords: () => readonly unknown[],
    spec: WindowSpec,
    upstreams: readonly ReductionUpstream[],
    via?: ViaPipeline,
  ): WindowedQuery<T>

  /**
   * Terminal streaming aggregator for `ScanBuilder.aggregate(spec)`.
   * Takes an async iterable of decrypted records + the spec and
   * returns the reduced result.
   */
  scanAggregate<Spec extends ReduceSpec>(
    iter: AsyncIterable<unknown>,
    spec: Spec,
  ): Promise<ReduceResult<Spec>>
}

const NOT_ENABLED = new Error(
  'Aggregate / groupBy / window is not enabled on this Noydb instance. ' +
  'Import `{ withReduce }` from "@noy-db/hub/reduce" and pass it to ' +
  '`createNoydb({ reduceStrategy: withReduce() })`.',
)

/**
 * No-aggregate stub. Every `.aggregate()` / `.groupBy()` / streaming
 * `scan().aggregate()` call throws with a pointer at the subpath. The
 * real `Reduction` / `GroupedQuery` classes are never referenced at
 * runtime, so the bundler drops the ~886 LOC.
 *
 * @internal
 */
export const NO_REDUCE: ReduceStrategy = {
  aggregate() { throw NOT_ENABLED },
  groupBy() { throw NOT_ENABLED },
  groupByN() { throw NOT_ENABLED },
  window() { throw NOT_ENABLED },
  scanAggregate() { throw NOT_ENABLED },
}
