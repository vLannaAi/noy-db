import { MaterializedViewCycleError, MaterializedViewSourceUnknownError } from '../errors.js'
import type { DerivationRegistry } from '../derivations/registry.js'
import type { Clause, FieldClause } from '../query/predicate.js'
import type { DeclaredPredicate } from '../query/builder.js'
import { analyzeDependencies, summarizeQueryPlan, summarizeUnionPlan } from './dependency-analyzer.js'
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
  /**
   * Top-level FieldClauses on the partition field, captured at
   * registration time. Used by the cycle detector to resolve
   * same-collection-as-source edges via the partition-discriminator
   * check (#152). Empty when `spec.output?.partition` is undefined.
   */
  readonly partitionClauses: readonly FieldClause[]
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
    // Build a predicate-aware db wrapper (#153). If `spec.predicates` is
    // declared, the wrapper intercepts `.collection().query()` and
    // attaches the predicates map to the resulting Query<T>. With no
    // predicates declared, the wrapper is the original db unchanged.
    const dbForQuery = spec.predicates ? wrapDbWithPredicates(db, spec.predicates) : db

    // Invoke the query callback once to inspect its plan / dependencies.
    // For Query<T> shapes the analyzer extracts deps + plan summary
    // automatically. Aggregation / GroupedAggregation shapes don't
    // expose the underlying Query, so the spec must declare `sources`
    // explicitly. `partitionClauses` are only populated for Query<T>
    // since same-collection-partition is a non-aggregate concern.
    // UNION-form strategies (#165): dependencies and plan summary come
    // straight off the strategy — no `query` callback to introspect.
    // The dependency-analyzer + summarizer are bypassed entirely; the
    // executor handles materialization via `materializeUnionResult`.
    let dependencies: Set<string>
    let queryPlanSummary: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let qAny: any = null
    let isQuery = false
    if (spec.unionSources) {
      dependencies = new Set(spec.unionSources.map(s => s.collection))
      queryPlanSummary = summarizeUnionPlan(spec)
    } else {
      const q = spec.query!(dbForQuery)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      qAny = q as any
      isQuery = typeof qAny._plan === 'function'
      if (isQuery) {
        dependencies = analyzeDependencies(q)
        queryPlanSummary = summarizeQueryPlan(q)
        // Fold `.wherePredicate(name, ctx)` references into the plan
        // summary so predicate function or ctx changes (signalled by
        // bumping `hash` or supplying a different ctx) propagate into
        // `queryHash` and force refresh on next visit.
        const predicateRefs = extractPredicateRefs(qAny._plan())
        if (predicateRefs.length > 0) {
          queryPlanSummary = JSON.stringify({ plan: queryPlanSummary, predicates: predicateRefs })
        }
        // If `sources` is ALSO declared, take the union (consumer's
        // explicit list extends the auto-analyzed set).
        if (spec.sources) for (const s of spec.sources) dependencies.add(s)
      } else {
        // Aggregate shape: require explicit `sources`.
        if (!spec.sources || spec.sources.length === 0) {
          throw new Error(
            `withMaterializedView "${spec.name}": query() returned an aggregate ` +
              `(Aggregation or GroupedAggregation) but no \`sources\` field is declared. ` +
              `The dependency analyzer cannot walk through groupBy().aggregate() ` +
              `back to the source — declare sources: [...] explicitly.`,
          )
        }
        dependencies = new Set(spec.sources)
        // Aggregate plans don't carry a chainable query plan for summary
        // purposes; the dep-set + spec.name serve as the queryHash inputs.
        queryPlanSummary = JSON.stringify({ aggregate: true, sources: [...spec.sources].sort() })
      }
    }

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
    // For same-collection-as-source MVs, capture the where-clauses on
    // the partition field so cycle detection can prove disjointness.
    // Only applicable to Query<T> shapes — aggregate MVs don't carry
    // a chainable plan to inspect (and same-collection aggregation
    // doesn't make sense in the niwat use cases that motivated #152).
    const partitionClauses: FieldClause[] = []
    const partitionField = spec.output?.partition?.field
    if (partitionField !== undefined && isQuery) {
      const plan = qAny._plan()
      for (const clause of plan.clauses) {
        if (isFieldClauseOnField(clause, partitionField)) partitionClauses.push(clause)
      }
    }
    const reg: RegisteredMV = { spec, outputCollection, dependencies, queryHash, partitionClauses }

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

    // MV edges: every dep → output. Same-collection edges (dep ===
    // outputCollection) are skipped IFF the MV declares an
    // `output.partition` discriminator AND the query has a where-clause
    // that provably excludes the partition value. Otherwise the cycle
    // detector treats the edge as real — naïve same-collection MVs
    // surface as `MaterializedViewCycleError`.
    for (const reg of this._byName.values()) {
      for (const dep of reg.dependencies) {
        if (dep === reg.outputCollection && partitionDisjoint(reg)) continue
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

/**
 * Type guard: is the clause a top-level `FieldClause` on the given
 * field? Used by the partition-disjoint check.
 *
 * @internal
 */
function isFieldClauseOnField(clause: Clause, field: string): clause is FieldClause {
  return clause.type === 'field' && clause.field === field
}

/**
 * Wrap an `MVQueryContext` so its `.collection().query()` returns a
 * Query<T> with the MV's declared predicates attached. Bare Queries
 * (outside of any MV) don't gain `.wherePredicate()` — only Queries
 * obtained through this wrapped db do.
 *
 * @internal
 */
export function wrapDbWithPredicates(
  db: MVQueryContext,
  predicates: NonNullable<MaterializedViewStrategy<Record<string, unknown>>['predicates']>,
): MVQueryContext {
  // Build the predicate map once — the fn signature in the MV spec
  // is row-typed but the QueryBuilder casts to unknown, so we widen
  // here for the Map.
  const map = new Map<string, DeclaredPredicate>()
  for (const [name, decl] of Object.entries(predicates)) {
    map.set(name, {
      hash: decl.hash,
      fn: decl.fn as (record: unknown, ctx?: unknown) => boolean,
    })
  }
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    collection<T extends Record<string, unknown>>(name: string): any {
      const c = db.collection<T>(name)
      // Return an object that delegates everything to `c` but
      // overrides `.query()` to attach predicates via the new
      // `Query._withPredicates()` accessor.
      return new Proxy(c, {
        get(target, prop, receiver) {
          if (prop === 'query') {
            return (...args: unknown[]) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const q = (target.query as any)(...args)
              // For non-aggregate Query<T>, attach predicates. For
              // legacy predicate-arg overload that returns T[] (sync
              // filter), pass through unchanged.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if (q && typeof q._withPredicates === 'function') {
                return q._withPredicates(map)
              }
              return q
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })
    },
  }
}

/**
 * Walk a QueryPlan's clauses and collect predicate-reference markers
 * for `queryHash` derivation. Returns a sorted array (deterministic
 * order) of `{ name, predicateHash, ctxHash }` tuples — these are the
 * hashable identity of each `.wherePredicate()` call site.
 *
 * @internal
 */
function extractPredicateRefs(
  plan: { clauses: readonly Clause[] },
): Array<{ name: string; predicateHash: string; ctxHash: string }> {
  const refs: Array<{ name: string; predicateHash: string; ctxHash: string }> = []
  const walk = (clauses: readonly Clause[]): void => {
    for (const c of clauses) {
      if (c.type === 'wherePredicate') {
        refs.push({ name: c.name, predicateHash: c.predicateHash, ctxHash: c.ctxHash })
      } else if (c.type === 'group') {
        walk(c.clauses)
      }
    }
  }
  walk(plan.clauses)
  // Stable-sort by (name, predicateHash, ctxHash) — same predicate
  // appearing twice with different ctx hashes both flow through.
  refs.sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1
    if (a.predicateHash !== b.predicateHash) return a.predicateHash < b.predicateHash ? -1 : 1
    return a.ctxHash < b.ctxHash ? -1 : a.ctxHash > b.ctxHash ? 1 : 0
  })
  return refs
}

