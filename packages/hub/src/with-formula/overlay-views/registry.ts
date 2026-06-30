import {
  OverlayBaseIsVirtualError,
  OverlayCollectionUnavailableError,
  OverlayNameCollisionError,
} from '../errors.js'
import type { MaterializedViewRegistry } from '../materialized-views/registry.js'
import type { OverlayedViewStrategy } from './types.js'

/**
 * Vault-internal registry of overlay strategies. Resolves the base
 * MV's `rowKey` lazily so virtual-collection writes can derive ids
 * from the row.
 *
 * @internal
 */
export class OverlayedViewRegistry {
  private readonly _byName = new Map<string, OverlayedViewStrategy>()

  /**
   * Register an overlay. Validates name uniqueness, base concreteness,
   * and overlay availability AGAINST the MV registry — overlays
   * declared without the MV registry context skip cross-registry
   * checks but still validate self-consistency.
   */
  register(
    spec: OverlayedViewStrategy,
    options: {
      isOverlayName?: (name: string) => boolean
      isMVOutput?: (name: string) => boolean
      isKnownCollection?: (name: string) => boolean
    },
  ): void {
    const { isOverlayName, isMVOutput, isKnownCollection } = options

    // 1. Virtual name must not collide with an MV output or a concrete
    //    source collection. Concrete-source detection is best-effort:
    //    if `isKnownCollection` is supplied, a hit there + no MV match
    //    is treated as a collision.
    if (isMVOutput?.(spec.name) || isOverlayName?.(spec.name)) {
      throw new OverlayNameCollisionError(spec.name)
    }
    // (We don't check isKnownCollection for `name` collision because
    // virtual names are typically NOT pre-existing — they're created
    // by the overlay declaration itself. Future versions may tighten.)

    // 2. base must be concrete: NOT another overlay's virtual name.
    if (isOverlayName?.(spec.base)) {
      throw new OverlayBaseIsVirtualError(spec.name, spec.base)
    }

    // 3. overlay must be available: a real, vault-known collection
    //    that is NOT an MV output (since MVs own their outputs).
    if (isMVOutput?.(spec.overlay)) {
      throw new OverlayCollectionUnavailableError(spec.name, spec.overlay)
    }
    // Best-effort known-collection check — when the vault can answer
    // it. Unknown collections aren't a hard failure (the overlay may
    // be implicitly created on first write), so we only throw on the
    // MV-output case above.
    void isKnownCollection

    this._byName.set(spec.name, spec)
  }

  byName(name: string): OverlayedViewStrategy | undefined {
    return this._byName.get(name)
  }

  /** All overlay virtual names. */
  names(): ReadonlySet<string> {
    return new Set(this._byName.keys())
  }

  isOverlay(name: string): boolean {
    return this._byName.has(name)
  }

  /**
   * All registered overlay strategies as a flat array.
   * Each strategy carries `name`, `base`, and `overlay` fields that
   * `describeOverlays()` in the introspection walker reads directly.
   *
   * Used by `dumpSchema()` to populate the `overlayViews` map.
   */
  all(): ReadonlyArray<OverlayedViewStrategy> {
    return [...this._byName.values()]
  }

  /**
   * Resolve the `rowKey` function for an overlay's base MV. Returns
   * `undefined` if the base isn't an MV (raw source collection) or
   * if the MV registry isn't supplied. Used by the virtual-collection
   * proxy to derive ids from `put(record)` calls.
   */
  resolveBaseRowKey(
    name: string,
    mvRegistry: MaterializedViewRegistry | null,
  ): ((row: Record<string, unknown>) => string) | undefined {
    const spec = this._byName.get(name)
    if (!spec || !mvRegistry) return undefined
    // The base might be an MV's `output.collection` OR the MV's `name`
    // (when no output.collection is declared). Search by both.
    for (const reg of mvRegistry.all()) {
      if (reg.outputCollection === spec.base || reg.spec.name === spec.base) {
        return (row) => reg.spec.rowKey(row)
      }
    }
    return undefined
  }
}
