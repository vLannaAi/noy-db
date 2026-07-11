import { DerivationCycleError } from '../../kernel/errors.js'
import { ViaGraph, type FieldRef, type EdgeKind, type Grain } from '../../kernel/via-graph.js'
import { computeStrategyHash } from './strategy-hash.js'
import type { DerivationStrategy } from './types.js'

/**
 * Whole-record artifact-grain field marker (#638 Task 2). A derivation's
 * `derive()`/a rollup's `compute()` reads the WHOLE source record — there is
 * no single declared field to point at — so a trigger/output collection is
 * modelled as one artifact node per collection (`kernel/via-graph.ts`'s
 * "Artifact-grain targets... modelled as a field node whose field is the
 * artifact key" convention). MUST match `materialized-views/registry.ts`'s
 * and `vault.ts`'s overlay-edge marker so cross-registry edges (a derivation
 * feeding into / out of an MV or overlay collection) resolve to the SAME
 * graph node.
 */
const WHOLE_RECORD = '*'

/** Strip this registry's `.${WHOLE_RECORD}` artifact suffix off a graph cycle
 *  path entry, recovering the bare collection name — preserves the exact
 *  pre-#638 `DerivationCycleError` message shape (behavior lock) for a pure
 *  record-shape derivation cycle. A rollup's real-field target (not suffixed
 *  `.${WHOLE_RECORD}`) is left untouched. */
function stripArtifactSuffix(displayId: string): string {
  const suffix = `.${WHOLE_RECORD}`
  return displayId.endsWith(suffix) ? displayId.slice(0, -suffix.length) : displayId
}

interface RegisteredStrategy {
  // Type-erased to allow the registry to hold heterogeneous strategies.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spec: DerivationStrategy<any, any>
  strategyHash: string
}

/**
 * Vault-internal registry of derivation strategies. Owned by `Vault`;
 * not exported.
 *
 * @internal
 */
export class DerivationRegistry {
  private readonly _bySource = new Map<string, RegisteredStrategy[]>()
  private readonly _byOutput = new Map<string, RegisteredStrategy[]>()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async register(spec: DerivationStrategy<any, any>): Promise<void> {
    const outputKeys = Object.keys(spec.outputs)
    const strategyHash = await computeStrategyHash(spec.source, outputKeys, spec.derive, spec.sources)
    const reg: RegisteredStrategy = { spec, strategyHash }

    const fromSource = this._bySource.get(spec.source)
    if (fromSource) fromSource.push(reg)
    else this._bySource.set(spec.source, [reg])

    // Declared sibling sources index the SAME `reg` under each
    // extra collection so `strategiesForSource(extra)` returns it and a
    // sibling write re-fires the derivation. Sibling keys also enter
    // `_bySource`, so `validate()`'s cycle DFS walks them automatically.
    for (const extra of spec.sources ?? []) {
      const fromExtra = this._bySource.get(extra)
      if (fromExtra) fromExtra.push(reg)
      else this._bySource.set(extra, [reg])
    }

    // FK triggers index the SAME `reg` under each parent collection so
    // a parent write re-fires the derivation (fanned out to matching source
    // records in `dispatchDerivations`). Like sources[], these keys enter
    // `_bySource` so the cycle DFS walks the trigger→output edge.
    for (const t of spec.triggerBy ?? []) {
      const fromTrigger = this._bySource.get(t.collection)
      if (fromTrigger) fromTrigger.push(reg)
      else this._bySource.set(t.collection, [reg])
    }

    // Rollup: a write to the child `from` collection recomputes
    // the parent (= spec.source = into) at id child[key]. Index under `from`
    // so a child write fires it; spec.source (into) is already indexed above,
    // so a parent write also recomputes its own aggregate (covers the
    // parent-created-after-children case). The from→into edge enters the cycle
    // DFS automatically.
    if (spec.rollup) {
      const fromRollup = this._bySource.get(spec.rollup.from)
      if (fromRollup) fromRollup.push(reg)
      else this._bySource.set(spec.rollup.from, [reg])
    }

    for (const key of outputKeys) {
      const output = spec.outputs[key]
      if (!output) continue
      const outputCollection = output.collection
      const arr = this._byOutput.get(outputCollection)
      if (arr) arr.push(reg)
      else this._byOutput.set(outputCollection, [reg])
    }
  }

  strategiesForSource(source: string): ReadonlyArray<RegisteredStrategy> {
    return this._bySource.get(source) ?? []
  }

