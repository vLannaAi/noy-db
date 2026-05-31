/** The coordinatedCutover update strategy (#232, single-step — no from/to). */
import type { SchemaUpdateStrategy, SchemaDelta, TransformFn } from './types.js'

export function coordinatedCutover(opts: { readonly transform: TransformFn }): SchemaUpdateStrategy {
  return {
    name: 'coordinatedCutover',
    onSchemaDelta(delta: SchemaDelta) {
      if (delta.kind === 'non-additive') {
        return { action: 'cutover' as const, transform: opts.transform }
      }
      return { action: 'allow' as const }
    },
  }
}
