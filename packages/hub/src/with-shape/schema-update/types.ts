/**
 * Schema-update strategy framework types (M12 §3a).
 *
 * The hub core detects a schema change (SchemaDelta) and dispatches it
 * through a collection's ordered strategy list. Strategies decide what
 * happens; the core only knows this interface.
 */

/** A single changed top-level property in a schema delta. */
export interface FieldChange {
  readonly field: string
  /** True when the field's required-ness flipped. */
  readonly requiredChanged: boolean
  /** True when the field's subschema shape changed. */
  readonly shapeChanged: boolean
}

/** The classified difference between a stored and a freshly-derived schema. */
export interface SchemaDelta {
  readonly collection: string
  readonly kind: 'none' | 'additive' | 'non-additive'
  /** Top-level properties present in the new schema but not the old. */
  readonly added: readonly string[]
  /** Top-level properties present in the old schema but not the new. */
  readonly removed: readonly string[]
  /** Top-level properties present in both but altered. */
  readonly changed: readonly FieldChange[]
}

/** Context handed to a strategy alongside the delta. */
export interface UpdateContext {
  readonly collection: string
}

/** Bulk transform run by the coordinatedCutover strategy. */
export type TransformFn = (doc: Record<string, unknown>) => Record<string, unknown>

/**
 * A strategy's verdict on a detected schema change.
 * - `allow`   — no objection; the dispatcher falls through to the next strategy.
 * - `reject`  — terminal: refuse the change; `error` is thrown at the write path.
 * - `cutover` — terminal: run a coordinated drain-barrier (handled by coordinatedCutover).
 * New terminal actions may be added without breaking existing strategies.
 */
export type UpdateDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'reject'; readonly error: Error }
  | { readonly action: 'cutover'; readonly transform: TransformFn }

/** A pluggable schema-evolution policy. */
export interface SchemaUpdateStrategy {
  readonly name: string
  onSchemaDelta(
    delta: SchemaDelta,
    ctx: UpdateContext,
  ): UpdateDecision | Promise<UpdateDecision>
}
