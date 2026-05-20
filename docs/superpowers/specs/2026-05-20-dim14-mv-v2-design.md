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
| Showcase + recipe + subsystem doc + `features.yaml` entry | ✓ | One showcase per refresh mode |

## v2 SCOPE — what's deferred

| Feature | Deferred to | Why |
|---|---|---|
| `withOverlayedView({ base: mvName, overlayCollection, mergePolicy })` | v2.5 | Operator-editable lifecycle composition (niwat PND.1 use case). Separate primitive — MV stays pure read-only projection; overlay is the merge layer on top. Designing the merge contract is a non-trivial spec on its own. |
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
| Showcases | `showcases/src/81-with-mv-eager.showcase.test.ts`, `82-with-mv-lazy.showcase.test.ts` | One per refresh mode |
| Subsystem doc | `docs/subsystems/derivations.md` (extend) | New § Materialized Views section |
| `features.yaml` entry | `features.yaml` (modify) | New `materialized-views` row under the derivation cluster |

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
- **MV is read-only projection.** No write API on the MV collection beyond what materialization itself produces. Operator-editable lifecycle on top of an MV is `withOverlayedView` — explicitly deferred to v2.5 (see § Scope deferred).

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
}

// Returned by withMaterializedView()
interface MaterializedViewStrategyHandle {
  __noydb_strategy: 'materialized-view'
  spec: MaterializedViewStrategy<unknown>
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
function analyzeDependencies(plan: QueryPlan, joinContext?: JoinContext): Set<string> {
  const deps = new Set<string>()
  deps.add(plan.rootCollection)
  for (const clause of plan.clauses) {
    if (clause.type === 'join') {
      const target = joinContext?.resolveRef(plan.rootCollection, clause.foreignKey)
      if (target) deps.add(target)
    } else if (clause.type === 'group' && clause.subPlan) {
      for (const d of analyzeDependencies(clause.subPlan, joinContext)) deps.add(d)
    }
    // where / groupBy / aggregate don't add new sources
  }
  return deps
}
```

The set is materialized at MV registration time. `MaterializedViewRegistry.onSourceWrite(source, ...)` fires when **any** member of the set is written.

### Pre-registration validation

- All declared sources must reference vault-known collections (otherwise `MaterializedViewSourceUnknownError`).
- The MV output collection must not overlap with the source set, UNLESS `output.partition` is declared AND the input query has a `.where(partition.field, '!=', partition.value)` clause (or equivalent — see § Cycle detection below).
- The query plan must be deterministic — no `.subscribe()` / `.live()` terminals embedded (these would create a re-entrant cycle).

### Function-based source-row predicates are not supported in v2

The MV `query()` builder accepts the standard `.where(field, op, value)` terminals + `.join` / `.groupBy` / `.aggregate`. Function-based predicates (e.g. niwat's `DERIV-SSO-001` "active employees during the period" rule, where the active-ness check is a function over an `employmentPeriods` array on the worker record) are **not supported** in v2. Reason: `queryHash` determinism requires a stable canonical serialization of the query plan; function bodies don't have one.

**Workaround pattern (canonical for v2):** pre-derive the predicate result via a v1 `withDerivation`, then MV-aggregate over the pre-derived collection. For DERIV-SSO-001:

```ts
// v1 derivation: per (worker, period) row with active-ness pre-computed
withDerivation<Worker, { activeInPeriod: { id: string; workerId: string; period: string; active: boolean } }>({
  source: 'workers',
  outputs: { activeInPeriod: { shape: 'record', collection: 'worker-period-active' } },
  derive: (w, ctx) => ({ /* per-period explosion using w.employmentPeriods */ }),
  lifecycle: 'eager',
})

// v2 MV: aggregates over the pre-derived collection — pure where-clause query
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

The composition is intentional — v1 owns "compute a deterministic field per source row," v2 owns "aggregate/project over rows by declared predicate." A future v2.x may add `declaredDeterministicPredicates: { activeInPeriod: fn }` with a registered `predicateHash` so the function can live inside the MV query directly, but v2 keeps the surface narrow.

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

- Node types: `'derivation'` (v1) and `'materialized-view'` (v2). Each node is keyed by its `source` (derivation) or `name` (MV).
- Edges:
  - Derivation: source collection → output collections (existing v1)
  - MV: every collection in the dependency set → MV's output collection (new)
- Detection: DFS from each registered node at vault open. Throws `DerivationCycleError` (existing) or `MaterializedViewCycleError` (new) on any back-edge. Same vault-init failure mode as v1.

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

User collections that mix MV rows and user-edited rows are **not supported in v2** — that's the overlay use case explicitly deferred to v2.5. v2's contract is: an MV's output collection is owned by the MV. Manual writes through the public `Collection.put` are not refused (zero-knowledge writes can't be gated post-hoc) but are subject to overwrite on the next refresh and are documented as "do not mix."

## Composition with operator-editable lifecycle (v2.5 bridge)

v2 MV is read-only projection. Many real consumers need an *operator-editable lifecycle* on top — a row that the system computes a default for, but that an operator can override, with state-machine fields (`dataStatus`, `filingStatus`, `overrideAt`, etc.) the MV cannot own. That's `withOverlayedView`, deferred to v2.5.

