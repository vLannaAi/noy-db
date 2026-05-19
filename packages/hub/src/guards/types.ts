import type { Role } from '../types.js'

/**
 * Minimum read surface exposed to guard `check` functions. Intentionally
 * narrow — guards can read other collections but never write.
 */
export interface ReadOnlyVaultFacade {
  collection<T = unknown>(name: string): {
    get(id: string): Promise<T | null>
    list(): Promise<T[]>
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
  check?: (incoming: T, ctx: GuardContext<T>) => Promise<void> | void
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
