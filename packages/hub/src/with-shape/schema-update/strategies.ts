/** Bundled light update strategies. */
import { NonAdditiveSchemaChangeError, SchemaLockedError } from '../../kernel/errors.js'
import type { SchemaUpdateStrategy, SchemaDelta } from './types.js'

/** Allow any schema change. Explicit blind / back-compat. */
export function blindUpdate(): SchemaUpdateStrategy {
  return { name: 'blindUpdate', onSchemaDelta: () => ({ action: 'allow' }) }
}

/**
 * Allow additive changes; reject non-additive ones. The safety backstop.
 *
 * #946: a `renamed` pair is NOT additive-safe *for this gate* — the delta
 * itself carries no data migration, so an allowed rename would orphan
 * existing record values under the old key. `computeSchemaDelta` classifies
 * a pure rename as `kind: 'additive'` (it IS additive-safe as far as the
 * name-change itself is concerned, and the id-carry through `SchemaDelta.
 * renamed` is real), but a guard whose whole job is "don't admit anything
 * that isn't a mechanical additive write" must still block it — the same as
 * it blocks any other non-additive change — forcing a `coordinatedCutover()`
 * (or `blindUpdate()`) to actually move the data.
 */
export function additiveOnly(): SchemaUpdateStrategy {
  return {
    name: 'additiveOnly',
    onSchemaDelta(delta: SchemaDelta) {
      const renamed = delta.renamed ?? []
      if (delta.kind === 'non-additive' || renamed.length > 0) {
        return {
          action: 'reject' as const,
          error: new NonAdditiveSchemaChangeError(
            `Non-additive schema change to "${delta.collection}" ` +
              `(added: [${delta.added.join(', ')}], removed: [${delta.removed.join(', ')}], ` +
              `changed: [${delta.changed.map(c => c.field).join(', ')}]` +
              (renamed.length > 0 ? `, renamed: [${renamed.map(r => `${r.from}->${r.to}`).join(', ')}]` : '') +
              `). Register a coordinatedCutover() strategy to migrate, or revert the change.`,
          ),
        }
      }
      return { action: 'allow' as const }
    },
  }
}

/**
 * Reject schema changes. With `fields`, reject only when one of those
 * fields is added/removed/changed/renamed; otherwise reject any non-`none`
 * delta. #946: a `renamed` pair's `from` AND `to` both count as touching a
 * locked field — a rename away from a locked name (or onto one) still
 * violates the lock, and a blanket `lockSchema()` (no `fields`) already
 * blocks any rename since a pure rename's `kind` is never `'none'`.
 */
export function lockSchema(opts?: { readonly fields?: readonly string[] }): SchemaUpdateStrategy {
  const fields = opts?.fields
  return {
    name: 'lockSchema',
    onSchemaDelta(delta: SchemaDelta) {
      if (delta.kind === 'none') return { action: 'allow' as const }
      const renamedNames = (delta.renamed ?? []).flatMap(r => [r.from, r.to])
      const touched = fields
        ? [...delta.added, ...delta.removed, ...delta.changed.map(c => c.field), ...renamedNames].filter(f => fields.includes(f))
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
