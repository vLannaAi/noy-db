/**
 * Blob retention + compaction.
 *
 * Declarative per-collection / per-slot eviction policy. Two
 * triggers:
 *
 *   - **`retainDays`** — age-based TTL. A slot uploaded more than N
 *     days ago is evicted.
 *   - **`evictWhen(record)`** — predicate over the **decrypted**
 *     record. Lets consumers express "the image is safe to drop once
 *     the structured invoice has been reviewed and confirmed."
 *
 * Either trigger (or both) causes the slot to evict. Eviction removes
 * the slot entry from `_blob_slots_{collection}`, decrements the
 * blob's refCount (so unreferenced chunks can be GC'd by the next
 * sweep), and writes one entry to the `_blob_eviction_audit`
 * collection for tamper-evident record-keeping.
 *
 * The audit entry carries the eTag of the evicted blob (opaque HMAC
 * of plaintext under the vault's `_blob` DEK) — no plaintext leakage,
 * per the SPEC non-correlation invariant. Consumers reconstructing
 * "what used to be attached" can look up the audit entry by record
 * id.
 *
 * Compaction is **consumer-scheduled** — noy-db never runs a
 * background daemon. Call `vault.compact()` whenever your workflow
 * allows (cron, manual "tidy" button, cold-storage export prep, …).
 *
 * @module
 */

import type { NoydbStore, EncryptedEnvelope, SlotInfo } from '../../kernel/types.js'
import { ValidationError } from '../../kernel/errors.js'
import { buildRecordEnvelope, encrypt, type EnclaveKey } from '../../kernel/enclave/index.js'

// ─── Config types ───────────────────────────────────────────────────────

export interface BlobFieldPolicy<T = unknown> {
  /**
   * Via port brand marker — lets a `BlobFieldPolicy` satisfy the kernel's
   * opaque `ViaDescriptor` (#629 Task 7). Optional (the
   * `ClassifiedFieldSpec._viaBrand` precedent): `blobFields` policies are
   * plain object literals with no declaration factory to stamp it, so a
   * mandatory field would break every existing declaration.
   */
  readonly _viaBrand?: 'blob'
  /**
   * Age-based TTL in days. A slot whose `uploadedAt` is older than
   * `now - retainDays × 86400s` evicts on the next `vault.compact()`.
   * Omit to disable age-based eviction.
   */
  readonly retainDays?: number
  /**
   * Predicate evaluated against the decrypted record. When it returns
   * `true`, every matching slot on that record evicts. Omit to
   * disable predicate-based eviction.
   */
  readonly evictWhen?: (record: T) => boolean
  /**
   * **Legal hold.** When this predicate returns `true`, the slot is
   * never evicted — `retainDays`/`evictWhen` are overridden. Use for a
   * litigation / audit hold on a fiscal document: the blob stays until
   * the predicate returns `false` (the hold is released). Fail-closed:
   * if the predicate throws, the slot is treated as held.
   */
  readonly legalHold?: (record: T) => boolean
  /**
   * **Period-bound retention.** Returns the date (Date / ISO string /
   * epoch ms) until which the slot must be retained — typically derived
   * from the record's fiscal period (e.g. period end + 10 years). While
   * `now < retainUntil`, the slot is never evicted, regardless of
   * `retainDays`. Return `null`/`undefined` to impose no floor.
   * Fail-closed: a throwing function holds the slot.
   */
  readonly retainUntil?: (record: T) => Date | string | number | null | undefined
  /**
   * **External projection.** When `true`, this field's bytes are stored in the
   * vault's `ObjectProjection` (`createNoydb({ objectStore })`) as a single raw,
   * **unencrypted** object — servable directly from S3/CDN and processable by
   * native tooling — instead of the encrypted-chunk path. The encrypted slot
   * record remains the catalog (anchoring invariant). Requires an `objectStore`;
   * **outside the zero-knowledge guarantee** — use only for assets meant to
   * leave the vault. See the as-aws-s3 design spec.
   */
  readonly external?: boolean
  /**
   * For an `external` field: make the object world-readable (CDN origin) rather
   * than presigned-only. Default `false` (presigned). Ignored unless `external`.
   */
  readonly public?: boolean
  /**
   * For an `external` field: how to stamp a **backlink** (this record's
   * vault/collection/id/field) onto the object's metadata — the self-describing
   * "secondary store" that powers reconcile / DR / import re-pairing.
   * - `'opaque-token'` (default): a random id; preserves the opaque-bucket
   *   property (no names leak); the token is also recorded on the slot.
   * - `'encrypted'`: the reference encrypted under the blob DEK (ZK-preserving;
   *   falls back to `'opaque-token'` on a plaintext vault).
   * - `'plain'`: the reference in cleartext metadata — **leaks structure** to
   *   bucket readers; only for non-sensitive deployments.
   * - `'none'`: no backlink.
   */
  readonly backlink?: 'opaque-token' | 'encrypted' | 'plain' | 'none'
}

