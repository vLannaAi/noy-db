import { ValidationError } from '../../kernel/errors.js'
import type { DerivationSpec, DerivationStrategy } from './types.js'

/**
 * Register a deterministic derivation: one source collection → one or
 * more typed outputs, computed by the user's `derive` function on
 * plaintext after DEK unwrap. Outputs are encrypted with the same DEK
 * as the source and written via the standard `Collection.put` path.
 *
 * See design-history/2026-05-01-dim14-derivation-v1-design.md.
 */
export function withDerivation<
  TSource extends Record<string, unknown>,
  TOutputs extends Record<string, Record<string, unknown> | ReadonlyArray<Record<string, unknown>>>,
>(spec: DerivationSpec<TSource, TOutputs>): DerivationStrategy {
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

  // Validate declared sibling sources. Each must be a non-empty
  // string and must differ from the primary source — a self-reference
  // would double-register the strategy under the same `_bySource` key.
  if (spec.sources !== undefined) {
    for (const extra of spec.sources) {
      if (typeof extra !== 'string' || extra.length === 0) {
        throw new ValidationError('withDerivation: each entry in sources[] must be a non-empty string')
      }
      if (extra === spec.source) {
        throw new ValidationError(
          `withDerivation: sources[] must not contain the primary source "${spec.source}"`,
        )
      }
    }
  }

  // Validate FK triggers. Each `collection` must be a non-empty
  // string differing from the primary source, and `on` a non-empty field.
  if (spec.triggerBy !== undefined) {
    for (const t of spec.triggerBy) {
      if (typeof t?.collection !== 'string' || t.collection.length === 0) {
        throw new ValidationError('withDerivation: each triggerBy entry needs a non-empty `collection`')
      }
      if (t.collection === spec.source) {
        throw new ValidationError(
          `withDerivation: triggerBy.collection must not equal the source "${spec.source}" (use sources[] for same-id triggers)`,
        )
      }
      const hasOn = typeof (t as { on?: unknown }).on === 'string'
      const hasMatch = Array.isArray((t as { match?: unknown }).match)
      if (hasOn === hasMatch) {
        throw new ValidationError(
          `withDerivation: triggerBy on "${t.collection}" needs exactly one of \`on\` or \`match\``,
        )
      }
      if (hasOn && (t as { on: string }).on.length === 0) {
        throw new ValidationError(
          `withDerivation: triggerBy on "${t.collection}" needs a non-empty \`on\` (the FK field on the source)`,
        )
      }
      if (hasMatch) {
        const match = (t as { match: ReadonlyArray<{ from: string; to: string }> }).match
        if (match.length === 0) {
          throw new ValidationError(`withDerivation: triggerBy match on "${t.collection}" must be non-empty`)
        }
        const seen = new Set<string>()
        for (const p of match) {
          if (typeof p?.from !== 'string' || p.from.length === 0 || typeof p?.to !== 'string' || p.to.length === 0) {
            throw new ValidationError(`withDerivation: triggerBy match on "${t.collection}" needs non-empty \`from\` and \`to\` in every pair`)
          }
          if (seen.has(p.to)) {
            throw new ValidationError(`withDerivation: triggerBy match on "${t.collection}" repeats \`to: "${p.to}"\` — two pairs constraining one source field is a contradiction, not a wider match`)
          }
          seen.add(p.to)
        }
      }
      if (t.maxFanout !== undefined && (!Number.isInteger(t.maxFanout) || t.maxFanout < 1)) {
        throw new ValidationError(
          `withDerivation: triggerBy maxFanout on "${t.collection}" must be a positive integer (got ${String(t.maxFanout)}).`,
        )
      }
    }
  }

  // Validate array-shape outputs.
  const lifecycleMode = typeof spec.lifecycle === 'string' ? spec.lifecycle : spec.lifecycle.mode
  for (const [outputKey, outputSpec] of Object.entries(spec.outputs)) {
    // Self-write output (collection === source): reverse-denorm must declare
    // `denorm` (the fields it owns) — field-level provenance.
    if (outputSpec.shape === 'record' && outputSpec.collection === spec.source) {
      if (!outputSpec.denorm || outputSpec.denorm.length === 0) {
        throw new ValidationError(
          `withDerivation: self-write output "${outputKey}" (collection === source "${spec.source}") `
          + 'must declare `denorm: [...]` naming the fields it maintains.',
        )
      }
    }
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
    spec: spec as DerivationSpec<any, any>,
  }
}
