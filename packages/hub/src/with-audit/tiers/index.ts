/**
 * Hierarchical access — the collection-level tier operations
 * (`putAtTier` / `getAtTier` / `listAtTier` / `elevate` / `demote`).
 *
 * A collection opted into `{ tiers: [...] }` stamps `_tier: N` on each envelope
 * and encrypts its body under the tier-N DEK. These helpers are the read/write
 * surface for that scheme: write at a tier, read with tier-aware visibility
 * (invisibility vs. ghost), and move a record up (`elevate`) or down (`demote`)
 * the tier ladder by re-wrapping its body key.
 *
 * Each function takes a small {@link TiersContext} (the exact `this.*` the
 * moving methods touched) instead of `this`, mirroring the `record-keys/`
 * siblings. Behaviour is byte-identical to the inline code it replaced.
 *
 * The crux is `cekCache`: `elevate`/`demote`/`getAtTier` write the SAME `Lru`
 * reference `Collection` owns (never a copy) so a per-record CEK re-wrap stays
 * synchronous with the cache the kernel's write/read path also mutates. The
 * cross-tier event sink stays collection-resident and is reached via the
 * `emitCrossTierEvent` callback.
 *
 * Internal service — not exported as a `@noy-db/hub/*` subpath.
 */
export { withTiers } from './active.js'
export { NO_TIERS, type TiersStrategy } from './strategy.js'
export { TiersNotEnabledError } from '../../kernel/errors.js'
import { encrypt, decrypt, unwrapCek, rewrapBodyToDek, isDeleteMarker, isTombstoneShape, type RecordCodec, type EnclaveKey, type SealedShredSlot } from '../../kernel/enclave/index.js'
import { TierDemoteDeniedError } from '../../kernel/errors.js'
import { dekKey, assertTierAccess } from '../../with-party/team/tiers.js'
import type { UnlockedKeyring } from '../../with-party/team/keyring.js'
import type { Lru } from '../../kernel/cache/index.js'
import {
  NOYDB_FORMAT_VERSION,
  type NoydbStore,
  type EncryptedEnvelope,
  type GhostRecord,
  type TierMode,
  type CrossTierAccessEvent,
} from '../../kernel/types.js'

/** Everything the moving tier methods touched on `this.*`, as a flat context. */
export interface TiersContext<T> {
  /** Collection name — the crypto AAD scope and tier-DEK key prefix. */
  readonly name: string
  /** Vault namespace the records live under. */
  readonly vault: string
  /** The ciphertext store. */
  readonly adapter: NoydbStore
  /** The caller's unlocked keyring (tier-DEK holdings + role + userId). */
  readonly keyring: UnlockedKeyring
  /** The record codec — decrypts a tier-0 envelope to T. */
  readonly codec: RecordCodec<T>
  /**
   * The collection's per-record CEK cache (SHARED reference, not a copy).
   * `elevate`/`demote`/`getAtTier` re-wrap a record's CEK and `set` it here so
   * the move stays synchronous with the cache the kernel's read/write path
   * owns. `null` → no caching.
   */
  readonly cekCache: Lru<string, EnclaveKey> | null
  /**
   * Sync the collection's decoded-record cache after a tier move rewraps the
   * envelope (#691). `null` → evict the eager cache entry and the lazy LRU
   * (the lazy LRU never needs re-seeding: its `#getRaw` has an adapter
   * fallback on a miss, so evicting it on every move stays correct). An
   * `entry` → set the eager cache to the given decoded record/version (used
   * only by `demote()` when landing back at tier 0 — the record is tier-0
   * again, so it must stay plain-`get()`-readable in the same session).
   */
  syncCache(id: string, entry: { record: T; version: number } | null): void
  /** Emit `_source`/`_sourceTs` provenance fields when a source is supplied. */
  readonly provenance: boolean
  /** Declared tiers, or null when the feature is off. */
  readonly tiers: ReadonlySet<number> | null
  /** Above-tier read visibility mode (`'invisibility'` | `'ghost'`). */
  readonly tierMode: TierMode
  /** Resolve a tier DEK by its `dekKey(name, tier)`. */
  getDEK(key: string): Promise<EnclaveKey>
  /** Fire a cross-tier access event (sink stays collection-resident). */
  emitCrossTierEvent(event: CrossTierAccessEvent): void
}

export function assertTiersEnabled<T>(ctx: TiersContext<T>): void {
  if (!ctx.tiers) {
    throw new Error(
      `Collection "${ctx.name}": hierarchical tiers are not enabled. ` +
      `Pass { tiers: [0, 1, 2, …] } to vault.collection() to opt in.`,
    )
  }
}

