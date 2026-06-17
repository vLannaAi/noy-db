/**
 * @klum-db/lobby interchange — reconcile an incoming extracted-partition
 * compartment into an existing receiver vault (FR-3).
 *
 * `mergeCompartment(receiver, compartmentBytes, opts)` → `MergeReport`:
 *   1. Decrypt the incoming bytes via hub's `decryptExtractedPartition`.
 *   2. `diffVault(receiver, incoming)` classifies records as added / modified
 *      / deleted (deleted = receiver-only slice, ignored per FR-3 semantics).
 *   3. Resolve each `modified` entry per the per-collection strategy.
 *   4. Apply writes via `collection.put(id, rec, { reason })` (unless dryRun).
 *
 * @module
 */
import type { Vault } from '@noy-db/hub'
import { diffVault } from '@noy-db/hub'
import { decryptExtractedPartition } from '@noy-db/hub/bundle'

// ─── Public types ─────────────────────────────────────────────────────────────

/** Per-collection conflict strategy. `field-level` is deferred to FR-4. */
export type MergeStrategy =
  | 'take-incoming'
  | 'keep-local'
  | 'lww-by-ts'
  | 'manual-queue'
  | 'field-level'

export interface MergeCompartmentOptions {
  readonly transferKey: Uint8Array
  /**
   * One strategy applied to all collections, or a per-collection map with an
   * optional `default` fallback (if a collection isn't in the map it falls back
   * to `default`, or `'manual-queue'` if no default is set).
   */
  readonly strategy:
    | MergeStrategy
    | (Record<string, MergeStrategy> & { default?: MergeStrategy })
  readonly dryRun?: boolean
  /** Audit reason stamped on every write. Defaults to `'merge:compartment'`. */
  readonly reason?: string
}

export interface MergeConflict {
  readonly collection: string
  readonly id: string
  readonly strategy: MergeStrategy
  readonly resolution: 'incoming' | 'local' | 'queued'
}

export interface MergeReport {
  readonly vault: string
  readonly dryRun: boolean
  readonly summary: {
    readonly inserted: number
    readonly updated: number
    readonly skipped: number
    readonly queued: number
    readonly total: number
  }
  readonly byCollection: Record<
    string,
    { readonly inserted: number; readonly updated: number; readonly skipped: number; readonly queued: number }
  >
  /**
   * One entry per `modified` (id-collision) record, regardless of outcome —
   * including `take-incoming` overwrites (`resolution: 'incoming'`). This is a
   * full audit trail of every conflict the merge encountered and how it was
   * resolved, not just the ones that were skipped or queued.
   */
  readonly conflicts: readonly MergeConflict[]
}

/** Mutable per-collection tally used while building a {@link MergeReport}. */
interface CollectionTally {
  inserted: number
  updated: number
  skipped: number
  queued: number
}

// ─── Error ────────────────────────────────────────────────────────────────────

/**
 * Thrown when a collection's strategy is `field-level` — this is deferred to
 * FR-4 (field-authority). Use `take-incoming`, `keep-local`, `lww-by-ts`, or
 * `manual-queue` for now.
 */
