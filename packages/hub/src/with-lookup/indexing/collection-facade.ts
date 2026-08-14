/**
 * Collection-level index maintenance — the eager/unique rebuild-from-cache
 * helpers, the full `rebuildIndexes` / `reconcileIndex` repair surface, and the
 * persisted `_idx/<field>/<recordId>` side-car maintenance fired from the write
 * path.
 *
 * Eager mode keeps an in-memory `CollectionIndexes` + `UniqueConstraintSet`;
 * lazy mode keeps durable encrypted side-cars whose in-memory mirror is a
 * `PersistedCollectionIndex`. These functions write/repair both. The unique-
 * constraint correctness and the side-car drift reconciliation are the parts to
 * watch: behaviour here is byte-identical to the inline code it replaced.
 *
 * Every function takes a small {@link IndexingContext} (the exact `this.*` the
 * moving methods touched) instead of `this`, mirroring the `record-keys/`
 * siblings. The eager `cache` Map and the three index/constraint mirror objects
 * are passed by reference (the SAME instances `Collection` owns, never copied)
 * so maintenance always mutates the live mirrors the query path reads. The
 * `persistedIndexesLoaded` flag and `ensure*` hydration stay collection-resident
 * and are reached via callbacks.
 *
 * Internal service — not exported as a `@noy-db/hub/*` subpath.
 */
import type { NoydbStore, EncryptedEnvelope } from '../../kernel/types.js'
import type { RecordCodec } from '../../kernel/enclave/index.js'
import type { NoydbEventEmitter } from '../../kernel/events.js'
import { IndexWriteFailureError } from '../../kernel/errors.js'
import type { CollectionIndexes } from './eager-indexes.js'
import type { UniqueConstraintSet } from './unique-constraints.js'
import { encodeIdxId, decodeIdxId, type PersistedCollectionIndex, type PersistedIndexDef } from './persisted-indexes.js'

/** Everything the moving index-maintenance methods touched on `this.*`. */
export interface IndexingContext<T> {
  /** Collection name — the canonical record namespace + error context. */
  readonly name: string
  /** Vault namespace the records + side-cars live under. */
  readonly vault: string
  /** The ciphertext store. */
  readonly adapter: NoydbStore
  /** The record codec — decrypts records + side-car bodies, encrypts side-cars. */
  readonly codec: RecordCodec<T>
  /** The eager working-set cache (SHARED `Map` reference, never copied). */
  readonly cache: Map<string, { record: T; version: number }>
  /** True in lazy mode — eager rebuild short-circuits, reconcile requires it. */
  readonly lazy: boolean
  /** Event emitter — surfaces `index:write-partial` on side-car write failure. */
  readonly emitter: NoydbEventEmitter
  /** The in-memory eager index mirror, or null (SHARED reference). */
  readonly indexes: CollectionIndexes | null
  /** The in-memory unique-constraint mirror, or null (SHARED reference). */
  readonly uniqueConstraints: UniqueConstraintSet | null
  /** The lazy-mode persisted-index mirror, or null (SHARED reference). */
  readonly persistedIndexes: PersistedCollectionIndex | null
  /** Hydrate the eager cache before rebuilding from it. */
  ensureHydrated(): Promise<void>
  /** Bulk-load the persisted-index mirror from side-cars (lazy mode). */
  ensurePersistedIndexesLoaded(): Promise<void>
  /** Set the collection-resident `persistedIndexesLoaded` flag. */
  setPersistedIndexesLoaded(value: boolean): void
}

/**
 * Read a field value from a plain record for persisted-index maintenance.
 * Supports dotted paths so declarations like `indexes: ['billing.clientId']`
 * work the same way `readPath` handles them for the eager-mode builder.
 */
function readPersistedValue(record: Record<string, unknown>, field: string): unknown {
  if (!field.includes('.')) return record[field]
  const segments = field.split('.')
  let cursor: unknown = record
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

/**
 * Canonicalize a typed value for storage inside the side-car body so it
 * round-trips through `JSON.parse` without losing fidelity. Dates are
 * serialised as ISO strings; everything else passes through.
 *
 * The in-memory mirror compares on the stringified bucket key, so the
 * exact storage form is not query-critical — this just protects the
 * reconciler, which compares the stored body against the
 * live record value and would otherwise mismatch on Date objects.
 */
function serializeIndexValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  return value
}

/**
 * Extract the indexable value for a declaration — a scalar for
 * single-field, or a tuple array for composite. Returns `null` when
 * the value is not indexable (single-field null/undefined, composite
 * with any null/undefined component — the whole composite is skipped
 * if any part is missing).
 */