export function assertDeclaredTier<T>(ctx: TiersContext<T>, tier: number): void {
  if (tier < 0 || !Number.isInteger(tier)) {
    throw new Error(`Collection "${ctx.name}": tier must be a non-negative integer, got ${tier}`)
  }
  if (tier === 0) return
  if (!ctx.tiers || !ctx.tiers.has(tier)) {
    throw new Error(
      `Collection "${ctx.name}": tier ${tier} is not declared in { tiers: [...] }`,
    )
  }
}

function isElevatorOrOwner<T>(ctx: TiersContext<T>): boolean {
  return ctx.keyring.role === 'owner' || ctx.keyring.role === 'admin'
}

/**
 * tier-aware put. Encrypts the record with the collection's tier-N DEK and
 * stamps `_tier: N` on the envelope. The caller's keyring must hold the tier-N
 * DEK (directly, by delegation, or by virtue of being the grantor); otherwise
 * throws `TierNotGrantedError`.
 *
 * accepts an optional `elevation` context. When present, the emitted cross-tier
 * event is stamped with `authorization: 'elevation'`, the elevation's reason,
 * and the caller's pre-elevation tier. `vault.elevate(...).collection().put`
 * threads this through; direct `putAtTier` calls leave it undefined and fall
 * back to the inherent-write event shape.
 */
export async function putAtTier<T>(
  ctx: TiersContext<T>,
  id: string,
  record: T,
  tier: number,
  opts?: { elevation?: { reason: string; fromTier: number }; source?: string; sourceTs?: string },
): Promise<void> {
  assertTiersEnabled(ctx)
  assertDeclaredTier(ctx, tier)
  assertTierAccess(ctx.keyring, ctx.name, tier)

  const key = dekKey(ctx.name, tier)
  const dek = await ctx.getDEK(key)

  const existing = await ctx.adapter.get(ctx.vault, ctx.name, id)
  const version = existing ? existing._v + 1 : 1
  const json = JSON.stringify(record)
  const { iv, data } = await encrypt(json, dek)
  const envelope: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: version,
    _ts: new Date().toISOString(),
    _iv: iv,
    _data: data,
    _by: ctx.keyring.userId,
    ...(tier > 0 && { _tier: tier }),
    ...(ctx.provenance && opts?.source !== undefined ? { _source: opts.source, _sourceTs: opts.sourceTs ?? new Date().toISOString() } : {}),
  }

  await ctx.adapter.put(ctx.vault, ctx.name, id, envelope)

  if (tier > 0) {
    ctx.emitCrossTierEvent({
      actor: ctx.keyring.userId,
      collection: ctx.name,
      id,
      tier,
      authorization: opts?.elevation ? 'elevation' : 'inherent',
      op: 'put',
      ts: envelope._ts,
      ...(opts?.elevation && {
        reason: opts.elevation.reason,
        elevatedFrom: opts.elevation.fromTier,
      }),
    })
  }
}

/**
 * tier-aware get. When the stored record is at a tier the caller cannot
 * decrypt:
 *   - `'invisibility'` mode (default) → returns `null`.
 *   - `'ghost'` mode → returns a `GhostRecord` placeholder with the tier and
 *     the record id (the record exists but contents are withheld).
 *
 * Fully-cleared reads return the plaintext record and fire a cross-tier event
 * when `_tier > 0`.
 */
export async function getAtTier<T>(ctx: TiersContext<T>, id: string): Promise<T | GhostRecord | null> {
  assertTiersEnabled(ctx)
  const envelope = await ctx.adapter.get(ctx.vault, ctx.name, id)
  if (!envelope) return null
  const tier = envelope._tier ?? 0
  if (tier === 0) {
    return ctx.codec.decryptRecord(envelope, { id })
  }

  const key = dekKey(ctx.name, tier)
  if (!ctx.keyring.deks.has(key)) {
    if (ctx.tierMode === 'ghost') {
      return { _ghost: true, _tier: tier } as GhostRecord
    }
    return null
  }

  const dek = await ctx.getDEK(key)
  // A tiered record may carry a per-record CEK (e.g. a CEK record
  // elevated via `elevate()`): the CEK is wrapped under the TIER DEK, so
  // unwrap under the tier DEK then decrypt the body under the CEK. Legacy
  // tiered records decrypt directly under the tier DEK.
  let plaintext: string
  let cek: EnclaveKey | undefined
  if (envelope._cek !== undefined) {
    cek = await unwrapCek(envelope._cek, dek)
    ctx.cekCache?.set(id, cek, 1)
    plaintext = await decrypt(envelope._iv, envelope._data, cek)
  } else {
    plaintext = await decrypt(envelope._iv, envelope._data, dek)
  }
  let record = JSON.parse(plaintext) as T

  // #635: this manual-decrypt leg never went through `decryptRecord`, so it
  // never processed `_sealed` slots — an elevated classified record read
  // back through here would return the body WITHOUT its sealed fields
  // (silent omission). `applySealedSlots` is the same post-processing
  // `decryptRecord`'s tier-0 branch above gets for free, extracted so it can
  // take OUR already-unwrapped `cek` (unwrapped under the TIER dek above)
  // instead of resolving one itself under the collection DEK the way
  // `decryptRecord`/`resolveEnvelopeCek` would — which would be the wrong
  // key for a `_cek` wrapped under a tier DEK. `sealedAsHandles` is omitted
  // (default false) to match this function's OWN tier-0 branch above
  // (`ctx.codec.decryptRecord(envelope, { id })`, no `sealedAsHandles`) —
  // both tiers return sealed fields inline-decrypted, not as handles.
  if (envelope._sealed !== undefined) {
    record = await ctx.codec.applySealedSlots(record, envelope._sealed, cek, { id })
  }

  ctx.emitCrossTierEvent({
    actor: ctx.keyring.userId,
    collection: ctx.name,
    id,
    tier,
    authorization: isElevatorOrOwner(ctx) ? 'inherent' : 'delegation',
    op: 'get',
    ts: new Date().toISOString(),
  })

  return record
}

