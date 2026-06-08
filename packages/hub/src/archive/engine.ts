/**
 * Record cold-storage archival engine.
 *
 * Archival relocates a sealed record's **encrypted envelope** from the
 * primary store to a cold archive store — no re-encryption, the envelope
 * is opaque ciphertext. Because relocation goes through low-level store
 * ops (and the collection's `_internalDelete`), it bypasses guards (an
 * issued/immutable record can still be archived) and never fires
 * materialized-view dispatch (finalized aggregates over a sealed period
 * don't recompute). The archive store's contents are themselves the
 * archived-set index — `listArchived` lists it; `restore` relocates an
 * envelope back to the primary store.
 *
 * A `legalHold` predicate blocks archival; `archiveWhen` (typically
 * derived from the record's fiscal period / business date) selects
 * eligible records.
 */

import type { NoydbStore, EncryptedEnvelope } from '../types.js'

export interface ArchivePolicy<T = unknown> {
  /** Select records eligible for archival — typically a business-date / period test. */
  readonly archiveWhen: (record: T) => boolean
  /** Block archival while true (litigation / audit hold). Fail-closed on throw. */
  readonly legalHold?: (record: T) => boolean
}

export interface ArchiveResult {
  /** Records relocated to the archive store. */
  readonly archived: number
  /** Records eligible by `archiveWhen` but retained by a `legalHold`. */
  readonly held: number
  /** Records scanned across policy collections. */
  readonly scanned: number
  readonly byCollection: Record<string, { archived: number; held: number }>
}

export interface ArchiveRunOptions {
  /** Stop after this many archivals. `undefined` = unbounded. */
  readonly maxArchives?: number
  /** Preview without relocating. */
  readonly dryRun?: boolean
}

/**
 * Everything the engine needs from the Vault, injected so the engine
 * stays unit-testable without a live vault.
 */
export interface ArchiveContext {
  readonly vaultId: string
  readonly archiveStore: NoydbStore
  /** Collections that declared an `archive` policy. */
  collectionsWithPolicy(): readonly string[]
  getPolicy(collection: string): ArchivePolicy | null
  listRecordIds(collection: string): Promise<readonly string[]>
  /** Decrypted record for policy evaluation, or null if unreadable. */
  getRecord(collection: string, id: string): Promise<Record<string, unknown> | null>
  /** Raw encrypted envelope from the primary store. */
  getEnvelope(collection: string, id: string): Promise<EncryptedEnvelope | null>
  /** Remove from the primary store + cache, bypassing guards/MV (`_internalDelete`). */
  removeFromPrimary(collection: string, id: string): Promise<void>
  /** Write an envelope back to the primary store + refresh cache. */
  restoreToPrimary(collection: string, id: string, env: EncryptedEnvelope): Promise<void>
}

function isHeld<T>(policy: ArchivePolicy<T>, record: T): boolean {
  if (!policy.legalHold) return false
  try {
    return policy.legalHold(record)
  } catch {
    return true // fail-closed: a throwing hold predicate retains the record
  }
}

/** Sweep eligible records into the archive store. */
export async function runArchive(ctx: ArchiveContext, options: ArchiveRunOptions = {}): Promise<ArchiveResult> {
  const maxArchives = options.maxArchives ?? Infinity
  const dryRun = options.dryRun === true
  let archived = 0
  let held = 0
  let scanned = 0
  const byCollection: Record<string, { archived: number; held: number }> = {}

  outer: for (const collection of ctx.collectionsWithPolicy()) {
    const policy = ctx.getPolicy(collection)
    if (!policy) continue
    byCollection[collection] = { archived: 0, held: 0 }
    for (const id of await ctx.listRecordIds(collection)) {
      if (archived >= maxArchives) break outer
      const record = await ctx.getRecord(collection, id).catch(() => null)
      if (record === null) continue
      scanned += 1
      let eligible = false
      try {
        eligible = policy.archiveWhen(record)
      } catch {
        eligible = false // fail-closed: don't archive on predicate error
      }
      if (!eligible) continue
      if (isHeld(policy, record)) {
        held += 1
        byCollection[collection].held += 1
        continue
      }
      if (!dryRun) {
        const env = await ctx.getEnvelope(collection, id)
        if (!env) continue
        await ctx.archiveStore.put(ctx.vaultId, collection, id, env)
        await ctx.removeFromPrimary(collection, id)
      }
      archived += 1
      byCollection[collection].archived += 1
    }
  }

  return { archived, held, scanned, byCollection }
}

/** Relocate one archived record back to the primary store. Returns false if not archived. */
export async function runRestore(ctx: ArchiveContext, collection: string, id: string): Promise<boolean> {
  const env = await ctx.archiveStore.get(ctx.vaultId, collection, id)
  if (!env) return false
  await ctx.restoreToPrimary(collection, id, env)
  await ctx.archiveStore.delete(ctx.vaultId, collection, id)
  return true
}

/** List archived record ids for a collection (or all policy collections). */
export async function runListArchived(
  ctx: ArchiveContext,
  collection?: string,
): Promise<Array<{ collection: string; id: string }>> {
  const collections = collection ? [collection] : ctx.collectionsWithPolicy()
  const out: Array<{ collection: string; id: string }> = []
  for (const c of collections) {
    const ids = await ctx.archiveStore.list(ctx.vaultId, c)
    for (const id of ids) out.push({ collection: c, id })
  }
  return out
}