function extractIndexValue(
  record: Record<string, unknown>,
  def: PersistedIndexDef,
): unknown {
  if (def.kind === 'single') {
    const v = readPersistedValue(record, def.field)
    return v === undefined || v === null ? null : v
  }
  const tuple: unknown[] = []
  for (const f of def.fields) {
    const v = readPersistedValue(record, f)
    if (v === undefined || v === null) return null
    tuple.push(v)
  }
  return tuple
}

/**
 * Compare the decrypted side-car body's `value` against the live record
 * field value, in the same canonical form used for storage. Handles the
 * Date-is-ISO-string round trip so reconcile doesn't flag a false drift.
 */
function valuesMatch(stored: unknown, live: unknown): boolean {
  const serialized = serializeIndexValue(live)
  if (stored === serialized) return true
  if (stored === undefined || serialized === undefined) return stored === serialized
  // JSON-stringify both sides for structural equality on arrays/objects.
  try {
    return JSON.stringify(stored) === JSON.stringify(serialized)
  } catch {
    return false
  }
}

/**
 * Rebuild the eager in-memory `CollectionIndexes` from the current cache.
 * Called after any bulk hydration; incremental put/delete updates go through
 * `indexes.upsert()`/`.remove()` directly, so this only fires for full reloads.
 */
export function rebuildEagerIndexesFromCache<T>(ctx: IndexingContext<T>): void {
  const eager = ctx.indexes
  if (!eager || eager.fields().length === 0) return
  const snapshot: Array<{ id: string; record: T }> = []
  for (const [id, entry] of ctx.cache) {
    snapshot.push({ id, record: entry.record })
  }
  eager.build(snapshot)
}

/**
 * Rebuild unique-constraint maps from the current in-memory cache.
 * Called after any bulk hydration alongside `rebuildEagerIndexesFromCache`.
 */
export function rebuildUniqueConstraintsFromCache<T>(ctx: IndexingContext<T>): void {
  if (!ctx.uniqueConstraints) return
  ctx.uniqueConstraints.build(
    (function* (cache: Map<string, { record: T }>) {
      for (const [id, entry] of cache) yield [id, entry.record] as const
    })(ctx.cache),
  )
}

/**
 * Rebuild every declared index from scratch — eager refresh from cache, or a
 * full lazy-mode side-car teardown + rewrite. NOT incremental; for per-field
 * drift repair use {@link reconcileIndex}.
 */
export async function rebuildIndexes<T>(ctx: IndexingContext<T>): Promise<void> {
  if (!ctx.lazy) {
    await ctx.ensureHydrated()
    rebuildEagerIndexesFromCache(ctx)
    return
  }

  const persisted = ctx.persistedIndexes
  if (!persisted) return
  const fields = persisted.fields()
  if (fields.length === 0) return

  // 1. Collect canonical ids (skip every reserved-namespace id —
  //    `_idx/`, `_keyring`, `_history/`, `_ledger_deltas/`, `_meta/`,
  //    `_ledger`, `_blob_`, etc. User records may not start with `_`
  //    per the monorepo convention used across the hub).
  const allIds = await ctx.adapter.list(ctx.vault, ctx.name)
  const canonicalIds: string[] = []
  const staleIdxIds: string[] = []
  for (const id of allIds) {
    if (decodeIdxId(id)) {
      staleIdxIds.push(id)
    } else if (!id.startsWith('_')) {
      canonicalIds.push(id)
    }
  }

  // 2. Drop every existing side-car. Errors here are tolerated — the
  //    next step overwrites any remnants. If a side-car is for a
  //    field that is no longer declared, the delete still removes
  //    the stale row from storage.
  for (const id of staleIdxIds) {
    try { await ctx.adapter.delete(ctx.vault, ctx.name, id) } catch { /* ignore */ }
  }
  persisted.clear()

  // 3. Walk records and write fresh side-cars for every declared field.
  for (const recordId of canonicalIds) {
    const envelope = await ctx.adapter.get(ctx.vault, ctx.name, recordId)
    if (!envelope) continue
    // #709: an elevated record must not be (re)indexed — the sidecar stores the
    // PLAINTEXT field value under the tier-0 DEK, so minting one here would
    // publish what elevation is meant to hide. Gate BEFORE the decrypt: a warm
    // cekCache would otherwise let it succeed (and a cold session throw).
    if ((envelope._tier ?? 0) > 0) continue
    const record = await ctx.codec.decryptRecord(envelope, { skipValidation: true, id: recordId })
    if (record === null) continue // shredded (tombstone) — no side-car to build
    await maintainPersistedIndexesOnPut(ctx, recordId, record, null, envelope._v)
  }

  ctx.setPersistedIndexesLoaded(true)
}

