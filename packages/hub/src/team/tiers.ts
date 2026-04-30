/**
 * Hierarchical access — tier-aware keyring helpers.
 *
 * The keyring's existing `deks: Map<string, CryptoKey>` is keyed by
 * collection name. extends the key space:
 *
 *   `'invoices'`      — tier-0 DEK (unchanged from v0.x)
 *   `'invoices#1'`    — tier-1 DEK
 *   `'invoices#2'`    — tier-2 DEK
 *
 * Tier 0 keeps the bare collection name so any keyring written
 * before tiers existed loads without migration. Tiers ≥ 1 use `#N`
 * suffixes that
 * would be invalid as user-supplied collection names (see
 * `ReservedCollectionNameError` — `#` is reserved).
 *
 * @module
 */

import type { UnlockedKeyring } from './keyring.js'
import { TierNotGrantedError } from '../errors.js'

/** Canonical DEK key for a given collection + tier. Tier 0 → bare name. */
export function dekKey(collection: string, tier: number): string {
  if (tier <= 0) return collection
  return `${collection}#${tier}`
}

/**
 * Returns the user's effective clearance for a given collection: the
 * maximum tier for which their keyring holds a DEK. Falls back to 0
 * when the user has only the tier-0 DEK (or none — the getDEK caller
 * will raise separately).
 */
export function effectiveClearance(keyring: UnlockedKeyring, collection: string): number {
  let max = 0
  const prefix = `${collection}#`
  for (const key of keyring.deks.keys()) {
    if (!key.startsWith(prefix)) continue
    const suffix = key.slice(prefix.length)
    const n = Number.parseInt(suffix, 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max
}

/**
 * Assert the caller is cleared for the requested tier. Owners and
 * admins always pass (they can mint any new tier DEK on demand);
 * other roles must already hold the tier DEK — via a prior grant or
 * an active delegation — otherwise this throws `TierNotGrantedError`.
 *
 * This gate runs BEFORE `getDEK()` on the mutation path so a
 * non-cleared operator never has the opportunity to silently
 * auto-create a tier DEK they shouldn't have.
 */
export function assertTierAccess(
  keyring: UnlockedKeyring,
  collection: string,
  tier: number,
): void {
  if (tier <= 0) return
  if (keyring.role === 'owner' || keyring.role === 'admin') return
  if (!keyring.deks.has(dekKey(collection, tier))) {
    throw new TierNotGrantedError(collection, tier)
  }
}
