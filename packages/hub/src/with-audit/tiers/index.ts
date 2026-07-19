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
import { encrypt, decrypt, unwrapCek, rewrapBodyToDek, applyRewrappedBody, isDeleteMarker, isTombstoneShape, type RecordCodec, type EnclaveKey, type SealedShredSlot } from '../../kernel/enclave/index.js'
import { TierDemoteDeniedError, UnsupportedTierCompositionError, PersistedIndexCompensationError } from '../../kernel/errors.js'
import { dekKey, assertTierAccess } from '../../with-party/team/tiers.js'
import type { UnlockedKeyring } from '../../with-party/team/keyring.js'
import type { Lru } from '../../kernel/cache/index.js'
import type { BlobFieldsConfig } from '../../with-shape/blobs/blob-compaction.js'
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
   * envelope (#691). The lazy LRU is evicted on EVERY call — it is never
   * re-seeded, since a lazy `#getRaw` miss refetches and decodes the fresh
   * envelope via its adapter fallback (a stale LRU entry after a tier-0
   * `putAtTier` overwrite was the #702 lazy-mode gap). `null` → also evict
   * the eager cache entry; an `entry` → set the eager cache to the given
   * decoded record/version (used by `demote()` landing back at tier 0 and
   * `putAtTier`'s tier-0 write, #702 — the record is tier-0, so it must stay
   * plain-`get()`-readable in-session).
   */
  syncCache(id: string, entry: { record: T; version: number } | null): void
  /**
   * Sync the collection's indexes after a tier move rewraps the envelope
   * (#709). Persisted `_idx/<field>/<recordId>` side-cars hold the indexed
   * field's PLAINTEXT value and are always encrypted under the tier-0 DEK,
   * whatever the record's own tier — the same leak class `forget()` fixed
   * via `purgePersistedIndexes` ("forget() crypto-shreds the body but keeps
   * the collection DEK, under which these side-cars are encrypted — so
   * without this they leave the indexed field VALUES readable"). `null` →
   * the record just left tier 0: purge its persisted side-cars and drop its
   * in-memory index entries. A record → it is tier-0 again: (re)build its
   * entries from that record. Call this BEFORE {@link syncCache} — the
   * implementation reads the pre-write cached value as "previous" to clean
   * up stale index buckets, so it must run while that entry is still live.
   * `version` stamps a rebuilt side-car's own envelope version — every
   * caller has one in scope (the envelope it just wrote), including the
   * purge (`null`) branches, which pass it along even though it's ignored
   * there (#720: keeps the parameter honestly required, no dead default).
   * `priorEnvelope` (#720) — the RAW envelope read BEFORE this call's own
   * overwrite (already in scope as `existing`/`envelope` at every record-
   * branch call site), so a lazy same-tier value change (a `putAtTier(0)`
   * dropping an indexed field, a `demote(0)` off an elevated record) can
   * still be tier-gate-decoded as "previous" once the live envelope itself
   * has already moved past it. The `null`-record branches never pass one —
   * see the implementation's doc comment for why they don't need to.
   */
  syncIndexes(id: string, record: T | null, version: number, priorEnvelope?: EncryptedEnvelope): Promise<void>
  /** Sync the collection's SEARCH artifacts after a tier move (#721). Both the
   *  lexical `_ftindex` blob and the `_vec/<id>` embedding are encrypted under
   *  the tier-0 DEK and hold the record's derived plaintext (full field text /
   *  a text-invertible vector), so leaving them means elevation never hid what
   *  the record was searchable by — the `forget()` precedent, unapplied to
   *  elevate. `null` → the record left tier 0: purge its `_vec`, and
   *  invalidate the `_ftindex` blob (the cache-driven rebuild then excludes
   *  it). A record → it is tier-0 again: re-embed it, and invalidate
   *  `_ftindex` (rebuild includes it). No-op fast when the collection has no
   *  search. */
  syncSearch(id: string, record: T | null, version?: number): Promise<void>
  /**
   * Sync a record's `_history` snapshots after a tier move rewraps the live
   * envelope (#712, at-rest hardening). Each snapshot carries its own key
   * material (a direct DEK wrap, or a per-record `_cek` itself wrapped under
   * the tier DEK) — `elevate()`'s live-body rewrap moves only the live
   * envelope, leaving prior versions decryptable at rest under the tier the
   * record has moved away from (the same leak class `forget()`'s
   * `tombstoneHistory` closed for erasure). `fromDek`/`toDek` are the SAME
   * DEKs the caller already resolved for the live rewrap — reuse them, don't
   * recompute. No-op when the strategy is `NO_HISTORY`.
   */
  syncHistory(id: string, fromDek: EnclaveKey, toDek: EnclaveKey): Promise<void>
  /**
   * Save a raw pre-move envelope as a `_history` snapshot (#728). Tier moves
   * (`putAtTier`/`elevate`/`demote`) bump `_v` and overwrite the live
   * envelope without ever snapshotting the version that existed just before
   * the move — so `history()` silently lost it. The caller (`tiers/index.ts`)
   * builds `envelope` by reusing the SAME `rewrapBodyToDek(envelope, fromDek,
   * toDek)` result it already computed for the live write, so the snapshot
   * lands wrapped under the DESTINATION tier's DEK — never `ctx.codec.
   * encryptRecord`, which always resolves the tier-0 DEK and would leak the
   * pre-move body whenever `fromTier > 0`. No-op when history is disabled
   * (folds the `historyConfig.enabled` gate so `tiers/index.ts` stays simple).
   */
  saveHistorySnapshot(id: string, envelope: EncryptedEnvelope): Promise<void>
  /**
   * `true` iff a real history strategy is wired (not `NO_HISTORY`) AND not
   * explicitly disabled via `historyConfig.enabled`. `putAtTier` checks this
   * BEFORE decrypting `existing` to build a snapshot (#728, #737 regression
   * fix) — unlike elevate/demote, which reuse a `body` rewrap their live
   * write needs unconditionally, putAtTier's live write never decrypts the
   * prior envelope, so building a snapshot is the ONLY reason it would
   * touch (and potentially throw decrypting) `existing`'s ciphertext. A
   * derivation-free, history-disabled collection must not pay that decode —
   * or risk it, on a corrupted/inaccessible prior body — same law
   * `hasDerivedOutputs` already enforces for the derived-outputs decode.
   */
  readonly historyEnabled: boolean
  /**
   * Rehome a record's blob attachments after a tier move (#724 Arc 10 Task
   * 2, at-rest hardening). A blob's home tier is its owning record's tier —
   * the `_blob` DEK is tier-scoped (`dekKey('_blob', tier)`), so a solo-
   * owned blob's content CEK must move with the record or it stays
   * tier-0-unwrappable at rest even once the live body has moved (the same
   * leak class `syncHistory` closes for `_history` snapshots). Delegates to
   * `BlobSet.rehomeForTier`; no-op fast when the collection has no blob
   * fields. Order-independent with the other sync hooks — touches only
   * blob side structures, not this collection's own cache/indexes.
   */
  syncBlobs(id: string, fromTier: number, toTier: number): Promise<void>
  /**
   * Purge a record's tier-0-era plaintext ledger deltas after a tier move
   * lands it above tier 0 (#729). The audit ledger is a flat, vault-wide,
   * hash-chained log — a record's reverse-JSON-Patch deltas in
   * `_ledger_deltas` are encrypted under one collection-wide `_ledger` DEK
   * (not the record's own tier DEK), so `elevate()`/`putAtTier()`'s live-body
   * rewrap never moves them: they stay readable at rest to any tier-0
   * caller, the same leak class `syncHistory` closed for `_history`
   * snapshots. Chain-safe: `verify()` reads only `_ledger` entry fields
   * (including `deltaHash`, which lives on the entry, not the deleted delta
   * row), never `_ledger_deltas`, so a purge cannot break it.
   * **Irreversible** — the deleted plaintext cannot be restored by
   * `demote()`. **Metadata-retained** — the `_ledger` entries (that the
   * record was mutated, at which version/timestamp/actor) are untouched;
   * only the delta *content* is purged. No-op when the collection has no
   * ledger (`withHistory()` not enabled).
   */
  syncLedger(id: string): Promise<void>
  /**
   * Sync a record's derived outputs (materialized-view rows, rollup
   * contributions, `withDerivation` outputs) after a tier move (#722).
   * Those outputs are computed from this record and written to OTHER
   * (output) collections via a plain `put` at tier 0 — `elevate()`'s live-
   * body rewrap moves only the source envelope, so the output rows keep
   * holding the source's tier-0-era plaintext, the same leak class
   * `syncSearch`/`syncIndexes` closed for THIS collection's own artifacts.
   * `elevated` (landing tier > 0) reuses the SAME onDelete fanout
   * `forgetDerivedFanout` drives for `forget()` (`kernel/via/dispatch.ts`)
   * — minus its `'ref'` cascade edge (elevate/demote never erase a
   * *different* record) — to recompute this record's derived outputs as
   * REMOVED. Recompute is tier-safe: the fanout's own source scan reads
   * the elevated-excluding cache (#701/#709/#712), so it naturally omits
   * the now-elevated record instead of re-embedding its plaintext. Landing
   * back at tier 0 (`elevated === false`) is the reverse (Task 2, #722):
   * `syncDerivedOutputs` instead runs the ordinary local-write add-
   * dispatchers (`dispatchDerivations`/`dispatchMaterializedViews`, the
   * same ones a plain `put()` fires) to restore the contribution —
   * reversible, since the source's plaintext survives the elevate/demote
   * rewrap round-trip. `record` is the decoded source record (PRE-move on
   * the remove side, POST-move on the add side); only the rollup edge
   * consumes it on remove, both add-dispatchers require it on add; `null`
   * (tombstone/delete-marker) skips both. `version` stamps the add-
   * dispatchers' `_derivedFrom.sourceVersion` metadata — reuses the version
   * the tier op already has, no re-read; unused on the remove side. No-op
   * fast when the collection has no MV/derivation source — each dispatcher
   * below checks its own source before doing any work.
   */
  syncDerived(id: string, record: T | null, elevated: boolean, version?: number): Promise<void>
  /**
   * `true` iff the collection has a materialized-view or derivation source
   * attached. Gates the {@link syncDerived} pre-move decode on the remove
   * direction (`elevate()`, `putAtTier(tier>0)`, `demote()`'s intermediate-
   * tier branch): those sites decode the record SOLELY to feed
   * `syncDerived(..., true)`, whose dispatchers no-op immediately when the
   * collection has no MV/derivation source — so a no-derivation collection
   * would otherwise pay a full record-body decrypt on every tier move for
   * nothing (#722 perf regression). `false` short-circuits the decode to
   * `null`, which `syncDerivedOutputs` already treats safely.
   */
  readonly hasDerivedOutputs: boolean
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
  /**
   * Register this record's ref in the encrypted `_subject_index` (#766).
   * `putAtTier`'s raw `ctx.adapter.put` bypasses `Collection.put()`'s write-
   * hook pipeline — the `onAfterWrite` hook that normally does this — so a
   * record whose FIRST persistence is `putAtTier` (sensitive from birth, a
   * documented legitimate use) would otherwise never enter the index and
   * stay unreachable by `vault.forget()`. Idempotent (safe on every call,
   * including a repeat write of an already-registered record) and a no-op
   * when the collection declares no forget-subject field.
   */
  addSubjectRef(id: string, record: T): Promise<void>
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

/**
 * Tier-composition guard (#724 / Arc 7 of the tier-invisibility campaign).
 *
 * Refuses `tiers` declared together with a derived-artifact feature whose
 * crypto has not yet been made tier-aware — i.e. a feature `elevate()` /
 * `demote()` does not re-key when a record moves tiers, so an elevated
 * record's data for that feature would stay readable at tier 0.
 *
 * **Status:** the original call site (`Collection` constructor, beside
 * `buildUniqueConstraintSet`) was removed by Arc 10 Task 1 (#724) — the
 * `tiers + blobFields` refusal below was superseded by a runtime read gate
 * on `collection.blob(id)` (`with-shape/blobs/blob-set.ts`), so this
 * function currently has no caller. Relocated here from
 * `with-lookup/indexing/unique-constraints.ts` (#733) so the tier-domain
 * guard lives in the tier domain, rather than an indexing file it only
 * borrowed for a grandfathered import specifier.
 *
 * ## #724 verified: `tiers + blobFields` leaks
 *
 * `collection.blob(id)` (`Collection.blob()`) never checks the live
 * record's tier before returning a `BlobSet` handle, and `BlobSet`'s crypto
 * is entirely orthogonal to the tier ladder:
 *  - the slot map (`_blob_slots_{collection}/{id}`) is encrypted under the
 *    collection's TIER-0 DEK (`getDEK(name)` ≡ `dekKey(name, 0)` — see
 *    `dekKey` in `with-party/team/tiers.ts`), never a tier-N DEK;
 *  - chunk content (`_blob_index` / `_blob_chunks`) is encrypted under the
 *    vault-shared `_blob` DEK (`BLOB_COLLECTION`), which has no tier
 *    dimension at all.
 * `elevate()`/`demote()` (this file) rewrap only the live record body,
 * `_history` snapshots (#712), and index side-cars — blob slots and chunks
 * are untouched. A caller whose keyring never held the record's elevated
 * tier DEK can still open `collection.blob(id).get(slot)` and read full
 * plaintext, even though `collection.get(id)` correctly reports the same
 * record as invisible. See `__tests__/tier-composition-guard.test.ts` for
 * the reproduction.
 *
 * ## Safe today — no check needed here
 *
 * Field indexes, search (`textIndexes`/`embeddings`), `withHistory`
 * (snapshot keys are rewrapped by `elevate()`/`demote()`, #712), and the
 * decoded-record cache (evicted on tier moves) are already tier-safe. They
 * are not enumerated below; only known-unsafe features are refused, so any
 * combination not named here passes silently by default.
 *
 * ## Deliberately NOT handled here
 *
 * - `ledger` — `withHistory` threads a ledger writer onto every tiered
 *   collection by default in shipped usage; refusing `tiers + ledger` would
 *   break that default. A ledger-specific tier-rekey handler (rewrap ledger
 *   entries, or scope ledger visibility to tier) is a separate arc.
 * - materialized-view (MV) output — an MV's fanout spec lives on the
 *   SOURCE collection, not on the MV collection's own config, so it is not
 *   visible at `vault.collection()` registration time and this guard cannot
 *   detect it structurally.
 */
export function assertTierComposition(
  collectionName: string,
  cfg: { readonly tiers: boolean; readonly blobFields: BlobFieldsConfig | undefined },
): void {
  if (!cfg.tiers) return
  if (cfg.blobFields !== undefined && Object.keys(cfg.blobFields).length > 0) {
    throw new UnsupportedTierCompositionError(
      'blobs',
      `Collection "${collectionName}": blobFields are not supported together with tiers (#724) — ` +
        `blob chunk content is encrypted under a vault-shared DEK that elevate()/demote() do not ` +
        `re-key, so an elevated record's blob attachments would remain readable at tier 0. Use a ` +
        `non-tiered collection for blob-bearing records until a blob tier-rekey handler ships.`,
    )
  }
}

function isElevatorOrOwner<T>(ctx: TiersContext<T>): boolean {
  return ctx.keyring.role === 'owner' || ctx.keyring.role === 'admin'
}

/**
 * Structural surface {@link syncDerivedOutputs} needs from the owning
 * collection — the SAME onDelete dispatchers `forgetDerivedFanout` already
 * drives (`kernel/via/dispatch.ts`), reused as-is (#722). Narrower than
 * `Collection<T>` (avoids an import cycle: collection.ts constructs
 * `TiersContext` FROM `this`, which already satisfies this shape
 * structurally — no cast needed at the `tiersContext()` call site).
 */
export interface DerivedOutputsHost<T> {
  dispatchMaterializedViewsOnDelete(id: string): Promise<{ deleted: number; residue: string[] }>
  dispatchArrayDerivationsOnDelete(id: string, eraseRecordShapeToo?: boolean): Promise<number>
  dispatchRollupsOnDelete(id: string, deleted: T): Promise<unknown>
  /** Task 2 (#722) add-direction: the same local-write dispatchers an ordinary `put()` fires. */
  dispatchMaterializedViews(id: string, record: T): Promise<void>
  dispatchDerivations(id: string, record: T, version: number): Promise<void>
}

/**
 * The {@link TiersContext.syncDerived} implementation collection.ts's
 * `tiersContext()` binds `this` into (#722). See that field's doc comment
 * for the design; `host` is `this` — every dispatcher below is a public
 * Collection method, already self-guarding (no-op) when the collection has
 * no materialized-view/derivation source, so no separate fast-path check is
 * needed here.
 */
export async function syncDerivedOutputs<T>(
  host: DerivedOutputsHost<T>,
  id: string,
  record: T | null,
  elevated: boolean,
  version?: number,
): Promise<void> {
  if (elevated) {
    await host.dispatchMaterializedViewsOnDelete(id)
    await host.dispatchArrayDerivationsOnDelete(id, true)
    if (record !== null) await host.dispatchRollupsOnDelete(id, record)
    return
  }
  // Task 2 (#722) recompute-as-add: the record rejoined tier 0 (demote(→0) /
  // putAtTier(0)) — restore its contribution via the SAME local-write
  // dispatchers an ordinary `put()` fires (`collection.ts`'s
  // `_onRecordMutated('local-write')`), same order. `record === null` only
  // when a caller demotes a tombstone/delete-marker to 0 — nothing to add.
  if (record === null) return
  await host.dispatchDerivations(id, record, version ?? 0)
  await host.dispatchMaterializedViews(id, record)
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
): Promise<TierMoveResult> {
  assertTiersEnabled(ctx)
  assertDeclaredTier(ctx, tier)
  assertTierAccess(ctx.keyring, ctx.name, tier)

  const key = dekKey(ctx.name, tier)
  const dek = await ctx.getDEK(key)

  const existing = await ctx.adapter.get(ctx.vault, ctx.name, id)
  // #712/whole-branch-fix-1: putAtTier moves the record OFF its existing
  // tier, same as elevate/demote — so the caller must also be cleared for
  // that existing tier, not just the target. Without this, a member holding
  // only the target tier's DEK could putAtTier over a record parked at a
  // tier they've never been granted; the from-tier `getDEK` below would then
  // silently MINT a fresh DEK for that tier into their keyring (a
  // non-cleared caller creating tier key material inside the trust
  // boundary — see `assertTierAccess`'s doc comment). Gate here, BEFORE any
  // from-tier getDEK/syncHistory call, so the mint never happens; owner/
  // admin/custodian still bypass (they may mint, same as elevate/demote).
  assertTierAccess(ctx.keyring, ctx.name, existing?._tier ?? 0)
  const version = existing ? existing._v + 1 : 1

  // #728 review-fix-2: resolve the from-tier DEK and snapshot the PRE-move
  // version BEFORE the live write below, mirroring elevate()/demote() —
  // originally this ran much later (after syncIndexes/syncLedger/syncDerived/
  // syncSearchResilient), so a throw in any of those left the live record
  // already moved with `existing` — its sole pre-move copy — gone, silently
  // losing the version #728 exists to preserve. `fromKey`/`fromDek` are
  // resolved ONCE here and reused below for the trailing syncHistory rewrap.
  const fromKey = dekKey(ctx.name, existing?._tier ?? 0)
  const fromDek = await ctx.getDEK(fromKey)
  if (existing && ctx.historyEnabled) {
    // Snapshot the version this write is about to overwrite — same law as
    // Collection.put()'s history save, extended to putAtTier (#728). Rewrap
    // under the DESTINATION `dek` via `applyRewrappedBody` (never
    // `ctx.codec.encryptRecord`, which always resolves the tier-0 DEK and
    // would leak this body at rest whenever the prior tier was > 0).
    // Untagged (`_tier`/`_elevatedBy` stripped), same as elevate()/
    // demote()'s snapshots. `_v` stays the PRE-move version (unbumped), as
    // `preCarried` already carries it.
    const body = await rewrapBodyToDek(existing, fromDek, dek)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- excluded from ...preCarried
    const { _tier: _preTier, _elevatedBy: _preElevatedBy, ...preCarried } = existing
    await ctx.saveHistorySnapshot(id, applyRewrappedBody(preCarried, body))
  }

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

  // #766: putAtTier bypasses Collection.put()'s onAfterWrite hook — register
  // the subject ref directly so a sensitive-from-birth first write stays
  // reachable by vault.forget(). No-op when no forget-subject field is declared.
  await ctx.addSubjectRef(id, record)

  // #702/#709: keep the record cache AND indexes coherent with the raw
  // write — same law as elevate/demote (#691): tier > 0 → invisible on
  // tier-0 surfaces (evict + purge); tier 0 → an ordinary write (re-seed +
  // reindex). syncIndexes runs first — it needs the pre-write cache entry
  // as "previous", which syncCache is about to overwrite/evict.
  if (tier > 0) {
    await ctx.syncIndexes(id, null, version)
    ctx.syncCache(id, null)
    // #729: the record lands above tier 0 — purge its tier-0-era plaintext
    // ledger deltas (irreversible; a tier-0 putAtTier(0) has nothing to purge).
    await ctx.syncLedger(id)
    // #722: recompute this record's derived outputs now that it left tier 0
    // — same law as elevate() below. `existing` is the PRE-write envelope;
    // decode it only here (the rollup edge is the only consumer). Gated by
    // `hasDerivedOutputs` — no-derivation collections skip this decrypt
    // entirely (perf regression review finding, Arc 9 #722). Whole-branch
    // review: `existing` may sit at ANY prior tier (including a
    // `putAtTier`-origin tier>0 record with no `_cek` ever minted) — decode
    // it under ITS OWN tier's DEK via `codec.decryptRecordAtDek`, not
    // `ctx.codec.decryptRecord`'s tier-unaware default, which threw
    // `TamperedError` here.
    await ctx.syncDerived(
      id,
      ctx.hasDerivedOutputs && existing
        ? await ctx.codec.decryptRecordAtDek(existing, await ctx.getDEK(dekKey(ctx.name, existing._tier ?? 0)), id)
        : null,
      true,
    )
  } else {
    const rec = await ctx.codec.decryptRecord(envelope, { id, sealedAsHandles: true })
    await ctx.syncIndexes(id, rec, envelope._v, existing ?? undefined)
    ctx.syncCache(id, rec !== null ? { record: rec, version: envelope._v } : null)
    // #722 Task 2: the record is written at tier 0 — restore its
    // contribution to every derived output (reuse the decode above, no
    // double-decrypt).
    await ctx.syncDerived(id, rec, false, envelope._v)
  }
  // #721: search artifacts follow the same tier > 0 → purge / tier 0 →
  // re-embed law as syncIndexes above. No ordering dependency on syncCache —
  // the _ftindex rebuild is deferred to the next retrieve() and _vec re-embed
  // reads `record` directly, not the cache. #774: a permanently stuck
  // compensation must not abort the write — the record put above already
  // landed — so it is caught and surfaced as residue instead, same as
  // elevate()/demote() (#764).
  const searchResidue = await syncSearchResilient(ctx, id, tier > 0 ? null : record, envelope._v)

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

  // #712/whole-branch-fix-2: syncHistory runs LAST — after syncIndexes/
  // syncCache/syncSearch (and the cross-tier emit) have already landed. Its
  // own throw (adapter I/O, the Fix-1 assertion, the rewrap) then strands
  // only the `_history` artifact instead of leaving indexes/cache/search
  // unsynced behind an already-moved live record (would conditionally
  // reopen #709/#721/#723 on the error path). A direct putAtTier also moves
  // the record's tier — its history snapshots (if any exist from an earlier
  // tier-0 put()) must follow, same as elevate/demote. Skip when the record
  // was already at this tier (no move, nothing to rewrap). `fromKey`/
  // `fromDek` were already resolved above (review-fix-2), before the live
  // write, for the pre-move snapshot — reused here rather than recomputed.
  if (fromKey !== key) {
    await ctx.syncHistory(id, fromDek, dek)
    // #724: this putAtTier moved the record's tier — rehome its blobs too.
    await ctx.syncBlobs(id, existing?._tier ?? 0, tier)
  }
  return { searchResidue }
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
 * Result of a completed `elevate()`/`demote()` (#764). The record move
 * (put + indexes/cache/ledger/derived/history/blobs sync) always completes —
 * `searchResidue: true` means only the search-index side (`_vec`/`_ftindex`)
 * was left in a needs-retry state (a stuck `PersistedIndexCompensationError`),
 * mirroring `forget()`'s `indexResidue` posture rather than aborting the move.
 */
export interface TierMoveResult {
  readonly searchResidue: boolean
}

/**
 * Run {@link TiersContext.syncSearch} with #764 resilience: a permanently
 * stuck compensation (`PersistedIndexCompensationError`, thrown by
 * `PersistedIndexStore` when its compensating `remove()` of a stale
 * `_ftindex` blob keeps failing) must not abort `elevate()`/`demote()` — the
 * record's tier-move `put` has already landed, and aborting here would leave
 * `syncLedger`/`syncDerived`/`syncHistory`/`syncBlobs` unsynced behind it (the
 * partial-completion hazard #764 names). Same posture `forget()` takes for
 * `_purgeSearchIndex` (`vault.ts`'s `indexResidue`) — everything else (a
 * genuinely unexpected search-hook error) still aborts, undisturbed.
 */
async function syncSearchResilient<T>(ctx: TiersContext<T>, id: string, record: T | null, version?: number): Promise<boolean> {
  try {
    await ctx.syncSearch(id, record, version)
    return false
  } catch (e) {
    if (e instanceof PersistedIndexCompensationError) return true
    throw e
  }
}

/**
 * elevate a record to a higher tier. Re-encrypts with the target tier's DEK.
 * The caller must hold DEKs for both the current tier (to decrypt) and the
 * target tier (to re-encrypt). Stamps `_elevatedBy` with the caller id so
 * `demote()` can check the reverse operation.
 */
export async function elevate<T>(ctx: TiersContext<T>, id: string, toTier: number): Promise<TierMoveResult> {
  assertTiersEnabled(ctx)
  assertDeclaredTier(ctx, toTier)
  assertTierAccess(ctx.keyring, ctx.name, toTier)

  const envelope = await ctx.adapter.get(ctx.vault, ctx.name, id)
  if (!envelope || isDeleteMarker(envelope) || isTombstoneShape(envelope)) {
    throw new Error(`Record "${id}" not found in collection "${ctx.name}"`)
  }
  const fromTier = envelope._tier ?? 0
  if (toTier === fromTier) return { searchResidue: false }
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
  // #728: snapshot the PRE-move version into `_history` before it's
  // overwritten below — reuses `body` (already fromDek→toDek) via
  // `applyRewrappedBody` (never `ctx.codec.encryptRecord`, which always
  // resolves the tier-0 DEK and would leak this body at rest whenever
  // `fromTier > 0`). Untagged (`_tier`/`_elevatedBy` stripped) so the
  // history read-gate doesn't hide it PERMANENTLY once the record demotes
  // back — at-rest protection comes from the ciphertext being under
  // `toDek`, not from the tag. `_v` stays the PRE-move version (unbumped),
  // exactly as `envelope` already carries it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- excluded from ...snapshot
  const { _tier: _preTier, _elevatedBy: _preElevatedBy, ...snapshot } = applyRewrappedBody(envelope, body)
  await ctx.saveHistorySnapshot(id, snapshot)
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
  // Evict/purge only once the write landed — a throwing put must not blind
  // the eager cache or leave a readable index behind for a still-valid
  // tier-0 record (same ordering as demote). #709: syncIndexes runs first —
  // it needs the pre-elevation cache entry as "previous" to clean the
  // eager index bucket; the persisted side-car purge is content-free.
  await ctx.syncIndexes(id, null, next._v)
  ctx.syncCache(id, null)
  // #721: same purge law as syncIndexes above — the record left tier 0, so
  // its _vec sidecar is purged and _ftindex is invalidated. #764: a
  // permanently stuck compensation must not abort the move — the record put
  // above already landed — so it is caught and surfaced as residue instead.
  const searchResidue = await syncSearchResilient(ctx, id, null)
  // #729: elevate always lands the record at tier > 0 — purge its
  // tier-0-era plaintext ledger deltas (irreversible; entry metadata stays).
  await ctx.syncLedger(id)
  // #722: recompute this record's derived outputs now that it left tier 0 —
  // same law as putAtTier(tier>0) above. `envelope` is the PRE-move envelope
  // (captured before the rewrap), decoded only here (the rollup edge is the
  // only consumer of the record content). Gated by `hasDerivedOutputs` — no-
  // derivation collections skip this decrypt entirely (perf regression
  // review finding, Arc 9 #722). Whole-branch review: decode under `fromDek`
  // via `codec.decryptRecordAtDek` — `fromTier` may be > 0 here (a prior
  // elevate), and `ctx.codec.decryptRecord`'s tier-unaware CEK resolution
  // threw `TamperedError` whenever this op's own rewrap hadn't just primed
  // the cekCache (non-`perRecordKeys` collections; `_cek`-absent bodies).
  await ctx.syncDerived(id, ctx.hasDerivedOutputs ? await ctx.codec.decryptRecordAtDek(envelope, fromDek, id) : null, true)

  ctx.emitCrossTierEvent({
    actor: ctx.keyring.userId,
    collection: ctx.name,
    id,
    tier: toTier,
    authorization: 'elevation',
    op: 'elevate',
    ts: now,
  })

  // #712/whole-branch-fix-2: syncHistory runs LAST — after syncIndexes/
  // syncCache/syncSearch/the cross-tier emit have already landed, so its own
  // throw (adapter I/O, the rewrap) strands only the `_history` artifact
  // instead of leaving indexes/cache/search unsynced behind an already-moved
  // live record (would conditionally reopen #709/#721/#723 on the error
  // path). Rewraps prior-version history snapshots to the SAME toTier DEK —
  // otherwise they stay decryptable at rest under fromDek forever.
  await ctx.syncHistory(id, fromDek, toDek)
  // #724: rehome any solo-owned blob attachments to the target tier's
  // `_blob` DEK — same at-rest law as syncHistory above.
  await ctx.syncBlobs(id, fromTier, toTier)
  return { searchResidue }
}

/**
 * demote a record to a lower tier. Allowed only for the user who performed the
 * last elevation or an owner.
 */
export async function demote<T>(ctx: TiersContext<T>, id: string, toTier: number): Promise<TierMoveResult> {
  assertTiersEnabled(ctx)
  if (toTier < 0) throw new Error(`Cannot demote to negative tier ${toTier}`)

  const envelope = await ctx.adapter.get(ctx.vault, ctx.name, id)
  if (!envelope || isDeleteMarker(envelope) || isTombstoneShape(envelope)) {
    throw new Error(`Record "${id}" not found in collection "${ctx.name}"`)
  }
  const fromTier = envelope._tier ?? 0
  if (toTier === fromTier) return { searchResidue: false }
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
  // #728: snapshot the PRE-move version into `_history` — reuses `body`
  // (already fromDek→toDek) and `carried` (envelope minus `_tier`/
  // `_elevatedBy`, computed above for the live write) via
  // `applyRewrappedBody`, so a tier-0-landing demote's snapshot is untagged
  // just like an ordinary put() entry, same law as elevate()'s snapshot
  // above. `_v` stays the PRE-move version (unbumped), as `carried` already
  // carries it.
  await ctx.saveHistorySnapshot(id, applyRewrappedBody(carried, body))
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

  // #691/#709: landing back at tier 0 makes this a plain tier-0 record
  // again — it must stay plain-get()-readable AND indexed in the same
  // session, so re-seed the eager cache and rebuild its index entries from
  // the just-written (now tier-0-keyed) envelope through the canonical
  // codec path, the same decode collection.ts's own eager hydration / lazy
  // cache-miss paths use — reused for both, no double-decrypt. A demote
  // that lands on an intermediate elevated tier (toTier > 0) still evicts
  // + purges: the record stays above tier 0 and must remain invisible on
  // tier-0 surfaces, unindexed. syncIndexes runs first in both branches —
  // it needs the pre-demote cache entry as "previous".
  // #764: a permanently stuck search-index compensation must not abort the
  // move — the record put above already landed — so it is caught in both
  // branches and surfaced as residue on the return value instead.
  let searchResidue: boolean
  if (toTier === 0) {
    const rec = await ctx.codec.decryptRecord(next, { id, sealedAsHandles: true })
    await ctx.syncIndexes(id, rec, next._v, envelope)
    ctx.syncCache(id, rec !== null ? { record: rec, version: next._v } : null)
    // #721: reuse the decode above — no double-decrypt. The record is tier-0
    // again, so re-embed its _vec and invalidate _ftindex to include it.
    searchResidue = await syncSearchResilient(ctx, id, rec, next._v)
    // #722 Task 2: the record rejoined tier 0 — restore its contribution to
    // every derived output (reuse the decode above, no double-decrypt).
    await ctx.syncDerived(id, rec, false, next._v)
  } else {
    await ctx.syncIndexes(id, null, next._v)
    ctx.syncCache(id, null)
    // #721: still above tier 0 — purge _vec, invalidate _ftindex.
    searchResidue = await syncSearchResilient(ctx, id, null)
    // #722 Task 2: still elevated (an intermediate tier) — the source's
    // derived outputs stay recompute-as-removed, same law as elevate()
    // above. `envelope` is the PRE-move envelope captured at function
    // entry; decoded only here (the rollup edge is the only consumer).
    // Gated by `hasDerivedOutputs` — no-derivation collections skip this
    // decrypt entirely (perf regression review finding, Arc 9 #722).
    // Whole-branch review: decode under `fromDek` via
    // `codec.decryptRecordAtDek` — this branch's `fromTier` is always > 0 (a
    // demote FROM tier `fromTier` TO an intermediate `toTier` > 0), so
    // `ctx.codec.decryptRecord`'s tier-unaware CEK resolution threw
    // `TamperedError` here exactly as it did in elevate() above
    // (code-identical bug, same fix).
    await ctx.syncDerived(id, ctx.hasDerivedOutputs ? await ctx.codec.decryptRecordAtDek(envelope, fromDek, id) : null, true)
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

  // #712/whole-branch-fix-2: syncHistory runs LAST — after syncIndexes/
  // syncCache/syncSearch/the cross-tier emit have already landed, so its own
  // throw (adapter I/O, the rewrap) strands only the `_history` artifact
  // instead of leaving indexes/cache/search unsynced behind an already-moved
  // live record (would conditionally reopen #709/#721/#723 on the error
  // path). Rewraps history snapshots the same direction as the live body —
  // demote restores tier-0 (or intermediate-tier) readability at rest.
  await ctx.syncHistory(id, fromDek, toDek)
  // #724: rehome any solo-owned blob attachments the same direction as the
  // live body — restores tier-0 (or intermediate-tier) readability at rest.
  await ctx.syncBlobs(id, fromTier, toTier)
  return { searchResidue }
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