/**
 * Compare the persisted `_idx/<field>/*` side-cars against the canonical
 * records for a single field, reporting the drift (and optionally repairing
 * it). Lazy mode only — eager mode throws (the in-memory index cannot drift).
 */
export async function reconcileIndex<T>(
  ctx: IndexingContext<T>,
  field: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ field: string; missing: string[]; stale: string[]; applied: number }> {
  if (!ctx.lazy) {
    throw new Error(
      `Collection "${ctx.name}": reconcileIndex is only meaningful in lazy mode ` +
      `(prefetch: false). Eager mode maintains indexes in memory with no drift.`,
    )
  }
  const persisted = ctx.persistedIndexes
  if (!persisted) {
    throw new Error(
      `Collection "${ctx.name}": indexing is disabled on this Noydb instance. ` +
      `Pass \`withIndexing()\` from "@noy-db/hub/indexing" to \`createNoydb({ indexingStrategy })\`.`,
    )
  }
  if (!persisted.has(field)) {
    throw new Error(
      `Collection "${ctx.name}": field "${field}" is not declared in indexes. ` +
      `Declare it in the collection options before reconciling.`,
    )
  }

  const dryRun = opts.dryRun === true
  const allIds = await ctx.adapter.list(ctx.vault, ctx.name)

  // Map side-car recordId → stored value (if readable). Also capture
  // "stale" side-cars whose field matches but whose record is gone.
  const sidecar = new Map<string, unknown>()
  const sidecarIds = new Map<string, string>() // recordId -> sidecar id
  for (const id of allIds) {
    const decoded = decodeIdxId(id)
    if (!decoded || decoded.field !== field) continue
    sidecarIds.set(decoded.recordId, id)
    const env = await ctx.adapter.get(ctx.vault, ctx.name, id)
    if (!env) continue
    try {
      const sidecarJson = await ctx.codec.decryptJsonString(env)
      if (sidecarJson === null) {
        // Tombstone side-car (shredded) — treat as stale so it's rewritten.
        sidecar.set(decoded.recordId, undefined)
      } else {
        const body = JSON.parse(sidecarJson) as { value: unknown }
        sidecar.set(decoded.recordId, body.value)
      }
    } catch {
      // Unreadable — treat as stale so it gets rewritten.
      sidecar.set(decoded.recordId, undefined)
    }
  }

  // Walk canonical records and compare against side-car state.
  const missing: string[] = []
  const stale: string[] = []
  const fixesPut: Array<{ recordId: string; record: T; version: number }> = []
  for (const id of allIds) {
    if (decodeIdxId(id)) continue
    if (id.startsWith('_')) continue
    const env = await ctx.adapter.get(ctx.vault, ctx.name, id)
    if (!env) continue
    if ((env._tier ?? 0) > 0) continue // #709: skip elevated records — see rebuildIndexes' gate above
    const record = await ctx.codec.decryptRecord(env, { skipValidation: true, id })
    // Shredded (tombstone) canonical record: treat like a vanished record —
    // leave its `id` in `sidecarIds` so any lingering side-car is marked
    // stale (and deleted) by the leftover loop below.
    if (record === null) continue
    const live = readPersistedValue(record as unknown as Record<string, unknown>, field)
    const stored = sidecar.get(id)
    const hasSidecar = sidecarIds.has(id)
    const indexable = live !== null && live !== undefined

    if (indexable && !hasSidecar) {
      missing.push(id)
      fixesPut.push({ recordId: id, record, version: env._v })
    } else if (indexable && hasSidecar && !valuesMatch(stored, live)) {
      // Side-car body drifted from live value (e.g. partial write
      // after an update). Rewrite so lookups agree with reality.
      missing.push(id)
      fixesPut.push({ recordId: id, record, version: env._v })
    } else if (!indexable && hasSidecar) {
      // Record exists but its value is no longer indexable (null/
      // undefined). The side-car is stale.
      stale.push(sidecarIds.get(id)!)
    }
    sidecarIds.delete(id)
  }
  // Any side-car whose canonical record vanished is stale.
  for (const [, idxId] of sidecarIds) stale.push(idxId)

  let applied = 0
  if (!dryRun) {
    for (const idxId of stale) {
      try {
        await ctx.adapter.delete(ctx.vault, ctx.name, idxId)
        applied++
      } catch { /* ignore — next reconcile picks it up */ }
    }
    for (const fix of fixesPut) {
      await maintainPersistedIndexesOnPut(ctx, fix.recordId, fix.record, null, fix.version)
      applied++
    }
    // In-memory mirror is authoritative for query dispatch — make
    // sure it matches what's on disk now.
    persisted.clear()
    ctx.setPersistedIndexesLoaded(false)
    await ctx.ensurePersistedIndexesLoaded()
  }

  return { field, missing, stale, applied }
}

