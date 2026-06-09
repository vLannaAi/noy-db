# crossShardJoin — co-partitioned + broadcast dimension join

**Status:** Design approved 2026-06-09
**Epic:** #271 multi-vault partition federation (milestone 16)
**Scope:** One of the remaining federation primitives. Self-contained "quick win" — no crypto design, no `join.ts` changes.

## Goal

Give `ShardedQuery` two correlation primitives so a `VaultGroup` fan-out can attach related records to its rows:

1. **`crossShardJoin(field, opts)`** — *co-partitioned* join: each shard joins its left collection against the **same shard's** right collection (resolved via a declared `ref()`), then results union. Reuses the existing intra-vault `.join()` executor per shard.
2. **`broadcastJoin(field, opts)`** — *broadcast dimension* join: every merged row is enriched from a **single shared collection** (a dimension/reference table living in one vault), loaded once and attached centrally.

Both are programmatic-only (never surface in the `in-sql` grammar) and return the existing `FanoutResult<R>` shape `{ results, skippedVaults }`.

## Non-goals

- **Arbitrary cross-partition correlation** (shard A left ⋈ shard B right). Excluded by the `join.ts` architectural invariant: "cross-vault correlation goes through `queryAcross`; this is an architectural invariant, not a limitation we plan to lift." Co-partitioned join does not breach it — every join *is* intra-vault; only the fan-out is cross-shard. Broadcast does not breach it either — it bypasses the join executor entirely (central map-attach, not correlation through the planner).
- **Reactive joined queries.** `.live()` on a joined `ShardedQuery` is deferred (cross-shard right-side change propagation is out of scope). It throws in v1.
- **Aggregation over joined rows.** `.aggregate()` / `.groupBy()` on a joined `ShardedQuery` is deferred. It throws in v1.
- **SQL surface.** The `in-sql` `JOIN` keyword stays same-vault. No grammar change.
- **`join.ts` changes.** None. See "Why `join.ts` is untouched" below.

## Why `join.ts` is untouched (and the `partitionScope` seam is not used)

