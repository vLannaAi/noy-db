import { FieldFrozenError, InvariantError } from '../errors.js'
import type { GuardStrategy, GuardContext, GuardChange } from './types.js'

/**
 * Pure functions that execute the work declared by a `GuardStrategy`.
 * Stateless — `GuardRegistry` decides when to call these.
 *
 * @internal
 */
export const GuardExecutor = {
  /**
   * Compare existing vs incoming for each `frozenFields.fields` entry
   * when `frozenFields.when(existing)` is true. Throws
   * `FieldFrozenError` listing every changed frozen field.
   */
  async checkFrozenFields<T extends Record<string, unknown>>(
    guard: GuardStrategy<T>,
    id: string,
    existing: T | null,
    incoming: T,
  ): Promise<void> {
    const ff = guard.frozenFields
    if (!ff) return
    if (existing === null) return // insert — nothing to freeze
    if (!ff.when(existing)) return

    const changed: string[] = []
    for (const f of ff.fields) {
      // Strict equality first, then deep-equality fallback for objects.
      if (existing[f] !== incoming[f]) {
        if (!deepEqual(existing[f], incoming[f])) changed.push(String(f))
      }
    }
    if (changed.length > 0) {
      throw new FieldFrozenError(guard.collection, id, changed)
    }
  },

  /**
   * Run a single guard's invariant over its slice of the change-set.
   * Any throw is converted to `InvariantError` unless it already is one.
   */
  async runInvariant<T extends Record<string, unknown>>(
    guard: GuardStrategy<T>,
    changes: ReadonlyArray<GuardChange<T>>,
    ctx: GuardContext<T>,
  ): Promise<void> {
    const amendment = guard.amendment
    if (!amendment) return
    try {
      await amendment.invariant(changes, ctx)
    } catch (err) {
      if (err instanceof InvariantError) throw err
      throw new InvariantError(
        err instanceof Error ? err.message : `invariant violated: ${String(err)}`,
      )
    }
  },
}

/**
 * Minimal deep-equality for guarded field diff. Handles arrays, plain
 * objects, primitives. Not for cyclic structures.
 *
 * @internal
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return a === b
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return a === b
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const aa = a as unknown[]
    const bb = b as unknown[]
    if (aa.length !== bb.length) return false
    for (let i = 0; i < aa.length; i++) if (!deepEqual(aa[i], bb[i])) return false
    return true
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao)
  const bk = Object.keys(bo)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false
    if (!deepEqual(ao[k], bo[k])) return false
  }
  return true
}