/**
 * Provability check for the same-collection partition-discriminator
 * (#152, spec § Same-collection-as-source MV). Returns `true` when
 * the captured partition clauses on the MV's query provably exclude
 * the partition's value — meaning the input filter and the output
 * partition are disjoint and the same-collection edge isn't really a
 * cycle.
 *
 * Supported provability shapes (narrow on purpose — niwat's DERIV-
 * PP30-001 is the load-bearing case):
 *
 * - `.where(field, '==', X)` where X !== partition.value → disjoint
 * - `.where(field, '!=', partition.value)` → disjoint
 * - `.where(field, 'in', [...])` where partition.value NOT in list → disjoint
 *
 * Anything else (no clause on the partition field, an 'in' list that
 * contains partition.value, unsupported operators) → not disjoint,
 * the cycle detector surfaces `MaterializedViewCycleError`.
 *
 * @internal
 */
function partitionDisjoint(reg: RegisteredMV): boolean {
  const partition = reg.spec.output?.partition
  if (partition === undefined) return false
  const value = partition.value
  // The OR-semantics of multiple where-clauses on the same field
  // would muddy this check. v2 only treats AND-chained clauses;
  // any clause that proves disjoint is sufficient.
  for (const c of reg.partitionClauses) {
    if (c.op === '==' && c.value !== value) return true
    if (c.op === '!=' && c.value === value) return true
    if (c.op === 'in' && Array.isArray(c.value)) {
      const list = c.value as readonly unknown[]
      if (!list.includes(value)) return true
    }
  }
  return false
}
