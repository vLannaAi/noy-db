/**
 * Commit-time changeset invariants for ordinary transactions.
 *
 * Today the only set-level invariant hook is `amendment.invariant`, which
 * fires solely inside `db.transaction({ amendment: true }, …)` and requires
 * an admin/owner role plus a registered guard. That is the right shape for
 * the WORM-override path, but normal application transactions also need
 * cross-record invariants that hold on every commit — e.g. niwat's
 * `assertR1` ("every payment is 100% receipted").
 *
 * `withTransactions({ invariants: [...] })` registers such invariants. Each
 * one names a `scope` (a collection) and a `check(changes, ctx)` callback
 * that receives the commit's change-set for that collection.
 *
 * ## Semantics
 *
 * - **`scope`** is a collection name. An invariant fires only when the
 *   committed transaction wrote at least one record in that collection.
 * - **When** — at commit, AFTER Phase 2 has executed all staged ops (so
 *   `after` reflects the written record), and after the amendment commit
 *   phase. It runs for BOTH ordinary and amendment transactions — an
 *   amendment is still a commit and is still subject to these invariants.
 * - **`changes`** — one `{ before, after }` pair per touched id (deduped to
 *   the last write per id, preserving write order). `before` is the
 *   plaintext prior record (captured in Phase 1 before the overwrite),
 *   `null` for an insert. `after` is the written record, `null` for a
 *   delete.
 * - **Throw → revert.** A throw reverts every executed op (via the shared
 *   `revertExecuted` unwind) and is surfaced as `InvariantError` (an
 *   `InvariantError` thrown by the check passes through unwrapped).
 *
 * ```ts
 * createNoydb({ txStrategy: withTransactions({
 *   invariants: [{
 *     scope: 'payments',
 *     check(changes) {
 *       for (const { after } of changes) {
 *         const p = after as Payment | null
 *         if (p && p.receiptAmount !== p.amount) {
 *           throw new InvariantError('R1: payment not fully receipted')
 *         }
 *       }
 *     },
 *   }],
 * }) })
 * ```
 */

import type { GuardChange, GuardContext } from '../guards/types.js'

/**
 * A commit-time set-level invariant for ordinary (and amendment)
 * transactions. See module docs for full semantics.
 */
export interface TransactionInvariant {
  /**
   * The collection this invariant watches. The `check` fires only when the
   * committed transaction wrote at least one record in this collection.
   */
  readonly scope: string
  /**
   * Validate the change-set for {@link scope}. `changes` carries one
   * `{ before, after }` pair per touched id (deduped to last-write,
   * write-order preserved); `before` is the plaintext prior record (null
   * on insert), `after` is the written record (null on delete). Throw to
   * revert the whole transaction — the throw is surfaced as
   * `InvariantError`.
   */
  check: (
    changes: ReadonlyArray<GuardChange<unknown>>,
    ctx: GuardContext<unknown>,
  ) => Promise<void> | void
}
