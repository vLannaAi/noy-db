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

import type { NoydbStore, EncryptedEnvelope, SlotInfo } from '../types.js'
import { NOYDB_FORMAT_VERSION } from '../types.js'
import { encrypt } from '../crypto.js'

// ─── Config types ───────────────────────────────────────────────────────

export interface BlobFieldPolicy<T = unknown> {
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
  readonly reason: 'ttl' | 'predicate' | 'both'
  readonly evictedAt: string
  readonly actor: string
}

// ─── Compaction result ──────────────────────────────────────────────────

export interface CompactionResult {
  /** Number of blob slots evicted across all collections. */
  readonly evicted: number
  /** Number of records touched (iterated + policy checked). */
  readonly records: number
  /** Number of collections with `blobFields` configured. */
  readonly collections: number
  /** Number of audit entries written. Equal to `evicted`. */
  readonly auditEntries: number
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
}

export interface CompactionContext {
  readonly adapter: NoydbStore
  readonly vault: string
  readonly actor: string
  readonly encrypted: boolean
  readonly getDEK: (collection: string) => Promise<CryptoKey>
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
}

export async function runCompaction(
  ctx: CompactionContext,
  options: CompactRunOptions = {},
): Promise<CompactionResult> {
  const now = options.now ?? new Date()
  const maxEvictions = options.maxEvictions ?? Infinity
  const dryRun = options.dryRun === true

  const allCollections = await ctx.listCollections()
  const byCollection: Record<string, { records: number; evicted: number }> = {}
  let evicted = 0
  let records = 0
  let auditEntries = 0
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

  return {
    evicted,
    records,
    collections: collectionsWithPolicy,
    auditEntries,
    byCollection,
  }
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
  let envelope: EncryptedEnvelope
  if (ctx.encrypted) {
    const dek = await ctx.getDEK(BLOB_EVICTION_AUDIT_COLLECTION)
    const { iv, data } = await encrypt(json, dek)
    envelope = {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: 1,
      _ts: entry.evictedAt,
      _iv: iv,
      _data: data,
      _by: entry.actor,
    }
  } else {
    envelope = {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: 1,
      _ts: entry.evictedAt,
      _iv: '',
      _data: json,
      _by: entry.actor,
    }
  }
  await ctx.adapter.put(ctx.vault, BLOB_EVICTION_AUDIT_COLLECTION, entry.id, envelope)
}
