/**
 * Read-shadow overlay primitive (MV v2 spec § Composition with
 * operator-editable lifecycle). Binds an MV's read-only base output
 * to a separate user-writable overlay collection; reads merge via a
 * single shadow predicate, writes route to the overlay.
 *
 * v2 ships the read-shadow variant only — arbitrary `mergePolicy`
 * callbacks are deferred to v3.
 */
export interface OverlayedViewStrategy {
  /**
   * Virtual collection name. `vault.collection(name)` returns a
   * proxy that merges `base` and `overlay` per the shadow rule.
   * Writes to the proxy route to the `overlay` collection. The name
   * must be unique within the vault — collisions with MV outputs or
   * concrete source collections throw `OverlayNameCollisionError` at
   * vault open.
   */
  name: string
  /**
   * The collection providing the default rows. Typically an MV's
   * output collection. Must be a CONCRETE collection (a real source
   * or an MV output) — not itself another overlay's virtual name.
   * Multi-overlay stacking is a v3 non-goal; the constraint is
   * enforced at vault open via `OverlayBaseIsVirtualError`.
   */
  base: string
  /**
   * User-writable collection that carries overrides. Must be a real,
   * vault-known collection that is NOT an MV-output collection. The
   * overlay's `withGuard` / `withDerivation` registrations apply to
   * direct writes; the virtual layer's `put(record)` also flows
   * through the overlay's normal write pipeline.
   */
  overlay: string
  /**
   * Single-field shadow predicate. When `overlay[shadowField] ===
   * shadowValue` for a given id, virtual-collection reads of that id
   * return the overlay row; otherwise reads return the base row.
   *
   * Niwat's canonical example: `dataStatus === 'override'` flips a
   * row into operator-controlled mode.
   *
   * No callback merge, no priority lattice, no field-level merge —
   * v2 stays explicitly narrow.
   */
  shadowField: string
  shadowValue: unknown
  /**
   * Optional field-level merge mode (AU+032 / #348). When present, a
   * row whose `shadowField` does NOT equal `shadowValue` is no longer
   * forced all-base: the rules below let an intermediate status pull a
   * declared subset of fields from the overlay while every other field
   * still comes from the base row.
   *
   * Absent `mergeMode` preserves the original binary behaviour
   * exactly — overlay wins entirely iff `shadowField === shadowValue`,
   * otherwise base wins.
   */
  mergeMode?: OverlayFieldMergeMode
}

/**
 * One field-level merge rule. When the overlay row's `shadowField`
 * equals `whenStatus`, the merged row takes `overlayFields` from the
 * overlay and every other field from the base row.
 *
 * Always include `shadowField` in `overlayFields` so the status value
 * itself propagates to the merged read (otherwise the merged row would
 * carry the base's status, which is usually `undefined`).
 */
export interface OverlayFieldMergeRule {
  /** The `overlay[shadowField]` value this rule matches. */
  readonly whenStatus: unknown
  /**
   * Field names pulled from the overlay row when this rule matches.
   * Fields absent on the overlay row are skipped (base value kept).
   */
  readonly overlayFields: readonly string[]
}

/**
 * Field-level merge configuration. `rules` are evaluated in
 * declaration order and the FIRST rule whose `whenStatus` matches the
 * overlay's `shadowField` wins; later rules are not consulted.
 *
 * The binary shadow check (`shadowField === shadowValue` → overlay
 * wins entirely) is always the implicit, highest-priority rule applied
 * BEFORE any `rules` entry, so adding `mergeMode` never changes the
 * full-override path.
 */
export interface OverlayFieldMergeMode {
  readonly kind: 'field-merge'
  readonly rules: readonly OverlayFieldMergeRule[]
}

/** Returned by `withOverlayedView()` and consumed by `createNoydb`. */
export interface OverlayedViewStrategyHandle {
  readonly __noydb_strategy: 'overlayed-view'
  readonly spec: OverlayedViewStrategy
}
