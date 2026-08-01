/**
 * #893/#906-prep — the atomic-commit eligibility gate.
 *
 * `runTransaction` (Task 5) consults `canCommitAtomically` right after the
 * body returns, to decide whether the whole staged batch can be prepared and
 * submitted as ONE `store.tx(ops)` call instead of the per-op abortable
 * path (Phase 1 pre-flight + Phase 2 Collection-layer execute + Phase 3
 * best-effort revert — see `transaction.ts`'s module doc).
 *
 * Pure decision logic: no side effects, no store reads. Every input is
 * already sitting on `db` / `ctx`.
 *
 * ALL of the following must hold (a fifth condition — commit-time changeset
 * invariants simply aren't run on the atomic path — needs no code here):
 *
 *  1. The store declares `capabilities.txAtomic === true` AND implements
 *     `tx()`. Both — mirrors the pairing rule `bestEffortRevert` already
 *     enforces (`kernel/best-effort-revert.ts:78`): an undeclared `tx()` is
 *     never used, even if present.
 *  2. Not an amendment transaction (`ctx._amendment === false`) — amendments
 *     need the guard-registry change-set + invariant machinery the atomic
 *     path skips entirely.
 *  3. No `(vault, collection, id)` is touched twice in the batch. The
 *     abortable path's Phase 1 snapshots each key once and Phase 2 replays
 *     every op against that same snapshot in order; a single `store.tx()`
 *     write set can't express "this key changes twice in sequence."
 *  4. Every touched collection reports `_txAtomicSafe(op.type)` — see that
 *     method's doc comment on `Collection` for what it excludes and why.
 *
 * @internal
 */

import type { Noydb } from '../../kernel/noydb.js'
import type { TxContext, StagedOp } from './transaction.js'

export function canCommitAtomically(db: Noydb, ctx: TxContext): boolean {
  const store = db._store
  if (store.capabilities?.txAtomic !== true || typeof store.tx !== 'function') return false
  if (ctx._amendment) return false

  const seen = new Set<string>()
  for (const op of ctx._ops) {
    const key = keyOf(op)
    if (seen.has(key)) return false
    seen.add(key)
  }

  for (const op of ctx._ops) {
    const coll = db.vault(op.vaultName).collection(op.collectionName)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(coll as any)._txAtomicSafe(op.type)) return false
  }

  return true
}

// Same key shape as `transaction.ts`'s (unexported) `keyOf` — duplicated
// rather than imported since the original isn't exported across the module.
function keyOf(op: StagedOp): string {
  return `${op.vaultName}\x00${op.collectionName}\x00${op.id}`
}
