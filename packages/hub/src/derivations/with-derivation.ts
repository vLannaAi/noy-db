import { ValidationError } from '../errors.js'
import type { DerivationStrategy, DerivationStrategyHandle } from './types.js'

/**
 * Register a deterministic derivation: one source collection → one or
 * more typed outputs, computed by the user's `derive` function on
 * plaintext after DEK unwrap. Outputs are encrypted with the same DEK
 * as the source and written via the standard `Collection.put` path.
 *
 * See docs/superpowers/specs/2026-05-01-dim14-derivation-v1-design.md.
 */
export function withDerivation<
  TSource extends Record<string, unknown>,
  TOutputs extends Record<string, Record<string, unknown>>,
>(spec: DerivationStrategy<TSource, TOutputs>): DerivationStrategyHandle {
  if (!spec.source || spec.source.length === 0) {
    throw new ValidationError('withDerivation: source collection name is required')
  }
  if (!spec.outputs || Object.keys(spec.outputs).length === 0) {
    throw new ValidationError('withDerivation: outputs map must declare at least one output')
  }
  if (spec.deterministic !== true) {
    throw new ValidationError('withDerivation: v1 only supports deterministic derivations')
  }
  if (typeof spec.derive !== 'function') {
    throw new ValidationError('withDerivation: derive must be a function')
  }
  return {
    __noydb_strategy: 'derivation',
    spec: spec as DerivationStrategy<any, any>,
  }
}
