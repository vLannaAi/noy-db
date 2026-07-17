/**
 * Tier visibility helper (#712/#707): a tier-0 code path treats an elevated
 * (_tier > 0) record as invisible. History reads gate on the LIVE record's
 * tier — history snapshots keep their tier-0-wrapped CEKs and carry no _tier
 * of their own, so an elevated record's prior versions would otherwise stay
 * tier-0-decryptable (the read-gate closes the API surface; #712's at-rest
 * arc rewraps the snapshot keys). Envelope inspection only — no decryption.
 *
 * #715/#716: the write ring. Invisibility on the read side is exactly what
 * makes a tier-0 write path treat an elevated record as absent — a put()
 * believes it's a create (demotion) and a delete() writes a marker with no
 * _tier (erasing the elevation signal). `assertTierWritable` closes that by
 * refusing the write outright. Both helpers share a single envelope peek
 * (`peekLiveTier`) — no duplicated `adapter.get` per write.
 */
import type { NoydbStore } from './types.js'
import { TierWriteRefusedError } from './errors.js'

async function peekLiveTier(
  adapter: NoydbStore, vault: string, name: string, id: string,
): Promise<number> {
  const env = await adapter.get(vault, name, id)
  return env?._tier ?? 0
}

export async function liveRecordIsElevated(
  adapter: NoydbStore, vault: string, name: string, id: string,
): Promise<boolean> {
  return (await peekLiveTier(adapter, vault, name, id)) > 0
}

/**
 * The tier a record's LIVE envelope currently carries (0 if untiered or
 * never moved). #724 Task 4: `BlobSet.loadSlots`/`saveSlots` use this to
 * resolve the per-record slot map's collection DEK at the record's current
 * tier by default, so the slot map's physical location follows the record
 * after `rehomeForTier` re-keys it.
 */
export async function liveRecordTier(
  adapter: NoydbStore, vault: string, name: string, id: string,
): Promise<number> {
  return peekLiveTier(adapter, vault, name, id)
}

/**
 * Refuses a tier-0 `put()`/`delete()` targeting an elevated record.
 * No-op when `tiersEnabled` is false (the cost gate — collections that
 * never declare tiers pay nothing). Throws `TierWriteRefusedError` with
 * the record's ACTUAL live tier when elevated — holders included, since
 * `put()`/`delete()` are the tier-0 APIs and `putAtTier`/`elevate`/`demote`
 * are the sanctioned tier-aware paths.
 */
export async function assertTierWritable(
  adapter: NoydbStore, vault: string, name: string, id: string, tiersEnabled: boolean,
): Promise<void> {
  if (!tiersEnabled) return
  const tier = await peekLiveTier(adapter, vault, name, id)
  if (tier > 0) throw new TierWriteRefusedError(name, tier)
}
