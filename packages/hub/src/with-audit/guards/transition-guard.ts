/**
 * `transitionGuard` — declarative state-machine sugar over the guard
 * service.
 *
 * Any record with a lifecycle field (invoice `status`, order state,
 * ticket workflow, subscription phase) needs transition validation: a
 * write may only move the field along a declared arc. That is expressible
 * with a hand-rolled `withGuard({ check })`, but every consumer
 * re-implements the same graph lookup + error. `transitionGuard`
 * generates exactly that guard from a state graph, reusing the guard
 * machinery wholesale — `check` rejection, the ledgered `amendment`
 * override, and composition with `periods`/`history`.
 *
 * It generalizes {@link immutableGuard}: WORM is the special case "every
 * state has no outgoing arcs", i.e. `transitions` mapping each state to `[]`.
 *
 * ```ts
 * createNoydb({ guardStrategies: [
 *   transitionGuard<Sale>({
 *     collection: 'sales', field: 'status',
 *     transitions: {                          // absence of an arc = forbidden
 *       draft: ['to_verify', 'cancelled'],
 *       to_verify: ['proforma', 'draft', 'cancelled'],
 *       proforma: ['invoiced', 'cancelled'],
 *       invoiced: ['paid'], paid: [], cancelled: [],
 *     },
 *     initial: ['draft', 'to_verify'],        // allowed status on insert
 *   }),
 * ] })
 * ```
 *
 * Semantics:
 * - **Insert** (`ctx.existing === null`): `incoming[field]` must be in
 *   `initial`. When `initial` is omitted, any value is allowed on insert.
 * - **Update**: the arc `(existing[field] → incoming[field])` must be
 *   listed in `transitions[from]`, else `IllegalTransitionError`. A
 *   same-value write (`from === to`) is allowed when `allowIdempotent`
 *   (default `true`) — so writes that touch other fields without moving
 *   state pass.
 * - **Override**: inside an `amendment` transaction by an authorized role
 *   the check is skipped and the change is ledgered (mirrors every guard).
 *
 * The status graph is caller-supplied data — no UI, no domain logic.
 */

import { withGuard } from './with-guard.js'
import type { GuardStrategy, GuardStrategyHandle, GuardContext, GuardChange } from './types.js'
import { IllegalTransitionError, ValidationError } from '../../kernel/errors.js'

export interface TransitionGuardConfig<T extends Record<string, unknown>> {
  /** The collection whose state field is governed. */
  collection: string
  /** The state field on the record (e.g. `'status'`). */
  field: keyof T & string
  /**
   * The transition graph: each state maps to the states it may move to.
   * A state absent from the map (or mapped to `[]`) is terminal — no
   * outgoing arc, so any non-idempotent write from it is rejected.
   */
  transitions: Readonly<Record<string, readonly string[]>>
  /**
   * States allowed as the initial value on insert (`existing === null`).
   * Omit to allow any value on insert.
   */
  initial?: readonly string[]
  /**
   * Allow a same-value write (`from === to`) on update. Default `true` —
   * lets a put that changes other fields, but not the state, through.
   */
  allowIdempotent?: boolean
  /** Roles permitted to override via an amendment transaction. Default `['admin', 'owner']`. */
  amendmentRoles?: ReadonlyArray<'admin' | 'owner'>
  /**
   * Optional set-level invariant run over the amendment change-set after
   * the writes execute. Signature matches `GuardStrategy.amendment.invariant`
   * exactly. When omitted the amendment is unconditionally allowed (the
   * amendment itself is the sanctioned, ledgered override) — the
   * backward-compatible default. Mirrors {@link immutableGuard}.
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

function stateOf(record: Record<string, unknown>, field: string): string {
  const v = record[field]
  return typeof v === 'string' ? v : String(v)
}

/**
 * Build a state-machine transition guard. Pass the returned handle to
 * `createNoydb({ guardStrategies: [...] })`.
 */
export function transitionGuard<T extends Record<string, unknown>>(
  config: TransitionGuardConfig<T>,
): GuardStrategyHandle<T> {
  const { collection, field, transitions, initial, amendmentRoles, amendmentInvariant } = config
  const allowIdempotent = config.allowIdempotent ?? true

  if (!field) {
    throw new ValidationError('transitionGuard: `field` is required')
  }
  if (transitions === undefined || typeof transitions !== 'object') {
    throw new ValidationError('transitionGuard: `transitions` must be a state→states map')
  }

  const spec: GuardStrategy<T> = {
    collection,
    check: (incoming: T, ctx: GuardContext<T>) => {
      const rec = incoming as Record<string, unknown>
      const to = stateOf(rec, field)

      // Insert — gate on the allowed initial set (any value if unset).
      if (ctx.existing === null) {
        if (initial !== undefined && !initial.includes(to)) {
          throw new IllegalTransitionError(collection, recordId(rec), '(none)', to)
        }
        return
      }

      // Update — the arc (from → to) must be a declared edge.
      const from = stateOf(ctx.existing as Record<string, unknown>, field)
      if (from === to) {
        if (allowIdempotent) return
        throw new IllegalTransitionError(collection, recordId(rec), from, to)
      }
      const allowed = transitions[from] ?? []
      if (!allowed.includes(to)) {
        throw new IllegalTransitionError(collection, recordId(rec), from, to)
      }
    },
    // The authorized override: inside an amendment transaction the check
    // is skipped and the change is ledgered. By default no extra invariant
    // — the amendment itself is the sanctioned exception. Callers may
    // supply `amendmentInvariant` to keep a constraint inviolable even
    // under amendment; a throw reverts the amendment as `InvariantError`.
    amendment: {
      roles: amendmentRoles ?? ['admin', 'owner'],
      invariant: amendmentInvariant ?? (() => {
        /* allow — the amendment is the override, and is ledgered */
      }),
    },
  }

  return withGuard<T>(spec)
}