/**
 * list ids grouped by the caller's readability. Returns only ids whose tier the
 * caller can read. Above-tier ids are omitted in `'invisibility'` mode and
 * included (with tier metadata) in `'ghost'` mode.
 */
export async function listAtTier<T>(ctx: TiersContext<T>): Promise<Array<{ id: string; tier: number; readable: boolean }>> {
  assertTiersEnabled(ctx)
  const ids = await ctx.adapter.list(ctx.vault, ctx.name)
  const out: Array<{ id: string; tier: number; readable: boolean }> = []
  for (const id of ids) {
    const env = await ctx.adapter.get(ctx.vault, ctx.name, id)
    if (!env) continue
    const tier = env._tier ?? 0
    const readable = tier === 0 || ctx.keyring.deks.has(dekKey(ctx.name, tier))
    if (!readable && ctx.tierMode === 'invisibility') continue
    out.push({ id, tier, readable })
  }
  return out
}

/**
 * elevate a record to a higher tier. Re-encrypts with the target tier's DEK.
 * The caller must hold DEKs for both the current tier (to decrypt) and the
 * target tier (to re-encrypt). Stamps `_elevatedBy` with the caller id so
 * `demote()` can check the reverse operation.
 */
export async function elevate<T>(ctx: TiersContext<T>, id: string, toTier: number): Promise<void> {
  assertTiersEnabled(ctx)
  assertDeclaredTier(ctx, toTier)
  assertTierAccess(ctx.keyring, ctx.name, toTier)

  const envelope = await ctx.adapter.get(ctx.vault, ctx.name, id)
  if (!envelope || isDeleteMarker(envelope) || isTombstoneShape(envelope)) {
    throw new Error(`Record "${id}" not found in collection "${ctx.name}"`)
  }
  const fromTier = envelope._tier ?? 0
  if (toTier === fromTier) return
  if (toTier < fromTier) {
    throw new Error(`Use demote() to lower the tier of "${id}" from ${fromTier} to ${toTier}`)
  }
  // Caller must have access at the existing tier to decrypt.
  if (fromTier > 0) assertTierAccess(ctx.keyring, ctx.name, fromTier)

  const fromKey = dekKey(ctx.name, fromTier)
  const toKey = dekKey(ctx.name, toTier)
  const fromDek = await ctx.getDEK(fromKey)
  const toDek = await ctx.getDEK(toKey)

  // Per-record CEK composes with tiers: the body key is unchanged (history
  // chain identity preserved); only the wrapping key moves with the tier.
  // Legacy (no `_cek`) records take the direct-DEK path unchanged.
  const now = new Date().toISOString()
  const body = await rewrapBodyToDek(envelope, fromDek, toDek)
  if (body.cek) ctx.cekCache?.set(id, body.cek, 1)
  ctx.syncCache(id, null)
  // #662: spread every slot the source carries (_sealed/_det/_vdig/_bidx/
  // _source/_sourceTs/_debug) through UNCHANGED, then override only
  // the fields a tier move manages. rewrapBodyToDek preserves the CEK, so no
  // passenger slot is re-keyed by the move. The old field-literal dropped every
  // unlisted slot.
  const next: EncryptedEnvelope = {
    ...envelope,
    _noydb: NOYDB_FORMAT_VERSION,
    _v: envelope._v + 1,
    _ts: now,
    _iv: body._iv,
    _data: body._data,
    _by: ctx.keyring.userId,
    _tier: toTier,
    _elevatedBy: ctx.keyring.userId,
    ...(body._cek !== undefined ? { _cek: body._cek } : {}),
  }
  await ctx.adapter.put(ctx.vault, ctx.name, id, next)

  ctx.emitCrossTierEvent({
    actor: ctx.keyring.userId,
    collection: ctx.name,
    id,
    tier: toTier,
    authorization: 'elevation',
    op: 'elevate',
    ts: now,
  })
}