export type BlobFieldsConfig<T = unknown> = Record<string, BlobFieldPolicy<T>>

// ─── Audit collection ──────────────────────────────────────────────────

export const BLOB_EVICTION_AUDIT_COLLECTION = '_blob_eviction_audit'

export interface BlobEvictionEntry {
  readonly id: string
  readonly collection: string
  readonly recordId: string
  readonly slotName: string
  readonly blobHash: string
  /** `'budget'` — evicted by the #808 cache-budget LRU pass, not a policy. */
  readonly reason: 'ttl' | 'predicate' | 'both' | 'budget'
  readonly evictedAt: string
  readonly actor: string
}

// ─── Compaction result ──────────────────────────────────────────────────

export interface CompactionResult {
  /** Number of blob slots evicted by the policy pass across all collections. */
  readonly evicted: number
  /** Number of records touched (iterated + policy checked). */
  readonly records: number
  /** Number of collections with `blobFields` configured. */
  readonly collections: number
  /**
   * Number of audit entries written — one per policy eviction plus one per
   * budget SLOT eviction (dropping a device-local cache copy writes none).
   */
  readonly auditEntries: number
  /**
   * Number of slots that would have evicted (TTL/predicate triggered)
   * but were retained by a `legalHold` or `retainUntil` floor.
   */
  readonly held: number
  /**
   * #808: number of slots whose due policy eviction was skipped because they
   * are pinned for offline on THIS device (pin state is device-local).
   */
  readonly pinned: number
  /**
   * #808: number of evictions performed by the `cacheBudget` LRU pass —
   * internal slots evicted through the standard eviction writer plus
   * device-local external cache copies dropped. 0 when no budget was given.
   */
  readonly budgetEvicted: number
  /** #808: plaintext bytes freed by the `cacheBudget` LRU pass. */
  readonly budgetBytesFreed: number
  /** Per-collection breakdown for diagnostics. */
  readonly byCollection: Record<string, { records: number; evicted: number }>
}

// ─── Core ──────────────────────────────────────────────────────────────

export interface CompactRunOptions {
  /** Override "now" for deterministic testing. */
  readonly now?: Date
  /**
   * Stop after this many evictions. Useful for capped batches / cron
   * jobs that need to fit in a time window. `undefined` = unbounded.
   */
  readonly maxEvictions?: number
  /**
   * Dry-run — evaluate policies and return the counts, but do NOT
   * delete slots or write audit entries. Lets a consumer preview
   * what would happen.
   */
  readonly dryRun?: boolean
  /**
   * #808 mobile cache budget: cap the locally-cached UNPINNED blob bytes.
   * After the policy pass, a dedicated LRU pass walks every collection's
   * slots (pinned slots and `legalHold`/`retainUntil`-held slots are exempt
   * and uncounted) and evicts oldest-access-first — internal slots through
   * the standard eviction writer (`deleteSlot` + a `'budget'` audit entry),
   * external slots by dropping their device-local encrypted cache copy only
   * (the object-store copy is authoritative and untouched) — until the
   * remaining unpinned bytes fit `maxBytes`. Internal slots count their
   * uncompressed `size`; external slots count `cachedBytes` (0 = nothing
   * local, nothing to evict). LRU order comes from the device-local
   * `lastAccessAt` stamp, falling back to `uploadedAt`.
   */
  readonly cacheBudget?: { readonly maxBytes: number }
}

