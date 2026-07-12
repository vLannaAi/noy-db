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
import type { EncryptedEnvelope } from './types.js'
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
      try {
        // Decrypt is INSIDE the per-id isolation boundary (whole-branch review Important
        // finding, #638): an undecryptable synced envelope (`TamperedError`) must not
        // escape `_getStoredRecordForDispatch` and abort the wave — that would propagate
        // through `_flushGraphBatch` and reject the surrounding `SyncEngine.pull`/`push`
        // AFTER records were already applied + meta persisted, starving every other
        // touched target in the same batch.
        const stored = await coll._getStoredRecordForDispatch(id)
        if (!stored) continue
        await coll.dispatchDerivations(id, stored.record, stored.version, wave)
        await coll.dispatchMaterializedViews(id, stored.record, wave)
      } catch (err) {
        // #638 Task 5 review mandate: one touched record's recompute must not abort the
        // whole wave (starving co-batched healthy targets) or the pull/push it's nested
        // inside. `PeriodClosedError` never reaches here — `putDerivedOutput` already
        // intercepts it at every output-write call site and turns it into a skip+event.
        // Anything else (a genuine decrypt failure, a derive()/executor bug, a schema
        // violation on the output, ...) is surfaced — not silently swallowed — via the
        // SAME console.warn channel `dispatchDerivations`/the MV executor already use for
        // their own non-strict-mode output failures, then isolated to just this one id.
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

/** `recomputeRollup`/`dispatchRollupsOnDelete`'s per-target write outcome (#638 Task 6):
 *  `'written'`/`'skipped-frozen'` mirror {@link putDerivedOutput}'s result; `'noop'` covers
 *  no-parent/no-change/deduped-by-wave — nothing to report either way. */
export type RollupOutcome = 'written' | 'skipped-frozen' | 'noop'

/** Mutable accumulator `forgetDerivedFanout` writes into, one per `Vault.forget()` call — keeps
 *  the per-ref loop's call site to a single line under vault.ts's tight kernel-surface ceiling.
 *  Maps 1:1 onto `ForgetResult`'s additive fields (`with-audit/forget/strategy.ts`). */
export interface ForgetFanoutStats {
  recordsErased: number
  aggregatesRecomputed: number
  readonly residueFrozen: string[]
  /** #650 Task 5 (#648) — referencing records tombstoned via a `'ref'` edge's `cascade` policy. */
  lookupReferencesCascaded: number
  /** #650 Task 5 (#648) — referencing fields cleared via a `'ref'` edge's `nullify` policy. */
  lookupReferencesNullified: number
  /** #650 Task 5 review (Important fix) — `'ref'` edges whose compare-key could NOT be resolved,
   *  even from the LIVE pre-shred row (the backing row itself is unreadable) — propagation was
   *  skipped for these, reported here so the skip is never silent. `backing:key:collection.field`
   *  entries, one per un-propagated edge. */
  readonly lookupReferencesResidue: string[]
}

/**
 * #622 — after `_writeTombstone(ref.id, actor)` erases the forgotten subject's own record, fan
 * out to its derived residue via the graph (spec §5): record-grain artifacts (MV rows,
 * array-shape derivation rows, same-id record-shape derivation copies) are ERASED through the
 * SAME `!internal` housekeeping-bypass machinery the ordinary delete path uses (no user
 * `onDelete` re-fires — the shred-is-not-a-domain-delete property `_writeTombstone` protects);
 * aggregate-grain rollups are RECOMPUTED without the forgotten contribution in open periods, or
 * skip+audit (via `putDerivedOutput`, already wired into the rollup/MV output paths) in frozen
 * ones. Mutates `stats` in place. `envelope` is `ref`'s PRE-tombstone envelope, decoded only if
 * a rollup edge is actually present — the #553 zero-cost-skip discipline: no decrypt for the
 * common case of a forgotten record with no aggregate-grain consumer, and no work at all when
 * `ref.collection` has no graph out-edges. `lookupCompareKeys` is the `'ref'` edges' compare-key
 * map, resolved from the LIVE row BEFORE any shred (`VaultLinks.checkLookupRefsRestrict`'s return
 * value — `Vault.forget()`'s pre-shred restrict check doubles as the live-resolve pass) — see
 * {@link applyLookupRefsFanout}.
 */
export async function forgetDerivedFanout(
  vault: VaultLike,
  ref: { readonly collection: string; readonly id: string },
  envelope: EncryptedEnvelope | null,
  stats: ForgetFanoutStats,
  lookupCompareKeys: ReadonlyMap<string, string | undefined>,
): Promise<void> {
  const edges = vault.graph.derivedArtifactsOf(ref.collection)
  if (edges.length === 0) return

  const coll = vault._getCollection(ref.collection)
  if (!coll) return

  // #650 Task 5 (#648) — 'ref' cascade/nullify propagate ADDITIVELY, here, AFTER the shred
  // (restrict already refused BEFORE any shred — the caller's pre-tombstone check, spec §4).
  // Duplicated (not imported) from `VaultLinks.applyLookupRefsPropagation`/`checkLookupRefsRestrict`
  // (with-shape/links/vault-facade.ts) — the kernel spine may not statically import a with-*
  // service (port-layering, the #638 Task 5 via-dispatch.ts precedent). A referencing edge whose
  // dimension uses a non-default `key` (matrix tier only) needs the backing row's OWN value at
  // that field, not its PUT-id — the row is ALREADY tombstoned by now, so it's read from
  // `lookupCompareKeys`, resolved by the caller from the LIVE row BEFORE the shred (#650 Task 5
  // review, Important fix — eliminates the post-shred envelope-decode dependency this used to
  // have, which silently skipped propagation whenever that decode failed).
  if (edges.some((e) => e.kind === 'ref')) {
    const { cascaded, nullified, residue } = await applyLookupRefsFanout(vault, ref.collection, ref.id, lookupCompareKeys)
    stats.lookupReferencesCascaded += cascaded
    stats.lookupReferencesNullified += nullified
    stats.lookupReferencesResidue.push(...residue)
  }

  if (edges.some((e) => e.kind === 'mv')) {
    stats.recordsErased += await coll.dispatchMaterializedViewsOnDelete(ref.id)
  }
  if (edges.some((e) => e.kind === 'derivation')) {
    // #622 review Finding 1: count REAL erasures (dispatchArrayDerivationsOnDelete's own
    // `_internalDelete`-backed tally), not the derivation EDGE count — an edge exists whenever
    // this collection is ANY trigger (source/sources[]/triggerBy), but the same-id record-shape
    // guard only erases for `spec.source === this.name`, and `derive()` may never have produced
    // an output row (optional-skip) in the first place. Both cases must contribute 0, not +1.
    stats.recordsErased += await coll.dispatchArrayDerivationsOnDelete(ref.id, true)
  }

  if (envelope && edges.some((e) => e.kind === 'rollup')) {
    const priorRecord = await coll._decodeEnvelope(envelope, ref.id)
    if (priorRecord) {
      for (const r of await coll.dispatchRollupsOnDelete(ref.id, priorRecord)) {
        if (r.outcome === 'written') stats.aggregatesRecomputed += 1
        else if (r.outcome === 'skipped-frozen') stats.residueFrozen.push(`${r.into}:${r.parentId}`)
      }
    }
  }
}

/**
 * Apply `cascade`/`nullify` propagation for `backing`'s non-restrict `'ref'` edges — the
 * forget-path counterpart of `VaultLinks.applyLookupRefsPropagation` (duplicated, not imported —
 * see {@link forgetDerivedFanout}'s call site comment). `restrict` edges are skipped here: the
 * forget loop's `checkLookupRefsRestrict`-equivalent call already refused (or the reference no
 * longer existed) BEFORE `_writeTombstone` ran, so by the time this runs only cascade/nullify
 * remain to propagate. `compareKeys` is the non-`'id'`-`keyField` compare-value map, resolved by
 * the caller from the LIVE row BEFORE the shred (#650 Task 5 review, Important fix) — the live row
 * is already shredded by the time THIS function runs, so it can no longer resolve one itself. A
 * `keyField` absent from (or `undefined` in) the map means that live resolve failed too — the edge
 * is reported as residue instead of silently skipped (never a bare `continue` with no trace).
 */
async function applyLookupRefsFanout(
  vault: VaultLike,
  backing: string,
  key: string,
  compareKeys: ReadonlyMap<string, string | undefined>,
): Promise<{ cascaded: number; nullified: number; residue: string[] }> {
  let cascaded = 0
  let nullified = 0
  const residue: string[] = []
  for (const { referencing, onDelete, keyField } of vault.graph.referencingEdgesOf(backing)) {
    if (onDelete === 'restrict') continue
    const compareKey = keyField === 'id' ? key : compareKeys.get(keyField)
    if (compareKey === undefined) {
      residue.push(`${backing}:${key}:${referencing.collection}.${referencing.field}`)
      continue
    }
    const coll = vault._getCollection(referencing.collection)
    if (!coll) continue
    const matches = (await coll.list()).filter((rec) => String(rec[referencing.field]) === compareKey)
    for (const rec of matches) {
      const id = rec['id'] as string | undefined
      if (id === undefined) continue
      if (onDelete === 'cascade') {
        await coll.delete(id)
        cascaded++
      } else if (onDelete === 'nullify') {
        await coll.put(id, { ...rec, [referencing.field]: null })
        nullified++
      }
    }
  }
  return { cascaded, nullified, residue }
}
