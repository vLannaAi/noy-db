import { DerivationCycleError } from '../errors.js'
import { computeStrategyHash } from './strategy-hash.js'
import type { DerivationStrategy } from './types.js'

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

    // Declared sibling sources (#344) index the SAME `reg` under each
    // extra collection so `strategiesForSource(extra)` returns it and a
    // sibling write re-fires the derivation. Sibling keys also enter
    // `_bySource`, so `validate()`'s cycle DFS walks them automatically.
    for (const extra of spec.sources ?? []) {
      const fromExtra = this._bySource.get(extra)
      if (fromExtra) fromExtra.push(reg)
      else this._bySource.set(extra, [reg])
    }

    // FK triggers (#376) index the SAME `reg` under each parent collection so
    // a parent write re-fires the derivation (fanned out to matching source
    // records in `dispatchDerivations`). Like sources[], these keys enter
    // `_bySource` so the cycle DFS walks the trigger→output edge.
    for (const t of spec.triggerBy ?? []) {
      const fromTrigger = this._bySource.get(t.collection)
      if (fromTrigger) fromTrigger.push(reg)
      else this._bySource.set(t.collection, [reg])
    }

    // Rollup (#376 slice 2): a write to the child `from` collection recomputes
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
   * Cycle detection over the source → output → … graph. Call after all
   * `register()` calls complete (i.e. at vault open). Throws
   * `DerivationCycleError` on the first cycle found.
   */
  validate(): void {
    const visited = new Set<string>()
    const stack: string[] = []

    const visit = (node: string): void => {
      if (stack.includes(node)) {
        const cycle = stack.slice(stack.indexOf(node)).concat(node)
        throw new DerivationCycleError(cycle)
      }
      if (visited.has(node)) return
      stack.push(node)
      const strategies = this._bySource.get(node)
      if (strategies) {
        for (const s of strategies) {
          for (const key of Object.keys(s.spec.outputs)) {
            const output = s.spec.outputs[key]
            if (!output) continue
            // Self-write reverse-denorm (#376): an output back to its own
            // source is intentional, not an infinite cycle — the value-equality
            // guard in dispatch terminates it. Skip this edge so it isn't
            // flagged. (Self-write outputs are required to declare `denorm`.)
            if (
              output.shape === 'record' &&
              output.collection === s.spec.source &&
              output.denorm !== undefined
            ) {
              continue
            }
            visit(output.collection)
          }
        }
      }
      stack.pop()
      visited.add(node)
    }

    for (const src of this._bySource.keys()) visit(src)
  }
}
