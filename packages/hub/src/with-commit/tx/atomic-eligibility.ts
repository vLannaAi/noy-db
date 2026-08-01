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
 * ALL of the following must hold. (Commit-time changeset invariants are NOT a
 * condition: that phase lives after Phase 2 in `runTransaction` and runs
 * unchanged on either path — a failing invariant reverts the atomic batch
 * through the same `ctx._executed` plan.)
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
 *     #931: of the wrapper-level write signals, only a live `onBeforeWrite`
 *     hook still excludes — it may REFUSE a write, which only
 *     `Collection.put()`/`.delete()` honors. After-hooks and the
 *     `afterPut`/`afterDelete` observe bus are refusal-free observers, so
 *     the atomic path fires them itself per leg post-finalize
 *     (`Collection._fireAtomicAfterWrite`) instead of forfeiting the batch.
 *     Delete gates on the enforcer's `_deleteCascadesPossible(name)` (#922):
 *     `Vault.enforceRefsOnDelete` cascades from THREE sources (lookup-ref
 *     edges, classic inbound refs, managed-link `onDelete`), and the Vault
 *     predicate unions exactly those three — a `getInbound`-only check would
 *     be narrower and wrongly admit unsafe atomic deletes, because
 *     `_prepareDelete` runs the cascades DURING prepare (see
 *     `with-shape/links/vault-facade.ts` `enforceRefsOnDelete`).
 *
 * @internal
 */

import type { Noydb } from '../../kernel/noydb.js'
import type { TxContext } from './transaction.js'
import { keyOf } from './transaction.js'

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
    if (!coll._txAtomicSafe(op.type)) return false
  }

  return true
}