export class FieldLevelDeferredError extends Error {
  constructor(collection: string) {
    super(
      `mergeCompartment: the 'field-level' strategy for "${collection}" is not implemented yet` +
        ` — it lands with FR-4 (field-authority).` +
        ` Use take-incoming / keep-local / lww-by-ts / manual-queue for now.`,
    )
    this.name = 'FieldLevelDeferredError'
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function strategyFor(
  opts: MergeCompartmentOptions['strategy'],
  collection: string,
): MergeStrategy {
  if (typeof opts === 'string') return opts
  return opts[collection] ?? opts.default ?? 'manual-queue'
}

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Reconcile an incoming extracted-partition compartment into a receiver vault.
 *
 * Semantics:
 * - **added**: in incoming, not in receiver → always insert (every strategy).
 * - **modified**: in both, body differs → resolve per collection strategy.
 * - **deleted**: in receiver, not in incoming → IGNORE (incoming is a slice;
 *   never delete receiver rows).
 * - **unchanged**: no-op.
 *
 * Returns a {@link MergeReport} describing what was (or would be) written.
 * When `dryRun: true` the report is fully computed but no `put()` is called.
 *
 * Writes are applied sequentially and **non-transactionally**: a `put()`
 * failure mid-loop (e.g. schema mismatch or a storage error) rejects the
 * returned promise but leaves the receiver partially merged. Use `dryRun`
 * first to validate the plan when partial application is unacceptable.
 */
export async function mergeCompartment(
  receiver: Vault,
  compartmentBytes: Uint8Array,
  opts: MergeCompartmentOptions,
): Promise<MergeReport> {
  const reason = opts.reason ?? 'merge:compartment'

  // 1. Decrypt incoming records.
  const incoming = await decryptExtractedPartition(compartmentBytes, opts.transferKey)

  // Build the candidate for diffVault: Record<collection, T[]> where each T has an `id` field.
  // Also keep incoming _ts for lww-by-ts comparison and _source for provenance threading (FR-5).
  const incomingTs = new Map<string, Map<string, string>>()
  const incomingSource = new Map<string, Map<string, string>>()
  const candidate: Record<string, Record<string, unknown>[]> = {}
  for (const [coll, recs] of Object.entries(incoming)) {
    const tsMap = new Map<string, string>()
    const srcMap = new Map<string, string>()
    for (const r of recs) {
      tsMap.set(r.id, r.ts)
      if (r.source !== undefined) srcMap.set(r.id, r.source)
    }
    candidate[coll] = recs.map((r) => r.record)
    incomingTs.set(coll, tsMap)
    incomingSource.set(coll, srcMap)
  }

  // 2. Diff the receiver against the incoming candidate.
  const diff = await diffVault(receiver, candidate)

  // 3. Resolve conflicts.
  const byCollection: Record<string, CollectionTally> = {}
  const conflicts: MergeConflict[] = []
  const writes: { collection: string; id: string; record: Record<string, unknown>; source?: string }[] = []

  function bump(
    coll: string,
    key: keyof CollectionTally,
  ): void {
    const e = byCollection[coll] ?? { inserted: 0, updated: 0, skipped: 0, queued: 0 }
    e[key]++
    byCollection[coll] = e
  }

  // 3a. added → insert (all strategies)
  for (const a of diff.added) {
    const src = incomingSource.get(a.collection)?.get(a.id)
    writes.push({ collection: a.collection, id: a.id, record: a.record, ...(src !== undefined ? { source: src } : {}) })
    bump(a.collection, 'inserted')
  }

  // 3b. modified → resolve per strategy
  // For lww-by-ts we need the receiver envelope's _ts.
  const { adapter, name: receiverName } = receiver._introspectState()

  for (const m of diff.modified) {
    const strat = strategyFor(opts.strategy, m.collection)

    if (strat === 'field-level') {
      throw new FieldLevelDeferredError(m.collection)
    }

    if (strat === 'take-incoming') {
      const src = incomingSource.get(m.collection)?.get(m.id)
      writes.push({ collection: m.collection, id: m.id, record: m.record, ...(src !== undefined ? { source: src } : {}) })
      bump(m.collection, 'updated')
      conflicts.push({ collection: m.collection, id: m.id, strategy: strat, resolution: 'incoming' })
    } else if (strat === 'keep-local') {
      bump(m.collection, 'skipped')
      conflicts.push({ collection: m.collection, id: m.id, strategy: strat, resolution: 'local' })
    } else if (strat === 'manual-queue') {
      bump(m.collection, 'queued')
      conflicts.push({ collection: m.collection, id: m.id, strategy: strat, resolution: 'queued' })
    } else {
      // lww-by-ts: compare ISO _ts strings lexicographically (correct for ISO-8601).
      const incTs = incomingTs.get(m.collection)?.get(m.id) ?? ''
      const recvEnv = await adapter.get(receiverName, m.collection, m.id)
      const localTs = recvEnv?._ts ?? ''
      if (incTs > localTs) {
        const src = incomingSource.get(m.collection)?.get(m.id)
        writes.push({ collection: m.collection, id: m.id, record: m.record, ...(src !== undefined ? { source: src } : {}) })
        bump(m.collection, 'updated')
        conflicts.push({ collection: m.collection, id: m.id, strategy: strat, resolution: 'incoming' })
      } else {
        bump(m.collection, 'skipped')
        conflicts.push({ collection: m.collection, id: m.id, strategy: strat, resolution: 'local' })
      }
    }
  }

  // diff.deleted (receiver-only) is intentionally ignored — incoming is a slice,
  // its absence of a row never means "delete that row from the receiver".

  // 4. Apply writes (unless dry-run).
  if (!opts.dryRun) {
    for (const w of writes) {
      await receiver.collection(w.collection).put(w.id, w.record, {
        reason,
        ...(w.source !== undefined ? { source: w.source } : {}),
      })
    }
  }

  // 5. Aggregate summary.
  const summary = { inserted: 0, updated: 0, skipped: 0, queued: 0, total: 0 }
  for (const e of Object.values(byCollection)) {
    summary.inserted += e.inserted
    summary.updated += e.updated
    summary.skipped += e.skipped
    summary.queued += e.queued
  }
  summary.total = summary.inserted + summary.updated + summary.skipped + summary.queued

  return {
    vault: receiverName,
    dryRun: opts.dryRun ?? false,
    summary,
    byCollection,
    conflicts,
  }
}
