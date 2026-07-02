import { ValidationError } from '../../kernel/errors.js'
import type { DerivationStrategy, DerivationStrategyHandle } from './types.js'

/**
 * `withRollup` — aggregate many child records onto a single field of their
 * parent. The reverse of a join: instead of reading children
 * on demand, the parent carries a maintained summary.
 *
 * ```ts
 * withRollup<Sale, Buyer>({
 *   from: 'sales',          // child collection (the trigger)
 *   key: 'buyerId',         // FK on the child → parent id
 *   into: 'buyers',         // parent collection
 *   field: 'revenueByYear', // field on the parent to maintain
 *   compute: (sales) => groupSumByYear(sales, 'total'),
 * })
 * ```
 *
 * On every write OR delete of a `from` record, the parent at id `child[key]`
 * is recomputed: `compute(allChildren where child[key] === parentId)` is
 * patched onto `parent[field]`. A parent write also recomputes its own
 * aggregate (so a parent created after its children still fills in). Only the
 * `field` is touched — the rest of the parent record is never clobbered — and
 * a value-equality guard suppresses no-op writes. The aggregate is gap-free
 * with respect to child inserts, updates, and deletes.
 *
 * Desugars to a `withDerivation` strategy carrying a `rollup` marker; dispatch
 * handles it without invoking the executor. Eager-only in this slice.
 */
export function withRollup<
  TChild extends Record<string, unknown> = Record<string, unknown>,
  TParent extends Record<string, unknown> = Record<string, unknown>,
>(config: {
  from: string
  key: keyof TChild & string
  into: string
  field: keyof TParent & string
  compute: (children: TChild[]) => unknown
}): DerivationStrategyHandle {
  const { from, key, into, field, compute } = config
  if (!from || from.length === 0) {
    throw new ValidationError('withRollup: `from` (child collection) is required')
  }
  if (!into || into.length === 0) {
    throw new ValidationError('withRollup: `into` (parent collection) is required')
  }
  if (from === into) {
    throw new ValidationError('withRollup: `from` and `into` must be different collections')
  }
  if (!key || key.length === 0) {
    throw new ValidationError('withRollup: `key` (FK field on the child) is required')
  }
  if (!field || field.length === 0) {
    throw new ValidationError('withRollup: `field` (target field on the parent) is required')
  }
  if (typeof compute !== 'function') {
    throw new ValidationError('withRollup: `compute` must be a function')
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spec: DerivationStrategy<any, any> = {
    source: into, // the parent record is what carries the rolled-up field
    deterministic: true,
    rollup: { from, key, field, compute: compute as (children: unknown[]) => unknown },
    // Synthetic self-write output for registry / cycle bookkeeping. Dispatch
    // patches `field` directly (value-equality guarded); the executor is not run.
    outputs: { value: { shape: 'record', collection: into, denorm: [field] } },
    derive: () => ({ value: {} }), // never invoked for a rollup strategy
    lifecycle: 'eager',
  }

  return { __noydb_strategy: 'derivation', spec }
}
