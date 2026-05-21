# Dimension 14 (derived data) — multi-key groupBy + UNION MV design

> Extends the pre.14 `withMaterializedView` design ([`2026-05-20-dim14-mv-v2-design.md`](./2026-05-20-dim14-mv-v2-design.md)) along two orthogonal-but-composable axes opened by the niwat refactor: variadic `groupBy(...fields)` and reading from multiple sibling source collections via `unionSources`. Targets the pre.15 release.

## Goal

Land two MV-adjacent features in `@noy-db/hub` that together unblock niwat's monthly-VAT and per-(client, period) roll-up MVs:

1. **Multi-key `groupBy` (`#166`).** Variadic `Query<T>.groupBy(...fields)` and the matching `withMaterializedView` `groupBy: string | string[]` field. One row per composite key, with every grouped field stamped onto the row.
2. **UNION MV (`#165`, Option 1).** A `unionSources: [{ collection, map }, ...]` field on `withMaterializedView` that reads from multiple sibling collections, unifies their row shapes via per-source `map`, then runs `groupBy` + `aggregate` on the concatenated stream.

Plus one pre.14 cleanup that rides along: **`GuardStrategyHandle` type-variance refinement (`#131`)** — a type-only refactor with no behavioural change.

## Success criteria (acceptance)

### #166 multi-key groupBy

- `Query<T>.groupBy(...fields)` accepts 1..N field names. Single-arg call site keeps its current narrowed return type (`GroupedQuery<T, F>`).
- `.aggregate({...})` emits rows containing **every grouped field in declaration order**, followed by aggregate outputs.
- `withMaterializedView` strategy accepts `groupBy: string | readonly string[]`.
- The existing cardinality warning (warn at 10k distinct tuples) and `GroupCardinalityError` (throw at 100k) fire on the multi-key tuple-count, with a message that lists all grouped field names.
- A new internal helper `canonicalGroupKey(fields, row)` produces a stable string by sorting field names before serialising values; it is reused by the UNION MV query-hash.

### #165 UNION MV

- `withMaterializedView({ unionSources: [{ collection, map }, ...], groupBy, aggregate, ... })` registers an MV whose source set is the union of every entry's `collection`.
- Strategies with both `query` AND `unionSources` are rejected at registration with a clear error.
- Strategies with `unionSources.length < 2` are rejected at registration (a 1-arm UNION is just a `query`-form MV).
- The executor reads each source, runs that source's `map`, concatenates the mapped rows, then runs `groupBy` + `aggregate` (reusing the #166 multi-key path).
- The MV registry maintains a `collection → MV[]` reverse-index. A write to ANY source-collection in `unionSources` fires the MV's refresh path.
- `sourceVersions` on the materialised row records all union arms; a write to any arm bumps the version and re-fires refresh.
- Existing fields `refresh`, `strict`, `onEmpty`, `maxRows`, `rowKey` behave identically to single-source MVs.
- Per-source `map` is mandatory. The mapped output row shape is the type parameter on `withMaterializedView<Row>`; both `map` callbacks must return that shape (compile-time checked; runtime guard for missing-field cases).

### #131 GuardStrategyHandle variance

- Public API of `GuardStrategyHandle<T>` carries no `any`. Generic parameter flows correctly through `register`, `unregister`, and any user-facing accessor.
- No behaviour change; no consumer in the workspace needs source edits.

### Cross-cutting

- 1573 hub tests (pre.14 baseline) pass plus all newly-added tests.
- One showcase per feature plus one combined showcase reproducing the canonical niwat shape (`unionSources` + multi-key `groupBy`).
- `features.yaml` gains entries `mv-multikey-groupby` and `mv-union-sources`.
- `docs/subsystems/materialized-views.md` extended with two sections (UNION + multi-key).
- `pnpm turbo build`, `pnpm turbo typecheck`, `pnpm turbo lint`, and `pnpm turbo test` all green.

## Scope — what's in

