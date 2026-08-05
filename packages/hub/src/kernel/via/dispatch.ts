// kernel/via/dispatch.ts — the batched, origin-aware sync/cutover/restore dispatch wave
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
// See design-history/2026-07-11-via-phase-c-design.md §3.

import type { ViaGraph } from './graph.js'
import type { Collection } from '../collection.js'
import type { EncryptedEnvelope } from '../types.js'
import { PeriodClosedError } from '../errors.js'
import { matchesReferencingValue } from '../../port/with/lookup-strategy.js'

/** One deleted child's resolved rollup PARENT intent (#640) — ids + a field name only. A
 *  resolved `parentId` is an id, same class as any touched record id — never a stored value. */
export interface RollupDeleteIntent {
  readonly into: string
  readonly parentId: string
  readonly field: string
}

/** One collection's batched touches this session (#640 widens the #638 `Set<string>` shape):
 *  `puts` — the original semantics, unchanged; `deletes` — a deleted record's id mapped to its
 *  resolved rollup-parent intents, captured PRE-invalidation by `Collection._onRecordMutated`'s
 *  sync-apply delete case (the FK is only readable there — see `kernel/collection.ts
 *  #_rollupDeleteIntents`). */
export interface GraphTouch {
  readonly puts: Set<string>
  readonly deletes: Map<string, readonly RollupDeleteIntent[]>
}

/** Per-session touched set — collection → its `GraphTouch`. Metadata only — ids (collection
 *  names, record ids INCLUDING resolved rollup parent ids) and field names; NEVER record payload
 *  or key material. A resolved parentId is an id, same class as the touched ids — not a stored
 *  value. */
export type GraphBatch = Map<string, GraphTouch>

/** Get-or-create `batch`'s `GraphTouch` entry for `collection` (#640) — shared by
 *  `Vault._collectGraphTouch`/`_collectGraphDelete` so each stays a one-line call. */
export function touchFor(batch: GraphBatch, collection: string): GraphTouch {
  let t = batch.get(collection)
  if (!t) {
    t = { puts: new Set(), deletes: new Map() }
    batch.set(collection, t)
  }
  return t
}

/** #640 — sync, I/O-free: `deleted`'s resolved rollup PARENT intents (the FK is only readable
 *  NOW, before the record is gone) — a pure function so `Collection._rollupDeleteIntents` stays
 *  a one-line delegator under the kernel-surface ceiling. `registry` is `this.derivationSource
 *  ?.registry()`; `collectionName` is `this.name` (the CHILD/`rollup.from` side). Generic over
 *  the registry's own spec shape so this file never imports a `with-formula` type (port-layering
 *  — via/dispatch.ts must not gain a with-* import). */
export function resolveRollupDeleteIntents<S extends { source: string; rollup?: { from: string; key: string; field: string } }>(
  registry: { strategiesForSource(name: string): ReadonlyArray<{ spec: S }> } | undefined,
  collectionName: string,
  deleted: Record<string, unknown>,
): RollupDeleteIntent[] {
  if (!registry) return []
  const intents: RollupDeleteIntent[] = []
  for (const { spec } of registry.strategiesForSource(collectionName)) {
    if (!spec.rollup || spec.rollup.from !== collectionName) continue
    const kv = deleted[spec.rollup.key]
    if (typeof kv === 'string' || typeof kv === 'number') intents.push({ into: spec.source, parentId: String(kv), field: spec.rollup.field })
  }
  return intents
}

/** #640 — resolve a `RollupDeleteIntent` back to its registry `spec`. The wave's per-intent
 *  driver needs `spec.rollup.compute`, which `GraphBatch`'s metadata-only pin forbids batching —
 *  so it's re-resolved here, post-boundary, instead of carried across it. `undefined` if the
 *  intent's originating strategy was unregistered between collect time and wave time (residual
 *  gap, freshness-only). */
