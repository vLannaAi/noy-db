/** The coordinatedCutover update strategy (single-step — no from/to). */
import type { SchemaUpdateStrategy, SchemaDelta, TransformFn } from './types.js'

export function coordinatedCutover(opts: { readonly transform: TransformFn }): SchemaUpdateStrategy {
  return {
    name: 'coordinatedCutover',
    onSchemaDelta(delta: SchemaDelta) {
      // #946: a detected rename (`delta.renamed`) must ALSO fire the
      // migration transform — even though computeSchemaDelta classifies a
      // pure rename as `kind: 'additive'` (the name-change itself is
      // additive-safe), the delta carries no data migration on its own.
      // Pre-#946 a rename was a plain drop+add -> `non-additive` -> the
      // transform fired and the caller re-keyed each record; this restores
      // that behavior so the user's TransformFn still runs and existing
      // values move from the old key to the new one instead of being
      // orphaned.
      if (delta.kind === 'non-additive' || (delta.renamed?.length ?? 0) > 0) {
        return { action: 'cutover' as const, transform: opts.transform }
      }
      return { action: 'allow' as const }
    },
  }
}
