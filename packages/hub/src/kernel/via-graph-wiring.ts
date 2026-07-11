// kernel/via-graph-wiring.ts — thin per-vault wiring that feeds `ViaGraph`
// from the collection-declare edge sources (via bindings' `deps`, `computed`)
// at collection-construction time (#638 Task 2). The with-formula (derivation/
// MV/overlay) edge sources are registered directly by `Vault._initDerivations`/
// `_initMaterializedViews`/`_initOverlayedViews` from their registries' own
// `edges()` accessors — this file only covers the per-collection sources,
// which fire on every `Vault.collection()` call, not just vaults that declare
// a derivation/MV/overlay strategy.
import type { ViaGraph } from './via-graph.js'
import { resolveCollectionConfig, resolveComputedEdges, type CollectionOpts } from './collection-config.js'
import { resolveClassifiedFields, type ClassifiedEntry } from '../port/with/classified-strategy.js'

// `ComputedFields` is a with-formula/computed type; the kernel spine may not
// statically import a with-* service (S5 port-layering — see
// scripts/check-architecture.mjs's checkPortLayering). Derive the type from
// the already-permitted `resolveComputedEdges` signature (collection-config.ts
// is grandfathered for the real with-formula import) instead of importing it
// directly here.
type ComputedFieldsParam = NonNullable<Parameters<typeof resolveComputedEdges>[1]>

/**
 * Register one collection's field postures (`binding.posture` + `covers()`)
 * and computed/via-binding-deps edges onto the vault's shared graph. Called
 * from `Vault.collection()`'s fresh-construction path, right after the real
 * `Collection` is built from the SAME `opts` — `resolveCollectionConfig` is a
 * pure function, so re-running it here (Collection's constructor already ran
 * it once internally) costs a one-time, side-effect-free recomputation at
 * collection-declare time, not a per-write cost.
 */
export function registerCollectionGraphSources<T>(graph: ViaGraph, name: string, opts: CollectionOpts<T>): void {
  const cfg = resolveCollectionConfig(opts)
  const bindings = cfg.via?.bindings ?? []
  const knownFields = new Set<string>([
    ...Object.keys(cfg.moneyFields ?? {}),
    ...Object.keys(cfg.i18nFields ?? {}),
    ...Object.keys(cfg.dictKeyFields ?? {}),
    ...(cfg.classified !== undefined ? Object.keys(cfg.classified.byField) : []),
  ])
  for (const field of knownFields) {
    for (const binding of bindings) {
      if (binding.covers?.(field)) {
        graph.registerField(name, field, binding.posture)
        break
      }
    }
  }
  for (const edge of cfg.computedEdges) graph.registerDerived(edge.target, edge.sources, 'computed', 'record')
  for (const edge of cfg.viaDepsEdges) graph.registerDerived(edge.target, edge.sources, 'computed', 'record')
}

/** The slice of `Vault.collection()`'s reconcile-path options relevant to
 *  graph registration — money/computed/classifiedFields are the only
 *  options `Vault.collection()`'s reconcile branches actually attach
 *  (i18nFields/dictKeyFields are construction-only, never reconciled). */
export interface ReconcileGraphOptions {
  readonly moneyFields?: Record<string, unknown>
  readonly classifiedFields?: Record<string, ClassifiedEntry>
  readonly computed?: ComputedFieldsParam
  readonly computedDeps?: Record<string, readonly string[]>
}

/**
 * Reconcile-path counterpart to {@link registerCollectionGraphSources} (#638
 * Task 2 review fix — Finding 1). A collection an MV's `query(db)` callback
 * auto-pre-creates BARE, later declared for real via `Vault.collection()`'s
 * `coll && options?.computed` reconcile branch, used to skip graph
 * registration entirely: no `resolveComputedEdges` call meant no depsless-
 * plus-classified anti-leak throw and no `computedDeps` edges. This runs the
 * SAME validation + registration the fresh-construction path runs, scoped to
 * THIS reconcile call's own options — a bare pre-created collection carries
 * no prior money/computed/classified state, so the realistic MV pattern
 * (bare pre-create, then ONE later full declare) needs no cross-call
 * accumulation. Callers MUST invoke this before mutating the collection
 * (`Collection._applyComputed`/`_applyClassifiedFields`) so a thrown
 * `ValidationError` leaves no partial state.
 */
export function reconcileCollectionGraphEdges(graph: ViaGraph, name: string, options: ReconcileGraphOptions): void {
  if (options.computed === undefined) return
  const resolvedClassified = options.classifiedFields !== undefined
    ? resolveClassifiedFields(name, options.classifiedFields)
    : undefined
  const knownFields = new Set<string>([
    ...Object.keys(options.moneyFields ?? {}),
    ...(resolvedClassified !== undefined ? Object.keys(resolvedClassified.byField) : []),
    ...Object.keys(options.computed),
  ])
  const edges = resolveComputedEdges(name, options.computed, options.computedDeps, knownFields, resolvedClassified !== undefined)
  for (const edge of edges) graph.registerDerived(edge.target, edge.sources, 'computed', 'record')
}
