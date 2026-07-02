import { MaterializedViewConfigError, ValidationError } from '../../kernel/errors.js'
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
 *   - **UNION** — declare `unionSources: [{ collection, map }, ...]`
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
    // A single arm is a deliberate shape: map→group→aggregate over
    // ONE collection with a COMPUTED bucket key (e.g. month sliced from a
    // date field) — something the query form's stored-field groupBy cannot
    // express. The executor and dependency analyzer are arm-count-agnostic.
    if (spec.unionSources.length < 1) {
      throw new MaterializedViewConfigError(
        'unionSources requires at least 1 source collection',
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
    if (Array.isArray(spec.groupBy) && spec.groupBy.length === 0) {
      throw new MaterializedViewConfigError(
        `withMaterializedView "${spec.name}": groupBy must not be an empty array — omit it or provide at least one field name`,
      )
    }
    if (spec.aggregate && !spec.groupBy) {
      throw new MaterializedViewConfigError(
        `withMaterializedView "${spec.name}": UNION strategy with aggregate requires groupBy — `
        + `use groupBy to declare the bucketing keys, or remove aggregate for a pure dedup MV`,
      )
    }
    // `moneyFields` only has meaning when there's an aggregate to
    // money-rewrite — it keys reducer outputs, so declaring it without
    // `aggregate` is a no-op config mistake.
    if (spec.moneyFields && !spec.aggregate) {
      throw new MaterializedViewConfigError(
        `withMaterializedView "${spec.name}": moneyFields requires aggregate — `
        + `moneyFields rewrites sum/min/max reducers over money output fields, `
        + `so it is meaningless without an aggregate spec`,
      )
    }
    // Per-arm joins resolve right-side collections that the union
    // dependency set (built from arm `collection`s alone) does NOT
    // include. The consumer must list those right-side collections in
    // `sources` so writes to them trigger MV refresh.
    if (spec.unionSources.some(s => s.join && s.join.length > 0) && (!spec.sources || spec.sources.length === 0)) {
      throw new MaterializedViewConfigError(
        `withMaterializedView "${spec.name}": a unionSources arm declares join(s) but `
        + `no \`sources\` are listed — declare sources: [...] with the right-side `
        + `(join-target) collection names so writes to them trigger MV refresh`,
      )
    }
    if (spec.predicates) {
      throw new MaterializedViewConfigError(
        `withMaterializedView "${spec.name}": predicates are not supported on UNION strategies — `
        + `UNION mode does not use a Query<T> chain, so .wherePredicate() cannot fire. `
        + `Use the query() form, or open an issue if per-arm predicates are needed`,
      )
    }
  }
  // i18nLocale + i18nFields drive compute-time i18n resolution of group-key
  // i18nText fields before bucketing — UNION mode (resolved on the unified rows)
  // AND query mode (resolved in GroupedAggregation.run before groupAndReduce).
  // i18nLocale without i18nFields cannot resolve anything, so reject it early.
  if (spec.i18nLocale !== undefined && spec.i18nFields === undefined) {
    throw new MaterializedViewConfigError(
      `withMaterializedView "${spec.name}": i18nLocale requires i18nFields — `
      + `declare the i18nText descriptors of the group-key fields so they can be `
      + `resolved at the mv layer before bucketing.`,
    )
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
