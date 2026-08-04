/**
 * Builds the `subsystems` block of the vault schema snapshot (#948 seam 5):
 * the 4 registry-presence booleans (guards / derivations / materializedViews
 * / overlayViews) UNION the 27 strategy-derived booleans — one per
 * {@link StrategyKey}, `true` iff that service's resolved strategy differs
 * from its un-opted-in default.
 *
 * The 4 registry keys are canonical: if a strategy key ever collides with one
 * of them, the registry value wins (registries are spread last).
 *
 * @module
 */

import { STRATEGY_DEFAULTS, STRATEGY_KEYS, type StrategyBag } from '../../port/with/strategies.js'

/** The 4 registry-presence keys already reported before #948 seam 5. */
export interface SubsystemRegistries {
  readonly guards: boolean
  readonly derivations: boolean
  readonly materializedViews: boolean
  readonly overlayViews: boolean
}

/** Registry keys UNION the 27 strategy-derived booleans, keyed by {@link StrategyKey} name. */
export function buildSubsystemMatrix(
  strategies: StrategyBag,
  registries: SubsystemRegistries,
): Record<string, boolean> {
  const matrix: Record<string, boolean> = {}
  for (const key of STRATEGY_KEYS) matrix[key] = strategies[key] !== STRATEGY_DEFAULTS[key]
  return { ...matrix, ...registries }
}
