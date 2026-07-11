/**
 * Computed scalar fields — schema-owned derived values evaluated on
 * write and materialized onto the record.
 *
 * A `computed` map declares pure, synchronous functions keyed by field
 * path. {@link evalComputedFields} runs them in declaration order — each
 * function sees the record with all prior computed fields already
 * injected, so a later field can read an earlier one (`total` reads
 * `netAmount`). The result is stored like any field: queryable,
 * indexable, and `aggregate(sum())`-able (exactly, when the field is also
 * a `money()` field).
 *
 * Computed evaluation is the FIRST stage of the write pipeline (before
 * schema validation), so the user need not supply computed fields and the
 * schema validates the computed result. Cross-record / async derivation
 * is out of scope here — see the validation service.
 */

import { NoydbError } from '../../kernel/errors.js'

export type ComputedFn<T = Record<string, unknown>> = (record: T) => unknown

/**
 * #638 Task 7 — the extended per-field entry: `deps` (source field names, feeds
 * `ViaGraph` for taint propagation) and `mode` (`'materialized' | 'virtual'`,
 * default `'materialized'`) alongside `fn`. Lets `computed: { field: {...} }`
 * declare the same `{deps, mode}` shape `via(computed(fn, {...}))` composes —
 * absorbs the old `computedDeps` sibling option (#638 Task 2, retired here).
 */
export interface ComputedFieldEntry<T = Record<string, unknown>> {
  readonly fn: ComputedFn<T>
  readonly deps?: readonly string[]
  readonly mode?: 'materialized' | 'virtual'
}

/** The plain `Record<string, ComputedFn>` sugar keeps working unchanged (materialized,
 *  no deps); a field may alternatively carry the extended `ComputedFieldEntry` shape. */
export type ComputedFields<T = Record<string, unknown>> = Record<string, ComputedFn<T> | ComputedFieldEntry<T>>

/** Raised when a computed function throws during a write. */
export class ComputedFieldError extends NoydbError {
  constructor(
    public readonly field: string,
    public readonly id: string,
    public readonly cause: unknown,
  ) {
    super(
      'COMPUTED_FIELD',
      `computed field "${field}" threw for record "${id}": ` +
        (cause instanceof Error ? cause.message : String(cause)),
    )
    this.name = 'ComputedFieldError'
  }
}

/**
 * Evaluate every computed field in declaration order, injecting each
 * result into a shallow clone. A computed field overwrites any
 * user-supplied value of the same name — the field is schema-owned.
 * Returns the new record; the input is not mutated.
 */
export function evalComputedFields<T extends Record<string, unknown>>(
  record: T,
  computed: ComputedFields,
  id: string,
): T {
  const out: Record<string, unknown> = { ...record }
  for (const [field, entry] of Object.entries(computed)) {
    const fn = typeof entry === 'function' ? entry : entry.fn
    try {
      out[field] = fn(out)
    } catch (cause) {
      throw new ComputedFieldError(field, id, cause)
    }
  }
  return out as T
}
