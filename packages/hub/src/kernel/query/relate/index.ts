/**
 * `@noy-db/hub/query/relate` — **the Relate group of the query DSL.**
 *
 * ```ts
 * import '@noy-db/hub/query/relate'   // once, in your app's entry
 *
 * invoices.query()
 *   .where('status', '==', 'paid')
 *   .join<'client', Client>('clientId', { as: 'client' })
 *   .toArray()
 * ```
 *
 * ⭐ **THIS MODULE EXISTS FOR ITS SIDE EFFECT.** Importing it patches
 * `Query.prototype` with the ten Relate methods and fills the executor's join
 * hooks; the `declare module` block below merges the same methods into the
 * `Query` TYPE, so the method and its signature arrive together and a call
 * without this import does not compile.
 *
 * ⚠️ It is listed in `package.json`'s `sideEffects` array for exactly that
 * reason. A bundler told `sideEffects: false` about this file would drop the
 * import — and the failure is a runtime `QueryExtensionMissingError` in
 * production from code that typechecked. Do not remove it from that list.
 *
 * The value exports below are the free functions Relate has always published
 * through `@noy-db/hub/query`; they moved here with their group.
 */
import type { RelateSurface } from './methods.js'
import type { ScanRelateSurface } from './scan-methods.js'
import { installRelate } from './install.js'

// ⭐ The statement that makes this file an ENTRY. Keep it here, and keep the
// work in `./install.ts` — see that file for the measured reason.
installRelate()

declare module '../builder.js' {
  // #1458 — the empty body is the mechanism, not an oversight. Interface
  // merging is what attaches the group's methods to the class declared in
  // `builder.ts` / `scan-builder.ts`; the members come from the `Pick` in the
  // `extends` clause, so writing any here would duplicate signatures that must
  // not be allowed to drift from the implementations.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Query<
    T,
    S extends keyof T = never,
    Q extends keyof T & string = never,
    M extends keyof T & string = never,
  > extends RelateSurface<T, S, Q, M> {}
}

declare module '../scan-builder.js' {
  // #1458 — the empty body is the mechanism, not an oversight. Interface
  // merging is what attaches the group's methods to the class declared in
  // `builder.ts` / `scan-builder.ts`; the members come from the `Pick` in the
  // `extends` clause, so writing any here would duplicate signatures that must
  // not be allowed to drift from the implementations.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ScanBuilder<T, S extends keyof T = never, M extends keyof T & string = never>
    extends ScanRelateSurface<T, S, M> {}
}

// ─── The Relate free functions and types ────────────────────────────────
export { applyJoins, DEFAULT_JOIN_MAX_ROWS, DEFAULT_CROSS_JOIN_MAX_ROWS, resetJoinWarnings } from './join.js'
export type { JoinLeg, JoinContext, JoinableSource, JoinStrategy, JoinDirection } from './join.js'
export type { JoinOnSpec, JoinOnPlan, JoinOnOp } from './join-on.js'
export { runTraversal } from './traverse.js'
export type { TraversalRow, TraverseOptions, TraverseDirection, TraverseSource, CyclePolicy } from './traverse.js'
export { explainPlan, renderExplainText } from './explain.js'
export type { QueryExplanation, ExplainNode, ExplainCap, ExplainDispatch, ExplainSource, ExplainIndexProbe } from './explain.js'
// Partition pruning (#1342, ADR 0007) — shared by the executor and explain().
export {
  ALL_PARTITIONS,
  describePartitionScope,
  partitionsInScope,
  resolvePartitionScope,
} from './partition.js'
export type { PartitionScope } from './partition.js'
// #1458 — `explainPlan(plan)` and `resolvePartitionScope(clauses)` name Find's
// `QueryPlan` and `Clause` in their signatures, so this entry has to publish
// them too or a consumer on `/relate` alone cannot spell the argument.
// Re-exported from Find rather than redeclared: one definition, and the two
// subpaths' `QueryPlan` stay the same type.
export type { QueryPlan } from '../builder.js'
export type { Clause } from '../predicate.js'
export {
  JoinTooLargeError,
  DanglingReferenceError,
  TraversalCycleError,
  CrossJoinTooLargeError,
  CrossJoinSourceUnknownError,
} from '../../errors.js'
