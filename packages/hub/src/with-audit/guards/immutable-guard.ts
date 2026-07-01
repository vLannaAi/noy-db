/**
 * `immutableGuard` — declarative WORM / append-only sugar over the guard
 * subsystem.
 *
 * Issued fiscal documents (invoices, DDTs) must be immutable after issue.
 * That is expressible today with a hand-rolled `withGuard` (block on
 * `check`/`onDelete`, allow an admin `amendment`), but the boilerplate is
 * repetitive and easy to get subtly wrong. `immutableGuard` generates
 * exactly that guard from a declarative config, reusing the guard
 * machinery wholesale — `check`/`onDelete` rejection, the ledgered
 * `amendment` override, and composition with `periods`/`history`.
 *
 * ```ts
 * createNoydb({ guardStrategies: [
 *   immutableGuard({
 *     collection: 'invoices',
 *     after: (r) => r.status === 'issued',   // immutable once issued
 *   }),
 * ] })
 * ```
 *
 * A record is mutable until `after(record)` holds; from then on, updates
 * and deletes throw `RecordLockedError` unless performed inside an
 * `amendment` transaction by an authorized role (the override is
 * ledgered by the guard amendment mechanism). `appendOnly: true` is
 * shorthand for `after: () => true` — immutable from creation.
 */

import { withGuard } from './with-guard.js'
import type { GuardStrategy, GuardStrategyHandle, GuardContext, GuardChange } from './types.js'
import { RecordLockedError, ValidationError } from '../../kernel/errors.js'

export interface ImmutableGuardConfig<T extends Record<string, unknown>> {
  /** The collection to make WORM. */
  collection: string
  /**
   * A record becomes immutable once this predicate holds. Evaluated on
   * the *existing* (already-persisted) record, so the write that first
   * makes it true is still allowed; subsequent writes are blocked.
   * Mutually exclusive with `appendOnly`.
   */
  after?: (record: T) => boolean
  /** Shorthand for `after: () => true` — immutable from creation. */
  appendOnly?: boolean
  /** Roles permitted to override via an amendment transaction. Default `['admin', 'owner']`. */
  amendmentRoles?: ReadonlyArray<'admin' | 'owner'>
  /**
   * Optional set-level invariant run over the amendment change-set after
   * the writes execute. Signature matches `GuardStrategy.amendment.invariant`
   * exactly: it receives every {before, after} pair touching this
   * collection in the amendment plus the guard context; throwing reverts
   * the whole amendment and surfaces as `InvariantError`.
   *
   * Use this to keep a constraint inviolable EVEN under amendment — e.g.
   * forbid deleting an issued document by re-throwing on any
   * `before !== null && after === null` change, or assert a cross-record
   * sum is preserved. When omitted the amendment is unconditionally
   * allowed (the amendment itself is the sanctioned, ledgered override) —
   * this is the backward-compatible default.
   */
  amendmentInvariant?: (
    changes: ReadonlyArray<GuardChange<T>>,
    ctx: GuardContext<T>,
  ) => Promise<void> | void
}

function recordId(record: Record<string, unknown> | null): string {
  const id = record?.id
  return typeof id === 'string' ? id : ''
}

/**
 * Build an immutability guard. Pass the returned handle to
 * `createNoydb({ guardStrategies: [...] })`.
 */
export function immutableGuard<T extends Record<string, unknown>>(
  config: ImmutableGuardConfig<T>,
): GuardStrategyHandle<T> {
  const { collection, after, appendOnly, amendmentRoles, amendmentInvariant } = config
  if (appendOnly && after !== undefined) {
    throw new ValidationError('immutableGuard: `after` and `appendOnly` are mutually exclusive')
  }
  if (!appendOnly && after === undefined) {
    throw new ValidationError('immutableGuard: provide `after` or `appendOnly: true`')
  }

  const isImmutable: (record: T) => boolean = appendOnly ? () => true : after!
  const reason = appendOnly ? 'append-only collection' : 'record is immutable after issue'

  const spec: GuardStrategy<T> = {
    collection,
    // Block updates to an already-immutable record. Inserts (existing
    // null) and the transition write that first makes the record
    // immutable are allowed — `after` reads the prior state.
    check: (incoming: T, ctx: GuardContext<T>) => {
      if (ctx.existing !== null && isImmutable(ctx.existing)) {
        throw new RecordLockedError(collection, recordId(incoming as Record<string, unknown>), reason)
      }
    },
    // Block deletes of an immutable record.
    onDelete: (existing: T) => {
      if (isImmutable(existing)) {
        throw new RecordLockedError(collection, recordId(existing as Record<string, unknown>), reason)
      }
    },
    // The authorized override: inside an amendment transaction the
    // check/onDelete are skipped and the change is ledgered. By default
    // there is no extra invariant — the amendment itself is the
    // sanctioned exception. Callers may supply `amendmentInvariant` to
    // keep a constraint inviolable even under amendment (e.g. forbid
    // deletes, or preserve a cross-record sum); a throw reverts the
    // amendment and surfaces as `InvariantError`.
    amendment: {
      roles: amendmentRoles ?? ['admin', 'owner'],
      invariant: amendmentInvariant ?? (() => {
        /* allow — the amendment is the override, and is ledgered */
      }),
    },
  }

  return withGuard<T>(spec)
}
