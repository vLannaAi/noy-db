// kernel/via-dispatch.ts — the batched, origin-aware sync/cutover/restore dispatch wave
// (Via port phase C, #638 Task 4, fixes #621).
//
// `Collection._onRecordMutated`'s `sync-apply`/`cutover`/`restore` cases feed touched
// (collection, id) pairs into a per-session `GraphBatch` (owned by `Vault._collectGraphTouch`)
// instead of dispatching inline — the `local-write` path keeps its own byte-identical inline
// dispatch (`wave` stays `undefined` there, per the spec's behavior lock). At batch-flush time
// `runGraphDispatchWave` decrypts each touched record (id threaded into the decrypt, matching
// the phase-B at-rest contract) and re-runs the SAME `dispatchDerivations`/
// `dispatchMaterializedViews` the local-write path uses, sharing one `WaveContext` so N touched
// records feeding the SAME rollup/MV target recompute exactly once (per-target dedup).
// See docs/superpowers/specs/2026-07-11-via-phase-c-design.md §3.

import type { ViaGraph } from './via-graph.js'
import type { Collection } from './collection.js'

/** Per-session touched set — collection → ids. Metadata only (no values, no key material). */
export type GraphBatch = Map<string, Set<string>>

/** One dedup ledger for a single wave — a target is recomputed at most once (mark-on-check). */
export class WaveContext {
  private readonly _seen = new Set<string>()
  seen(targetKey: string): boolean {
    if (this._seen.has(targetKey)) return true
    this._seen.add(targetKey)
    return false
  }
}

/** The slice of `Vault` the wave needs: the shared graph (the #553 zero-cost skip) and cached-
 *  collection lookup — never constructs, since a touched collection is, by construction,
 *  already open (it just fired `_onRecordMutated`). */
export interface VaultLike {
  readonly graph: ViaGraph
  _getCollection(name: string): Collection<Record<string, unknown>> | undefined
}

/**
 * Run ONE dispatch wave for a completed batch: for each touched (collection, id), decrypt the
 * applied envelope (id threaded), then run the SAME `dispatchDerivations` +
 * `dispatchMaterializedViews` the local-write path uses — with a shared `WaveContext` so N
 * touched records feeding the SAME target recompute once. #553: a collection with no graph
 * out-edges (e.g. money-only) is skipped before any decrypt/dispatch async work.
 */
export async function runGraphDispatchWave(vault: VaultLike, batch: GraphBatch): Promise<void> {
  const wave = new WaveContext()
  for (const [collectionName, ids] of batch) {
    if (vault.graph.dependentsOf(collectionName).length === 0) continue
    const coll = vault._getCollection(collectionName)
    if (!coll) continue
    for (const id of ids) {
      const stored = await coll._getStoredRecordForDispatch(id)
      if (!stored) continue
      await coll.dispatchDerivations(id, stored.record, stored.version, wave)
      await coll.dispatchMaterializedViews(id, stored.record, wave)
    }
  }
}
