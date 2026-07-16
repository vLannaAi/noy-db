/**
 * Tier visibility helper (#712/#707): a tier-0 code path treats an elevated
 * (_tier > 0) record as invisible. History reads gate on the LIVE record's
 * tier — history snapshots keep their tier-0-wrapped CEKs and carry no _tier
 * of their own, so an elevated record's prior versions would otherwise stay
 * tier-0-decryptable (the read-gate closes the API surface; #712's at-rest
 * arc rewraps the snapshot keys). Envelope inspection only — no decryption.
 */
import type { NoydbStore } from './types.js'

export async function liveRecordIsElevated(
  adapter: NoydbStore, vault: string, name: string, id: string,
): Promise<boolean> {
  const env = await adapter.get(vault, name, id)
  return (env?._tier ?? 0) > 0
}
