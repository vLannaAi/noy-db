/**
 * Per-layer i18n resolution policy.
 *
 * `onMissing` governs what happens when a multilingual field is resolved
 * to a target locale that is absent. It may be a single scalar policy or
 * a per-layer map, so a field can be lenient at the app read boundary but
 * strict inside a materialized view.
 *
 * Effective policy for layer `λ`:
 *
 * ```
 * explicit(λ) = typeof onMissing === 'object' ? onMissing[λ] : undefined
 * scalar      = typeof onMissing === 'string' ? onMissing : undefined
 * policy(λ)   = explicit(λ) ?? layerDefault(λ) ?? scalar ?? 'throw'
 * ```
 *
 * - `layerDefault('guard') = 'substitute'` — guards are lenient unless
 *   EXPLICITLY overridden; they never inherit a scalar policy (a guard
 *   reading a display value must not hard-fail on a missing locale).
 * - every other layer has no default, so it inherits the scalar, else
 *   falls back to `'throw'` (today's behavior — zero breaking change).
 *
 * @public
 */
export type OnMissing = 'substitute' | 'null' | 'throw'

/**
 * The contexts in which a multilingual field is resolved. Each can carry
 * its own `onMissing` policy.
 *
 * - `read`       — ordinary app reads (`get`/`list`/query projection).
 * - `guard`      — a guard callback reading a value.
 * - `join`       — a joined record expanded onto a row.
 * - `mv`         — materialized-view input.
 * - `derivation` — derivation input.
 * - `export`     — bundle/public-envelope export.
 */
export type Layer = 'read' | 'guard' | 'join' | 'mv' | 'derivation' | 'export'

/** Field-level policy: a single scalar, or a per-layer map. */
export type OnMissingPolicy = OnMissing | Partial<Record<Layer, OnMissing>>

/**
 * Resolve the effective `OnMissing` for a layer from a field's declared
 * policy. See module docs for the resolution rule.
 */
export function resolvePolicy(
  onMissing: OnMissingPolicy | undefined,
  layer: Layer,
): OnMissing {
  const explicit =
    onMissing && typeof onMissing === 'object' ? onMissing[layer] : undefined
  const scalar = typeof onMissing === 'string' ? onMissing : undefined
  const layerDefault: OnMissing | undefined =
    layer === 'guard' ? 'substitute' : undefined
  return explicit ?? layerDefault ?? scalar ?? 'throw'
}