export interface CompactionContext {
  readonly adapter: NoydbStore
  readonly vault: string
  readonly actor: string
  readonly encrypted: boolean
  readonly getDEK: (collection: string) => Promise<EnclaveKey>
  /**
   * Resolve a collection's declared `blobFields` config. Returns an
   * empty map for collections without the config — the walk skips
   * those.
   */
  readonly getBlobFields: <T>(collection: string) => BlobFieldsConfig<T> | null
  /** List collection names in the vault. */
  readonly listCollections: () => Promise<string[]>
  /** List record ids in a collection. */
  readonly listRecords: (collection: string) => Promise<string[]>
  /** Decrypt and return the record. Null when absent. */
  readonly getRecord: <T>(collection: string, id: string) => Promise<T | null>
  /** Return the BlobSet-like handle for a record's slots. */
  readonly listSlots: (collection: string, id: string) => Promise<SlotInfo[]>
  /** Delete a slot and decrement its blob's refCount. */
  readonly deleteSlot: (collection: string, id: string, slotName: string) => Promise<void>
  /**
   * #808: drop a slot's DEVICE-LOCAL cached copy (the encrypted external
   * side-cache) without touching the slot or the object store. Returns the
   * plaintext bytes freed. Optional — absent (or a 0 return) means external
   * cache entries simply cannot be budget-evicted through this context.
   */
  readonly dropLocalCache?: (collection: string, id: string, slotName: string) => Promise<number>
}

export async function runCompaction(
  ctx: CompactionContext,
  options: CompactRunOptions = {},
): Promise<CompactionResult> {
  const now = options.now ?? new Date()
  const maxEvictions = options.maxEvictions ?? Infinity
  const dryRun = options.dryRun === true
  if (options.cacheBudget !== undefined
    && (!Number.isFinite(options.cacheBudget.maxBytes) || options.cacheBudget.maxBytes < 0)) {
    throw new ValidationError('compact(): cacheBudget.maxBytes must be a non-negative finite number (#808)')
  }

  const allCollections = await ctx.listCollections()
  const byCollection: Record<string, { records: number; evicted: number }> = {}
  let evicted = 0
  let records = 0
  let auditEntries = 0
  let held = 0
  let pinned = 0
  let collectionsWithPolicy = 0

  outer: for (const collectionName of allCollections) {
    if (collectionName.startsWith('_')) continue
    const config = ctx.getBlobFields(collectionName)
    if (!config) continue
    const configuredSlots = Object.keys(config)
    if (configuredSlots.length === 0) continue
    collectionsWithPolicy += 1
    byCollection[collectionName] = { records: 0, evicted: 0 }

    const ids = await ctx.listRecords(collectionName)
    for (const recordId of ids) {
      if (evicted >= maxEvictions) break outer

      const record = await ctx.getRecord(collectionName, recordId).catch(() => null)
      if (record === null) continue
      records += 1
      byCollection[collectionName].records += 1

      const slots = await ctx.listSlots(collectionName, recordId).catch(() => [])
      for (const slot of slots) {
        if (evicted >= maxEvictions) break outer
        const policy = config[slot.name]
        if (!policy) continue

        const reason = evaluatePolicy(policy, record, slot, now)
        if (!reason) continue

        // #808: device-local offline pin — an exemption inside this existing
        // pass, exactly like a hold: counted, never evicted. `slot.pinned` is
        // the device-local annotation `BlobSet.list()` stamps from the
        // withBlobs() pin registry (never synced state).
        if (slot.pinned === true) {
          pinned += 1
          continue
        }

        // Retention floor: a legal hold or period-bound retainUntil
        // blocks an otherwise-due eviction. Counted, never evicted.
        if (isHeld(policy, record, now)) {
          held += 1
          continue
        }

        if (!dryRun) {
          await ctx.deleteSlot(collectionName, recordId, slot.name)
          await writeAuditEntry(ctx, {
            id: generateEvictionId(collectionName, recordId, slot.name),
            collection: collectionName,
            recordId,
            slotName: slot.name,
            blobHash: slot.eTag,
            reason,
            evictedAt: now.toISOString(),
            actor: ctx.actor,
          })
          auditEntries += 1
        }
        evicted += 1
        byCollection[collectionName].evicted += 1
      }
    }
  }

  // #808: cache-budget LRU pass — runs AFTER the policy pass so a slot that
  // just evicted no longer counts toward the budget. Reuses this module's own
  // eviction writer (deleteSlot + audit), never a parallel one.
  let budgetEvicted = 0
  let budgetBytesFreed = 0
  if (options.cacheBudget !== undefined) {
    const pass = await runBudgetPass(ctx, options.cacheBudget.maxBytes, {
      now, dryRun, remainingEvictions: maxEvictions - evicted,
    })
    budgetEvicted = pass.evicted
    budgetBytesFreed = pass.bytesFreed
    auditEntries += pass.auditEntries
  }

  return {
    evicted,
    records,
    collections: collectionsWithPolicy,
    auditEntries,
    held,
    pinned,
    budgetEvicted,
    budgetBytesFreed,
    byCollection,
  }
}