  strategiesProducingOutput(collection: string): ReadonlyArray<RegisteredStrategy> {
    return this._byOutput.get(collection) ?? []
  }

  /**
   * All registered strategies as a flat, deduplicated array.
   * Each strategy is indexed once per source (not once per output key),
   * so iterating `_bySource.values()` naturally yields each strategy
   * exactly once per source — deduplication is handled by flattening
   * the per-source arrays and collecting into a Set by identity.
   *
   * Used by `dumpSchema()` / `describeDerivations()` in the introspection
   * walker to populate the derivations map.
   */
  all(): ReadonlyArray<RegisteredStrategy> {
    const seen = new Set<RegisteredStrategy>()
    for (const strategies of this._bySource.values()) {
      for (const s of strategies) seen.add(s)
    }
    return [...seen]
  }

  /**
   * Graph edges for #638 Task 2: one `'derivation'`/`'record'` edge per
   * (non-self-write) output key — target = the output collection (a
   * `WHOLE_RECORD` artifact node), sources = every collection that can
   * trigger this strategy (`source`, `sources[]`, `triggerBy[].collection`,
   * and — for a rollup — `rollup.from`), mirroring EXACTLY the trigger keys
   * `register()` indexes under `_bySource`. The self-write reverse-denorm
   * output (`output.collection === source` with `denorm` declared) is
   * skipped — the SAME condition the old local DFS used; it is not a cycle
   * (see the comment `validate()` used to carry, now on this skip).
   * Rollups ADDITIONALLY get a dedicated `'rollup'`/`'aggregate'` edge
   * targeting the real `rollup.field` on the parent (`source`) — the
   * self-write output above only covers the cycle-DFS skip, not
   * dispatch/taint (Tasks 3/4/6), which need the real field.
   */
  edges(): ReadonlyArray<{ readonly target: FieldRef; readonly sources: readonly FieldRef[]; readonly kind: EdgeKind; readonly grain: Grain }> {
    const out: Array<{ target: FieldRef; sources: FieldRef[]; kind: EdgeKind; grain: Grain }> = []
    for (const reg of this.all()) {
      const spec = reg.spec
      const triggerCollections = [
        spec.source,
        ...(spec.sources ?? []),
        ...(spec.triggerBy ?? []).map((t) => t.collection),
        ...(spec.rollup ? [spec.rollup.from] : []),
      ]
      const sources: FieldRef[] = triggerCollections.map((c) => ({ collection: c, field: WHOLE_RECORD }))
      for (const key of Object.keys(spec.outputs)) {
        const output = spec.outputs[key]
        if (!output) continue
        if (output.shape === 'record' && output.collection === spec.source && output.denorm !== undefined) continue
        out.push({ target: { collection: output.collection, field: WHOLE_RECORD }, sources, kind: 'derivation', grain: 'record' })
      }
      if (spec.rollup) {
        out.push({
          target: { collection: spec.source, field: spec.rollup.field },
          sources: [{ collection: spec.rollup.from, field: WHOLE_RECORD }],
          kind: 'rollup',
          grain: 'aggregate',
        })
      }
    }
    return out
  }

  /**
   * Cycle detection, delegated to `ViaGraph.assertAcyclic()` (#638 Task 2 —
   * retires the local DFS). Call after all `register()` calls complete (i.e.
   * at vault open). Throws `DerivationCycleError` on the first cycle found —
   * SAME class/timing as before; the message/path is byte-identical to the
   * pre-#638 shape for a pure record-shape derivation cycle (the
   * `WHOLE_RECORD` artifact suffix is stripped back to a bare collection
   * name before re-throwing).
   *
   * `graph` is the caller's shared per-vault graph, ALREADY carrying this
   * registry's `edges()` (the caller registers them — see `Vault._initDerivations`)
   * — omit it (e.g. this registry's own unit tests) to validate this
   * registry's edges in isolation against a throwaway graph.
   */
  validate(graph?: ViaGraph): void {
    const g = graph ?? new ViaGraph()
    if (!graph) {
      for (const edge of this.edges()) g.registerDerived(edge.target, edge.sources, edge.kind, edge.grain)
    }
    try {
      g.assertAcyclic()
    } catch (e) {
      if (e instanceof DerivationCycleError) throw new DerivationCycleError(e.path.map(stripArtifactSuffix))
      throw e
    }
  }
}