| Feature | In | Notes |
|---|:---:|---|
| `Query<T>.groupBy(...fields)` variadic overload | ✓ | Single-arg overload retained for back-compat narrowing |
| `withMaterializedView` strategy `groupBy: string \| string[]` | ✓ | Consumed by the eager/lazy executor unchanged from single-key path |
| Declaration-order row shape preservation | ✓ | `groupBy('a','b')` → `{ a, b, …aggregates }` (NOT `{ b, a, … }`) |
| `canonicalGroupKey` internal helper (sorted-field-name serialiser) | ✓ | Hashing + dedup only; never surfaces in row output |
| Multi-key cardinality warning / error reuses single-key thresholds | ✓ | 10k warn / 100k throw, message lists fields |
| `withMaterializedView` `unionSources` field (Option 1 API) | ✓ | Mutually exclusive with `query` |
| Per-source `map` callback | ✓ | Mandatory; schema-unification boundary |
| Dep-analyser treats `unionSources[].collection` as the source set | ✓ | Internally a thin shortcut: when `unionSources` is set, skip the AST walk and read collection names off the strategy directly. The `query`-form and `unionSources`-form remain independent code paths; they are NOT unified into one internal "n-arm" path. |
| MV registry `collection → MV[]` reverse-index | ✓ | Built at registration; rebuilt on unregister |
| `sourceVersions` lists every union arm | ✓ | Existing envelope field; just multi-arm now |
| `Collection.put` source-write hook fires for either arm | ✓ | Registry is the integration point; no change to `put` itself |
| Combined showcase (UNION + multi-key) | ✓ | Mirrors niwat's monthly-VAT roll-up shape |
| `GuardStrategyHandle<T>` variance fix | ✓ | Independent landing; type-only |

## Scope — what's deferred

| Feature | Deferred to | Why |
|---|---|---|
| `.union(otherQuery)` chain operator on the query builder (Option 2) | post-pre.15, possibly never | Option 1 declared shape covers niwat's need with less dep-analyser risk |
| `db.unionOf(...)` accessor (Option 3) | post-pre.15, possibly never | Conflates `sources`-as-deps with `sources`-as-arms |
| Cross-compartment `unionSources` | v0.10+ partition-aware story | Out of scope for memory-first model; spans tenants |
| Recursive UNION (UNION inside one of the arms) | v3+ | No consumer need; adds dep-analyser complexity |
| Index-accelerated multi-key `groupBy` | v3+ | Inherits the existing "groupBy can't be index-accelerated" property unchanged |
| MV cross-join (`periods × workers` cartesian) | v3 (already deferred in MV v2 spec) | Separate primitive, not UNION territory |

## Non-goals

- Changing the existing single-source MV path's behaviour or row shape.
- Imposing a canonical composite-key encoding. The MV consumer's `rowKey: row => ...` callback formats however it likes (`${a}|${b}`, JSON canonicalisation, hash, etc.).
- Schema validation across union arms beyond what TypeScript infers from the shared row-shape type parameter and runtime missing-field guards.
- Cross-collection writes from a single MV refresh. The MV's output collection remains exactly one.

## Sequencing — three PRs

| Order | PR | Touches | Depends on |
|---|---|---|---|
| 1 | **#166 multi-key groupBy** | `packages/hub/src/query/builder.ts`, `packages/hub/src/aggregate/groupby.ts`, `packages/hub/src/materialized-views/strategy.ts` (accept `string[]`), unit tests, showcase, `features.yaml`, subsystem doc | pre.14 MV v2 (shipped) |
| 2 | **#165 UNION MV** | `packages/hub/src/materialized-views/{registry,strategy,executor,dep-analyser}.ts`, unit tests, showcase, `features.yaml`, subsystem doc | PR 1 (consumes `canonicalGroupKey` helper + multi-key groupBy in the strategy) |
| 3 | **#131 GuardStrategyHandle variance** | `packages/hub/src/guards/` only | none — independent; can land first, last, or anywhere |

PRs are sequential because PR 2 imports the canonical-key helper added by PR 1. PR 3 is free to interleave.

