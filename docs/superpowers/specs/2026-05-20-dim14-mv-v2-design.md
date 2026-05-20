# Dimension 14 (derived data) — v2 implementation design (`withMaterializedView`)

> Extends the v1 `withDerivation` design ([`2026-05-01-dim14-derivation-v1-design.md`](./2026-05-01-dim14-derivation-v1-design.md)) to cover **collection-level derivation** — a declared query whose result is persisted, kept fresh as sources change, and read like any other collection. v1's record-level shape (source record → output records) and v2's query-level shape (query → materialized collection) cover the two halves of Dim 14 the brainstorm split out at L43.

## Goal

Ship a `withMaterializedView` strategy in `@noy-db/hub` that lets a vault declare a **query** whose result is persisted as a queryable collection, with automatic refresh on source-collection changes. The view writes to an existing collection via existing stores; no new storage backends. Composes with `withDerivation` v1's `DerivationRegistry` (shared cycle detection), `_internalDelete` (shared housekeeping bypass), and `withTransactions` (shared rollback substrate).

## Success criteria (acceptance)

- A vault can register an MV: query → named materialized collection.
- Writes to any source collection identified by the dependency analyzer trigger re-materialization (eager) or staling (lazy).
- Source-row deletes that cause empty groups remove the corresponding MV row (default; overridable).
- Cycle detection refuses a query that depends on its own MV (handles MV → MV chains, MV → derivation chains, derivation → MV chains — single graph shared with v1).
- Reads from the MV name route through the standard `Collection<T>` API — query DSL, `live()`, `subscribe()`, `as-pinia` / `in-pinia` wiring all work unchanged.
- All outputs encrypted with the same DEK as the source collection by default (zero-knowledge preserved).
- Refresh-driven deletes route through `Collection._internalDelete` so user `onDelete` guards on the output collection are NOT tripped by housekeeping (#145 composition).
- A `refresh: 'eager'` materialization that exceeds the row-count ceiling throws `MaterializedViewTooLargeError` analogous to `JoinTooLargeError` / `GroupCardinalityError`.
- Conformance tests pass on `to-memory` and `to-file`.

## v2 SCOPE — what's in

| Feature | In v2 | Notes |
|---|:---:|---|
| `withMaterializedView({ name, query, refresh, output })` factory | ✓ | The core API |
| Query-AST dependency analyzer (which source collections trigger re-materialization) | ✓ | Handles `where`, `join`, `groupBy`, `aggregate` |
| Eager refresh (re-materialize inside source-write transaction) | ✓ | Cost ceiling enforced |
| Lazy refresh (mark stale on source-change; re-materialize on read) | ✓ | Same machinery as v1 lazy |
| Manual refresh (`vault.refreshView(name)`) | ✓ | Bulk recompute primitive |
| Shared `DerivationRegistry` cycle detection (MV ↔ MV, MV ↔ derivation) | ✓ | Single graph; one extension to v1's DFS |
| Empty-group row delete (last source row removed → MV row tombstoned) | ✓ | Default; overridable via `onEmpty: 'keep'` |
| Strict-mode rollback inside `withTransactions` | ✓ | Composes with v1 `strict: true` semantics |
| Same-DEK encryption (zero-knowledge preserved) | ✓ | Inherit v1 default |
| Routes housekeeping deletes through `_internalDelete` | ✓ | User `onDelete` not tripped on refresh (#145) |
| `_materializedFrom` envelope metadata (query fingerprint + queryHash + version + ts) | ✓ | Extends `_derivedFrom`; lives in encrypted payload |
| `MaterializedViewTooLargeError` row ceiling at 100k by default | ✓ | Mirrors `JoinTooLargeError`; overridable via `{ maxRows }` |
| Same-collection-as-source MV with `outputPartition` discriminator | ✓ | Resolves cycle detector for niwat's `DERIV-PP30-001` shape |
| `declaredDeterministicPredicates` on MV strategy | ✓ | Pulled forward from v2.x (niwat-review of #149). Function-based filtering with a consumer-stable `predicateHash` folded into `queryHash`. Closes the general function-predicate gap; SSO-specific cross-product is still v3. |
| `withOverlayedView` (read-shadow variant) | ✓ | Pulled forward from v2.5 (niwat-review of #149). Narrow primitive — single shadow predicate (`shadowField` + `shadowValue`), no arbitrary merge logic. Collapses W3-A/B/C-style consumer imperative shells into one declarative block per rule. |
| Showcase + recipe + subsystem doc + `features.yaml` entry | ✓ | One showcase per refresh mode + one for overlay + one for predicates |

## v2 SCOPE — what's deferred

| Feature | Deferred to | Why |
|---|---|---|
| `withOverlayedView` with arbitrary `mergePolicy` callback | v3 | The read-shadow variant lands in v2 (see "in" table above). Arbitrary user-supplied merge functions — priority lattices, field-level merge, history-aware reconciliation — still need a dedicated spec and stay deferred. |
| MV cross-join (`periods × workers` style cartesian semantics) | v3 | DERIV-SSO-001's full structural path needs cross-product semantics in the query DSL — separate primitive, not query-DSL-extension territory. The v2 path for SSO is a consumer-maintained `(workerId, period)` junction collection + MV aggregate (see § DERIV-SSO-001 v2 path). |
| Scheduled refresh (`{ every: '1h' }`) | v3 | No general cron/scheduler primitive in `@noy-db/hub`; pairs with Dim 11 hooks/triggers |
| Streaming MVs (incremental over Dim 12 streams) | v3 | Pairs with Dim 12 stream primitive's own v1 |
| MapReduce views (`map` + optional `reduce`, CouchDB lineage) | v3 | Different shape; separate spec |
| Rendered views (server-authoritative pre-rendered query, Zero/Replicache lineage) | v3 | Couples to Dim 02 ACL tiering + Dim 05 transports |
| Public / CDN-served MVs (`public: true`) | v3 | Privacy-tier ACL gate (deferred from v1 too) |
| Cross-vault MV sources | v3 | Cross-vault joins are Dim 11 catch-all; same boundary |
| MV result with separate DEK | v3 | Same-DEK is sufficient for v2; separate-DEK adds key-management surface |

## Architecture

### Layers

```
┌─────────────────────────────────────────────────────────────┐
│ Application                                                  │
│   vault.collection('pnd1-aggregate').query()...toArray()     │
└──────────────────────────┬──────────────────────────────────┘
                           ▼ (same as any collection read)
┌─────────────────────────────────────────────────────────────┐
│ Collection.get / .query / .list (existing)                  │
│   - Lazy MV: resolveStaleMVOnRead before serving            │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ MaterializedViewRegistry — NEW (extends DerivationRegistry) │
│   - Holds MV graph alongside derivation graph (single DFS)  │
│   - QueryDependencyAnalyzer: extracts source-collection set │
│     from a Query plan (where/join/groupBy/aggregate)        │
│   - onSourceWrite(source, record): dispatch eager / mark    │
│     stale (mirrors v1 onSourceWrite hook)                   │
│   - resolveStaleMV(viewName): lazy resolve-on-read          │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ MaterializedViewExecutor — NEW                              │
│   - Reads source(s) through ReadOnlyVaultFacade             │
│   - Runs the declared Query against the live cache(s)       │
│   - Encrypts each result row (existing path) and writes     │
│     via Collection.put (existing) — output rows are normal  │
│     records with `_materializedFrom` payload metadata       │
│   - Tombstones rows that no longer have a matching source   │
│     via Collection._internalDelete (skips user onDelete)    │
│   - Strict-mode rollback hook for withTransactions          │
└─────────────────────────────────────────────────────────────┘
```

### Components

| Component | File | Responsibility |
|---|---|---|
| `withMaterializedView()` factory | `packages/hub/src/materialized-views/with-materialized-view.ts` | API surface; returns `MaterializedViewStrategyHandle` |
| `MaterializedViewRegistry` | `packages/hub/src/materialized-views/registry.ts` | MV graph; integrates with `DerivationRegistry` for shared cycle detection |
| `MaterializedViewExecutor` | `packages/hub/src/materialized-views/executor.ts` | Runs query, encrypts result rows, writes/tombstones via Collection |
| `QueryDependencyAnalyzer` | `packages/hub/src/materialized-views/dependency-analyzer.ts` | Walks a `Query` plan → set of source collection names; understands `where`, `join`, `groupBy`, `aggregate` |
| `_materializedFrom` envelope ext | `packages/hub/src/envelope.ts` (modify) | New optional metadata field inside `_data` |
| `vault.refreshView(name)` method | `packages/hub/src/vault.ts` (modify) | Bulk re-materialize entrypoint |
| `MaterializedViewTooLargeError` | `packages/hub/src/errors.ts` (modify) | Thrown when materialization exceeds `maxRows` |
| `withOverlayedView()` factory | `packages/hub/src/overlay-views/with-overlayed-view.ts` | API surface for the read-shadow overlay primitive |
| `OverlayedViewRegistry` | `packages/hub/src/overlay-views/registry.ts` | Name→{base, overlay, shadow} mapping; shared cycle detection |
| `OverlayedCollection` proxy | `packages/hub/src/overlay-views/virtual-collection.ts` | `Collection<T>`-shaped merge-on-read + write-to-overlay routing |
| `QueryBuilder.wherePredicate(name, ctx?)` | `packages/hub/src/query/builder.ts` (modify) | Declared-predicate terminal added to the chainable builder |
| Showcases | `showcases/src/81-with-mv-eager.showcase.test.ts`, `82-with-mv-lazy.showcase.test.ts`, `83-with-overlay.showcase.test.ts`, `84-with-mv-predicates.showcase.test.ts` | One per refresh mode + overlay + predicates |
| Subsystem doc | `docs/subsystems/derivations.md` (extend) | New § Materialized Views + § Overlay views sections |
| `features.yaml` entry | `features.yaml` (modify) | New `materialized-views` + `overlay-views` rows under the derivation cluster |

### Modified components

- `DerivationRegistry` — promoted to host an MV sub-registry; cycle detection walks both node types in a single DFS
- `Collection.put` — `MaterializedViewRegistry.onSourceWrite` hook fires alongside the existing v1 derivation hook
- `Collection.get` — lazy MV resolve-on-read path alongside v1 lazy derivation path
- `Vault._initDerivations` (renaming?) — also wires the MV registry; allocates the same shared `ReadOnlyVaultFacade`
- `runTransaction` — already accepts derivation side-effects via `_executed`; MV writes/tombstones register through the same path

## Key invariants

- **Zero-knowledge preserved.** Materialization runs after DEK unwrap, *inside* the encrypted boundary. Output rows are encrypted with the same DEK as the source collection (or, when multiple sources contribute to a join, the DEK of the **left-most source collection** — the one named in `query`'s root `.collection()`).
- **No new wire format.** MV rows use the existing envelope (`_noydb`, `_v`, `_ts`, `_iv`, `_data`) plus one new payload field `_materializedFrom: { mvName, queryHash, sourceVersions, materializedAt }`. Lives inside `_data` — opaque to the storage backend.
- **No new store interface.** MV rows route through existing stores via existing collections.
- **No tombstone collateral on user collections.** Refresh-driven deletes use `Collection._internalDelete` so a user-registered `onDelete` on the output collection is not tripped by housekeeping. An amendment window IS still surfaced to `amendment.invariant` (matches the #145 follow-up resolution: housekeeping ≠ user-initiated, but an active amendment is still about the user's intent).
- **Atomic with `withTransactions`.** A single source `Collection.put` that triggers eager re-materialization runs all dependent MV writes/tombstones inside the same transaction. `strict: true` aborts the whole transaction on any output failure (composes with v1 `strict` semantics).
- **MV is read-only projection.** No write API on the MV collection beyond what materialization itself produces. Operator-editable lifecycle on top of an MV is `withOverlayedView` — a separate primitive that ships alongside MV in v2 (see § Composition with operator-editable lifecycle). Arbitrary `mergePolicy` callbacks on top of overlay are deferred to v3 (see § Scope deferred).

## Type surface

```ts
// Registration
interface MaterializedViewStrategy<TRow> {
  /**
   * Stable identity for this view. Used as the output collection name
   * unless `output.collection` overrides. Must be unique within the vault.
   */
  name: string
  /**
   * Declared query. Built via the same `Query<T>` chainable builder
   * used elsewhere — `.where()`, `.join()`, `.groupBy()`,
   * `.aggregate()`. The dependency analyzer walks this plan to
   * determine source collections.
   */
  query: () => Query<TRow>
  /**
   * Pure function from a materialized row → stable id used in the
   * output collection. **Required for all MVs** — no default. For
   * groupBy MVs, supply something like
   * `(row) => `${row.clientId}|${row.period}`` (use a separator that
   * cannot appear in any groupBy field value to avoid collision).
   * For non-groupBy MVs, supply a stable function over whatever
   * uniquely identifies the projection. Resolving #6 from the
   * niwat-review pass: explicit always beats default-with-pitfalls.
   */
  rowKey: (row: TRow) => string
  /**
   * Refresh policy.
   *
   * - `'eager'` (default) — re-materialize synchronously inside the
   *   source-write transaction. Composes with `withTransactions` for
   *   strict-mode rollback.
   * - `'lazy'` — mark stale on source-change; materialize on first
   *   read of the MV.
   * - `'manual'` — only materializes when `vault.refreshView(name)`
   *   is called. Useful for very expensive MVs where the consumer
   *   wants to schedule the refresh externally.
   */
  refresh: 'eager' | 'lazy' | 'manual'
  /**
   * Output routing. Optional — if omitted, the MV writes to a
   * collection named after `name`.
   */
  output?: {
    /**
     * Output collection name. Defaults to `name`.
     */
    collection?: string
    /**
     * For same-collection-as-source MVs (e.g. niwat DERIV-PP30-001:
     * MV reads `disbursements` filtered to `type !== 'pp30'` and writes
     * `disbursements` filtered to `type === 'pp30'`), declare the
     * output partition explicitly so the cycle detector treats the
     * input filter and the output partition as disjoint. Without this,
     * same-collection MV is refused.
     */
    partition?: { field: string; value: unknown }
  }
  /**
   * What to do when a re-materialization produces zero rows for a
   * given groupBy key that previously had rows.
   *
   * - `'delete'` (default) — tombstone the prior MV row via
   *   `Collection._internalDelete`. Matches niwat's "no payroll → no
   *   PND.1 disbursement" expectation.
   * - `'keep'` — leave the prior MV row in place. Useful when zero
   *   is a meaningful state (e.g. a daily total of zero is still a
   *   row in the report).
   */
  onEmpty?: 'delete' | 'keep'
  /**
   * `true` (default) for eager refresh: any output failure rolls back
   * the source write inside `withTransactions`. `false`: isolate per-
   * row failure, log, continue. Defaults align with v1 derivation
   * `strict` semantics — eager+strict is the safe choice.
   */
  strict?: boolean
  /**
   * Row-count ceiling for the materialized output. Throws
   * `MaterializedViewTooLargeError` if exceeded during a refresh.
   * Default 100k — matches `JoinTooLargeError`'s 50k per side plus
   * a comfortable headroom for groupBy explosions. Override per-MV
   * when the domain warrants it.
   */
  maxRows?: number
  /**
   * Declared deterministic predicates that the query may invoke via
   * `.wherePredicate(name, ctx?)`. Function bodies have no stable
   * canonical serialization, so the consumer supplies a stable
   * `hash` per predicate — included in `queryHash` so a change to
   * the function's semantics forces a refresh on next visit (mirrors
   * v1's `strategyHash` mechanism for `derive`).
   *
   * Use when a `.where(field, op, value)` clause is too narrow:
   * boolean predicates over array fields, date-range membership,
   * cross-field invariants. The predicate fn receives the source row
   * + an optional `ctx` argument the query call site supplies.
   *
   * Consumer responsibility: bump `hash` whenever the function's
   * semantics change. Stale hashes do not corrupt; they just trigger
   * a re-materialization that may not actually be needed.
   */
  predicates?: {
    [name: string]: {
      hash: string
      fn: (row: unknown, ctx?: unknown) => boolean
    }
  }
}

// Returned by withMaterializedView()
interface MaterializedViewStrategyHandle {
  __noydb_strategy: 'materialized-view'
  spec: MaterializedViewStrategy<unknown>
}

// New: overlay primitive — read-shadow merge of two collections
interface OverlayedViewStrategy {
  /**
   * Virtual collection name. `vault.collection(name)` returns a view
   * that merges `base` and `overlay` per the shadow rule. Reads union
   * by id; writes route to `overlay` only (the `base` is owned by an
   * MV or another upstream).
   */
  name: string
  /**
   * The collection providing the default rows. Typically an MV's
   * output collection. The overlay primitive does NOT modify `base`
   * — it only shadows on read.
   */
  base: string
  /**
   * User-writable collection that carries overrides. Independent
   * write path; supports the standard `Collection` API including
   * `withGuard` / `withDerivation` registration.
   */
  overlay: string
  /**
   * Single-field shadow predicate. When `overlay[shadowField] ===
   * shadowValue` for a given id, reads of that id return the overlay
   * row; otherwise reads return the base row. Designed to support
   * "the operator can flip a row to 'override' mode and from then on
   * their hand-edited values win." Niwat's `dataStatus === 'override'`
   * is the canonical example.
   *
   * No callback merge, no priority lattice, no field-level merge —
   * v2 stays explicitly narrow. Arbitrary merge policies are v3.
   */
  shadowField: string
  shadowValue: unknown
}

interface OverlayedViewStrategyHandle {
  __noydb_strategy: 'overlayed-view'
  spec: OverlayedViewStrategy
}

// Query DSL extension (added to QueryBuilder for MV consumers)
interface QueryBuilder<T> {
  /**
   * Invoke a declared predicate by name. The predicate must be
   * registered on the calling MV's `predicates` map.
   *
   * `queryHash` folds two things from this call site:
   *   - the predicate's consumer-stable `hash` (covers function-body
   *     semantics — bump when behavior changes)
   *   - a canonical-JSON hash of `ctx` (covers runtime parameters —
   *     change forces re-materialization on next visit)
   *
   * `ctx` is opaque to the query DSL — passed verbatim to the
   * predicate fn. Useful for threading config values into the
   * predicate (date ranges, feature flags, etc.). `ctx` must be a
   * stable value across the MV's lifetime — dynamic values (e.g.
   * `{ asOf: new Date().toISOString() }`) make the hash change on
   * every materialization, defeating staleness tracking. For
   * time-dependent MVs, use `refresh: 'manual'` and trigger
   * externally.
   */
  wherePredicate(name: string, ctx?: unknown): QueryBuilder<T>
}

// Vault method (added)
declare module '@noy-db/hub' {
  interface Vault {
    refreshView(name: string): Promise<{ written: number; deleted: number; failed: number }>
  }
}
```

### `_materializedFrom` envelope metadata

```ts
// Added to the encrypted payload (NOT unencrypted metadata)
interface MaterializedFromMeta {
  /** Stable identity for the MV that emitted this row. */
  readonly mvName: string
  /**
   * SHA-256 of (mvName + canonical query plan + dependency-set).
   * Changes when the query structure changes → forces refresh on
   * next visit (parallels v1's `strategyHash`).
   */
  readonly queryHash: string
  /**
   * Map from source collection name → `_v` of the source row(s) that
   * contributed to this MV row at materialization time. For aggregates
   * over many rows, this is `max(_v)` per source collection — coarse
   * but sufficient for stale detection.
   */
  readonly sourceVersions: Record<string, number>
  /** ISO timestamp when this row was materialized. */
  readonly materializedAt: string
}
```

## Query dependency analysis

The analyzer walks the `Query`'s internal `QueryPlan` and returns the set of source collection names that any source-write should trigger a refresh on.

### Inputs the analyzer must handle

| Query plan node | Contributes to dependency set |
|---|---|
| `query()` root | The root collection (always present) |
| `.where(field, op, value)` | No additional source — just refines the root |
| `.join('foreignKey', { as: 'alias' })` | The joined collection (looked up via `joinResolver.resolveRef`) |
| `.groupBy(field)` | No additional source — operates on the root or join result |
| `.aggregate({ … })` | No additional source — operates on the root or join result |
| Nested sub-queries inside `or()` clauses | Recursively analyzed; union with parent |

### Algorithm sketch

```ts
function analyzeDependencies(
  plan: QueryPlan,
  joinContext: JoinContext | undefined,
  overlayResolver: OverlayResolver | undefined,
): Set<string> {
  const deps = new Set<string>()
  // Root collection: expand if it's a virtual overlay name, else add directly.
  expand(plan.rootCollection, deps, overlayResolver)
  for (const clause of plan.clauses) {
    if (clause.type === 'join') {
      const target = joinContext?.resolveRef(plan.rootCollection, clause.foreignKey)
      if (target) expand(target, deps, overlayResolver)
    } else if (clause.type === 'group' && clause.subPlan) {
      for (const d of analyzeDependencies(clause.subPlan, joinContext, overlayResolver)) {
        deps.add(d)
      }
    }
    // where / groupBy / aggregate don't add new sources
  }
  return deps
}

function expand(name: string, deps: Set<string>, overlayResolver: OverlayResolver | undefined) {
  const overlay = overlayResolver?.resolveVirtual(name)
  if (overlay !== undefined) {
    // `name` is a withOverlayedView virtual collection — both the base
    // and the overlay collection are real sources whose writes must
    // trigger refresh of any downstream MV reading the virtual name.
    deps.add(overlay.base)
    deps.add(overlay.overlay)
  } else {
    deps.add(name)
  }
}
```

The set is materialized at MV registration time. `MaterializedViewRegistry.onSourceWrite(source, ...)` fires when **any** member of the set is written.

#### Overlay resolution

A downstream MV that reads from `vault.collection('pnd1')` (a `withOverlayedView` virtual name) has its dependency set expanded to `{pnd1-aggregate, pnd1-overlay}` — writes to either side trigger refresh. Without this expansion, source writes would silently leave the downstream MV stale.

`OverlayResolver` is the analog of `joinResolver`: a small interface (`resolveVirtual(name): { base, overlay } | undefined`) backed by the `OverlayedViewRegistry`. The MV `Vault._initMaterializedViews` plumbs both resolvers into the analyzer at vault init.

The expansion is **shallow** in v2 — if `pnd1-aggregate` itself depends on another virtual collection, that's resolved at the upstream MV's analysis time, not transitively here. Cycle detection (which IS transitive) covers the "chain of MVs through overlays" case via the shared `DerivationRegistry` graph.

### Pre-registration validation

- All declared sources must reference vault-known collections (otherwise `MaterializedViewSourceUnknownError`).
- The MV output collection must not overlap with the source set, UNLESS `output.partition` is declared AND the input query has a `.where(partition.field, '!=', partition.value)` clause (or equivalent — see § Cycle detection below).
- The query plan must be deterministic — no `.subscribe()` / `.live()` terminals embedded (these would create a re-entrant cycle).

### Function-based source-row predicates (`declaredDeterministicPredicates`)

The MV `query()` builder accepts the standard `.where(field, op, value)` terminals + `.join` / `.groupBy` / `.aggregate`. For cases where these aren't expressive enough — boolean predicates over array fields, date-range membership, cross-field invariants — v2 adds `declaredDeterministicPredicates`:

```ts
withMaterializedView({
  name: 'overdue-aggregate',
  predicates: {
    isOverdue: {
      hash: 'is-overdue-v1',
      fn: (inv: Invoice, ctx: { asOf: string }) =>
        inv.status === 'open' && inv.dueDate < ctx.asOf,
    },
  },
  query: () => invoices.query()
    .wherePredicate('isOverdue', { asOf: '2026-05-20' })
    .groupBy('clientId')
    .aggregate({ outstanding: sum('amount') }),
  rowKey: (r) => r.clientId,
  refresh: 'eager',
})
```

The function body's lack of canonical serialization is handled by the consumer-supplied `hash` field — folded into `queryHash` so a function change (signalled by a `hash` bump) forces a refresh on next visit. Same drift-detection pattern v1 `withDerivation` uses for `derive.toString()`.

**Consumer responsibility:** bump `hash` whenever the predicate's semantics change. Failing to bump is not unsafe (the old hash matches the old MV rows; new rows just use the new function); failing to bump after a *non-equivalent* function change leaves stale rows around until the next refresh.

#### `ctx`-hash folding

The `ctx` argument passed at each `.wherePredicate(name, ctx)` call site is canonicalized (deep, sorted-key JSON) and its SHA-256 is folded into `queryHash`. This makes runtime parameters symmetric with the function body: changing `ctx` forces re-materialization the same way bumping `hash` does. Together they cover both halves of "this MV's filter is no longer the same."

Concrete behavior:

| Scenario | queryHash | Refresh on next read |
|---|:---:|:---:|
| Consumer re-deploys with same `predicates.hash` and same literal `ctx` | unchanged | no |
| Consumer bumps `predicates.hash` | changes | yes |
| Consumer changes the literal `ctx` (e.g. `{ asOf: '2026-05-20' }` → `'2026-06-01'`) | changes | yes |
| Consumer keeps `ctx` shape but reorders keys (`{ a, b }` vs `{ b, a }`) | unchanged | no (canonical serialization) |

**Dynamic `ctx` is incompatible with `eager` AND `lazy`.** If the consumer writes `ctx: { asOf: new Date().toISOString() }` directly in the `query()` callback, the hash changes on every materialization → infinite-refresh loop. The trap shape differs per refresh mode but the failure is the same:

- `refresh: 'eager'` — every source write triggers re-materialization with a new `ctx` (new clock reading) → write storm
- `refresh: 'lazy'` — every read after a source write re-evaluates `queryHash` against the new `ctx` → constant `queryHash` mismatch → re-materialize on every read → read-path storm

For time-dependent MVs the correct pattern is:

- `refresh: 'manual'` — the consumer decides when to refresh and supplies the new `ctx` at that point (e.g. a daily cron-style trigger in app code calls `vault.refreshView('overdue-aggregate')` with a freshly-materialized strategy whose `ctx.asOf` reflects "today")

The spec stays narrow on time-handling: time-dependent MVs are the consumer's responsibility. v2 ships the deterministic-on-stable-inputs case cleanly; "MV that knows it's stale because the wall clock advanced" is v3 (pairs with Dim 11 hooks/triggers).

#### DERIV-SSO-001 v2 path

DERIV-SSO-001 from the niwat enforcement plan reads workers filtered to "active during the period" and counts per period. This needs **cross-product** semantics (periods × workers), which v2's query DSL does NOT add — predicate filtering operates on a single row at a time, and v2 has no cartesian join (deferred to v3).

The honest v2 path for SSO is a **consumer-maintained junction collection** combined with a predicate filter. The junction is small enough (~niwat scale: 12 periods × 30 workers = 360 max rows) to maintain from app code without losing too much:

```ts
// niwat-app: junction collection. Rebuilt when a Worker's
// employmentPeriods edit fires. ~30 LoC in a Vue composable.
type WorkerPeriodActive = {
  id: string            // `${workerId}|${period}`
  workerId: string
  period: string
  active: boolean       // computed at write time from worker.employmentPeriods
}

// v2 MV: aggregates the junction by period. Predicate not strictly
// needed here — `where('active', '==', true)` would do — but if
// the consumer wants to derive `active` from the row instead of
// storing it, the predicate primitive enables that without a junction
// rewrite.
withMaterializedView({
  name: 'sso-aggregate',
  query: () => workerPeriodActive.query()
    .where('active', '==', true)
    .groupBy('period')
    .aggregate({ workerCount: count() }),
  rowKey: (r) => r.period,
  refresh: 'eager',
})
```

Cost vs the v3 cross-join path: ~30 LoC of junction-maintenance code in the consumer, repeated for each per-period rule. Smaller than the imperative shell `withOverlayedView` replaces; structural enforcement still holds *within* the predicate (the consumer can't accidentally count an inactive worker) but the junction maintenance itself is application-owned.

A future v3 cross-join primitive (`workers.query().crossJoin('periods', { as: 'p' }).wherePredicate('activeInPeriod', { period: '$row.p.id' })`) closes the remaining structural gap. Not in v2.

## Lifecycle

### Eager (`refresh: 'eager'`)

```
Caller: vault.collection('compensations').put({ id: 'c1', taxAmount: 100, ... })
  │
  ▼
Collection.put — existing path
  │  ├─ permission check, encrypt, store.put, ledger
  │  └─ DerivationRegistry.onSourceWrite (v1) — fires first
  │
  ▼
MaterializedViewRegistry.onSourceWrite('compensations', { id, record, version })
  │
  ▼ (inside same transaction if withTransactions is active)
MaterializedViewExecutor.refresh(strategy)
  │  ┌─ Read sources through ReadOnlyVaultFacade (#147 surface)
  │  ├─ Execute Query plan → result rows
  │  ├─ Diff result against current MV collection:
  │  │   - new rows  → Collection.put
  │  │   - existing rows that changed → Collection.put (overwrite)
  │  │   - existing rows that disappeared (onEmpty: 'delete')
  │  │     → Collection._internalDelete(id, txCtx) — skips user onDelete
  │  └─ All writes/tombstones register on txCtx._executed for #133-rollback
  │
  ▼
strict mode? all-or-nothing rollback : per-row failure isolation
```

### Lazy (`refresh: 'lazy'`)

```
Source.put → MaterializedViewRegistry marks the MV stale (in-memory bit
  per MV name, keyed by Registry instance — same shape as v1 _staleByRegistry)

Reader: vault.collection('pnd1-aggregate').get('client1/2026-05')
  │  OR: vault.collection('pnd1-aggregate').query().toArray()
  │
  ▼
Collection.get / .query — existing path
  │  ├─ resolveStaleMVOnRead — checks the stale bit; if set, runs
  │  │   MaterializedViewExecutor.refresh BEFORE returning data
  │  └─ Same diff logic as eager (above)
```

### Manual (`refresh: 'manual'`)

```
Consumer: await vault.refreshView('pnd1-aggregate')
  │
  ▼
Same MaterializedViewExecutor.refresh path; no implicit triggers.
```

`vault.refreshView(name)` returns `{ written, deleted, failed }` per refresh. Idempotent on identical source state.

## Cycle detection

Single shared graph with v1 derivations:

- Node types: `'derivation'` (v1), `'materialized-view'` (v2), `'overlayed-view'` (v2). Each node is keyed by its `source` (derivation) or `name` (MV / overlay).
- Edges:
  - Derivation: source collection → output collections (existing v1)
  - MV: every collection in the dependency set → MV's output collection (new)
  - Overlay: `base` → `name` and `overlay` → `name` (new)
- Detection: DFS from each registered node at vault open. Throws `DerivationCycleError` (existing), `MaterializedViewCycleError` (new), or `OverlayedViewCycleError` (new) on any back-edge. Same vault-init failure mode as v1.

### Same-collection-as-source MV (partition discriminator)

Required for niwat's `DERIV-PP30-001`: the MV reads `disbursements` filtered to `type IN ('vatSales', 'vatPurchase', 'vatCredit')` and writes a row to `disbursements` with `type === 'pp30'`. Same collection, disjoint partitions.

Without explicit declaration this is refused as a cycle. With:

```ts
withMaterializedView({
  name: 'pp30-aggregate',
  query: () => disbursements.query()
    .where('type', 'in', ['vatSales', 'vatPurchase', 'vatCredit'])
    .groupBy('period')
    .aggregate({ net: sum('amount') }),
  rowKey: (r) => `pp30|${r.period}`,
  output: {
    collection: 'disbursements',
    partition: { field: 'type', value: 'pp30' },
  },
  refresh: 'eager',
})
```

…the cycle detector treats the edge as resolved IFF the query has a `.where(partition.field, ...)` clause that **provably excludes** `partition.value`. Provability check:

- `.where('type', '==', X)` where `X !== 'pp30'` → disjoint
- `.where('type', '!=', 'pp30')` → disjoint
- `.where('type', 'in', [...])` where `'pp30'` is not in the list → disjoint
- Anything else (no `partition.field` clause; `'in'` list contains `partition.value`; unsupported operator) → refused as cycle, `MaterializedViewCycleError`

This stays narrow on purpose. v2 only resolves the partition pattern niwat actually needs; more general partition reasoning is v3.

## Strict-mode rollback

Composes with v1 + `withTransactions`:

1. Source `Collection.put` succeeds.
2. `MaterializedViewRegistry.onSourceWrite` fires; executor runs.
3. Each row write/tombstone registers on `txCtx._executed` (the same mechanism #133 + the #144 follow-up landed for v1).
4. On any error inside the refresh:
   - `strict: true`: the source put and every MV row written so far roll back via `revertExecuted`.
   - `strict: false`: failed row is logged; other rows commit; source put commits.

Lazy-mode behavior matches v1: the lazy resolve-on-read path uses `_internalDelete(id, accessor.getActiveTxContext())` for tombstones, so any active TxContext correctly tracks the tombstones. (End-to-end rollback of body-phase lazy refreshes isn't reachable today; the interface is correct for future call paths.)

## Materialized-collection shape

**MV writes to a regular collection.** Reads route through the standard `Collection<T>` API — `query()`, `get()`, `list()`, `live()`, `subscribe()`, and the `as-pinia` / `in-pinia` wiring all work unchanged. This matches niwat's stated preference (Pinia store wiring works without special-casing).

**Output collection accessibility.** noy-db collections are dynamically accessible via `vault.collection(name)` — there is no pre-declaration step for collection schemas. The MV's output collection is implicitly created the first time materialization writes a row. No `schemas` config entry is required. The MV registration itself is what binds the name to the materialization strategy. If a consumer tries to access `vault.collection(mvName)` before materialization fires (e.g. an eager-MV before any source write), reads return an empty collection — the standard "empty collection" behavior, not an error.

The MV-emitted rows are distinguished by carrying `_materializedFrom` inside `_data`. Consumers can detect "this is an MV row" by reading the metadata (e.g. for showing a "computed" badge in a UI), but the shape on read is identical to any other record.

User collections that mix MV rows and user-edited rows are **not supported via `withMaterializedView` alone** — that's the overlay use case, addressed by the `withOverlayedView` primitive that ships alongside MV in v2 (see § Composition with operator-editable lifecycle). The MV's contract is: an MV's output collection is owned by the MV. Manual writes through the public `Collection.put` on the MV's output collection are not refused (zero-knowledge writes can't be gated post-hoc) but are subject to overwrite on the next refresh and are documented as "do not mix" — the canonical pattern for adding writable rows on top is `withOverlayedView`.

## Composition with operator-editable lifecycle (`withOverlayedView`)

v2 MV is read-only projection. Many real consumers need an *operator-editable lifecycle* on top — a row that the system computes a default for, but that an operator can override, with state-machine fields (`dataStatus`, `filingStatus`, `overrideAt`, etc.) the MV cannot own. That's `withOverlayedView`, **shipped in v2** (pulled forward from v2.5 per niwat-review of PR #149).

### Canonical pattern — MV + overlay

The MV owns the computed projection. A second user-writable collection — the overlay — carries the operator-editable fields. A `withOverlayedView` declaration binds them: reads from the virtual collection merge via a single shadow predicate; writes route to the overlay.

```ts
// niwat-app: PND.1 disbursement — DERIV-PND1-001 + DSB-OVERRIDE-001 structural
import { withMaterializedView, withOverlayedView, sum } from '@noy-db/hub'

// 1. MV computes the aggregate. Owned end-to-end by the MV.
const pnd1Aggregate = withMaterializedView({
  name: 'pnd1-aggregate',
  query: () => compensations.query()
    .groupBy(['clientId', 'period'])
    .aggregate({ taxTotal: sum('taxAmount') }),
  rowKey: (r) => `${r.clientId}|${r.period}`,
  refresh: 'eager',
  onEmpty: 'delete',
})

// 2. Overlay merges with a user-owned collection carrying lifecycle fields.
//    Reads from `vault.collection('pnd1')` return:
//      - if pnd1-overlay row exists AND its dataStatus === 'override' → overlay row
//      - else → pnd1-aggregate row
//    Writes to `vault.collection('pnd1')` route to `pnd1-overlay`.
const pnd1Overlay = withOverlayedView({
  name: 'pnd1',
  base: 'pnd1-aggregate',
  overlay: 'pnd1-overlay',
  shadowField: 'dataStatus',
  shadowValue: 'override',
})

createNoydb({
  ...,
  materializedViews: [pnd1Aggregate],
  overlayedViews: [pnd1Overlay],
})
```

The consumer-facing surface collapses to a single virtual collection — `vault.collection('pnd1')` — with structural enforcement on both sides:

| Operation | Base row | Overlay row | Shadow predicate | Result |
|---|:---:|:---:|:---:|---|
| `get(id)` | ✓ | absent | n/a | base row |
| `get(id)` | ✓ | ✓ | true | overlay row |
| `get(id)` | ✓ | ✓ | false | base row (overlay shadowed but predicate fails) |
| `get(id)` | absent | ✓ | true | **overlay row (orphaned-override; intentional)** |
| `get(id)` | absent | ✓ | false | `null` (overlay exists but predicate doesn't qualify it; no base to fall back to) |
| `get(id)` | absent | absent | n/a | `null` |
| `list()` / `.query()` | — | — | — | Union of ids in base ∪ overlay; per-id merge from the table above; predicate evaluated per row |
| `live()` / `.subscribe()` | — | — | — | Merged change-stream from both base and overlay; emit re-merged row per source change |
| `put(record)` | — | — | — | Routes to overlay collection; `id` derived via the base MV's `rowKey(record)`; no effect on base |
| `put(id, record)` | — | — | — | Validates that `id === rowKey(record)`; throws `OverlayIdMismatchError(actual, expected)` if they diverge. Pass-through write when consistent. See § Virtual-collection writes below. |
| `delete(id)` | ✓ | ✓ | — | Removes overlay row only; base row resurfaces on next read |
| `delete(id)` | ✓ | absent | — | No-op (idempotent contract) |
| `delete(id)` | absent | ✓ | — | Removes overlay row; next read returns `null` |
| `delete(id)` | absent | absent | — | No-op (idempotent contract) |

DERIV-PND1-001 + DSB-OVERRIDE-001 ship as **one declarative block per disbursement type** — no `upsertWhtS01Disbursement` imperative shell. Same shape for PP.30, future PND.3, PND.53, etc.

### Orphaned-override pattern

A consumer may preemptively write an overlay row before the base MV has materialized for that key — e.g., an operator knows the auto-computed PND.1 amount will be wrong and wants to lock the override in before the first compensation lands.

This is **intentional and supported**. From the table above:

- The overlay row's `dataStatus: 'override'` qualifies the shadow predicate → `get(id)` returns the overlay row directly (no base to fall back to).
- When source rows finally arrive and the MV materializes a base row, the merge still favours the overlay (predicate still true) — operator intent preserved.
- If the operator "un-overrides" (deletes the overlay row) before the base materializes, `get(id)` returns `null` until the MV catches up — same as any not-yet-materialized id.

The opposite case — overlay row with predicate **false** and no base row — returns `null`. This is the "stale or aborted override" state: the row was written but doesn't satisfy the shadow rule and has nothing to mask. Consumers can observe it via `vault.collection('pnd1-overlay').get(id)` directly if they need to inspect; the virtual collection silently hides it.

### Virtual-collection writes derive `id` from the base MV's `rowKey`

The overlay primitive resolves the base MV's `rowKey` at vault init and uses it for `vault.collection('pnd1').put(record)` calls. The consumer doesn't compute the id format manually — eliminating an undocumented coupling that round-3 niwat-review flagged.

```ts
// Consumer code — id is derived from the base MV's rowKey
// (which knows it's `${clientId}|${period}`)
await vault.collection('pnd1').put({
  clientId: 'c1',
  period: '2026-05',
  dataStatus: 'override',
  amount: 99999,
})
// Internally:
//   id = pnd1Aggregate.rowKey({ clientId: 'c1', period: '2026-05' })
//   vault.collection('pnd1-overlay').put(id, { ...record })
```

For consumers who do need to write to the overlay collection directly (e.g. bulk-imports outside the virtual layer), `vault.collection('pnd1').overlay.rowKey(row)` exposes the same function. Mismatched ids in `pnd1-overlay` still work as raw rows — they just won't shadow anything via the virtual collection.

#### Explicit-id `put(id, record)` — validate, don't trust

The standard `Collection<T>.put(id, record)` signature is preserved on the virtual collection for API compatibility, but its behavior is **validate-and-throw on mismatch** rather than pass-through. Calling `vault.collection('pnd1').put(id, record)` checks `id === rowKey(record)`:

- **Match:** pass-through write to the overlay collection — equivalent to `put(record)`.
- **Mismatch:** throws `OverlayIdMismatchError(actual, expected)` synchronously before any write — `actual` is the consumer-supplied `id`, `expected` is `rowKey(record)`. The consumer's foot-gun (typoed separator, copy-pasted id from a different row, etc.) surfaces immediately rather than producing a silent orphaned-override row.

Picked validate-throw over the alternatives ("use verbatim", "reject explicit-id form entirely") for two reasons:

1. **Preserves the standard `Collection<T>.put(id, record)` signature** — code that's generic over collections doesn't need an overlay-specific code path.
2. **Surfaces typos immediately** — silent orphans are exactly the foot-gun class the round-3 review pushed to eliminate; making the explicit-id form work silently when consistent and loudly when inconsistent is the same logic applied to write-time validation.

Direct writes to the underlying overlay collection (`vault.collection('pnd1-overlay').put(arbitraryId, record)`) bypass this validation — the constraint is on the virtual collection, not on the raw overlay. Bulk-imports outside the virtual layer therefore retain full id control; the validation is for the consumer-facing virtual API only.

### Read-shadow only — explicit non-goals

- **No arbitrary `mergePolicy` callback.** v2 ships the single-field-shadow primitive only. Field-level merges, priority lattices, history-aware reconciliation all stay v3 work.
- **No automatic write-to-base.** The overlay primitive cannot create base rows or modify them; the base is owned by whatever upstream wrote it (typically an MV).
- **No multi-overlay stacking.** A given virtual collection has exactly one base and one overlay. Multi-tier shadowing (overlay-A shadows base; overlay-B shadows the result of A) is v3.

### Pre-registration validation (overlay)

- `base` must reference a **concrete** collection — either a real source collection or an MV's output collection. A virtual overlay name is not permitted as `base` in v2 (multi-overlay stacking is a v3 non-goal listed above). Enforces the non-goal at vault init rather than letting it ship as a latent dependency-tracking gap: the shallow expansion in `QueryDependencyAnalyzer` would truncate at the inner overlay name, leaving downstream MVs that read the outer virtual collection silently stale on writes to the concrete sources further down the chain. Throws `OverlayBaseIsVirtualError(name, base)` at vault init.
- `overlay` must reference a real, vault-known collection that is NOT itself an MV output (the overlay collection is user-writable; an MV-owned collection isn't). Throws `OverlayCollectionUnavailableError(name, overlay)` at vault init.
- `name` (the virtual collection name) must not collide with any registered MV output collection or any concrete source collection. Throws `OverlayNameCollisionError(name)` at vault init.

### Cycle detection

`withOverlayedView` adds edges to the shared `DerivationRegistry` graph:

- `base` → `name` (virtual collection depends on base)
- `overlay` → `name` (virtual collection depends on overlay)

If `base` is itself an MV output, the MV's source-collection edges already flow through. Cycles detected via the same DFS used for v1 derivations and v2 MVs.

### Architecture additions

| Component | File | Responsibility |
|---|---|---|
| `withOverlayedView()` factory | `packages/hub/src/overlay-views/with-overlayed-view.ts` | API surface; returns `OverlayedViewStrategyHandle` |
| `OverlayedViewRegistry` | `packages/hub/src/overlay-views/registry.ts` | Maintains the name→{base, overlay, shadow} mapping; integrates with `DerivationRegistry` for shared cycle detection |
| `OverlayedCollection` (or virtual-collection proxy) | `packages/hub/src/overlay-views/virtual-collection.ts` | `Collection<T>`-compatible proxy that implements the merge-on-read + write-to-overlay routing |
| Subsystem doc | `docs/subsystems/derivations.md` (extend) | New § Overlay views section |

`Vault.collection(name)` checks the `OverlayedViewRegistry` before constructing a regular collection — if `name` matches an overlay, it returns the virtual proxy.

## Error handling

| Failure | Behavior |
|---|---|
| Query plan references an unknown source collection | Throw `MaterializedViewSourceUnknownError` at registration |
| Cycle detected at registration | Throw `MaterializedViewCycleError` at vault init |
| Materialization produces more rows than `maxRows` | Throw `MaterializedViewTooLargeError` (default 100k); rollback if strict |
| Join inside MV exceeds `JoinTooLargeError` ceiling (50k per side) | Surface unchanged from query DSL — strict-mode rollback applies |
| `derive`-equivalent failure inside aggregate reducers | Strict: rollback; non-strict: skip the affected row, continue |
| Lazy stale-bit lost on vault close | Re-materialize on next read (idempotent; matches v1) |
| User `onDelete` registered on output collection | Bypassed for refresh-driven deletes via `_internalDelete` (#145 composition) |
| User `amendment.invariant` on output collection during admin amendment | Sees MV-cascaded tombstones via `collectChange` (#145 follow-up) — can reject the amendment |
| Overlay `base` references a virtual overlay name (multi-overlay stacking attempt) | Throw `OverlayBaseIsVirtualError(name, base)` at vault init — see § Pre-registration validation (overlay) |
| Overlay `overlay` references an unknown collection or an MV-owned collection | Throw `OverlayCollectionUnavailableError(name, overlay)` at vault init |
| Overlay `name` collides with an MV output or a concrete source collection | Throw `OverlayNameCollisionError(name)` at vault init |
| `vault.collection(virtualName).put(id, record)` with `id !== rowKey(record)` | Throw `OverlayIdMismatchError(actual, expected)` synchronously before any write; direct writes to the underlying overlay collection bypass this validation |

## Testing strategy

### Unit tests

- `QueryDependencyAnalyzer` — root collection always in deps; join target added; nested OR sub-queries recursed; where/groupBy/aggregate don't add
- `MaterializedViewRegistry` — registration; cycle detection alongside v1 derivations (MV → MV, MV → derivation, derivation → MV chains); same-collection-as-source partition resolution
- `MaterializedViewExecutor` — single-row MV happy path; multi-row MV with eager refresh; lazy stale + resolve-on-read; manual `refreshView`
- `_materializedFrom` — `queryHash` determinism; serialization round-trip
- Conformance suite — runs against `to-memory` and `to-file`

### Integration tests

- PND.1-style aggregate showcase — `compensations.groupBy(['clientId', 'period']).aggregate(sum('taxAmount'))` writes to `pnd1-aggregate` with `rowKey: (r) => \`${r.clientId}|${r.period}\``; source updates correctly re-aggregate; `onEmpty: 'delete'` drops empty-period rows
- Same-collection partition MV — DERIV-PP30-001 shape: input is `disbursements.where('type', '!=', 'pp30')`; output is `disbursements` partitioned to `type === 'pp30'`; verify cycle detector accepts + refresh works
- MV + derivation composition — chained: source → v1 derivation → MV reads derivation's output; cycle detector recognizes the chain
- Tombstone bypass — MV with `onEmpty: 'delete'` writing to a collection that has `withGuard.onDelete: throw` registered; refresh-driven deletes succeed (user onDelete bypassed); user-initiated `delete` on the same collection still fires onDelete
- Admin amendment cascade — admin amendment edits source → MV re-materializes → tombstones a row → `amendment.invariant` sees the `{before, after: null}` change and can reject the amendment
- **Declared predicates** — MV with `predicates: { isOverdue: { hash, fn } }` and `.wherePredicate('isOverdue', { asOf })` correctly filters; `queryHash` changes when `hash` bumps; refresh fires after a `hash` bump
- **Overlay read-shadow** — `withOverlayedView({ name: 'pnd1', base: 'pnd1-aggregate', overlay: 'pnd1-overlay', shadowField: 'dataStatus', shadowValue: 'override' })`; before any overlay write, `vault.collection('pnd1').get(id)` returns base; after writing an overlay row with `dataStatus === 'override'`, get returns overlay; after writing a non-override overlay row, get falls back to base; `.list()` / `.query()` apply the merge per row
- **Overlay write routing** — `vault.collection('pnd1').put(record)` (id derived from the base MV's `rowKey`) writes to `pnd1-overlay`, NOT to `pnd1-aggregate`; the MV is unaffected; the next MV refresh does not clobber the overlay
- **Overlay explicit-id validation** — `vault.collection('pnd1').put(id, record)` with `id !== rowKey(record)` throws `OverlayIdMismatchError`; passing `id === rowKey(record)` writes normally (pass-through)
- **Overlay delete = un-override** — `vault.collection('pnd1').delete(id)` removes the overlay row only; the base row resurfaces on the next read
- **Overlay cycle detection** — `withOverlayedView` declared with `base === overlay` or with a cycle through a chained MV is refused at vault open

### Security tests

- MV output rows are encrypted with the source collection's DEK (verify ciphertext equivalence-class)
- `_materializedFrom` lives inside `_data`, not in unencrypted envelope fields
- Strategy registration with cyclic graph fails before any refresh attempt (no DoS)

## Backward compatibility

- Existing vaults without any MV strategies are unaffected (`MaterializedViewRegistry` is empty no-op)
- `Collection.put` / `.get` paths are unchanged when no MV depends on the collection
- `_materializedFrom` is an optional payload field; absent on rows that aren't MV-emitted
- No envelope-format version bump — `_materializedFrom` lives inside `_data` payload
- v1 `withDerivation` consumers see no behavior change; the `DerivationRegistry` extension is purely additive (new node type, same DFS)

## Open implementation questions (resolve during writing-plans)

1. **Diff strategy for incremental refresh.** Re-materializing the entire query result on every source write is O(query). Can we incrementally diff the prior MV snapshot against the new query result, only writing changed rows? Trade-off: more code complexity vs less write traffic. v2 default: full re-materialize; document the diff-incremental path as a v2.x optimization. *(Confirmed by niwat-review: niwat's scale doesn't need incremental in v2.)*
2. **Refresh ordering when many MVs depend on the same source.** Sequential (FIFO of registration order)? Parallel-with-cap? Topological by dependency chain length? v1 derivations dispatch sequentially; recommend matching for v2. *(Confirmed by niwat-review: sequential FIFO matches the consumer mental model; topological opt-in is the natural v3 extension.)*
3. **`queryHash` determinism for joined queries.** The query plan's serialized form must include join-target collection names (already in the plan) but should NOT include `joinResolver` instance state. Confirm in implementation. *(Cross-reference: each declared predicate's `predicateHash` folds into `queryHash` — see § Function-based source-row predicates. Each `.wherePredicate(name, ctx)` call site also folds a canonical-JSON hash of `ctx` so runtime parameters are tracked symmetrically — see § `ctx`-hash folding.)*
4. **`refreshView` concurrency.** Mirrors `deriveAll`'s open question. Sequential default; parallel via opt-in is v2.x.
5. **Vault-init failure recovery.** Same as v1: fail-fast on cycle detection; document a future `--ignore-cycles` migration flag if a real consumer needs it.

### Resolved during niwat-review of PR #149

- ~~**Materialized output id derivation.**~~ **Resolved: `rowKey` is required for all MVs.** No default formula. Niwat-review on PR #149 flagged that the proposed `${clientId}/${period}` composite for groupBy MVs silently collides if any key value contains `/`. Explicit-always eliminates that class — minor ergonomic cost, structural clarity gain. See § Type surface.
- ~~**Function-based source predicates.**~~ **Resolved (round 2): pulled forward to v2 as `declaredDeterministicPredicates`.** Round 1 of niwat-review on PR #149 (proposed: defer to v2.x with a v1-derivation pre-materialize workaround) found in round 2 that v1's 1:1 `withDerivation` shape can't actually produce the junction collection the workaround needed. Rather than ship a broken canonical pattern, the primitive landed in v2 (~100 LoC scope). See § Function-based source-row predicates (`declaredDeterministicPredicates`).
- ~~**Operator-editable lifecycle composition.**~~ **Resolved (round 2): pulled forward to v2 as `withOverlayedView` (read-shadow variant).** Round 1 of niwat-review proposed deferring to v2.5 with a documented "MV + imperative shell" bridge pattern. Round 2 argued the bridge pattern would force the same imperative shell three times in pre.14 (DERIV-PND1-001, -SSO-001, -PP30-001), each one rewritten when v2.5 ships. The minimum-useful read-shadow variant (~300–500 LoC, single shadow predicate, no arbitrary merge) lands in v2. Arbitrary `mergePolicy` callback stays deferred to v3. See § Composition with operator-editable lifecycle.

## Cross-references

- Predecessor: [`2026-05-01-dim14-derivation-v1-design.md`](./2026-05-01-dim14-derivation-v1-design.md) — v1 record-level derivation (shipped in pre.11)
- Brainstorm: [`2026-05-01-dimensions/14-derived-data.md`](./2026-05-01-dimensions/14-derived-data.md) — full dimension scope, L60-69 MV API sketch
- Niwat consumer worked example: [#142 comment](https://github.com/vLannaAi/noy-db/issues/142#issuecomment-4497378829) — PND.1 disbursement aggregate; operator-editable lifecycle question; same-collection partition pattern
- System-internal-delete resolution: [#142 comment](https://github.com/vLannaAi/noy-db/issues/142#issuecomment-4497846553) — Option A decided; MV refresh uses `Collection._internalDelete`
- Related decisions: PR #148 → `_internalDelete` skips `onDelete`/period-guard/ref-enforcer; amendment-collectChange fires for system-internal deletes inside open amendment windows
- `features.yaml` — new `materialized-views` entry parallel to existing `derivations`
- Subsystems doc — extends `docs/subsystems/derivations.md` with a new § Materialized Views
- Spec anchor: `SUBSYSTEMS.md#materialized-views` — new sub-section under derivations

## Sequencing for implementation

The implementation epic (#143) should sequence roughly:

1. **`MaterializedViewStrategy` + `OutputSpec` types + `withMaterializedView()` factory** (smallest first piece, no execution)
2. **`QueryDependencyAnalyzer`** — pure function over `QueryPlan`; unit-tested standalone
3. **`MaterializedViewRegistry` skeleton** — registration; cycle detection alongside v1 (extend `DerivationRegistry.validate()`)
4. **`MaterializedViewExecutor`** — eager-mode full re-materialize; same-DEK encryption; route writes through `Collection.put` and tombstones through `Collection._internalDelete`
5. **`_materializedFrom` envelope** — payload field; queryHash determinism tests
6. **`Collection.put` hook integration** — invoke `MaterializedViewRegistry.onSourceWrite` after the source write commits, alongside v1's derivation hook
7. **Lazy lifecycle** — stale-bit tracking + `resolveStaleMVOnRead`; mirrors v1's stale.ts machinery
8. **`vault.refreshView(name)`** — manual bulk recompute
9. **Same-collection partition support** — extend cycle detector + add the partition-resolution check
10. **`onEmpty: 'delete'` tombstoning** — diff-against-prior-MV pass; route through `_internalDelete`
11. **Cost ceiling + `MaterializedViewTooLargeError`** — enforced at executor commit
12. **Strict-mode rollback** — atomic semantics inside `withTransactions`
13. **`declaredDeterministicPredicates` + `.wherePredicate(name, ctx?)`** — adds the predicate primitive; fold `predicateHash` into `queryHash`; refresh-on-hash-bump
14. **`withOverlayedView` factory + `OverlayedViewRegistry`** — registration; cycle detection edges in shared graph
15. **`OverlayedCollection` virtual proxy** — `Collection<T>`-compatible merge-on-read + write-to-overlay routing; `Vault.collection(name)` resolves to the proxy when a name matches
16. **Showcases (eager MV, lazy MV, overlay, predicates) + recipes + subsystem doc + `features.yaml` entries** — documentation and verification

Each step produces a green test before the next begins. Steps 13–15 are independent of 1–12 and can stack at the tail without forcing a tree-rewrite of the prior steps.
