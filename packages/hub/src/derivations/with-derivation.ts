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

  // Validate array-shape outputs.
  const lifecycleMode = typeof spec.lifecycle === 'string' ? spec.lifecycle : spec.lifecycle.mode
  for (const [outputKey, outputSpec] of Object.entries(spec.outputs)) {
    if (outputSpec.shape === 'array') {
      if (lifecycleMode !== 'eager') {
        throw new ValidationError(
          `withDerivation: shape 'array' supports lifecycle 'eager' only in this release `
          + `Output "${outputKey}" declared lifecycle '${lifecycleMode}'. `
          + 'Switch to `lifecycle: "eager"` or use shape: "record".',
        )
      }
      if (typeof outputSpec.key !== 'function') {
        throw new ValidationError(
          `withDerivation: shape 'array' output "${outputKey}" requires \`key: (out) => string\`.`,
        )
      }
      if (outputSpec.maxFanout !== undefined) {
        if (!Number.isInteger(outputSpec.maxFanout) || outputSpec.maxFanout < 1) {
          throw new ValidationError(
            `withDerivation: maxFanout for output "${outputKey}" must be a positive integer `
            + `(got ${String(outputSpec.maxFanout)}).`,
          )
        }
      }
    }
  }

  return {
    __noydb_strategy: 'derivation',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spec: spec as DerivationStrategy<any, any>,
  }
}
