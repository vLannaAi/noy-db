import { MaterializedViewCycleError, MaterializedViewSourceUnknownError } from '../errors.js'
import type { DerivationRegistry } from '../derivations/registry.js'
import { analyzeDependencies, summarizeQueryPlan } from './dependency-analyzer.js'
import { computeQueryHash } from './query-hash.js'
import type { MaterializedViewStrategy, MVQueryContext } from './types.js'

/**
 * One registered MV strategy alongside its derived metadata. Stored
 * type-erased on `TRow` so the registry can hold heterogeneous MVs.
 */
export interface RegisteredMV {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly spec: MaterializedViewStrategy<any>
  /** Output collection name (`spec.output?.collection ?? spec.name`). */
  readonly outputCollection: string
  /** Set of source collections; populated at registration via the analyzer. */
  readonly dependencies: ReadonlySet<string>
  /** Canonical `queryHash` — `_materializedFrom.queryHash` for every emitted row. */
  readonly queryHash: string
}

/**
 * Vault-internal registry of MV strategies. Owned by `Vault`; not
 * exported. Parallel to v1's `DerivationRegistry`; the two graphs share
 * a single cycle-detection pass at vault open (see `validate`).
 *
 * @internal
 */
export class MaterializedViewRegistry {
  /** Keyed by `spec.name`. */
  private readonly _byName = new Map<string, RegisteredMV>()
  /** Keyed by dependency source-collection → MVs that depend on it. */
  private readonly _bySource = new Map<string, RegisteredMV[]>()

  /**
   * Register an MV. Invokes `spec.query()` once at registration time to
   * read the plan + join context; the resulting `Query<T>` is discarded
   * after dependency extraction. `vault.collection(...)` must therefore
   * be functional by the time this runs — typically wired from
   * `Vault._initMaterializedViews` after collection bootstrap.
   *
   * Throws `MaterializedViewSourceUnknownError` if the analyzer
   * surfaces a dependency the vault doesn't know about (when a
   * `knownCollections` checker is supplied).
   */
  async register(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spec: MaterializedViewStrategy<any>,
    db: MVQueryContext,
    options?: { knownCollections?: (name: string) => boolean },
  ): Promise<void> {
    // Invoke the query callback once to inspect its plan.
    const q = spec.query(db)
    const dependencies = analyzeDependencies(q)
    const queryPlanSummary = summarizeQueryPlan(q)

    // Sanity-check declared dependencies against the vault's known
    // collections. Optional — when the checker isn't supplied (test
    // wiring, in-process composition) the registration succeeds and
    // any typo surfaces at first onSourceWrite as a no-op.
    if (options?.knownCollections) {
      for (const dep of dependencies) {
        if (!options.knownCollections(dep)) {
          throw new MaterializedViewSourceUnknownError(spec.name, dep)
        }
      }
    }

    const outputCollection = spec.output?.collection ?? spec.name
    const queryHash = await computeQueryHash(spec.name, dependencies, queryPlanSummary)
    const reg: RegisteredMV = { spec, outputCollection, dependencies, queryHash }

    this._byName.set(spec.name, reg)
    for (const dep of dependencies) {
      const arr = this._bySource.get(dep)
      if (arr) arr.push(reg)
      else this._bySource.set(dep, [reg])
    }
  }

  /** All MVs that depend on `source`, in registration order. */
  mvsForSource(source: string): ReadonlyArray<RegisteredMV> {
    return this._bySource.get(source) ?? []
  }

  /** Single MV by name, or `undefined`. */
  byName(name: string): RegisteredMV | undefined {
    return this._byName.get(name)
  }

  /** Iterate over every registered MV. */
  all(): ReadonlyArray<RegisteredMV> {
    return [...this._byName.values()]
  }

  /**
   * Cycle detection over the combined derivation + MV graph. Edges:
   *   - Derivation: derivation.source → output.collection (each output)
   *   - MV: every dep in MV.dependencies → MV.outputCollection
   *
   * Throws `MaterializedViewCycleError` if the cycle's terminal node
   * is an MV output collection; otherwise (a pure-derivation cycle)
   * the caller's `DerivationRegistry.validate()` will surface
   * `DerivationCycleError` separately at vault open.
   *
   * Call AFTER all `register()` calls complete.
   */
  validate(derivationRegistry?: DerivationRegistry | null): void {
    const visited = new Set<string>()
    const stack: string[] = []
    const mvOutputs = new Set<string>()
    for (const reg of this._byName.values()) mvOutputs.add(reg.outputCollection)

    const edges = new Map<string, string[]>()

    // MV edges: every dep → output
    for (const reg of this._byName.values()) {
      for (const dep of reg.dependencies) {
        const arr = edges.get(dep)
        if (arr) arr.push(reg.outputCollection)
        else edges.set(dep, [reg.outputCollection])
      }
    }

    // Derivation edges: source → output collections
    if (derivationRegistry) {
      // The shared DerivationRegistry exposes its edges via the same
      // `strategiesForSource` API its own `validate()` uses. We don't
      // duplicate cycle detection — we add MV nodes to the graph and
      // run the unified DFS, attributing cycles that touch an MV
      // output to `MaterializedViewCycleError`.
      for (const reg of this._byName.values()) {
        // Walk every dependency through derivation edges too: a
        // derivation whose output we depend on is itself a source.
        void reg
      }
      // Pull derivation edges by scanning every MV dep + every MV
      // output as potential derivation sources.
      const sourcesToScan = new Set<string>()
      for (const reg of this._byName.values()) {
        for (const dep of reg.dependencies) sourcesToScan.add(dep)
        sourcesToScan.add(reg.outputCollection)
      }
      for (const src of sourcesToScan) {
        const strategies = derivationRegistry.strategiesForSource(src)
        if (strategies.length === 0) continue
        for (const s of strategies) {
          for (const key of Object.keys(s.spec.outputs)) {
            const o = s.spec.outputs[key]
            if (!o) continue
            const arr = edges.get(src)
            if (arr) arr.push(o.collection)
            else edges.set(src, [o.collection])
          }
        }
      }
    }

    const visit = (node: string): void => {
      if (stack.includes(node)) {
        const cycle = stack.slice(stack.indexOf(node)).concat(node)
        // If any node on the cycle is an MV output, attribute as MV
        // cycle. Otherwise let DerivationRegistry.validate() surface it.
        if (cycle.some(n => mvOutputs.has(n))) {
          throw new MaterializedViewCycleError(cycle)
        }
        // Pure-derivation cycle — caller's DerivationRegistry.validate()
        // will catch it separately. Don't double-report.
        return
      }
      if (visited.has(node)) return
      stack.push(node)
      const outs = edges.get(node)
      if (outs) for (const o of outs) visit(o)
      stack.pop()
      visited.add(node)
    }

    for (const node of edges.keys()) visit(node)
  }
}
