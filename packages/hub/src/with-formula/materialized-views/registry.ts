import { MaterializedViewSourceUnknownError } from '../../kernel/errors.js'
import type { ViaGraph, FieldRef, EdgeKind, Grain } from '../../kernel/via/graph.js'
import type { Clause, FieldClause } from '../../kernel/query/predicate.js'
import type { DeclaredPredicate } from '../../kernel/query/builder.js'
import { analyzeDependencies, summarizeQueryPlan, summarizeUnionPlan, summarizeProjectionPlan } from './dependency-analyzer.js'
import { computeQueryHash } from './query-hash.js'
import type { MaterializedViewStrategy, MVQueryContext } from './types.js'

/**
 * Whole-record artifact-grain field marker (#638 Task 2) — MUST match
 * `derivations/registry.ts`'s and `vault.ts`'s overlay-edge marker so
 * cross-registry edges (a derivation feeding an MV, or vice versa) resolve
 * to the SAME graph node. See that file's `WHOLE_RECORD` doc comment.
 */
const WHOLE_RECORD = '*'

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
   * check. Empty when `spec.output?.partition` is undefined.
   */
  readonly partitionClauses: readonly FieldClause[]
  /**
   * #638 Task 2 — `'record'` for a row-per-source-row Query<T> or
   * `unionSources` MV, `'aggregate'` for a `.groupBy().aggregate()` MV
   * (the shape that requires explicit `sources`, since the dependency
   * analyzer can't walk an aggregate plan). Feeds `edges()`'s grain.
   */
  readonly grain: Grain
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
   * Projection MVs (#810) whose forward-leg ref() targets could not be
   * resolved at registration time. A forward leg names only the FK
   * FIELD; its dependency is the field's ref() TARGET, declared on the
   * source collection — but registration runs at vault open, BEFORE
   * user code declares collections (and their refs). Constructing the
   * source collection here to look them up would be worse: a later
   * `vault.collection(source, { refs })` call only registers refs on a
   * cache miss, so an early construction would silently drop them.
   * Instead each entry carries a non-constructive ref-registry probe;
   * `mvsForSource` retries on every dispatch until every forward
   * target has resolved (see `_resolvePendingForwardDeps`).
   */
  private readonly _pendingForwardDeps: Array<{
    reg: RegisteredMV
    fields: Set<string>
    resolveTarget: (field: string) => string | null
  }> = []

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
    // Build a predicate-aware db wrapper. If `spec.predicates` is
    // declared, the wrapper intercepts `.collection().query()` and
    // attaches the predicates map to the resulting Query<T>. With no
    // predicates declared, the wrapper is the original db unchanged.
    const dbForQuery = spec.predicates ? wrapDbWithPredicates(db, spec.predicates) : db

    // Invoke the query callback once to inspect its plan / dependencies.
    // For Query<T> shapes the analyzer extracts deps + plan summary
    // automatically. Reduction / GroupedReduction shapes don't
    // expose the underlying Query, so the spec must declare `sources`
    // explicitly. `partitionClauses` are only populated for Query<T>
    // since same-collection-partition is a non-aggregate concern.
    // UNION-form strategies: dependencies and plan summary come
    // straight off the strategy — no `query` callback to introspect.
    // The dependency-analyzer + summarizer are bypassed entirely; the
    // executor handles materialization via `materializeUnionResult`.
    let dependencies: Set<string>
    let queryPlanSummary: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let qAny: any = null
    let isQuery = false
    // Projection-form (#810): forward legs whose ref() target wasn't
    // resolvable at registration time — folded in lazily, see
    // `_pendingForwardDeps`.
    const pendingForwardFields: string[] = []
    if (spec.unionSources) {
      dependencies = new Set(spec.unionSources.map(s => s.collection))
      // Per-arm joins resolve right-side collections that aren't among
      // the arm `collection`s. The consumer lists those in `sources`;
      // fold them into the dependency set so a write to a join-target
      // collection triggers MV refresh (and contributes a cycle edge).
      if (spec.sources) for (const s of spec.sources) dependencies.add(s)
      queryPlanSummary = summarizeUnionPlan(spec)
    } else if (spec.projection) {
      // Projection-form (#810): dependencies are all AUTO — the primary
      // source, every collect leg's collection (both literal names), and
      // every forward leg's ref() target. Forward targets usually can't
      // resolve yet (refs are declared after vault open) — those go
      // through the pending-resolution path below. Explicit `sources`
      // remains additive, same as the other two forms.
      const projection = spec.projection
      dependencies = new Set([projection.source])
      for (const leg of projection.joins) {
        if ('collect' in leg) dependencies.add(leg.collect)
        else pendingForwardFields.push(leg.field)
      }
      if (spec.sources) for (const s of spec.sources) dependencies.add(s)
      queryPlanSummary = summarizeProjectionPlan(spec)
    } else {
      const q = spec.query!(dbForQuery)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      qAny = q as any
      isQuery = typeof qAny._plan === 'function'
      if (isQuery) {
        // `q` is the `Query` arm of the union here (runtime-confirmed via
        // `qAny._plan` above); reuse the already-`any` `qAny` the block uses
        // for `_plan()` rather than re-narrowing.
        dependencies = analyzeDependencies(qAny)
        queryPlanSummary = summarizeQueryPlan(qAny)
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
              `(Reduction or GroupedReduction) but no \`sources\` field is declared. ` +
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
    // doesn't make sense for same-collection aggregation).
    const partitionClauses: FieldClause[] = []
    const partitionField = spec.output?.partition?.field
    if (partitionField !== undefined && isQuery) {
      const plan = qAny._plan()
      for (const clause of plan.clauses) {
        if (isFieldClauseOnField(clause, partitionField)) partitionClauses.push(clause)
      }
    }
    // #638 Task 2 — 'aggregate' only for the explicit-sources aggregate shape
    // (groupBy().aggregate() with no chainable plan); a row-per-source-row
    // Query<T>, unionSources, or projection MV is 'record'.
    const grain: Grain = spec.unionSources || spec.projection || isQuery ? 'record' : 'aggregate'
    const reg: RegisteredMV = { spec, outputCollection, dependencies, queryHash, partitionClauses, grain }

    this._byName.set(spec.name, reg)
    for (const dep of dependencies) {
      const arr = this._bySource.get(dep)
      if (arr) arr.push(reg)
      else this._bySource.set(dep, [reg])
    }
    if (pendingForwardFields.length > 0) {
      // Non-constructive ref-registry probe: the Vault (the real
      // MVQueryContext) carries its RefRegistry as a private field,
      // reachable structurally at runtime. Test stubs without one simply
      // never resolve — forward deps then come only from explicit `sources`.
      const refRegistry = (db as unknown as {
        refRegistry?: { getOutbound(collection: string): Record<string, { target: string }> }
      }).refRegistry
      const source = spec.projection!.source
      this._pendingForwardDeps.push({
        reg,
        fields: new Set(pendingForwardFields),
        resolveTarget: (field) => refRegistry?.getOutbound(source)[field]?.target ?? null,
      })
      // Immediate attempt — covers refs already declared by the time
      // this MV registers (re-registration flows, test wiring).
      this._resolvePendingForwardDeps()
    }
  }

  /** All MVs that depend on `source`, in registration order. */
  mvsForSource(source: string): ReadonlyArray<RegisteredMV> {
    if (this._pendingForwardDeps.length > 0) this._resolvePendingForwardDeps()
    return this._bySource.get(source) ?? []
  }

  /**
   * Retry ref() resolution for every pending projection forward leg
   * (#810). A field resolves once its source collection's refs have
   * been declared; the target then folds into the owning MV's
   * dependency set and `_bySource`, so subsequent writes to it
   * dispatch a refresh. Idempotent and cheap — the pending list
   * empties as fields resolve, and `mvsForSource` skips the call
   * entirely once it's empty.
   *
   * Late-resolved targets do NOT retro-feed `edges()` — the cycle
   * pass runs once at vault open, before refs exist. A cycle routed
   * exclusively through a forward leg is therefore not detected at
   * open (collect + source edges, the literal names, are).
   */
  private _resolvePendingForwardDeps(): void {
    for (let i = this._pendingForwardDeps.length - 1; i >= 0; i--) {
      const entry = this._pendingForwardDeps[i]!
      for (const field of [...entry.fields]) {
        const target = entry.resolveTarget(field)
        if (target === null) continue
        entry.fields.delete(field)
        if (entry.reg.dependencies.has(target)) continue
        // `dependencies` is declared ReadonlySet for consumers; the
        // registry owns the underlying Set and is the one writer.
        ;(entry.reg.dependencies as Set<string>).add(target)
        const arr = this._bySource.get(target)
        if (arr) arr.push(entry.reg)
        else this._bySource.set(target, [entry.reg])
      }
      if (entry.fields.size === 0) this._pendingForwardDeps.splice(i, 1)
    }
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
   * Graph edges for #638 Task 2: one `'mv'` edge per registered MV — target
   * = the output collection (a `WHOLE_RECORD` artifact node), sources =
   * every dependency (also `WHOLE_RECORD` nodes). Same-collection edges
   * (`dep === outputCollection`) are skipped IFF the MV declares an
   * `output.partition` discriminator AND the query has a where-clause that
   * provably excludes the partition value (`partitionDisjoint`) — the SAME
   * condition the old local DFS used. Grain comes from the registration-time
   * `RegisteredMV.grain`.
   */
  edges(): ReadonlyArray<{ readonly target: FieldRef; readonly sources: readonly FieldRef[]; readonly kind: EdgeKind; readonly grain: Grain }> {
    const out: Array<{ target: FieldRef; sources: FieldRef[]; kind: EdgeKind; grain: Grain }> = []
    for (const reg of this._byName.values()) {
      const sources: FieldRef[] = []
      for (const dep of reg.dependencies) {
        if (dep === reg.outputCollection && partitionDisjoint(reg)) continue
        sources.push({ collection: dep, field: WHOLE_RECORD })
      }
      if (sources.length === 0) continue
      out.push({ target: { collection: reg.outputCollection, field: WHOLE_RECORD }, sources, kind: 'mv', grain: reg.grain })
    }
    return out
  }

  /**
   * Cycle detection, delegated to `ViaGraph.assertAcyclic()` (#638 Task 2 —
   * retires the local DFS). `graph` is the caller's shared per-vault graph,
   * ALREADY carrying this registry's `edges()` AND `DerivationRegistry`'s
   * (registered by the caller — see `Vault._initMaterializedViews`, which
   * runs after `_initDerivations`, so a pure-derivation cycle already threw
   * `DerivationCycleError` there; any cycle surfacing here necessarily
   * touches an MV edge). Throws `MaterializedViewCycleError` — SAME class as
   * before.
   */
  validate(graph: ViaGraph): void {
    graph.assertAcyclic()
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
 * Provability check for the same-collection partition-discriminator.
 * Returns `true` when
 * the captured partition clauses on the MV's query provably exclude
 * the partition's value — meaning the input filter and the output
 * partition are disjoint and the same-collection edge isn't really a
 * cycle.
 *
 * Supported provability shapes (narrow on purpose — DERIV-PP30-001
 * is the load-bearing case):
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
