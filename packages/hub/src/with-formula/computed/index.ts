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
 * is out of scope here — see the validation subsystem (#299).
 */

import { NoydbError } from '../../errors.js'

export type ComputedFn<T = Record<string, unknown>> = (record: T) => unknown

export type ComputedFields<T = Record<string, unknown>> = Record<string, ComputedFn<T>>

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
  for (const [field, fn] of Object.entries(computed)) {
    try {
      out[field] = fn(out)
    } catch (cause) {
      throw new ComputedFieldError(field, id, cause)
    }
  }
  return out as T
}
