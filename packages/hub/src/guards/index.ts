export { withGuard } from './with-guard.js'
export { GuardRegistry } from './registry.js'
export { GuardExecutor } from './executor.js'
export { ReadOnlyVaultFacade } from './read-only-facade.js'
export type {
  GuardStrategy,
  GuardStrategyHandle,
  GuardContext,
  GuardChange,
} from './types.js'

// Re-export error classes so `@noy-db/hub/guards` is self-contained.
// Splitting: true in tsup.config.ts deduplicates the class definitions
// across subpath boundaries, so `instanceof` works.
export {
  RecordLockedError,
  FieldFrozenError,
  InvariantError,
  AmendmentForbiddenError,
} from '../errors.js'
