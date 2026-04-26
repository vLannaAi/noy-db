/**
 * Strategy seam between the core Query / ScanBuilder chain and the
 * optional aggregate / groupBy subsystem. Core imports
 * `AggregateStrategy` as a TYPE-ONLY symbol and `NO_AGGREGATE` as a
 * tiny runtime stub.
 *
 * The heavy machinery — `Aggregation`, `GroupedQuery`, the
 * reducer-step logic — is only reachable from `withAggregate()` in
 * `./active.ts`, which is only exported through the
 * `@noy-db/hub/aggregate` subpath. Consumers that don't import the
 * subpath ship none of the ~886 LOC.
 *
 * @internal
 */

import type {
  Aggregation,
  AggregateSpec,
  AggregateResult,
  AggregationUpstream,
} from './aggregation.js'
import type { GroupedQuery } from './groupby.js'

/**
 * Seam interface. `@internal` — will promote to public only when the
 * aggregate subsystem is extracted into its own package.
 *
 * @internal
 */
export interface AggregateStrategy {
  /**
   * Build an `Aggregation<R>` for `Query.aggregate(spec)`. `executeRecords`
   * is a closure that produces the matching record set when the
   * aggregation runs. NO_AGGREGATE throws; the active strategy
   * constructs a real `Aggregation`.
   */
  aggregate<Spec extends AggregateSpec>(
    executeRecords: () => readonly unknown[],
    spec: Spec,
    upstreams: readonly AggregationUpstream[],
  ): Aggregation<AggregateResult<Spec>>

  /**
   * Build a `GroupedQuery<T, F>` for `Query.groupBy(field)`. Same
   * closure / upstream inputs as `aggregate` plus the group key field.
   */
  groupBy<T, F extends string>(
    executeRecords: () => readonly unknown[],
    field: F,
    upstreams: readonly AggregationUpstream[],
    dictLabelResolver?: (
      key: string,
      locale: string,
      fallback?: string | readonly string[],
    ) => Promise<string | undefined>,
  ): GroupedQuery<T, F>

  /**
   * Terminal streaming aggregator for `ScanBuilder.aggregate(spec)`.
   * Takes an async iterable of decrypted records + the spec and
   * returns the reduced result.
   */
  scanAggregate<Spec extends AggregateSpec>(
    iter: AsyncIterable<unknown>,
    spec: Spec,
  ): Promise<AggregateResult<Spec>>
}

const NOT_ENABLED = new Error(
  'Aggregate / groupBy is not enabled on this Noydb instance. ' +
  'Import `{ withAggregate }` from "@noy-db/hub/aggregate" and pass it to ' +
  '`createNoydb({ aggregateStrategy: withAggregate() })`.',
)

/**
 * No-aggregate stub. Every `.aggregate()` / `.groupBy()` / streaming
 * `scan().aggregate()` call throws with a pointer at the subpath. The
 * real `Aggregation` / `GroupedQuery` classes are never referenced at
 * runtime, so the bundler drops the ~886 LOC.
 *
 * @internal
 */
export const NO_AGGREGATE: AggregateStrategy = {
  aggregate() { throw NOT_ENABLED },
  groupBy() { throw NOT_ENABLED },
  scanAggregate() { throw NOT_ENABLED },
}
