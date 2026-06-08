/**
 * @category capability
 * Deferred-numbering config descriptor. See
 * docs/superpowers/specs/2026-06-08-sealed-numbering-and-store-clock-design.md.
 */

/** A registered deferred-numbering series. */
export interface DeferredNumberingConfig {
  /** Series name — the key passed to `vault.sequence(series)`. */
  readonly series: string
  /** Collection holding the records to number. */
  readonly collection: string
  /** Field on each record where the assigned serial is written. */
  readonly field: string
  /**
   * Minimum wall-clock age (ms) before an entry is eligible at a pass, in
   * addition to the interval commit-wait. Default 0 — the store-clock
   * interval (`storeLatest ≤ now.earliest`) is the correctness mechanism.
   */
  readonly settleWindowMs: number
}

/** Declare a deferred-numbering series. Pass the result in `createNoydb({ numbering: [...] })`. */
export function withDeferredNumbering(config: {
  series: string
  collection: string
  field: string
  settleWindowMs?: number
}): DeferredNumberingConfig {
  return {
    series: config.series,
    collection: config.collection,
    field: config.field,
    settleWindowMs: config.settleWindowMs ?? 0,
  }
}