## API surface

### #166 multi-key groupBy

```ts
// Single-field overload — back-compat (return narrows F to the literal field name)
.groupBy<F extends string>(field: F): GroupedQuery<T, F>

// Variadic overload — new
.groupBy<F extends readonly [string, ...string[]]>(...fields: F): GroupedQueryN<T, F>
```

`GroupedQueryN<T, F>.aggregate<R>(spec: AggregateSpec<R>)` returns rows of type:

```ts
Pick<T, F[number]> & R
```

where `F[number]` is the union of the field literal types.

**`withMaterializedView` strategy:**

```ts
type MaterializedViewStrategy<Row> = {
  name: string
  query?: (db: Db) => Query<unknown>                     // existing
  unionSources?: UnionSource<Row>[]                      // new (PR 2)
  groupBy?: string | readonly string[]                   // new (PR 1) — string keeps back-compat
  aggregate?: AggregateSpec<unknown>                     // existing
  rowKey: (row: Row) => string                           // existing
  refresh?: 'eager' | 'lazy'                             // existing
  strict?: boolean                                       // existing
  onEmpty?: 'tombstone' | 'keep'                         // existing
  maxRows?: number                                       // existing
}
```

**`canonicalGroupKey` helper:**

```ts
// packages/hub/src/aggregate/canonical-key.ts (new file)
export function canonicalGroupKey(
  fields: readonly string[],
  row: Record<string, unknown>,
): string {
  // Sort field names lexicographically, then serialise as `name=value|name=value|...`
  // Values JSON-stringified; undefined → 'undefined'; null → 'null'
}
```

Pure function. Unit-tested with: single field, multiple fields, order-invariance, undefined/null handling, value-with-pipe-character handling (escape rule documented in tests).

### #165 UNION MV (Option 1)

```ts
type UnionSource<Row> = {
  collection: string
  map: (sourceRow: any) => Row
}

// Canonical consumer shape — the niwat monthly-VAT MV:
withMaterializedView<{ clientId: string; period: string; vat: number }>({
  name: 'monthlyOutputVat',
  unionSources: [
    { collection: 'taxReceipts', map: r => ({ clientId: r.clientId, period: r.issuedAt.slice(0, 7), vat:  r.paidServicesVat }) },
    { collection: 'creditNotes', map: r => ({ clientId: r.clientId, period: r.issuedAt.slice(0, 7), vat: -r.paidServicesVat }) },
  ],
  groupBy: ['clientId', 'period'],
  aggregate: { vat: sum('vat') },
  rowKey: r => `${r.clientId}|${r.period}`,
  refresh: 'eager',
})
```

Registration-time validation:

- `unionSources` present AND `query` present → throw `MaterializedViewConfigError("unionSources and query are mutually exclusive")`.
- `unionSources.length < 2` → throw `MaterializedViewConfigError("unionSources requires at least 2 source collections")`.
- Duplicate collection name across `unionSources` entries → throw `MaterializedViewConfigError("unionSources must reference distinct collections")`.
- `unionSources` present AND no `groupBy` → allowed (UNION-only, no aggregation; passes through mapped rows).

## Implementation notes

### PR 1 (#166)

- **`packages/hub/src/query/builder.ts`** — overload the existing `groupBy` method. Internal state on `Query<T>` already carries `_groupByField?: string`; widen to `_groupByFields?: readonly string[]` and keep single-field constructions setting a 1-element array. The single-field overload's return type stays `GroupedQuery<T, F>` for back-compat; the variadic returns `GroupedQueryN<T, F>`.
- **`packages/hub/src/aggregate/groupby.ts`** — the dedup map switches its key from `row[field]` to `canonicalGroupKey(fields, row)`. Row output stamps fields in *declaration order* (iterate `fields` array directly).
- **`packages/hub/src/aggregate/canonical-key.ts`** — new file, pure helper.
- **Cardinality warning** — existing call site (`groupby.ts` ~line 93 per CLAUDE.md) reads from the dedup map's `size`; message format becomes `groupBy [a, b, c] produced N distinct tuples (warn ≥ 10k)`.
- **Tests** — `packages/hub/src/aggregate/groupby.test.ts`: extend with multi-key cases (2-key, 3-key, declaration-order preservation, canonical-key invariance under field-order permutation in two separate `groupBy` calls, cardinality warning text contains all field names).
- **No changes to**: `Collection.scan()` (already returns `ScanBuilder<T>` that delegates to the same path), `live()`/`subscribe()` (cardinality threshold same), `aggregate({...}).run()` terminal (already group-aware).

