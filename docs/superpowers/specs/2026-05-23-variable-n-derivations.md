# Variable-N derivations — `shape: 'array'` (#200, slice 1)

> Per-issue spec for #200. Extends `withDerivation` so one source row
> can produce a variable-length list of output rows in a single
> output-key. Unblocks the three niwat use cases (interval-overlap
> MVs, multi-WHT-line documents, carry-forward expansion).

## 0. Status

- Date: 2026-05-23
- Tracks: #200 (slice 1 — eager mode only)
- Out of scope: lazy-mode array shape, persisted index over `_derivedFrom.sourceId`.
- Builds on: existing `withDerivation` engine (eager record-shape pipeline, strict-mode rollback via `_executed` tracking from #133), `_internalDelete` (#144).

## 1. Goal

Allow declaring an `OutputSpec` with `shape: 'array'` and a `key` extractor:

```ts
withDerivation({
  source: 'workers',
  outputs: {
    activeInPeriod: {
      shape: 'array',
      collection: 'workerActiveInPeriod',
      key: (out) => `${out.workerId}|${out.period}`,
      maxFanout: 60,          // optional; default 64
    },
  },
  derive: (worker) => ({
    activeInPeriod: monthsCoveredBy(worker.employmentPeriods).map(period => ({
      id: `${worker.id}|${period}`,   // matches the `key` extractor
      workerId: worker.id,
      clientId: worker.clientId,
      period,
      baseSalary: worker.baseSalary,
    })),
  }),
  lifecycle: 'eager',
  deterministic: true,
})
```

Semantics:

- Each invocation of `derive` returns, for the `array`-shape output key, an array of records.
- Each record is identified by `key(record)` — the dispatch engine uses this id as the output collection's record id (same role that `source.id` plays today for record-shape).
- On source update, the dispatcher diffs the previously-emitted key set vs the new one: deletes removed, upserts in/changed, leaves untouched.
- On source delete, all derived rows are deleted.

## 2. Why this matters

Three concrete niwat use cases (per #200's body):

1. **Interval-overlap MVs** (niwat#85) — one `worker` row → N `workerActiveInPeriod` rows, one per month overlapping the worker's employment periods. Downstream MV groups on `(clientId, period)`.
2. **TaxDocument WHT lines** (niwat#84) — one `taxDocument` row with `whtLines: WhtLine[]` → N `whtLineByDocument` rows. Downstream MV groups on `(clientId, period, whtFormCode)`.
3. **Carry-forward expansion** — one `contract` row with `validFrom`/`validTo` → 12+ rows per year. Downstream monthly aggregation.

Today's workaround in all three cases is either (a) imperative aggregation in app code (loses vault-enforced invariant), or (b) hand-rolled writer fired from app code on every source-collection write (loses deterministic re-execution).

## 3. API shape

### 3.1 New `OutputSpec` variant

```ts
export interface ArrayOutputSpec<T extends Record<string, unknown>> {
  shape: 'array'
  collection: string
  /**
   * Stable identity extractor. Called on every derived record produced
   * for this output key. The string MUST be unique within a single
   * source-row invocation (duplicate keys in one derive() call throw
   * DerivationOutputShapeError).
   */
  key: (output: T) => string
  /**
   * Cap on derived-row count per source-row invocation. Defaults to 64.
   * Raise for carry-forward cases (12-month × multi-year contracts).
   * Exceeding the cap throws DerivationCapExceededError so the diff
   * doesn't silently truncate.
   */
  maxFanout?: number
}

// Discriminated union — record-shape stays exactly as today.
export type OutputSpec =
  | { shape: 'record'; collection: string; optional?: boolean }
  | ArrayOutputSpec<Record<string, unknown>>
```

The record-shape branch is unchanged. All existing v1 strategies compile without modification.

### 3.2 `derive` return shape

For an array-shape output key, the return is `T[]`. For record-shape, the return remains `T | null | undefined` (when optional).

TypeScript inference: declare `outputs` with the shape literal and the derive return type follows. (Simple discriminated mapped types.)

### 3.3 Errors

| Error | Cause |
|---|---|
| `DerivationCapExceededError` | `derive` returned more rows than `maxFanout` for an array-shape output. |
| `DerivationOutputShapeError` | Existing class — also fires when array-shape returns non-array, when array members aren't objects, or when duplicate keys appear in one invocation. |

## 4. Storage layout — fanout sidecar

To support the diff-on-update operation in O(1), the dispatcher persists, for each `(source, sourceId, outputKey)`, the set of keys emitted in the last dispatch:

```
_meta/derivations-fanout/<sourceCollection>/<sourceId>/<outputKey>
```

Plain JSON, AES-GCM-bypassed (mirrors `_meta/policy`, `_meta/handle`, `_meta/recovery-paper`, etc.):

```ts
interface FanoutSidecar {
  readonly _noydb_fanout: 1
  readonly source: string       // source collection name
  readonly sourceId: string     // source record id
  readonly outputKey: string    // strategy output key
  readonly outputCollection: string  // for forensics
  readonly keys: ReadonlyArray<string>  // last-emitted derived row ids
  readonly emittedAt: string    // ISO timestamp
}
```

The sidecar is:

- **Written** by `dispatchDerivations` after a successful array-shape output put-batch.
- **Read** at the start of the next `dispatchDerivations` for the same source-row.
- **Deleted** when the source row is deleted (via existing source-delete cascade).
- **Not exposed publicly** — internal metadata.

Why a separate `_meta/derivations-fanout/...` namespace rather than co-locating with the output records?

- Diff-on-update needs one read, not a scan.
- Deletion is bounded (one envelope per source row per output, deleted together with source).
- Stays consistent with how MVs and recovery profiles use `_meta/` sidecars for system metadata.

## 5. Diff algorithm

On `dispatchDerivations` for an array-shape output:

```
prevKeys ← read sidecar (default: empty set)
newRecs  ← derive() return value (array of records)
newKeys  ← { key(r) for r in newRecs }

if newKeys.length > maxFanout: throw DerivationCapExceededError
if duplicates(newKeys): throw DerivationOutputShapeError

toDelete ← prevKeys ∖ newKeys
toWrite  ← newRecs  (all records, including unchanged — simplest correct
                     impl; an identity-skip optimization is a follow-up)

for k in toDelete:
  outputCollection._internalDelete(k, txCtx)
for r in newRecs:
  // Track for #133 rollback before write
  if txCtx: capture prior envelope at key(r)
  outputCollection.put(key(r), r)

write sidecar with keys = newKeys
```

Slice-1 simplification: write every row in `newRecs`, even unchanged ones. Identity-skip (only write when content differs from prior) is a clear optimization but adds complexity (compare canonical JSON of `r` to previously-stored envelope decrypted, or hash-track). Defer.

### 5.1 Strict-mode rollback

The existing `_executed` tracking in `Collection.put` and `_internalDelete` captures prior envelopes onto `txCtx._executed` BEFORE the write fires. A failure mid-dispatch triggers `revertExecuted` which walks `_executed` in reverse and restores each prior. Array-shape's diff writes use the same primitives — no new rollback infrastructure needed.

The sidecar write itself happens AFTER the output writes; if it fails, the data on disk is now ahead of the sidecar. To stay symmetric:

- The sidecar write is the LAST step of the dispatch.
- On failure, the prior sidecar still says `prevKeys`; next dispatch will re-diff against that.
- Worst case: a duplicate output may be written (idempotent at the key level — same key, same value). No data loss; no orphan rows.

### 5.2 Source delete

When the source row is deleted (`Collection._doDelete` triggers MV refresh + derivation tombstone today), the array-shape outputs ALL go too:

```
sidecar ← read previous keys
for k in sidecar.keys: outputCollection._internalDelete(k, txCtx)
delete sidecar
```

This already mirrors the record-shape case; the only new part is "iterate the sidecar's key list."

## 6. Lifecycle scope (slice 1)

`shape: 'array'` is **eager-only** in slice 1. Lazy-mode would need:

- A different `markStale` payload (tracking which derived ids are stale, not just "the source row is dirty").
- A different "resolve on read" path that recomputes the fanout.

Both are tractable but doubling the design scope. Defer to slice 2 with its own spec.

Registering an array-shape output with `lifecycle: 'lazy'` throws a clear validation error at `withDerivation` construction time: `"shape: 'array' supports lifecycle 'eager' only in this release (#200 slice 1)"`.

## 7. Tests

`packages/hub/__tests__/derivations/array-shape.test.ts`:

- **Basic fanout**: 1 source row → 3 derived rows; all 3 readable in the output collection.
- **Update reduces fanout**: source updated to produce 2 derived rows; the third is deleted; sidecar reflects new keys.
- **Update grows fanout**: source updated to produce 4 derived rows; the new one is inserted; sidecar reflects.
- **Source delete cascades**: source deleted; all derived rows gone; sidecar deleted.
- **maxFanout exceeded**: source produces N+1 rows; throws `DerivationCapExceededError`; no derived rows written (we throw before any put).
- **Duplicate keys**: `derive` returns two records with the same `key(r)` value; throws `DerivationOutputShapeError`.
- **Empty array**: source produces zero rows; equivalent to "no outputs"; any prior outputs deleted; sidecar carries empty keys array.
- **Strict-mode rollback**: a derive that throws mid-batch via a second strategy on the same source rolls back the array-shape writes too.
- **Record + array mixed strategies**: same source supports a record-shape AND an array-shape output simultaneously; both update independently on source change.
- **niwat-shape canonical**: worker → activeInPeriod with `monthsCoveredBy` over multiple employmentPeriods (the canonical niwat#85 use case); verify groupBy MV on output collection sees the right rows.
- **Cycle detection**: array-shape participates in the existing cycle-detection graph (output collection cannot be the source of another strategy that targets the original source).
- **Lifecycle 'lazy' rejection**: clear error at registration when shape 'array' + lifecycle 'lazy'.

## 8. PR boundary

One PR containing:

- `packages/hub/src/derivations/types.ts` — discriminated `OutputSpec` union; new `ArrayOutputSpec` interface.
- `packages/hub/src/derivations/executor.ts` — extend `run` to handle the array-shape branch; emit `RunResult` with per-output `entries: Array<{ key, value }>` for array-shape outputs.
- `packages/hub/src/derivations/with-derivation.ts` — accept the new shape; validation at registration (lifecycle + maxFanout).
- `packages/hub/src/derivations/registry.ts` — cycle-detection unchanged (still walks via `output.collection`).
- `packages/hub/src/derivations/fanout-sidecar.ts` (NEW) — `loadFanoutSidecar`, `saveFanoutSidecar`, `deleteFanoutSidecar`.
- `packages/hub/src/collection.ts` — extend `dispatchDerivations` with the array-shape diff branch.
- `packages/hub/src/errors.ts` — `DerivationCapExceededError`.
- `packages/hub/__tests__/derivations/array-shape.test.ts` (NEW).
- `packages/hub/src/index.ts` — export `ArrayOutputSpec`, `DerivationCapExceededError`.

Approximate diff: ~600–900 LOC, 1 new test file, 2 new internal source files.

## 9. Acceptance

- [ ] `withDerivation({ outputs: { foo: { shape: 'array', ..., key } } })` registers and validates.
- [ ] Eager dispatch writes the right N rows; subsequent updates correctly diff (delete-removed, upsert-kept).
- [ ] Source delete cascades to all derived rows.
- [ ] `maxFanout` enforced; `DerivationCapExceededError` thrown before any write.
- [ ] Duplicate keys → `DerivationOutputShapeError`.
- [ ] Empty array → all prior outputs deleted; sidecar reflects.
- [ ] Strict-mode rollback restores prior outputs across an array-shape diff.
- [ ] Mixed record + array on the same source works independently.
- [ ] niwat canonical use case (worker → activeInPeriod) round-trips, and an MV on the output collection sees the expanded rows.
- [ ] Lifecycle `'lazy'` + shape `'array'` rejected with a clear error message.
- [ ] Full hub regression passes (1715+ + new tests).
- [ ] Typecheck + lint clean.

## 10. Out of scope (separate follow-ups)

- **Lazy-mode array-shape** — needs new stale-tracking semantics.
- **Identity-skip optimisation** — only-write-when-content-differs requires per-row hash tracking; defer until measured slowdown.
- **Persisted index over `_derivedFrom.sourceId`** — the sidecar suffices for `dispatchDerivations`; consumers wanting to query derived outputs by source separately (e.g., for an audit view) would benefit from such an index. Out of scope.
- **Streaming / chunked derive** — for sources with very large fanout (10K+ rows per source), the current `derive` returns an array all at once. A streaming variant is a future optimisation.

---

Cross-references:

- Issue: #200
- niwat use cases: niwat#85 (interval-overlap MVs), niwat#84 (TaxDocument WHT lines)
- Sibling subsystem: materialized views (Dim 14 v2 / v2-multikey-union, pre.14 + pre.15)
- Existing primitives: `_internalDelete` (#144), `_executed`/`txCtx` rollback (#133), `withDerivation` (#129)