/**
 * Write / update / delete the `_idx/<field>/<recordId>` side-cars for every
 * declared persistence-index field after a successful main-record `put()`.
 * Called AFTER `adapter.put()` of the main record succeeds; side-car write
 * failures surface as `index:write-partial` and do NOT fail the put.
 */
export async function maintainPersistedIndexesOnPut<T>(
  ctx: IndexingContext<T>,
  id: string,
  newRecord: T,
  previousRecord: T | null,
  version: number,
): Promise<void> {
  const persisted = ctx.persistedIndexes
  if (!persisted) return
  const defs = persisted.definitions()
  if (defs.length === 0) return

  const newRec = newRecord as unknown as Record<string, unknown>
  const prevRec = previousRecord as unknown as Record<string, unknown> | null

  for (const def of defs) {
    const newValue = extractIndexValue(newRec, def)
    const previousValue = prevRec ? extractIndexValue(prevRec, def) : null

    // Update the in-memory mirror first — it's the authoritative source
    // for query dispatch. If the adapter write below fails, the mirror
    // still reflects intended state; the reconciler compares mirror
    // against side-cars on next run.
    persisted.upsert(id, def.key, newValue, previousValue)

    const idxId = encodeIdxId(def.key, id)
    try {
      if (newValue === null || newValue === undefined) {
        // Clear any pre-existing side-car for this (field, record).
        if (previousValue !== null && previousValue !== undefined) {
          await ctx.adapter.delete(ctx.vault, ctx.name, idxId)
        }
      } else {
        const body = JSON.stringify({
          field: def.key,
          value: serializeIndexValue(newValue),
          recordId: id,
          writtenAt: new Date().toISOString(),
        })
        const envelope = await ctx.codec.encryptJsonString({ collection: ctx.name, id: idxId }, body, version)
        await ctx.adapter.put(ctx.vault, ctx.name, idxId, envelope)
      }
    } catch (cause) {
      ctx.emitter.emit('index:write-partial', {
        vault: ctx.vault,
        collection: ctx.name,
        id,
        action: 'put',
        error: new IndexWriteFailureError({ recordId: id, field: def.key, op: 'put', cause }),
      })
    }
  }
}

/**
 * Tear down `_idx/<field>/<recordId>` side-cars for a deleted record.
 * Mirror state updates regardless of adapter outcome; adapter failures
 * surface on `index:write-partial` the same way put does.
 */
export async function maintainPersistedIndexesOnDelete<T>(ctx: IndexingContext<T>, id: string, previousRecord: T): Promise<void> {
  const persisted = ctx.persistedIndexes
  if (!persisted) return
  const defs = persisted.definitions()
  if (defs.length === 0) return

  const prevRec = previousRecord as unknown as Record<string, unknown>
  for (const def of defs) {
    const previousValue = extractIndexValue(prevRec, def)
    if (previousValue !== null && previousValue !== undefined) {
      persisted.remove(id, def.key, previousValue)
    }

    const idxId = encodeIdxId(def.key, id)
    try {
      await ctx.adapter.delete(ctx.vault, ctx.name, idxId)
    } catch (cause) {
      ctx.emitter.emit('index:write-partial', {
        vault: ctx.vault,
        collection: ctx.name,
        id,
        action: 'delete',
        error: new IndexWriteFailureError({ recordId: id, field: def.key, op: 'delete', cause }),
      })
    }
  }
}

/**
 * @internal — hard-delete this record's persisted `_idx/<field>/<recordId>`
 * side-cars for the erasure path. `forget()` crypto-shreds the body but
 * keeps the collection DEK, under which these side-cars are encrypted — so
 * without this they leave the indexed field VALUES readable after a "forget".
 *
 * Content-free: the side-car id is `encodeIdxId(def.key, id)`, so it needs no
 * body decode (the body is being shredded). Eager mode has no durable side-car
 * → no-op. The in-memory mirror is left as-is: it is ephemeral (rebuilt from
 * the now-deleted side-cars on reopen) and live reads skip the tombstone, so a
 * stale mirror hit cannot surface the erased record. Returns the count deleted
 * + the `def.key`s whose delete FAILED (residue that still leaks the value).
 */