### PR 2 (#165)

- **`packages/hub/src/materialized-views/strategy.ts`** — accept `unionSources?: UnionSource<Row>[]`. Validate at the construction call (`withMaterializedView`) before the registry call.
- **`packages/hub/src/materialized-views/registry.ts`** — extend the per-collection reverse-index. Today the registry tracks `mvName → MaterializedViewStrategy`; add `_sourceIndex: Map<string, Set<string>>` (`collectionName → Set<mvName>`). On register: for each entry in `unionSources` (or `dep-analyser.sources(query)` for `query`-form), insert. On unregister: remove. `findMvsForCollection(name)` is now a single map lookup.
- **`packages/hub/src/materialized-views/executor.ts`** — branch at the start of `materialise(strategy, db)`:
  - `strategy.query`: existing path unchanged.
  - `strategy.unionSources`: for each entry, read `collection`, run `map` on each row, push into `unifiedRows` buffer. Then apply `groupBy` + `aggregate` to `unifiedRows` (same builder, same canonical-key helper).
- **`packages/hub/src/materialized-views/dep-analyser.ts`** — add a thin shortcut: when `strategy.unionSources` is set, `sources(strategy)` returns `unionSources.map(s => s.collection)`. The AST-walking analyser still runs for the `query` form.
- **`sourceVersions`** — already a `Record<string, number>` on the materialised row envelope per pre.14 design. UNION makes it multi-entry instead of single-entry. The version-bump path on `Collection.put` (per pre.14 source-write hook) reads the strategy's `sources` set; behaviour falls out for free once the source set is multi-element.
- **`Collection.put` source-write hook** — already calls `registry.findMvsForCollection(this.name)` per pre.14. UNION just means more MVs come back from one collection's lookup. No change to `put` itself.
- **Mismatched-map runtime guard** — when one source's `map` produces a row missing a field that another source's `map` produces, the multi-key `groupBy` will see `undefined` for that field and group accordingly. Documented as a "garbage-in-garbage-out" boundary; the test suite includes a positive assertion that *consistent* maps produce correct results and a negative case showing the visible failure mode.
- **Tests** — `packages/hub/src/materialized-views/union.test.ts` (new file): 2-source UNION, 3-source UNION, refresh on each arm independently, mutually-exclusive `query` + `unionSources` rejected, `length < 2` rejected, duplicate-collection rejected, combined UNION + multi-key groupBy (niwat shape), `onEmpty: 'tombstone'` behaviour when all contributing rows on a key are deleted, `strict: true` rollback when the executor throws mid-`map`.
- **Showcase** — `showcases/src/withMaterializedView-union.ts` (new): two collections, one MV reading both, asserts hook firing on writes to each arm, asserts combined row shape.

### PR 3 (#131)

- **`packages/hub/src/guards/`** — locate the `GuardStrategyHandle<T>` definition. Identify the `any` widening (probably a function signature returning `unknown` widened to `any` in a public-API position). Replace with the correct generic parameter flow. Run `pnpm turbo typecheck` and confirm no consumer in the workspace breaks. No test changes needed (type-only refactor); existing tests assert behaviour, which is unchanged.

## Testing