// ─── #808: cache-budget LRU pass ───────────────────────────────────────

interface BudgetCandidate {
  readonly collection: string
  readonly recordId: string
  readonly slotName: string
  readonly eTag: string
  readonly bytes: number
  /** `'slot'` — internal blob, evicted via `deleteSlot`; `'cache'` — external device-local copy, dropped via `dropLocalCache`. */
  readonly kind: 'slot' | 'cache'
  readonly lastAccessMs: number
}

/**
 * Enforce `cacheBudget.maxBytes` over the locally-cached UNPINNED blob bytes
 * (see {@link CompactRunOptions.cacheBudget} for the full contract). Walks
 * EVERY collection — unlike the policy pass, the budget is not gated on a
 * declared `blobFields` config — but still honors a declared policy's
 * `legalHold`/`retainUntil` floor where one exists.
 */
async function runBudgetPass(
  ctx: CompactionContext,
  maxBytes: number,
  opts: { now: Date; dryRun: boolean; remainingEvictions: number },
): Promise<{ evicted: number; bytesFreed: number; auditEntries: number }> {
  const candidates: BudgetCandidate[] = []
  let total = 0

  for (const collectionName of await ctx.listCollections()) {
    if (collectionName.startsWith('_')) continue
    const config = ctx.getBlobFields(collectionName)
    for (const recordId of await ctx.listRecords(collectionName)) {
      const slots = await ctx.listSlots(collectionName, recordId).catch(() => [])
      if (slots.length === 0) continue
      // The record is only needed to evaluate a declared policy's retention
      // floor — skip the decrypt entirely for policy-less collections.
      const record = config
        ? await ctx.getRecord<unknown>(collectionName, recordId).catch(() => null)
        : null
      for (const slot of slots) {
        if (slot.pinned === true) continue // pinned: exempt AND uncounted (#808)
        const policy = config?.[slot.name]
        if (policy && record !== null && isHeld(policy, record, opts.now)) continue // floor blocks budget too
        const lastAccessMs = Date.parse(slot.lastAccessAt ?? slot.uploadedAt) || 0
        const isExternal = slot.external !== undefined
        const bytes = isExternal ? slot.cachedBytes ?? 0 : slot.size
        if (bytes <= 0) continue // external with no local copy: nothing cached to evict
        total += bytes
        candidates.push({
          collection: collectionName, recordId, slotName: slot.name, eTag: slot.eTag,
          bytes, kind: isExternal ? 'cache' : 'slot', lastAccessMs,
        })
      }
    }
  }

  // Oldest access first; deterministic tiebreak so equal timestamps (common
  // within one ms) never make the eviction order flap between runs.
  candidates.sort((a, b) =>
    a.lastAccessMs - b.lastAccessMs
    || a.collection.localeCompare(b.collection)
    || a.recordId.localeCompare(b.recordId)
    || a.slotName.localeCompare(b.slotName))

  let evicted = 0
  let bytesFreed = 0
  let auditEntries = 0
  for (const c of candidates) {
    if (total <= maxBytes || evicted >= opts.remainingEvictions) break
    if (!opts.dryRun) {
      if (c.kind === 'slot') {
        await ctx.deleteSlot(c.collection, c.recordId, c.slotName)
        await writeAuditEntry(ctx, {
          id: generateEvictionId(c.collection, c.recordId, c.slotName),
          collection: c.collection,
          recordId: c.recordId,
          slotName: c.slotName,
          blobHash: c.eTag,
          reason: 'budget',
          evictedAt: opts.now.toISOString(),
          actor: ctx.actor,
        })
        auditEntries += 1
      } else {
        // Device-local cache drop only — the slot (catalog) and the
        // object-store copy are untouched, so no eviction audit entry.
        await ctx.dropLocalCache?.(c.collection, c.recordId, c.slotName)
      }
    }
    evicted += 1
    bytesFreed += c.bytes
    total -= c.bytes
  }

  return { evicted, bytesFreed, auditEntries }
}

