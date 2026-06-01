# Hub coordination epic (#228 + #231) — design

**Status:** epic decomposition + first-slice design · **Date:** 2026-06-01 · **Milestone:** #12 (deferred items)

Groups the two M12-deferred coordination features. They are **independent subsystems** — decomposed and sequenced here; each gets its own spec→plan→PR cycle.

## Epic decomposition

| Sub-project | Issue | Scale | Notes |
|---|---|---|---|
| **Dry-run transactions** | #231 | small, self-contained | first — reuses `transaction()` staging; deterministic |
| Multi-client coordination | #228 | large, distributed | split into 3a presence/tab-roles · 3b cross-tab write propagation · 3c conflict detection (headline). Reuses M12 3b machinery (`by-peer` Web Locks, `Collection.presence`, `by-tabs`). Brainstormed separately when reached. |

Build order: **#231 → #228(3a) → #228(3b) → #228(3c)**. This doc details #231; #228 sub-slices get their own specs.

---

# Sub-project 1: dry-run transactions (#231)

**Goal:** `db.transaction({ dryRun: true }, fn)` previews what a transaction *would* write and which guards it *would* violate — without committing.

## Key realisation

The transaction body **stages** ops into `TxContext._ops` (it calls `TxCollection.put/delete`, which buffer; reads see staged writes). Only **phase 2** of `runTransaction` executes those ops against the adapter. So a dry-run is: **run the body to stage → read priors → build the affected diff → run guards in collect-mode → return, skipping phase 2 entirely.** No adapter writes, no `onAfterWrite` hooks, no shadow store. (The `shadow/` subsystem is read-only — `CollectionFrame.put` throws — so it is *not* the dry-run target.)

## API

```ts
db.transaction({ dryRun: true }, fn: (tx: TxContext) => unknown): Promise<DryRunResult>

interface DryRunResult {
  readonly affected: ReadonlyArray<AffectedDocument>
  readonly guardViolations: ReadonlyArray<GuardViolation>
}
interface AffectedDocument {
  readonly vault: string
  readonly op: 'create' | 'update' | 'delete'
  readonly collection: string
  readonly docId: string
  readonly before: unknown | null   // current committed record; null when creating
  readonly after: unknown | null    // staged record; null when deleting
}
interface GuardViolation {
  readonly vault: string
  readonly collection: string
  readonly docId: string
  readonly message: string          // the guard's thrown error message (guards are anonymous — no stable name)
}
```

New `db.transaction` overload `(options: { dryRun: true }, fn)` alongside the existing `(options: AmendmentTxOptions, fn)` form.

## Scope (decided)

**In (v1):**
- The documents the transaction directly stages (put/delete) → `affected` with `before` (current committed, via `collection.get`) / `after` (staged record) / `op`.
- Guard violations: for each staged put, run the collection's guards (`runChecks` + frozen-field checks) with the **same `GuardContext` the real write path builds** (existing record + vault read-only facade + userId + role), collecting thrown errors into `guardViolations` instead of aborting.
- Zero adapter writes; zero write-hook firing; no commit.
- Multi-vault transactions supported (`affected`/`guardViolations` carry `vault`).
- Dedup staged ops by `(vault, collection, docId)` — last write wins for `after`.

**Out (documented v2 follow-up):**
- **MV/derivation cascade simulation** — indirectly-changed docs (materialized-view rebuilds, derivation outputs) are NOT in v1's `affected`. Simulating them needs a shadow-execution layer running `putInternal`'s cascade without the adapter — substantially larger; deferred.
- Lazy-MV stale marking in the diff.

## Architecture

- **noydb.ts:** new `transaction({ dryRun: true }, fn)` overload → `txStrategy.runDryRun(this, fn)` (or `runTransaction(this, fn, { dryRun: true })` returning `DryRunResult`).
- **tx subsystem (`withTransactions()`):** a `runDryRun(db, fn)` that builds a `TxContext`, runs `fn(ctx)` to stage ops, then:
  1. Dedup `ctx._ops` by key (last-wins per id; a delete after a put ⇒ delete).
  2. For each: `before = await db.vault(v).collection(c).get(id)`; `after = op.type==='delete' ? null : op.record`; `op = op.type==='delete' ? 'delete' : (before === null ? 'create' : 'update')`.
  3. For each non-delete op, run guards via the vault's registry + read-only facade in try/catch, collecting `{ message }` violations.
  4. Return `{ affected, guardViolations }`. **Never** phase 1/2.
- **vault.ts:** small internal accessor `_readOnlyFacade(): ReadOnlyVaultFacade | null` (returns the existing `readOnlyFacade`, `null` when guards aren't initialised) so the dry-run runner can build the identical guard ctx without touching `Collection` internals.
- **Guard re-check:** reuse `registry.guardsFor(collection)`, `registry.runChecks(...)`, and `GuardExecutor.checkFrozenFields(...)` — the same calls `putInternal` makes — wrapped in try/catch. (Duplicates ~15 lines of the guard loop to avoid hot-path surgery; a comment cross-links `putInternal` so they stay in sync.)
- Type lives in `tx/` (e.g. `tx/dry-run.ts` types) and is re-exported from `@noy-db/hub`.

## Error handling

- A guard throw during dry-run is **captured** (→ `guardViolations`), never propagated. An application error thrown by `fn` itself propagates normally (same as a real transaction body throwing).
- Dry-run requires the tx subsystem (`withTransactions()`); calling it without throws the existing "tx strategy required" error.

## Testing

- `db.transaction({ dryRun: true }, ...)` that stages a create + an update + a delete → `affected` has the three with correct `op`/`before`/`after`; **the store is unchanged** (assert `get` returns pre-dry-run state).
- A guard that throws on a staged record → appears in `guardViolations`, and `affected` still lists the doc; **no throw** out of the dry-run.
- An `onAfterWrite` hook registered → **not** fired during dry-run (assert a counter stays 0).
- Multi-vault dry-run → `affected` rows carry the right `vault`.
- Standard `db.transaction(fn)` (no options) still commits — unchanged.

## Success criteria

1. Dry-run returns the directly-affected diff with correct `op`/`before`/`after` and **commits nothing** (store byte-identical after).
2. Guard violations are collected, not thrown; `affected` is still complete.
3. No write-hook (`onBeforeWrite`/`onAfterWrite`) fires during a dry-run.
4. Multi-vault transactions are supported.
5. The existing `transaction()` commit/rollback paths and test suite are unchanged (dry-run is a separate branch).
