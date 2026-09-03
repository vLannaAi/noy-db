/**
 * Enable the hierarchical-tiers capability.
 * Pass to `createNoydb({ tiersStrategy: withTiers() })` to make a collection's
 * `putAtTier` / `getAtTier` / `listAtTier` / `elevate` / `demote` methods live.
 * The tier read/write/re-key engine is dynamically imported here, so it stays
 * out of the floor bundle until opted in.
 */
import type { TiersStrategy } from './strategy.js'

export function withTiers(): TiersStrategy {
  return {
    async putAtTier(ctx, id, record, tier, opts) {
      const { putAtTier } = await import('./index.js')
      return putAtTier(ctx, id, record, tier, opts)
    },
    async getAtTier(ctx, id) {
      const { getAtTier } = await import('./index.js')
      return getAtTier(ctx, id)
    },
    async listAtTier(ctx) {
      const { listAtTier } = await import('./index.js')
      return listAtTier(ctx)
    },
    async elevate(ctx, id, toTier) {
      const { elevate } = await import('./index.js')
      return elevate(ctx, id, toTier)
    },
    async demote(ctx, id, toTier) {
      const { demote } = await import('./index.js')
      return demote(ctx, id, toTier)
    },
    async checkUnique(ctx, id, record) {
      // Skip the dynamic import entirely on the overwhelmingly common case:
      // a tiered collection with no `unique` index declared.
      if (!ctx.uniqueKeys) return
      const { checkUniqueAcrossTiers } = await import('./index.js')
      return checkUniqueAcrossTiers(ctx, id, record)
    },
  }
}
