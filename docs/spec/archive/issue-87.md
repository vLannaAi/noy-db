# Issue #87 — Design v0.6 query DSL & exports with partition-awareness in mind (no partition code yet)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **Closed:** 2026-04-09
- **Milestone:** v0.6.0
- **Labels:** _(none)_

---

## Why this issue exists

Discussion #86 proposes partitioned collections (per-partition DEKs, carries with closing snapshots, ledger-anchored close events). That work doesn't land until v0.10 at the earliest — it depends on joins (#64), aggregations (#65), and the export-snapshot primitive (#84) being designed first.

But the design choices made in v0.6 for joins/aggregations/exports can either **leave the door open** for partitioning or **silently close it**. This issue captures the constraints that v0.6 work has to honor so v0.10 doesn't require an API break.

This is **design-forward, not implementation**: nothing partition-related ships in v0.6. The v0.6 epics (#64, #65, plus the export-snapshot work in #84) just have to make decisions in a partition-aware way.

## Constraints v0.6 must honor

### 1. Join planner needs a "partition scope" concept (even with one partition)

Even though every collection in v0.6 has exactly one logical partition, the join planner's internal representation must carry a partition-scope field on every join leg. Concretely:

- A `JoinLeg` type that carries `{ collection, partitionScope: 'all' | string[] }`.
- v0.6 always sets `partitionScope: 'all'` because partitioning doesn't exist yet.
- v0.10 starts populating it from query predicates (`where('year', '==', 2024)` → `partitionScope: ['2024']`).

If v0.6 doesn't model this, adding partition-scoped joins in v0.10 is an API break to the join planner internals. Modeling it now is two extra fields and zero behavior change.

**Acceptance:** the v0.6 join planner has a `partitionScope` field on its internal representation, even if it's always `'all'` and never read by the executor.

### 2. `.aggregate().live()` reducer signature must leave room for "seed from a precomputed value"

This is the load-bearing constraint. Without it, partitioned aggregations in v0.10 would recompute closed-period data on every tick and silently destroy the entire performance argument from #86.

The reducer signature in #65 v2 (per-row callback reducers) needs to accept an optional **seed** parameter:

```ts
collection.query()
  .aggregate({
    runningTotal: sum('amount', { seed: 0 }),  // v0.6: seed always 0
  })
```

In v0.10, the seed becomes the value read from the previous partition's carry:

```ts
const carry = await invoices.partition('2025').previousCarry()
collection.query()
  .where('year', '==', 2025)
  .aggregate({
    runningTotal: sum('amount', { seed: carry.runningTotal }),
  })
```

If v0.6 ships `.aggregate()` without the seed parameter, v0.10 either:
- (a) Adds it as a new optional parameter — fine but requires every reducer to grow a new code path.
- (b) Adds a separate `.aggregateWithSeed()` API — API duplication.
- (c) Forces consumers to manually post-process — defeats the optimization.

**Acceptance:** every built-in reducer (`sum`, `count`, `avg`, `min`, `max`, plus the v2 per-row callback form) accepts an optional `seed` parameter in v0.6. The parameter is ignored by the executor (no carry to read from yet) but is plumbed through the reducer protocol.

### 3. Export-snapshot primitive (#84) must generalize to "any frozen-at-export-time auxiliary state"

#84 currently captures one use case: bundling a dictionary snapshot into the export so an i18n export is self-consistent (the labels in the export match the records in the export, even if the dictionary mutates between record-stream-start and record-stream-end).

Partitioned collections will need exactly the same primitive for a different payload: bundling **carries** into the export so a multi-year export is self-consistent (the historical aggregates in the export match the records in the export).

If #84 designs the snapshot mechanism narrowly around dictionaries — e.g. with a `dictionarySnapshot` field on the export envelope, or a dictionary-specific serialization path — then v0.10 has to either retrofit it or add a parallel mechanism.

**Acceptance:** the export-snapshot primitive in #84 uses a generic field (e.g. `auxiliaryState: Record<string, unknown>`) that can carry dictionary snapshots in v0.8 *and* carry snapshots in v0.10. The dictionary use case is one consumer of the primitive, not the only shape it understands.

### 4. Export envelope must reserve space for partition metadata

When partitioned exports land in v0.10, each record in the export stream needs to know which partition it came from (for round-trip imports, for partition-scoped re-exports, for `verify()` after import). If the v0.6 export envelope has no `partition` field on records, v0.10 has to either:

- Add it and break consumers reading existing exports.
- Add a parallel "partitioned export" format.

Better: v0.6 envelope reserves an optional `_partition?: string` field on every exported record. v0.6 always omits it. v0.10 starts populating it.

**Acceptance:** export envelope schema in v0.6 explicitly documents `_partition?: string` as a reserved field. The schema validator accepts it, the executor never writes it, importers tolerate it.

### 5. Ledger event format must support "parent hash from a different chain"

The v0.4 ledger is a single chain per collection. Partitioned collections will have one chain per partition, with each partition's opening event referencing the previous partition's closing head as a parent hash from a different chain.

The current v0.4 ledger event format probably doesn't have a "parent from another chain" field — it just walks back through the same chain's previous entries. If v0.6 ships any ledger format extensions (for joins or aggregations recording their query inputs), they must not assume single-chain structure.

**Acceptance:** any ledger event format changes in v0.6 use a `parentHashes: Hash[]` array (not a single `parentHash`) so v0.10 can record both within-partition predecessor and cross-partition closing-head linkage.

## What this issue does NOT do

- Does not implement partitioning. Zero partition code lands in v0.6.
- Does not block #64, #65, or #84 from progressing — these are constraints on their *design*, not new work items.
- Does not commit v0.10 to a specific partition API. The constraints just preserve optionality; the actual partition API is still up for debate in #86.

## How to use this issue

When working on #64, #65, or #84, check this issue's constraints before finalizing the design. If a design decision conflicts with one of these constraints, the right move is to discuss it on this issue (or back on #86) before locking it in. The constraints are not hard rules — they're "here's what you'd be giving up if you don't honor them."

If by v0.6 close, partitioning has been deprioritized or abandoned, this issue can be closed as "constraints no longer needed." But while #86 is open, these are the load-bearing seams.

## Cross-references

- Discussion #86 — Partitioned collections proposal (the source of these constraints)
- #64 — Joins (constraint 1 applies)
- #65 — Aggregations (constraint 2 applies, load-bearing)
- #84 — Export bundled snapshot (constraint 3 applies)