export async function purgePersistedIndexes<T>(ctx: IndexingContext<T>, id: string): Promise<{ purged: number; residue: string[] }> {
  const persisted = ctx.persistedIndexes
  if (!persisted) return { purged: 0, residue: [] }
  let purged = 0
  const residue: string[] = []
  for (const def of persisted.definitions()) {
    try {
      await ctx.adapter.delete(ctx.vault, ctx.name, encodeIdxId(def.key, id))
      purged++
    } catch {
      residue.push(def.key)
    }
  }
  return { purged, residue }
}

/**
 * Sync this collection's indexes after a tier move (#709). Persisted
 * `_idx/<field>/<recordId>` side-cars are always encrypted under the
 * tier-0 DEK regardless of the record's own tier, and the eager in-memory
 * `CollectionIndexes` mirror holds plaintext bucket values too — so both
 * leak an elevated record's indexed field values unless swept the same way
 * `purgePersistedIndexes` already sweeps them for `forget()` ("forget()
 * crypto-shreds the body but keeps the collection DEK, under which these
 * side-cars are encrypted — so without this they leave the indexed field
 * VALUES readable", `purgePersistedIndexes` above).
 *
 * `record === null` — the record just left tier 0: purge its persisted
 * side-cars (content-free, no decrypt needed) and drop its eager-mirror
 * entry, read from `ctx.cache` (the caller's pre-write value — the caller
 * MUST invoke this before evicting/overwriting that cache entry, so it
 * still reflects the value being replaced).
 *
 * `record` given — the record is tier-0 again: (re)build its entries from
 * that record, using the SAME pre-write `ctx.cache` read as the previous
 * value so a stale bucket (e.g. a same-tier `putAtTier` value change) is
 * cleaned up rather than left as a false-positive hit. `version` stamps
 * the rebuilt side-car's own envelope version.
 *
 * `priorEnvelope` (#720) — the RAW envelope the caller read BEFORE its own
 * overwrite landed (`putAtTier`'s `existing` / `demote`'s pre-move
 * `envelope`), for the `ctx.cache`-miss lazy case: by this call's time the
 * adapter already holds the NEW envelope, so a `ctx.adapter.get()` here
 * would only ever re-observe the write just made — useless for recovering
 * what a same-tier `putAtTier` may have dropped. Optional: the null-record
 * branches (elevate / demote-to-intermediate / putAtTier(tier>0)) never
 * need it — their only prior-dependent step, the eager `indexes.remove`
 * below, already has what it needs from `ctx.cache` (eager mode is
 * unaffected by the raw-envelope overwrite; lazy mode has no eager mirror).
 *
 * No-ops fast when the collection has neither index kind declared.
 */
export async function syncTierIndexes<T>(
  ctx: IndexingContext<T>,
  id: string,
  record: T | null,
  version: number,
  priorEnvelope?: EncryptedEnvelope,
): Promise<void> {
  if (!ctx.indexes && !ctx.persistedIndexes) return
  const prior: T | null = await resolveTierSyncPrior(ctx, id, priorEnvelope)
  if (record === null) {
    await purgePersistedIndexes(ctx, id)
    if (prior) ctx.indexes?.remove(id, prior)
  } else {
    await maintainPersistedIndexesOnPut(ctx, id, record, prior, version)
    ctx.indexes?.upsert(id, record, prior)
  }
}

/**
 * Resolve the pre-write record `syncTierIndexes` needs as "previous" for
 * index maintenance. `ctx.cache` (eager mode, or a lazy record a prior tier
 * op already synced into it via `syncCache`) is checked first — cheap, no
 * I/O. Lazy mode falls back to a TIER-GATED decode of the caller-supplied
 * `priorEnvelope` (read before the caller's own overwrite, see the doc
 * comment above): gating on `(env._tier ?? 0) > 0` before decoding — the
 * campaign's standard "elevated ≡ missing" skip, never an ungated decode —
 * means a prior that was itself elevated (a `demote(0)` off an
 * `elevate()`-purged record) resolves to null cleanly instead of risking the
 * warm-cekCache-succeeds/cold-session-throws asymmetry #709 eliminated
 * elsewhere. No `priorEnvelope` (the null-record branches never pass one) or
 * eager mode both resolve to null here — by design, per the doc comment
 * above.
 */
async function resolveTierSyncPrior<T>(ctx: IndexingContext<T>, id: string, priorEnvelope: EncryptedEnvelope | undefined): Promise<T | null> {
  const cached = ctx.cache.get(id)?.record
  if (cached !== undefined) return cached
  if (!ctx.lazy || !priorEnvelope || (priorEnvelope._tier ?? 0) > 0) return null
  return await ctx.codec.decryptRecord(priorEnvelope, { skipValidation: true, id })
}
