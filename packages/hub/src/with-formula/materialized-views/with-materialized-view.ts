import { MaterializedViewConfigError, ValidationError } from '../../kernel/errors.js'
import type { MaterializedViewSpec, MaterializedViewStrategy } from './types.js'

/**
 * Register a materialized view: a declared query whose result is
 * persisted as a queryable collection and kept fresh as sources
 * change. Writes go through the standard `Collection.put` pipeline;
 * refresh-driven deletes route through `Collection._internalDelete` so
 * user `onDelete` guards on the output collection aren't tripped by
 * housekeeping.
 *
 * Three registration modes:
 *   - **single-source** — declare `query: (db) => Query<TRow>`; the
 *     dependency analyzer derives source collections from the plan.
 *   - **UNION** — declare `unionSources: [{ collection, map }, ...]`
 *     plus optional `groupBy` + `aggregate`; the executor reads each
 *     arm, maps to the unified row shape, concatenates, then groups
 *     and aggregates.
 *   - **projection** (#810) — declare `projection: { source, joins,
 *     map }`; one output row per primary record, enriched with
 *     forward FK legs and reverse "collect" legs before `map` runs.
 *
 * The three modes are mutually exclusive — exactly one of `query` /
 * `unionSources` / `projection` must be set at registration time.
 *
 * See docs/superpowers/specs/2026-05-20-dim14-mv-v2-design.md (single-source v2),
 * docs/superpowers/specs/2026-05-21-dim14-mv-multikey-and-union.md (UNION),
 * and docs/superpowers/specs/2026-07-25-join-projection-mv-design.md (projection).
 */
export function withMaterializedView<TRow extends Record<string, unknown>>(
  spec: MaterializedViewSpec<TRow>,
): MaterializedViewStrategy {
  if (!spec.name || spec.name.length === 0) {
    throw new ValidationError('withMaterializedView: name is required')
  }
  // Mutual exclusion: exactly one of the three forms must be declared.
  const declaredForms = [spec.query, spec.unionSources, spec.projection]
    .filter((f) => f !== undefined).length
  if (declaredForms > 1) {
    throw new MaterializedViewConfigError(
      'query, unionSources, and projection are mutually exclusive — pick one',
    )
  }
  if (declaredForms === 0) {
    throw new MaterializedViewConfigError(
      'strategy must declare exactly one of query, unionSources, or projection',
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
  // Projection-form invariants (#810). Shape checks only — the
  // semantic ref() check on collect legs (the `on` field must carry a
  // ref() targeting the projection source) runs at first
  // materialization, parity with join-time ref errors.
  if (spec.projection) {
    const projection = spec.projection
    if (typeof projection.source !== 'string' || projection.source.length === 0) {
      throw new MaterializedViewConfigError(
        `withMaterializedView "${spec.name}": projection.source must be a non-empty collection name`,
      )
    }
    if (typeof projection.map !== 'function') {
      throw new MaterializedViewConfigError(
        `withMaterializedView "${spec.name}": projection is missing a \`map\` function`,
      )
    }
    if (!Array.isArray(projection.joins) || projection.joins.length < 1) {
      throw new MaterializedViewConfigError(
        `withMaterializedView "${spec.name}": projection.joins must declare at least 1 leg — `
        + `a leg-less single-source MV is the query() form's job`,
      )
    }
    const seenAs = new Set<string>()
    for (const leg of projection.joins) {
      const l = leg as { field?: unknown; collect?: unknown; on?: unknown; as?: unknown }
      const isForward = l.field !== undefined
      const isCollect = l.collect !== undefined
      if (isForward && isCollect) {
        throw new MaterializedViewConfigError(
          `withMaterializedView "${spec.name}": a projection leg cannot declare both \`field\` `
          + `(forward) and \`collect\` (reverse) — split it into two legs`,
        )
      }
      if (!isForward && !isCollect) {
        throw new MaterializedViewConfigError(
          `withMaterializedView "${spec.name}": each projection leg must declare either \`field\` `
          + `(forward FK) or \`collect\` (reverse one-to-many)`,
        )
      }
      if (isForward && (typeof l.field !== 'string' || l.field.length === 0)) {
        throw new MaterializedViewConfigError(
          `withMaterializedView "${spec.name}": a forward projection leg must declare a non-empty \`field\``,
        )
      }
      if (isCollect) {
        if (typeof l.collect !== 'string' || l.collect.length === 0) {
          throw new MaterializedViewConfigError(
            `withMaterializedView "${spec.name}": a collect projection leg must declare a non-empty \`collect\` collection name`,
          )
        }
        if (typeof l.on !== 'string' || l.on.length === 0) {
          throw new MaterializedViewConfigError(
            `withMaterializedView "${spec.name}": collect leg for "${l.collect}" must declare a non-empty \`on\` FK field`,
          )
        }
      }
      if (typeof l.as !== 'string' || l.as.length === 0) {
        throw new MaterializedViewConfigError(
          `withMaterializedView "${spec.name}": each projection leg must declare a non-empty \`as\` alias`,
        )
      }
      if (seenAs.has(l.as)) {
        throw new MaterializedViewConfigError(
          `withMaterializedView "${spec.name}": projection legs must attach under distinct \`as\` aliases (duplicate: "${l.as}")`,
        )
      }
      seenAs.add(l.as)
    }
    // Post-map grouping invariants — same rules as UNION (the mapped
    // stream feeds the same shared groupAndReduce tail).
    if (Array.isArray(spec.groupBy) && spec.groupBy.length === 0) {
      throw new MaterializedViewConfigError(
        `withMaterializedView "${spec.name}": groupBy must not be an empty array — omit it or provide at least one field name`,
      )
    }
    if (spec.aggregate && !spec.groupBy) {
      throw new MaterializedViewConfigError(
        `withMaterializedView "${spec.name}": projection strategy with aggregate requires groupBy — `
        + `use groupBy to declare the bucketing keys, or remove aggregate for a row-per-primary-record MV`,
      )
    }
    if (spec.moneyFields && !spec.aggregate) {
      throw new MaterializedViewConfigError(
        `withMaterializedView "${spec.name}": moneyFields requires aggregate — `
        + `moneyFields rewrites sum/min/max reducers over money output fields, `
        + `so it is meaningless without an aggregate spec`,
      )
    }
    if (spec.predicates) {
      throw new MaterializedViewConfigError(
        `withMaterializedView "${spec.name}": predicates are not supported on projection strategies — `
        + `projection mode does not use a Query<T> chain, so .wherePredicate() cannot fire. `
        + `Filter inside projection.map (return null to omit) instead`,
      )
    }
  }
  // i18nLocale + i18nFields drive compute-time i18n resolution of group-key
  // i18nText fields before bucketing — UNION mode (resolved on the unified rows)
  // AND query mode (resolved in GroupedReduction.run before groupAndReduce).
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
