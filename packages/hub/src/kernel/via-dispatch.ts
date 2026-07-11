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
import { PeriodClosedError } from './errors.js'

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
      try {
        await coll.dispatchDerivations(id, stored.record, stored.version, wave)
        await coll.dispatchMaterializedViews(id, stored.record, wave)
      } catch (err) {
        // #638 Task 5 review mandate: one touched record's recompute must not abort the
        // whole wave (starving co-batched healthy targets) or the pull/push it's nested
        // inside. `PeriodClosedError` never reaches here — `putDerivedOutput` already
        // intercepts it at every output-write call site and turns it into a skip+event.
        // Anything else (a genuine derive()/executor bug, a schema violation on the
        // output, ...) is surfaced — not silently swallowed — via the SAME console.warn
        // channel `dispatchDerivations`/the MV executor already use for their own
        // non-strict-mode output failures, then isolated to just this one id.
        console.warn(`[via-dispatch] wave recompute failed for ${collectionName}/${id}:`, err)
      }
    }
  }
}

/** A record's post-freeze source mutation, for the `'derivation:skipped-frozen'` event
 *  and the optional audit-trail entry. See {@link putDerivedOutput}. */
export interface DerivationSkippedFrozen {
  readonly source: { readonly collection: string; readonly id: string }
  readonly target: { readonly collection: string; readonly id: string }
  readonly period: string
  readonly endDate: string
}

/** The minimal put-capable shape `putDerivedOutput` needs. Any `Collection<T>` structurally
 *  satisfies this — its real `options` type is a superset of what's declared here. */
export interface CollectionLike {
  put(id: string, value: unknown, options?: { readonly source?: string }): Promise<void>
}

export interface PutDerivedOutputCtx {
  readonly emit: (ev: string, p: unknown) => void
  readonly source: { readonly collection: string; readonly id: string }
  readonly audit?: ((e: DerivationSkippedFrozen) => Promise<void>) | undefined
}

/**
 * Attempt a dispatch-driven output write. On `PeriodClosedError` (the closed-period
 * `beforePut` gate — `freezePeriod`/`archivePeriod` add no separate gate, per seam map
 * Part 7): SKIP (no `_ts` stamped — the gate throws before any write happens), emit
 * `'derivation:skipped-frozen'` on the event bus (ALWAYS), and append an audit-trail entry
 * when the with-history ledger is active. Returns `'written' | 'skipped-frozen'`. Any OTHER
 * error propagates unchanged — this helper narrows exactly one error class. The SOURCE
 * write is never wrapped through this helper — only derived-output writes are (§7).
 */
export async function putDerivedOutput(
  outColl: CollectionLike, id: string, value: unknown,
  ctx: PutDerivedOutputCtx,
  options?: { readonly source?: string },
): Promise<'written' | 'skipped-frozen'> {
  try {
    await outColl.put(id, value, options)
    return 'written'
  } catch (err) {
    if (!(err instanceof PeriodClosedError)) throw err
    // Reach-around for the target collection's private `name` — the SAME pattern
    // `with-formula/materialized-views/executor.ts`'s `listOutputIds` already uses to
    // read a `Collection`'s private `adapter`/`vault`/`name` fields from outside the class.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const targetCollection = (outColl as any).name as string
    const event: DerivationSkippedFrozen = {
      source: ctx.source,
      target: { collection: targetCollection, id },
      period: err.periodName,
      endDate: err.endDate,
    }
    ctx.emit('derivation:skipped-frozen', event)
    if (ctx.audit) await ctx.audit(event)
    return 'skipped-frozen'
  }
}

/** Structural (no static import — kernel spine may not statically reach a with-* service,
 *  the S4 gate recipe `check-architecture.mjs`'s port-layering check enforces) shape of the
 *  with-history `LedgerStore.append` seam this helper needs. */
interface AuditLedgerLike {
  append(input: {
    readonly op: 'lifecycle'
    readonly collection: string
    readonly id: string
    readonly version: number
    readonly actor: string
    readonly payloadHash: string
    readonly reason?: string
  }): Promise<unknown>
}

/** @internal — the optional with-history ledger audit hook for `putDerivedOutput`, present
 *  only when the ledger is active (mirrors every other kernel event's `if (this.ledger)`
 *  gate). Encoded as a `'lifecycle'` entry — the existing "non-data audit event" op (the
 *  same convention `forget`'s JSON-summary-in-`reason` entry uses; `ledger/entry.ts:88-104`). */
export function ledgerAuditHook(
  ledger: AuditLedgerLike | undefined, actor: string,
): ((e: DerivationSkippedFrozen) => Promise<void>) | undefined {
  if (!ledger) return undefined
  return async (e) => {
    await ledger.append({
      op: 'lifecycle', collection: e.target.collection, id: e.target.id, version: 0, actor, payloadHash: '',
      reason: JSON.stringify({ event: 'derivation-skipped-frozen', ...e }),
    })
  }
}
