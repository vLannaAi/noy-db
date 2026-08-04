/**
 * The deterministic fallback key for an UNNAMED derivation, shared by
 * `dumpSchema`'s `describeDerivations` (walk.ts) and `listBehaviors`'s
 * `buildDerivationEntries` (behaviors.ts) so the two surfaces always key the
 * same unnamed derivation identically.
 *
 * Base key = the derivation's output-collection names, sorted and joined by
 * `+` (or `source` when it has no outputs). On collision with any key already
 * assigned in this enumeration (named or fallback, passed in `used`), a
 * deterministic `#occurrence` suffix is appended (`base`, `base#1`, `base#2`, …)
 * so two derivations with the same output set both appear.
 *
 * Takes the already-extracted output-collection list + source (rather than a
 * `DerivationSpec`) so both the typed builder and walk.ts's duck-typed registry
 * walk can call it without a shared concrete type.
 */
export function fallbackDerivationName(
  outputCollections: readonly string[],
  source: string,
  used: ReadonlySet<string>,
): string {
  const base = outputCollections.length > 0 ? [...outputCollections].sort().join('+') : source
  if (!used.has(base)) return base
  let occurrence = 1
  let candidate = `${base}#${occurrence}`
  while (used.has(candidate)) {
    occurrence++
    candidate = `${base}#${occurrence}`
  }
  return candidate
}
