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

/**
 * #708: ALL-OR-NOTHING pre-check for a coordinated-cutover bulk-rewrite —
 * scans every id's live tier BEFORE any record is transformed and refuses
 * on the first elevated one found. `_applyCutoverTransform` re-encrypts at
 * tier 0 with no gate of its own; without this, it would silently demote
 * an elevated record. Same cost gate as `assertTierWritable` (no-op, no
 * adapter call, when `tiersEnabled` is false).
 *
 * This pre-check guards against an ordinary `put()`/`delete()` racing the
 * cutover, because those go through the schema fence (`SchemaFenceController`
 * blocks concurrent writes during a coordinated cutover). It does NOT guard
 * against `elevate()`/`demote()`/`putAtTier()` — those tier-move paths bypass
 * the fence, so a tier move landing between this scan and the rewrite it
 * gates is not excluded. Cutover callers are expected to hold the vault
 * quiescent for tier moves on this collection for the duration of the call,
 * the same tier-quiescence assumption the documented CAS-less caller
 * (`with-shape/satellites/migrate-cek.ts`'s "No-quiesce precondition") makes
 * explicit for concurrent writes generally.
 */
export async function assertCutoverTierSafe(
  adapter: NoydbStore, vault: string, name: string, tiersEnabled: boolean,
): Promise<void> {
  if (!tiersEnabled) return
  for (const id of await adapter.list(vault, name)) {
    const tier = await peekLiveTier(adapter, vault, name, id)
    if (tier > 0) {
      throw new TierWriteRefusedError(name, tier, `Coordinated cutover on collection "${name}" refused — record "${id}" is elevated to tier ${tier}. Demote it before a coordinated cutover.`)
    }
  }
}

/**
 * The key a collection's DEK is stored under in `UnlockedKeyring.deks` for a
 * given tier: `collection` at tier 0, `collection#N` above it.
 *
 * Lives in the kernel because the `deks` map is a kernel type and the kernel
 * reads it — `noydb.ts` needs this to resolve the right DEK when verifying a
 * pulled envelope (#1042). `with-party/team/tiers.ts` re-exports it, so every
 * existing importer is unchanged; the definition simply moved to the layer that
 * owns the map rather than one that happens to use it.
 *
 * This move was forced by `port-layering`, and rightly: the alternative was the
 * kernel spine statically importing a `with-*` service, or duplicating the
 * naming convention in two places where it could drift.
 */
export function dekKey(collection: string, tier: number): string {
  if (tier <= 0) return collection
  return `${collection}#${tier}`
}

/**
 * Inverse of {@link dekKey}: split a DEK slot name back into the collection it
 * belongs to and the tier it covers.
 *
 * Needed because a tier slot **names a key, not a collection** (#1125).
 * `store.list(vault, "docs#1")` is empty — elevated records live in `docs`
 * alongside their tier-0 siblings, distinguished by the envelope `_tier` field.
 * Anything that walks a slot's data must walk `collection` and select within it,
 * never list the slot name.
 *
 * Parsed from the RIGHT, requiring an all-digit positive suffix. A name that
 * does not fit that shape is a plain collection at tier 0 — including one that
 * merely contains a `#`, which round-trips correctly precisely because `dekKey`
 * never produces `#0`.
 */
export function parseDekKey(slot: string): { collection: string; tier: number } {
  const cut = slot.lastIndexOf('#')
  if (cut <= 0 || cut === slot.length - 1) return { collection: slot, tier: 0 }
  const suffix = slot.slice(cut + 1)
  if (!/^[0-9]+$/.test(suffix)) return { collection: slot, tier: 0 }
  const tier = Number(suffix)
  if (tier <= 0) return { collection: slot, tier: 0 }
  return { collection: slot.slice(0, cut), tier }
}