| Layer | Coverage |
|---|---|
| Unit (#166) | Multi-key groupBy: 2-key, 3-key, declaration-order, canonical-key sort-invariance, cardinality warning text, `GroupCardinalityError` at 100k tuples |
| Unit (#165) | UNION 2-source, 3-source, mutual exclusion with `query`, `length < 2` rejection, duplicate-collection rejection, per-arm refresh, combined UNION + multi-key, `onEmpty`/`strict`/`maxRows` propagation, mismatched-map garbage-in-garbage-out boundary |
| Combined | Niwat shape — UNION `taxReceipts ∪ creditNotes`, multi-key `groupBy('clientId', 'period')`, `sum('vat')`, writes to either arm re-materialise correctly |
| Integration | `to-file` conformance: register MV, write to both arms, close & reopen vault, assert MV row state survives |
| Showcase | `showcases/src/withMaterializedView-multikey.ts`, `showcases/src/withMaterializedView-union.ts`, plus the combined assertion baked into one of them |
| Architecture invariants | `node scripts/check-architecture.mjs` clean (no new strategy-opt-in or peer-dep violations) |
| Feature schema | `node scripts/validate-features.mjs` clean after adding `mv-multikey-groupby` and `mv-union-sources` |

Target: 1573 + N hub tests passing on green CI before merge.

## Docs

- **`docs/subsystems/materialized-views.md`** — add two sections:
  - "Multi-key `groupBy`" — variadic API, row-shape rule (declaration order), cardinality, composite-key encoding is consumer's choice
  - "UNION sources" — `unionSources` API, mutual exclusion with `query`, per-source `map` as the schema-unification boundary, source-write hook behaviour, the niwat canonical shape
- **`SUBSYSTEMS.md`** — no new entry (this extends an existing subsystem), but a one-line note under the MV row pointing at the new sections.
- **`features.yaml`** — two entries (`mv-multikey-groupby`, `mv-union-sources`).
- **`ROADMAP.md`** — pre.15 entry referencing this spec.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Single-key `groupBy` callers see a return-type widening if overload resolution picks the variadic | Keep the single-field overload as the *first* declaration in the overload list; TypeScript's resolution prefers it for 1-arg calls. Verify with a regression test that pins the old narrowed return type. |
| Per-source `map` produces inconsistent row shapes silently | Documented as garbage-in-garbage-out; tests assert the visible failure mode and a positive consistent-map case. The single-row-shape type parameter on `withMaterializedView<Row>` catches most of this at compile time. |
| Dep-analyser fan-out on a hot collection (many MVs include it as a UNION arm) | `findMvsForCollection` is a single map lookup; per-MV refresh is the same cost as today. The fan-out is just "how many MVs touch this collection", not a new algorithmic surface. |
| Cardinality blow-up when grouping by 3+ keys | Existing 10k-warn / 100k-throw threshold applies on the tuple count, not the field count. The warning message lists all fields so the consumer can see which combination exploded. |
| Source-write hook reverse-index gets out of sync with strategy registry | Registry holds the index as private state, updated atomically with the strategy-table entry on register/unregister. Unit test asserts state after a register-then-unregister round-trip. |

## Out of scope (explicit non-asks for this cycle)

- `.union()` query-builder chain operator (Option 2 from issue #165)
- `db.unionOf(...)` accessor (Option 3 from issue #165)
- Cross-compartment UNION
- Recursive UNION (UNION inside one of the arms)
- Multi-key index hints / index-accelerated `groupBy`
- MV cross-join (already deferred in MV v2 spec to v3)
- Anything from #14, #15, #121, #1, #2, or the pre.13 showcase cluster

## References

- Pre.14 MV v2 spec: [`2026-05-20-dim14-mv-v2-design.md`](./2026-05-20-dim14-mv-v2-design.md)
- Pre.14 derivation v1 spec: [`2026-05-01-dim14-derivation-v1-design.md`](./2026-05-01-dim14-derivation-v1-design.md)
- Pre.14 guards spec: [`2026-05-18-guards-design.md`](./2026-05-18-guards-design.md)
- Open issues this spec resolves: #165 (UNION MV), #166 (multi-key groupBy), #131 (`GuardStrategyHandle` variance)
- Pre.14 epic for context: #143
