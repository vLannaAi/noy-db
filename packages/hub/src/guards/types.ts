import type { Role } from '../types.js'
import type { Query } from '../query/builder.js'

/**
 * Minimum read surface exposed to guard `check` functions. Intentionally
 * narrow — guards can read other collections but never write.
 *
 * `query()` returns the same chainable builder used elsewhere. `Query<T>`
 * has no write terminals (no `.update()` / `.delete()`) so exposing it
 * here preserves the read-only contract while letting guards aggregate
 * with `.where().aggregate()` / `.groupBy()` / `.join()` instead of
 * decrypting every sibling row via `.list()`.
 */
export interface ReadOnlyVaultFacade {
  collection<T = unknown>(name: string): {
    get(id: string): Promise<T | null>
    list(): Promise<T[]>
    query(): Query<T>
  }
}

/**
 * Runtime context passed to `check` and `invariant` callbacks.
 * `existing` is the currently-persisted record (null for inserts).
 */
export interface GuardContext<T> {
  existing: T | null
  vault: ReadOnlyVaultFacade
  userId: string
  role: Role
}

/**
 * One {before, after} pair handed to an `invariant` function. `before`
 * is null for inserts; `after` reflects the proposed post-commit record.
 */
export interface GuardChange<T> {
  before: T | null
  after: T
}

/** @internal — output of {@link withGuard}. */
export interface GuardStrategyHandle<T extends Record<string, unknown>> {
  readonly __noydb_strategy: 'guard'
  readonly spec: GuardStrategy<T>
}

/** Public registration shape. See `withGuard()`. */
export interface GuardStrategy<T extends Record<string, unknown>> {
  collection: string
  /**
   * Fires on `Collection.put` (insert + update). The `incoming` argument
   * is the record being written. Throw to cancel the put.
   *
   * Does NOT fire on `Collection.delete` — use {@link onDelete} for
   * delete-time validation. Skipped during an amendment transaction
   * (`db.transaction({ amendment: true })`) — admin/owner override.
   */
  check?: (incoming: T, ctx: GuardContext<T>) => Promise<void> | void
  /**
   * Fires on user-initiated `Collection.delete` before the adapter
   * delete and before the ledger append. The `existing` argument is
   * the currently-persisted record. Throw to cancel the delete — no
   * partial state, no tombstone ledger entry.
   *
   * Skipped during an amendment transaction (admin/owner override) —
   * amendments are the unlock primitive. To make a delete TRULY
   * unconditional (e.g. legal-document immutability rules), pair
   * `onDelete` with an `amendment.invariant` that re-throws on any
   * `before !== null && after === null` change:
   *
   * ```ts
   * withGuard<Receipt>({
   *   collection: 'receipts',
   *   onDelete: () => { throw new RecordLockedError(...) },
   *   amendment: {
   *     roles: ['admin', 'owner'],
   *     invariant: (changes) => {
   *       for (const c of changes) {
   *         if (c.before !== null && c.after === null) {
   *           throw new RecordLockedError(...) // wrapped as InvariantError
   *         }
   *       }
   *     },
   *   },
   * })
   * ```
   *
   * Also skipped on system-internal deletes (derivation tombstones from
   * #144, MV refresh from Dim 14 v2) — those use `_internalDelete`
   * which bypasses every user-facing delete hook. Housekeeping ops are
   * NOT user-initiated and should not trip user invariants.
   *
   * Delete of an absent record is a no-op and does not consult any
   * guard, matching the idempotent-delete contract.
   */
  onDelete?: (existing: T, ctx: GuardContext<T>) => Promise<void> | void
  frozenFields?: {
    when: (existing: T) => boolean
    fields: ReadonlyArray<keyof T>
  }
  amendment?: {
    roles: ReadonlyArray<'admin' | 'owner'>
    invariant: (
      changes: ReadonlyArray<GuardChange<T>>,
      ctx: GuardContext<T>,
    ) => Promise<void> | void
  }
}
