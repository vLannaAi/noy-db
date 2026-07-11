// kernel/via-graph-wiring.ts — thin per-vault wiring that feeds `ViaGraph`
// from the collection-declare edge sources (via bindings' `deps`, `computed`)
// at collection-construction time (#638 Task 2). The with-formula (derivation/
// MV/overlay) edge sources are registered directly by `Vault._initDerivations`/
// `_initMaterializedViews`/`_initOverlayedViews` from their registries' own
// `edges()` accessors — this file only covers the per-collection sources,
// which fire on every `Vault.collection()` call, not just vaults that declare
// a derivation/MV/overlay strategy.
import type { ViaGraph } from './via-graph.js'
import { resolveCollectionConfig, type CollectionOpts } from './collection-config.js'

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
