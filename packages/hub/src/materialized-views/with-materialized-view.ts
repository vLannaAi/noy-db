import { MaterializedViewConfigError, ValidationError } from '../errors.js'
import type { MaterializedViewStrategy, MaterializedViewStrategyHandle } from './types.js'

/**
 * Register a materialized view: a declared query whose result is
 * persisted as a queryable collection and kept fresh as sources
 * change. Writes go through the standard `Collection.put` pipeline;
 * refresh-driven deletes route through `Collection._internalDelete` so
 * user `onDelete` guards on the output collection aren't tripped by
 * housekeeping.
 *
 * Two registration modes:
 *   - **single-source** — declare `query: (db) => Query<TRow>`; the
 *     dependency analyzer derives source collections from the plan.
 *   - **UNION** (#165) — declare `unionSources: [{ collection, map }, ...]`
 *     plus optional `groupBy` + `aggregate`; the executor reads each
 *     arm, maps to the unified row shape, concatenates, then groups
 *     and aggregates.
 *
 * The two modes are mutually exclusive — exactly one of `query` /
 * `unionSources` must be set at registration time.
 *
 * See docs/superpowers/specs/2026-05-20-dim14-mv-v2-design.md (single-source v2)
 * and docs/superpowers/specs/2026-05-21-dim14-mv-multikey-and-union.md (UNION).
 */
export function withMaterializedView<TRow extends Record<string, unknown>>(
  spec: MaterializedViewStrategy<TRow>,
): MaterializedViewStrategyHandle {
  if (!spec.name || spec.name.length === 0) {
    throw new ValidationError('withMaterializedView: name is required')
  }
  // Mutual exclusion: query and unionSources cannot coexist.
  if (spec.query && spec.unionSources) {
    throw new MaterializedViewConfigError(
      'query and unionSources are mutually exclusive — pick one',
    )
  }
  // Strategy must declare one of the two.
  if (!spec.query && !spec.unionSources) {
    throw new MaterializedViewConfigError(
      'strategy must declare either query or unionSources',
    )
  }
  if (spec.query !== undefined && typeof spec.query !== 'function') {
    throw new ValidationError('withMaterializedView: query must be a function returning a Query<T>')
  }
  // UNION-form invariants.
  if (spec.unionSources) {
    if (spec.unionSources.length < 2) {
      throw new MaterializedViewConfigError(
        'unionSources requires at least 2 source collections',
      )
    }
    const seen = new Set<string>()
    for (const s of spec.unionSources) {
      if (typeof s?.collection !== 'string' || s.collection.length === 0) {
        throw new MaterializedViewConfigError(
          'each unionSources entry must declare a non-empty `collection` string',
        )
      }
      if (typeof s.map !== 'function') {
        throw new MaterializedViewConfigError(
          `unionSources entry for "${s.collection}" is missing a \`map\` function`,
        )
      }
      if (seen.has(s.collection)) {
        throw new MaterializedViewConfigError(
          `unionSources must reference distinct collections (duplicate: "${s.collection}")`,
        )
      }
      seen.add(s.collection)
    }
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
