/**
 * Tiers capability strategy — the five on-demand collection-level tier
 * operations the `Collection` routes through. The active engine
 * ({@link withTiers}) dynamically imports the tier cores (keeping them out of
 * the floor bundle); {@link NO_TIERS} throws. Collection always builds its
 * per-call {@link TiersContext} and delegates here, so an un-opted-in caller
 * hits `NO_TIERS`'s throw.
 * @internal
 */
import type { GhostRecord } from '../../kernel/types.js'
import type { TiersContext, TierMoveResult } from './index.js'
import { TiersNotEnabledError } from '../../kernel/errors.js'

// #779 — re-exported so kernel-spine callers (e.g. `Vault._elevatedPut`) can reference the
// result shape via this grandfathered strategy.js seam instead of statically importing
// tiers/index.js directly (the port-layering check only grandfathers this file).
export type { TierMoveResult }

export interface TiersStrategy {
  putAtTier<T>(
    ctx: TiersContext<T>,
    id: string,
    record: T,
    tier: number,
    opts?: { elevation?: { reason: string; fromTier: number }; source?: string; sourceTs?: string },
  ): Promise<TierMoveResult>
  getAtTier<T>(ctx: TiersContext<T>, id: string): Promise<T | GhostRecord | null>
  listAtTier<T>(ctx: TiersContext<T>): Promise<Array<{ id: string; tier: number; readable: boolean }>>
  elevate<T>(ctx: TiersContext<T>, id: string, toTier: number): Promise<TierMoveResult>
  demote<T>(ctx: TiersContext<T>, id: string, toTier: number): Promise<TierMoveResult>
  /**
   * #1358 — unique-constraint scan across every tier whose DEK the writer
   * holds. Called by the ORDINARY `Collection.put()` on a tiered collection
   * (`putAtTier` calls the core directly): the tier-0 mirror cannot see an
   * elevated record, because #709 purges its index entries on elevation.
   * A tier the writer cannot read is outside the guarantee.
   */
  checkUnique<T>(ctx: TiersContext<T>, id: string, record: T): Promise<void>
}

/**
 * No-op stub — the floor default. Every capability method throws
 * {@link TiersNotEnabledError}; opt in with `tiersStrategy: withTiers()` in
 * createNoydb. @internal
 */
export const NO_TIERS: TiersStrategy = {
  async putAtTier() { throw new TiersNotEnabledError() },
  async getAtTier() { throw new TiersNotEnabledError() },
  async listAtTier() { throw new TiersNotEnabledError() },
  async elevate() { throw new TiersNotEnabledError() },
  async demote() { throw new TiersNotEnabledError() },
  // NOT a throw, unlike its five siblings: this one is called from the
  // ORDINARY put path of any collection that declared `tiers` — and a
  // collection can declare `tiers` without wiring `withTiers()`. Without the
  // engine no record can ever leave tier 0, so there is nothing above tier 0
  // to scan and the tier-0 mirror is already the whole truth. Throwing here
  // would break plain `put()` on such a collection for no gain.
  async checkUnique() { /* no tier engine ⇒ every record is at tier 0 */ },
}
