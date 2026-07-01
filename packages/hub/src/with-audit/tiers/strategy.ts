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
import type { TiersContext } from './index.js'
import { TiersNotEnabledError } from '../../kernel/errors.js'

export interface TiersStrategy {
  putAtTier<T>(
    ctx: TiersContext<T>,
    id: string,
    record: T,
    tier: number,
    opts?: { elevation?: { reason: string; fromTier: number }; source?: string; sourceTs?: string },
  ): Promise<void>
  getAtTier<T>(ctx: TiersContext<T>, id: string): Promise<T | GhostRecord | null>
  listAtTier<T>(ctx: TiersContext<T>): Promise<Array<{ id: string; tier: number; readable: boolean }>>
  elevate<T>(ctx: TiersContext<T>, id: string, toTier: number): Promise<void>
  demote<T>(ctx: TiersContext<T>, id: string, toTier: number): Promise<void>
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
}