**The canonical v2 pattern until v2.5 ships:** MV + imperative shell.

- MV writes to its own collection (e.g. `pnd1-aggregate`) — pure computed values, no lifecycle fields. Owned end-to-end by the MV.
- A separate user-owned collection (e.g. `disbursements`) carries the operator-editable lifecycle. The application's upsert function reads the MV row for the auto-amount, owns the workflow state, applies any override-short-circuit logic.

```ts
// Consumer code, pre-v2.5
async function upsertWhtS01Disbursement(clientId: string, period: string) {
  const auto = await vault.collection('pnd1-aggregate').get(`${clientId}|${period}`)
  if (!auto) return // MV hasn't materialized for this group yet

  const existing = await vault.collection('disbursements').get(`${clientId}/${period}/pnd1`)
  if (existing?.dataStatus === 'override') return // operator override wins

  await vault.collection('disbursements').put(`${clientId}/${period}/pnd1`, {
    ...existing,
    amount: auto.taxTotal,
    dataStatus: existing?.dataStatus ?? 'acquired',
    // ... operator-owned fields preserved
  })
}
```

This works today. The cost vs the full v2.5 primitive:

- Two collections instead of one — `as-pinia` / `in-pinia` wiring sees both
- Upsert is imperative — the structural-enforcement promise only holds for the auto-amount, not the operator override invariant
- No automatic re-upsert on MV re-materialization — the application must call `upsertWhtS01Disbursement` after writing source records (or hook it via `Collection.subscribe` on the MV collection)

When `withOverlayedView({ base: 'pnd1-aggregate', overlayCollection: 'disbursements', mergePolicy: ... })` ships in v2.5, the two collections collapse into one structural primitive, the upsert becomes declarative, and the lifecycle fields move into the overlay declaration.

**v2.5 ETA:** TBD — depends on pre.14 close + real-consumer demand assessment after MV ships. The bridge pattern above is sustainable for at least one full release cycle.

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

## Testing strategy

### Unit tests

- `QueryDependencyAnalyzer` — root collection always in deps; join target added; nested OR sub-queries recursed; where/groupBy/aggregate don't add
- `MaterializedViewRegistry` — registration; cycle detection alongside v1 derivations (MV → MV, MV → derivation, derivation → MV chains); same-collection-as-source partition resolution
- `MaterializedViewExecutor` — single-row MV happy path; multi-row MV with eager refresh; lazy stale + resolve-on-read; manual `refreshView`
- `_materializedFrom` — `queryHash` determinism; serialization round-trip
- Conformance suite — runs against `to-memory` and `to-file`

### Integration tests

- PND.1-style aggregate showcase — `compensations.groupBy(['clientId', 'period']).aggregate(sum('taxAmount'))` writes to `pnd1-aggregate`; source updates correctly re-aggregate; `onEmpty: 'delete'` drops empty-period rows
- Same-collection partition MV — DERIV-PP30-001 shape: input is `disbursements.where('type', '!=', 'pp30')`; output is `disbursements` partitioned to `type === 'pp30'`; verify cycle detector accepts + refresh works
- MV + derivation composition — chained: source → v1 derivation → MV reads derivation's output; cycle detector recognizes the chain
- Tombstone bypass — MV with `onEmpty: 'delete'` writing to a collection that has `withGuard.onDelete: throw` registered; refresh-driven deletes succeed (user onDelete bypassed); user-initiated `delete` on the same collection still fires onDelete
- Admin amendment cascade — admin amendment edits source → MV re-materializes → tombstones a row → `amendment.invariant` sees the `{before, after: null}` change and can reject the amendment

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
3. **`queryHash` determinism for joined queries.** The query plan's serialized form must include join-target collection names (already in the plan) but should NOT include `joinResolver` instance state. Confirm in implementation. *(Cross-reference: if v2.x adds `declaredDeterministicPredicates`, the predicate's `predicateHash` must fold into `queryHash`. See § Pre-registration validation → "Function-based source-row predicates are not supported in v2".)*
4. **`refreshView` concurrency.** Mirrors `deriveAll`'s open question. Sequential default; parallel via opt-in is v2.x.
5. **Vault-init failure recovery.** Same as v1: fail-fast on cycle detection; document a future `--ignore-cycles` migration flag if a real consumer needs it.

### Resolved during niwat-review of PR #149

- ~~**Materialized output id derivation.**~~ **Resolved: `rowKey` is required for all MVs.** No default formula. Niwat-review on PR #149 flagged that the proposed `${clientId}/${period}` composite for groupBy MVs silently collides if any key value contains `/`. Explicit-always eliminates that class — minor ergonomic cost, structural clarity gain. See § Type surface.
- ~~**Function-based source predicates.**~~ **Resolved: not supported in v2.** Workaround documented in § Pre-registration validation (pre-derive via v1 `withDerivation`, MV-aggregate over the pre-derived collection). A `declaredDeterministicPredicates` extension stays open for v2.x.

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
13. **Showcases (eager + lazy) + recipes + subsystem doc + `features.yaml` entry** — documentation and verification

Each step produces a green test before the next begins.