The epic prose said crossShardJoin "extends `JoinLeg.partitionScope`." That was a pre-`VaultGroup` guess at the mechanism, written when the seam was reserved for *shard-pruning a join from a `where()` on the partition key*. The federation work that landed afterward (#292/#319) moved shard selection into `VaultGroup.resolveEligible` at the fan-out layer. The `partitionScope` field is therefore **vestigial relative to the shipped federation design** — populating it cosmetically would add an unread field-write for documentation's sake. We do not touch it.

The deliverable is `crossShardJoin` (the API). It is delivered entirely from `federation/`:

- Co-partitioned join calls the *existing, unchanged* intra-vault `.join()` inside each shard's closure. Same `JoinLeg`, same `applyJoins`, same DEK.
- Broadcast is a separate central enrichment, not a join-planner construct.

A consequence worth stating: because all code lives in `federation/` (already a lazy import chunk), it sits under **no** kernel-surface line ceiling (`collection.ts` / `vault.ts` / `noydb.ts`) and trips **no** architecture invariant.

## API

### Co-partitioned join

```ts
.crossShardJoin(field: string, opts: {
  as: string                 // alias key under which the joined record attaches
  maxRows?: number           // per-shard row ceiling override (default DEFAULT_JOIN_MAX_ROWS)
  strategy?: JoinStrategy     // 'hash' | 'nested' planner override (passthrough)
}): ShardedQuery<T, R>
```

- `field` MUST be a `ref()`-declared field on the left collection in the shared template schema. If not declared, the per-shard `.join()` throws its existing actionable error; we surface that as the shard's skip reason (see Failure semantics) — except for a declaration error, which is deterministic across all shards and is therefore re-raised as a single `CrossShardJoinError` rather than N identical skips (see below).
- Right collection name and the dangling-ref `RefMode` are both resolved from the `ref()` descriptor — never passed explicitly. `Query.join()`'s option bag is `{ as, strategy?, maxRows? }` (no `mode` override), so `crossShardJoin` deliberately omits `mode` too; the declared ref mode governs dangling refs per shard. This keeps the intra-vault executor unchanged.
- Returns a new `ShardedQuery` carrying an appended co-partitioned leg (immutable builder, like `.where()`).

### Broadcast dimension join

```ts
.broadcastJoin(field: string, opts: {
  as: string                 // alias key under which the dimension record attaches
  from: BroadcastSource      // an opened Collection (or structural snapshot source) in another vault
  on?: string                // key on the right record to match field against; default 'id'
  mode?: 'warn' | 'cascade'   // miss behavior; default 'warn' (attach null + one-shot warning)
}): ShardedQuery<T, R>
```

- `from` is an explicit handle because a `ref()` cannot point cross-vault. The API asymmetry (declared ref vs explicit `from`/`on`) is deliberate — two mechanisms.
- The caller holds `from`'s keyring by possessing the opened handle → "permission-checked" by construction. No new ACL layer.
- `BroadcastSource` is the minimal structural shape `{ snapshot(): readonly unknown[]; list?(): Promise<unknown> }` — `snapshot()` is required, `list()` optional. A `Collection` satisfies it structurally; the executor calls `await from.list()` first when present to hydrate the in-memory cache, then reads `from.snapshot()`.
- Multiple independent `broadcastJoin` legs may be stacked (each enriches a different `as`). No join *on* a broadcast's output (no chaining a co-partitioned join against a broadcast alias).

### Result

```ts
.toArray(options?: FanoutQueryOptions): Promise<FanoutResult<Enriched>>
//   Enriched = R & { [as]: <joined record> | null }   (one widening per leg)
//   FanoutResult = { results: Enriched[], skippedVaults: SkippedVault[] }
```

## Execution model

`ShardedQuery` gains two private leg arrays: `coPartitionedLegs: CoPartitionedLeg[]` and `broadcastLegs: BroadcastLeg[]`. `crossShardJoin()` / `broadcastJoin()` return a new `ShardedQuery` with the leg appended (preserving `clauses` and the other leg array).

`fanoutRecords(options)` (existing) changes in exactly one place — the per-shard closure:

```ts
async (vault) => {
  this.group.template.configure(vault)
  const coll = vault.collection<R>(this.collectionName)
  await coll.list()
  // Hydrate each co-partitioned join target — resolveSource reads the
  // in-memory cache, so an unopened right collection would join to an
  // empty snapshot (every row → null). This is the one subtlety vs the
  // intra-vault path, where the caller has usually already opened both.
  for (const leg of this.coPartitionedLegs) {
    const desc = vault.resolveRef(this.collectionName, leg.field)
    if (desc) await vault.collection(desc.target).list()
  }
  let q = coll.query()
  for (const c of this.clauses) q = q.where(c.field, c.op, c.value)
  for (const leg of this.coPartitionedLegs) {
    q = q.join(leg.field, {
      as: leg.as,
      ...(leg.maxRows !== undefined ? { maxRows: leg.maxRows } : {}),
      ...(leg.strategy ? { strategy: leg.strategy } : {}),
    })
  }
  return q.toArray()
}
```

Order matters and is already correct: the existing executor applies `where` → `orderBy` → `limit` → joins. We add `where` then `join`, matching that order. The right-side hydration (`vault.resolveRef` → `vault.collection(target).list()`) must run *before* the join, since `Vault.resolveSource` reads the in-memory cache only.

`toArray()` (existing) changes by applying broadcast legs centrally **after** the fan-out union:

```ts
async toArray(options = {}): Promise<FanoutResult<Enriched>> {
  const { records, skippedVaults } = await this.fanoutRecords(options)
  const enriched = applyBroadcastLegs(records, this.broadcastLegs)  // new, in cross-shard-join.ts
  return { results: enriched, skippedVaults }
}
```

`applyBroadcastLegs(rows, legs)` (new, in `cross-shard-join.ts`):

- For each leg: `await leg.from.list?.()` (hydrate if hydratable), `const snap = leg.from.snapshot()`, build `Map<string, unknown>` keyed by `readPath(record, leg.on ?? 'id')` coerced via a local `coerceKey` helper. `coerceKey` mirrors `join.ts`'s private `coerceRefKey` (string → string; number/bigint → `String(v)`; else `null`) — re-implemented locally rather than exported from `join.ts`, to keep `join.ts` literally untouched. `readPath` IS imported from `query/predicate.js` (already exported).
- For each row: `key = coerceRefKey(readPath(row, leg.field))`; `match = key === null ? null : (map.get(key) ?? null)`; attach `{ ...row, [leg.as]: match }`. On `null` match with `mode: 'warn'` (default), emit a one-shot warning keyed by `field→as` (dedup `Set`, mirroring `warnOnceDangling`).
- Builds each leg's map once; broadcasts to all rows. Loads the `from` snapshot exactly once per `toArray()`.

## Failure semantics

- **Shard throws during its join** → caught by the existing `fanoutRecords` loop and recorded as `skippedVault` with `reason: classifyShardSkip(error)`. Consistent with current fan-out behavior.
- **Dangling ref within a shard** → the existing per-shard `RefMode`: `strict` → the shard's closure throws `DanglingReferenceError` → that shard becomes a `skippedVault`; `warn` / `cascade` → `null` attached for that row, shard succeeds.
- **`ref()` not declared for `field`** → deterministic across all shards (shared schema). Rather than returning N identical "no ref declared" skips, detect this once up front: resolve the ref against the template schema before fan-out and throw `CrossShardJoinError` naming the field and collection. (If the template cannot be cheaply inspected, fall back to: if *every* eligible shard skips with the same ref-declaration reason, re-raise as `CrossShardJoinError`.)
- **Broadcast miss** → `null` attached; `mode: 'warn'` (default) emits a one-shot warning; `mode: 'cascade'` is silent.
- **Empty eligible set** (all shards drift-skipped) → `{ results: [], skippedVaults: [...] }`, broadcast legs applied to the empty set (no-op). No throw.

## Guards on deferred surfaces

`ShardedQuery.live()` and `ShardedQuery.aggregate()` / `.groupBy()` must throw when any leg array is non-empty:

```ts
live(options = {}): CrossVaultLiveQuery<R> {
  if (this.coPartitionedLegs.length || this.broadcastLegs.length) {
    throw new CrossShardJoinError(
      'live() is not supported on a ShardedQuery with crossShardJoin/broadcastJoin legs in v1. ' +
      'Use toArray() for joined cross-shard queries.',
    )
  }
  /* ...existing... */
}
```

Same guard at the top of `aggregate()` and `groupBy()`. This prevents silently dropping the join legs (the failure mode the design explicitly guards against).

## Errors

New `CrossShardJoinError extends NoydbError` in `packages/hub/src/errors.ts`, two-arg `super('CROSS_SHARD_JOIN', message)` (matching the existing error convention, e.g. `NumberingUncertaintyError`). Used for: undeclared-ref-across-all-shards, and the deferred-surface guards.

## Zero-knowledge note

- **Co-partitioned join**: right side is in the same shard, decrypted under the same DEK the caller already holds for that shard. No change to the per-shard ZK profile.
- **Broadcast join**: the merged result set co-mingles plaintext from the sharded vaults *and* the dimension vault, in the caller's process. The caller already holds both keyrings (they passed the `from` handle). No ciphertext crosses a DEK boundary; no backend sees cross-vault plaintext. Document that the enriched result is plaintext from two authorized vaults — expected and caller-initiated.

## Files

| File | Change |
|---|---|
| `packages/hub/src/federation/cross-shard-join.ts` | **New.** `CoPartitionedLeg` / `BroadcastLeg` types, `BroadcastSource` interface, `applyBroadcastLegs(rows, legs)` executor, broadcast warn-dedup. |
| `packages/hub/src/federation/vault-group.ts` | `ShardedQuery` gains `coPartitionedLegs` / `broadcastLegs` fields + constructor params, `crossShardJoin()` / `broadcastJoin()` methods; `fanoutRecords` threads co-partitioned legs into the closure; `toArray` applies broadcast legs; `live` / `aggregate` / `groupBy` guards. |
| `packages/hub/src/errors.ts` | New `CrossShardJoinError`. |
| `packages/hub/src/federation/index.ts` | Export the public option types (`CrossShardJoinOptions`, `BroadcastJoinOptions`, `BroadcastSource`) — they appear in the `ShardedQuery` method signatures, so they are public surface. |
| `packages/hub/__tests__/federation-cross-shard-join.test.ts` | **New.** Behavior + failure-mode coverage. |
| `features.yaml` | The `vault-group-federation` feature already exists. **Update** its invariants: replace the line `'join.ts partitionScope seam is untouched (crossShardJoin deferred)'` with one stating crossShardJoin shipped *and still leaves join.ts untouched*. No new feature entry; showcase optional (the feature already carries showcases 98–100). |

`join.ts` is **not** in this table — intentionally.

## Test plan (behaviors to cover)

1. Co-partitioned join attaches each shard's same-vault right record; results union across shards.
2. Co-partitioned join with a `where()` filter narrows the left set before joining (order correctness).
3. Per-shard `maxRows` ceiling: a shard exceeding it is skipped (not the whole query).
4. Dangling ref `strict` → shard skipped with reason; `warn`/`cascade` → `null` attached.
5. Undeclared ref field → single `CrossShardJoinError`, not N skips.
6. Broadcast join attaches the dimension record by `on` key; default `on: 'id'`.
7. Broadcast miss → `null` + one-shot warn (`warn`); silent (`cascade`).
8. Broadcast snapshot loaded exactly once regardless of row count (spy on `from.snapshot`).
9. Stacked legs: one co-partitioned + two broadcast legs all attach independently.
10. `.live()` / `.aggregate()` / `.groupBy()` on a joined query throw `CrossShardJoinError`.
11. Drift-skipped shards still surface in `skippedVaults`; broadcast applied to the surviving union.
12. Empty eligible set → `{ results: [], skippedVaults }`, no throw.
