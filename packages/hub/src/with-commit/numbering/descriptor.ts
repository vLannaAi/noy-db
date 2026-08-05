/**
 * @category capability
 * Deferred-numbering config descriptor. See
 * design-history/2026-06-08-sealed-numbering-and-store-clock-design.md.
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

/**
 * Options for {@link withDeferredNumbering} (#844b — was an inline literal, so
 * unnameable). Same shape as {@link DeferredNumberingConfig} except
 * `settleWindowMs` is optional; the factory defaults it to 0.
 */
export interface WithDeferredNumberingOptions {
  /** Series name — the key passed to `vault.sequence(series)`. */
  readonly series: string
  /** Collection holding the records to number. */
  readonly collection: string
  /** Field on each record where the assigned serial is written. */
  readonly field: string
  /** See {@link DeferredNumberingConfig.settleWindowMs}. Default 0. */
  readonly settleWindowMs?: number
}

/** Declare a deferred-numbering series. Pass the result in `createNoydb({ numbering: [...] })`. */
export function withDeferredNumbering(opts: WithDeferredNumberingOptions): DeferredNumberingConfig {
  return {
    series: opts.series,
    collection: opts.collection,
    field: opts.field,
    settleWindowMs: opts.settleWindowMs ?? 0,
  }
}