export function findRollupSpecForIntent<S extends { source: string; rollup?: { from: string; field: string } }>(
  registry: { strategiesForSource(name: string): ReadonlyArray<{ spec: S }> } | undefined,
  collectionName: string,
  intent: RollupDeleteIntent,
): S | undefined {
  return registry?.strategiesForSource(collectionName).find((s) => s.spec.source === intent.into && s.spec.rollup?.field === intent.field && s.spec.rollup?.from === collectionName)?.spec
}

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
  /** #640 (#644 item 3) — structured wave-error surfacing, additive to the existing console.warn. */
  _emit(event: string, payload: unknown): void
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
  for (const [collectionName, touch] of batch) {
    if (vault.graph.dependentsOf(collectionName).length === 0) continue
    const coll = vault._getCollection(collectionName)
    if (!coll) continue
    for (const id of touch.puts) {
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
        // #644 item 3: ADDITIVELY (never in place of the warn) emit a structured event too,
        // so a listener doesn't have to scrape console output to react to a wave failure.
        console.warn(`[via-dispatch] wave recompute failed for ${collectionName}/${id}:`, err)
        vault._emit('derivation:wave-error', { collection: collectionName, id, error: err })
      }
    }
    // #640 — delete-kind touches: the deleted child's rollup-parent intents, resolved (sync,
    // pre-invalidation) at collect time by `Collection._rollupDeleteIntents`. Same per-id
    // isolation as the puts loop above. #658: the wave now ALSO heals MV rows and array-shape
    // derivation output rows for the deleted child — parity with the local-delete boundary
    // (`Collection._doDelete`'s `!internal` block, which already calls all three). Still never
    // routed through `dispatchDerivations` (the mutation-choke-point.test.ts:85-99 pin — sync-
    // applied deletes never RE-DERIVE); `dispatchMaterializedViewsOnDelete`/
    // `dispatchArrayDerivationsOnDelete` only need `id` (MV refresh recomputes+diffs; array-
    // derivation reads its per-source sidecar) and never call `derive()`, so the pin holds.
    for (const [id, intents] of touch.deletes) {
      try {
        await coll._recomputeDeletedRollups(intents, wave)
        // #658: record-shape same-id outputs are left untouched (eraseRecordShapeToo defaults
        // false), matching local delete — the user deletes those directly if wanted.
        // #658: TODO dedup MV refresh per wave — `dispatchMaterializedViewsOnDelete` doesn't
        // accept a `WaveContext` (unlike the put-path `dispatchMaterializedViews`), so N deleted
        // children of one eager MV in a batch each trigger a full refresh pass. Threading `wave`
        // through would touch collection.ts's zero-slack kernel-surface ceiling for a perf-only
        // win; correctness doesn't depend on it (idempotent per source-id) — left as a follow-up.
        await coll.dispatchMaterializedViewsOnDelete(id)
        await coll.dispatchArrayDerivationsOnDelete(id)
      } catch (err) {
        console.warn(`[via-dispatch] wave delete-recompute failed for ${collectionName}/${id}:`, err)
        vault._emit('derivation:wave-error', { collection: collectionName, id, error: err })
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
  /** #776/#782/#785 — `outputCollection:id` MV-output rows that survived erasure invalidation
   *  (eager tombstone leg AND lazy/manual `invalidateMVAtRest`) despite belonging to the
   *  forgotten subject, because the ownership stamp could not be decoded (undecodable under
   *  the default DEK — e.g. elevated above tier 0 on a tiered output collection). Ownership
   *  UNCONFIRMED. Never erased, but surfaced here rather than silently skipped. */
  readonly derivedResidueUndecodable: string[]
  /** #782/#785 — `outputCollection:id` MV-output rows that decoded and stamp-matched but whose
   *  `_internalDelete` declined (the #718 tier-elevation gate). Ownership CONFIRMED, erasure
   *  declined — a real silent survival, surfaced here rather than silently skipped. */
  readonly derivedResidueDeclined: string[]
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
  const coll = vault._getCollection(ref.collection)

  // #761 item 4 — drive the MV arm off `dispatchMaterializedViewsOnDelete` UNCONDITIONALLY,
  // ABOVE the `edges` check below: `registry.edges()` drops the same-collection
  // partition-disjoint MV edge (registry.ts's `sources.length === 0 → continue`), so a
  // same-collection MV's source collection never appears in `vault.graph`'s derived-artifact
  // edges even though the MV IS registered — forget() would otherwise never reach it.
  // `dispatchMaterializedViewsOnDelete` self-guards O(1) via `mvsForSource` (a no-op when
  // this collection isn't an MV source), so this is safe to call unconditionally. Safe to
  // route through the eager executor's tombstone leg ONLY because that leg is now
  // stamp-scoped (#762) — before that fix this would have opened a NEW forget-time
  // data-loss path into the unscoped tombstone diff.
  if (coll) {
    const mv = await coll.dispatchMaterializedViewsOnDelete(ref.id)
    stats.recordsErased += mv.deleted
    stats.derivedResidueUndecodable.push(...mv.residueUndecodable)
    stats.derivedResidueDeclined.push(...mv.residueDeclined)
  }

  const edges = vault.graph.derivedArtifactsOf(ref.collection)
  if (edges.length === 0 || !coll) return

  // #650 Task 5 (#648) — 'ref' cascade/nullify propagate ADDITIVELY, here, AFTER the shred
  // (restrict already refused BEFORE any shred — the caller's pre-tombstone check, spec §4).
  // The I/O shell (loop shape, collection accessor) is duplicated, not imported, from
  // `VaultLinks.applyLookupRefsPropagation`/`checkLookupRefsRestrict` (with-shape/links/
  // vault-facade.ts) — the kernel spine may not statically import a with-* service
  // (port-layering, the #638 Task 5 via/dispatch.ts precedent); `vault._getCollection` is
  // cached-only while `VaultLinks`' accessor constructs. The pure match predicate itself is
  // shared through the port seam (#651 Task 3 — `matchesReferencingValue`, `port/with/
  // lookup-strategy.ts`), so only the shell, not the coercion logic, stays duplicated. A
  // referencing edge whose dimension uses a non-default `key` (matrix tier only) needs the
  // backing row's OWN value at that field, not its PUT-id — the row is ALREADY tombstoned by
  // now, so it's read from `lookupCompareKeys`, resolved by the caller from the LIVE row
  // BEFORE the shred (#650 Task 5 review, Important fix — eliminates the post-shred
  // envelope-decode dependency this used to have, which silently skipped propagation whenever
  // that decode failed).
  if (edges.some((e) => e.kind === 'ref')) {
    const { cascaded, nullified, residue } = await applyLookupRefsFanout(vault, ref.collection, ref.id, lookupCompareKeys)
    stats.lookupReferencesCascaded += cascaded
    stats.lookupReferencesNullified += nullified
    stats.lookupReferencesResidue.push(...residue)
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
 * forget-path counterpart of `VaultLinks.applyLookupRefsPropagation` (I/O shell duplicated, not
 * imported, match predicate shared via the port — see {@link forgetDerivedFanout}'s call site
 * comment). `restrict` edges are skipped here: the
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
    const matches = (await coll.list()).filter((rec) => matchesReferencingValue(rec, referencing.field, compareKey))
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

/**
 * Value-equality for a single self-write reverse-denorm field. Scalars
 * compare by identity; objects by canonical JSON (denorm values should be
 * deterministically shaped). Used as the cycle guard — when every denorm
 * field already matches, no write is issued and the self-write recursion ends.
 */
export function selfWriteFieldEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
