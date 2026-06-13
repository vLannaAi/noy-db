# Commit-time changeset invariants for ordinary transactions

**Issue:** #342 (AU+026) · **Layer:** Transactions · **Cluster:** au-series-pre16.

## Problem

The hub has exactly one set-level invariant hook today: `amendment.invariant`. It fires only inside `db.transaction({ amendment: true, reason }, …)`, requires an admin/owner role, and requires a registered guard. That is the correct shape for the WORM-override path — but ordinary application transactions also need cross-record invariants that must hold on *every* commit. niwat's `assertR1` ("every payment is 100% receipted") is the motivating case: it is a normal-write constraint, not an amendment override, and there is no hook for it.

## Goal

`withTransactions({ invariants: [{ scope, check }] })` — commit-time, set-level invariants that fire for **normal** `db.transaction(fn)` calls (and amendments), with no role gate and no guard requirement. Each invariant names a collection `scope` and a `check(changes, ctx)` callback that receives the commit's change-set for that scope; a throw reverts the whole transaction.

## API

```ts
// tx/invariants.ts
export interface TransactionInvariant {
  readonly scope: string  // collection name
  check: (
    changes: ReadonlyArray<GuardChange<unknown>>,
    ctx: GuardContext<unknown>,
  ) => Promise<void> | void
}

// tx/active.ts
export interface TransactionStrategyOptions {
  invariants?: ReadonlyArray<TransactionInvariant>
}
export function withTransactions(opts?: TransactionStrategyOptions): TxStrategy

// usage
createNoydb({ txStrategy: withTransactions({
  invariants: [{
    scope: 'payments',
    check(changes) {
      for (const { after } of changes) {
        const p = after as Payment | null
        if (p && p.receiptAmount !== p.amount) throw new InvariantError('R1')
      }
    },
  }],
}) })
```

`TransactionInvariant` reuses the existing `GuardChange<T>` / `GuardContext<T>` shapes (erased to `unknown`) so an invariant author sees the same `{ before, after }` / `{ existing, vault, userId, role }` surface a guard amendment invariant sees.

## Behavior

**Changeset assembly.** From `ctx._ops`, dedup to the **last write per `(vault, coll, id)`** while preserving first-seen (write) order. For each deduped op in a watched scope build `GuardChange{ before, after }`: `before` is the plaintext prior record (null on insert), `after` is the written record (`op.record`), or `null` on delete. Group by `scope` (collection name).

**Scope.** An invariant fires only when its `scope` has at least one change in the commit. `watchedScopes = new Set(invariants.map(i => i.scope))` keeps Phase-1 capture and grouping cheap.

**Phase-1 before-capture.** `priorEnvelopes` holds *encrypted* envelopes; invariants need *plaintext* `before`. So in Phase 1, for any op whose collection is a watched scope, we additionally read the decrypted prior via `db.vault(v).collection(c).get(id)` into a `plainBefore` map **before** Phase 2 overwrites it. Snapshots only the initial committed state per key, matching the envelope snapshot.

**Ordering vs the amendment phase.** The invariant phase runs **after** the amendment commit phase, so it applies to ordinary AND amendment transactions — an amendment is still a commit and is still subject to these set-level constraints. (Independent of `ctx._amendment`; gated only on `invariants.length > 0`.)

**Context.** Per invariant, the watched scope's vault provides the ctx: `vault: v._getReadOnlyFacade() ?? <minimal read-only stub>`, `userId: v.userId`, `role: v.role`, `existing: null` (a per-record concept that doesn't apply to a set-level check — invariants get the full change-set in their first parameter).

## Errors + rollback

A throw from any `check` mirrors the amendment-phase failure mode exactly:

```ts
catch (err) {
  await revertExecuted(ctx._executed, store, db)
  throw err instanceof InvariantError ? err : new InvariantError(
    err instanceof Error ? err.message : `invariant violated: ${String(err)}`,
  )
}
```

`revertExecuted` unwinds every executed op (main staged ops + nested derivation side-effects) in reverse via the raw store, then rethrows. An `InvariantError` thrown by the check passes through unwrapped; any other throw is wrapped.

## Composition

- **Amendment.** Additive and orthogonal. A guard `amendment.invariant` may allow a change that a tx invariant then rejects (and vice versa) — both must pass for an amendment to commit. The tx-invariant phase runs strictly after the amendment phase.
- **Guards / periods / history / derivations.** Unchanged. Tx invariants are a commit-phase concern layered on top of Phase 2; per-op side effects (history snapshots, ledger entries, change events, eager derivations) have already fired by the time invariants run, and roll back together with the source ops on a throw.
- **Dry-run.** `runDryRun` does not execute Phase 2 and so does not run tx invariants.

## Errors + boundaries

- No kernel-surface change: `index.ts`, `vault.ts`, `collection.ts` are untouched. All code lives under `tx/` (a lazy subpath chunk) + the `GuardChange`/`GuardContext` types it reuses.
- The extra Phase-1 plaintext read is incurred **only** for ops in a watched scope — zero overhead when `invariants` is empty (the common path).

## Testing

- Passing invariant → tx commits.
- Throwing invariant → `InvariantError` + ALL writes rolled back (bad record absent; a prior valid record unchanged).
- `before`/`after` correctness: insert → `before` null; update → `before` is the prior record.
- An invariant whose scope wasn't touched is not called.
- Additive with amendment: an amendment tx still runs the invariant (and a violating amendment is reverted even when the guard amendment invariant would allow it).

## Build sequence

1. `tx/invariants.ts` — `TransactionInvariant`.
2. `tx/active.ts` — `TransactionStrategyOptions` + `withTransactions(opts)` capturing/forwarding `invariants`.
3. `tx/strategy.ts` — 4th `txInvariants?` param on `TxStrategy.runTransaction` (+ `NO_TX` stub).
4. `tx/transaction.ts` — 4th param; Phase-1 `plainBefore` capture; post-amendment invariant phase.
5. `tx/index.ts` + main barrel — export `TransactionInvariant` / `TransactionStrategyOptions`.
6. Tests + features.yaml entry.
