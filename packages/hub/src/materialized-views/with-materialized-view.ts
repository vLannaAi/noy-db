import { ValidationError } from '../errors.js'
import type { MaterializedViewStrategy, MaterializedViewStrategyHandle } from './types.js'

/**
 * Register a materialized view: a declared query whose result is
 * persisted as a queryable collection and kept fresh as sources
 * change. Writes go through the standard `Collection.put` pipeline;
 * refresh-driven deletes route through `Collection._internalDelete` so
 * user `onDelete` guards on the output collection aren't tripped by
 * housekeeping.
 *
 * See docs/superpowers/specs/2026-05-20-dim14-mv-v2-design.md.
 */
export function withMaterializedView<TRow extends Record<string, unknown>>(
  spec: MaterializedViewStrategy<TRow>,
): MaterializedViewStrategyHandle {
  if (!spec.name || spec.name.length === 0) {
    throw new ValidationError('withMaterializedView: name is required')
  }
  if (typeof spec.query !== 'function') {
    throw new ValidationError('withMaterializedView: query must be a function returning a Query<T>')
  }
  if (typeof spec.rowKey !== 'function') {
    throw new ValidationError('withMaterializedView: rowKey is required (no default; see spec § Type surface)')
  }
  if (spec.refresh !== 'eager' && spec.refresh !== 'lazy' && spec.refresh !== 'manual') {
    throw new ValidationError(
      `withMaterializedView: refresh must be 'eager' | 'lazy' | 'manual', got "${String(spec.refresh)}"`,
    )
  }
  return {
    __noydb_strategy: 'materialized-view',
    spec,
  }
}