/**
 * demote a record to a lower tier. Allowed only for the user who performed the
 * last elevation or an owner.
 */
export async function demote<T>(ctx: TiersContext<T>, id: string, toTier: number): Promise<void> {
  assertTiersEnabled(ctx)
  if (toTier < 0) throw new Error(`Cannot demote to negative tier ${toTier}`)

  const envelope = await ctx.adapter.get(ctx.vault, ctx.name, id)
  if (!envelope || isDeleteMarker(envelope) || isTombstoneShape(envelope)) {
    throw new Error(`Record "${id}" not found in collection "${ctx.name}"`)
  }
  const fromTier = envelope._tier ?? 0
  if (toTier === fromTier) return
  if (toTier > fromTier) {
    throw new Error(`Use elevate() to raise the tier of "${id}" from ${fromTier} to ${toTier}`)
  }
  const isOwner = ctx.keyring.role === 'owner'
  const isOriginalElevator = envelope._elevatedBy === ctx.keyring.userId
  if (!isOwner && !isOriginalElevator) {
    throw new TierDemoteDeniedError(id, fromTier)
  }
  // Caller must still hold the DEK of the current tier to decrypt.
  assertTierAccess(ctx.keyring, ctx.name, fromTier)
  if (toTier > 0) assertDeclaredTier(ctx, toTier)

  const fromDek = await ctx.getDEK(dekKey(ctx.name, fromTier))
  const toDek = await ctx.getDEK(dekKey(ctx.name, toTier))

  // CEK re-wrap on demote — same body key, moved from the source tier
  // DEK to the target tier DEK. Legacy records take the direct-DEK path.
  const now = new Date().toISOString()
  const body = await rewrapBodyToDek(envelope, fromDek, toDek)
  if (body.cek) ctx.cekCache?.set(id, body.cek, 1)
  // #662: same passenger carry-through as elevate(). demote additionally CLEARS
  // `_elevatedBy` (the demote right is consumed) and OMITS `_tier` at tier 0, so
  // both are destructured out of the spread rather than carried.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- excluded from ...carried
  const { _elevatedBy, _tier: _priorTier, ...carried } = envelope
  const next: EncryptedEnvelope = {
    ...carried,
    _noydb: NOYDB_FORMAT_VERSION,
    _v: envelope._v + 1,
    _ts: now,
    _iv: body._iv,
    _data: body._data,
    _by: ctx.keyring.userId,
    ...(toTier > 0 ? { _tier: toTier } : {}),
    ...(body._cek !== undefined ? { _cek: body._cek } : {}),
  }
  await ctx.adapter.put(ctx.vault, ctx.name, id, next)

  // #691: landing back at tier 0 makes this a plain tier-0 record again — it
  // must stay plain-get()-readable in the same session, so re-seed the
  // eager cache from the just-written (now tier-0-keyed) envelope through
  // the canonical codec path, the same decode collection.ts's own eager
  // hydration / lazy cache-miss paths use. A demote that lands on an
  // intermediate elevated tier (toTier > 0) still evicts: the record stays
  // above tier 0 and must remain invisible on tier-0 surfaces.
  if (toTier === 0) {
    const rec = await ctx.codec.decryptRecord(next, { id, sealedAsHandles: true })
    ctx.syncCache(id, rec !== null ? { record: rec, version: next._v } : null)
  } else {
    ctx.syncCache(id, null)
  }

  ctx.emitCrossTierEvent({
    actor: ctx.keyring.userId,
    collection: ctx.name,
    id,
    tier: fromTier,
    authorization: 'elevation',
    op: 'demote',
    ts: now,
  })
}

/**
 * Classify a live envelope's `_sealed` slots for crypto-shred completeness
 * (#M-1). Thin delegate to {@link RecordCodec.classifySealedShred}; surfaced
 * here because `vault.ts` forget() reaches in via `collection._classifySealedShred`.
 */
export function classifySealedShred<T>(
  ctx: TiersContext<T>,
  live: EncryptedEnvelope,
): Promise<{ readonly slots: readonly SealedShredSlot[] }> {
  return ctx.codec.classifySealedShred(live)
}
