export { withDerivation } from './with-derivation.js'
export { withRollup } from './with-rollup.js'
export type { WithRollupOptions } from './with-rollup.js'
export { DerivationRegistry } from './registry.js'
export { DerivationExecutor } from './executor.js'
export type {
  DerivationSpec,
  DerivationStrategy,
  DerivedFromMeta,
  OutputSpec,
  RecordOutputSpec,
  ArrayOutputSpec,
} from './types.js'

// Re-export error classes so `@noy-db/hub/derivations` is self-contained.
// Splitting: true in tsup.config.ts deduplicates the class definitions
// across subpath boundaries, so `instanceof` works.
export {
  DerivationCycleError,
  DerivationDepthError,
  DerivationOutputUnknownError,
  DerivationOutputShapeError,
  DerivationCapExceededError,
} from '../../kernel/errors.js'

// #837 — signature types of this entry's own exports must be nameable here.
export type { DerivationContext } from './types.js'
export type { RunResult } from './executor.js'
