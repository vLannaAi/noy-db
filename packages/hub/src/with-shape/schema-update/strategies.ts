/** Bundled light update strategies. */
import { NonAdditiveSchemaChangeError, SchemaLockedError } from '../../kernel/errors.js'
import type { SchemaUpdateStrategy, SchemaDelta } from './types.js'

/** Allow any schema change. Explicit blind / back-compat. */
export function blindUpdate(): SchemaUpdateStrategy {
  return { name: 'blindUpdate', onSchemaDelta: () => ({ action: 'allow' }) }
}

/** Allow additive changes; reject non-additive ones. The safety backstop. */
export function additiveOnly(): SchemaUpdateStrategy {
  return {
    name: 'additiveOnly',
    onSchemaDelta(delta: SchemaDelta) {
      if (delta.kind === 'non-additive') {
        return {
          action: 'reject' as const,
          error: new NonAdditiveSchemaChangeError(
            `Non-additive schema change to "${delta.collection}" ` +
              `(added: [${delta.added.join(', ')}], removed: [${delta.removed.join(', ')}], ` +
              `changed: [${delta.changed.map(c => c.field).join(', ')}]). ` +
              `Register a coordinatedCutover() strategy to migrate, or revert the change.`,
          ),
        }
      }
      return { action: 'allow' as const }
    },
  }
}

/**
 * Reject schema changes. With `fields`, reject only when one of those
 * fields is added/removed/changed; otherwise reject any non-`none` delta.
 */
export function lockSchema(opts?: { readonly fields?: readonly string[] }): SchemaUpdateStrategy {
  const fields = opts?.fields
  return {
    name: 'lockSchema',
    onSchemaDelta(delta: SchemaDelta) {
      if (delta.kind === 'none') return { action: 'allow' as const }
      const touched = fields
        ? [...delta.added, ...delta.removed, ...delta.changed.map(c => c.field)].filter(f => fields.includes(f))
        : ['<any>']
      if (touched.length === 0) return { action: 'allow' as const }
      return {
        action: 'reject' as const,
        error: new SchemaLockedError(
          `Schema for "${delta.collection}" is locked` +
            (fields ? ` on fields [${fields.join(', ')}] (touched: [${touched.join(', ')}])` : '') +
            `; the change was refused.`,
        ),
      }
    },
  }
}