/**
 * Whether a retention floor (legal hold or period-bound `retainUntil`)
 * currently blocks eviction of this record's slots. Fail-closed: a
 * throwing predicate holds the slot.
 */
function isHeld<T>(policy: BlobFieldPolicy<T>, record: T, now: Date): boolean {
  if (policy.legalHold) {
    try {
      if (policy.legalHold(record)) return true
    } catch {
      return true
    }
  }
  if (policy.retainUntil) {
    try {
      const until = policy.retainUntil(record)
      if (until !== null && until !== undefined) {
        const t = until instanceof Date ? until.getTime() : typeof until === 'number' ? until : Date.parse(String(until))
        if (!Number.isFinite(t)) return true   // fail-closed: unparseable retainUntil holds the slot
        if (t > now.getTime()) return true
      }
    } catch {
      return true
    }
  }
  return false
}

function evaluatePolicy<T>(
  policy: BlobFieldPolicy<T>,
  record: T,
  slot: SlotInfo,
  now: Date,
): 'ttl' | 'predicate' | 'both' | null {
  let ttlTriggered = false
  let predicateTriggered = false

  if (policy.retainDays !== undefined && policy.retainDays > 0) {
    const uploadedAt = Date.parse(slot.uploadedAt)
    if (Number.isFinite(uploadedAt)) {
      const ageMs = now.getTime() - uploadedAt
      const limitMs = policy.retainDays * 86_400_000
      if (ageMs > limitMs) ttlTriggered = true
    }
  }

  if (policy.evictWhen) {
    try {
      if (policy.evictWhen(record)) predicateTriggered = true
    } catch {
      // Predicate error → do NOT evict. Fail closed.
    }
  }

  if (ttlTriggered && predicateTriggered) return 'both'
  if (ttlTriggered) return 'ttl'
  if (predicateTriggered) return 'predicate'
  return null
}

function generateEvictionId(collection: string, recordId: string, slotName: string): string {
  const rand = globalThis.crypto.getRandomValues(new Uint8Array(8))
  let suffix = ''
  for (const b of rand) suffix += b.toString(16).padStart(2, '0')
  return `${collection}__${recordId}__${slotName}__${suffix}`
}

async function writeAuditEntry(ctx: CompactionContext, entry: BlobEvictionEntry): Promise<void> {
  const json = JSON.stringify(entry)
  const identity = { collection: BLOB_EVICTION_AUDIT_COLLECTION, id: entry.id, by: entry.actor }
  const body = { version: 1, ts: entry.evictedAt, by: entry.actor }
  let envelope: EncryptedEnvelope
  if (ctx.encrypted) {
    const dek = await ctx.getDEK(BLOB_EVICTION_AUDIT_COLLECTION)
    const { iv, data } = await encrypt(json, dek)
    envelope = buildRecordEnvelope(identity, { ...body, iv, data })
  } else {
    envelope = buildRecordEnvelope(identity, { ...body, iv: '', data: json })
  }
  await ctx.adapter.put(ctx.vault, BLOB_EVICTION_AUDIT_COLLECTION, entry.id, envelope)
}
