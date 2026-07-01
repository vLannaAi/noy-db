import { ValidationError } from '../../kernel/errors.js'
import type { GuardStrategy, GuardStrategyHandle } from './types.js'

/**
 * Register a guard for a collection. Guards run on every `put()` /
 * `delete()` for the named collection (after permissions, before
 * encryption) and may:
 *
 *   - `check` — block writes by throwing (typically `RecordLockedError`)
 *   - `frozenFields` — freeze specific fields once a condition is true
 *   - `amendment` — declare an authorized-override path with invariant
 *
 * Pass the returned handle to `createNoydb({ strategies: [...] })`.
 *
 * @see docs/superpowers/specs/2026-05-18-guards-design.md
 */
export function withGuard<T extends Record<string, unknown>>(
  strategy: GuardStrategy<T>,
): GuardStrategyHandle<T> {
  if (!strategy.collection || strategy.collection.length === 0) {
    throw new ValidationError('withGuard: collection name is required')
  }
  return {
    __noydb_strategy: 'guard',
    spec: strategy,
  }
}
