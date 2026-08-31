/**
 * Derivation dispatch, lifted out of the kernel spine (#842 part b).
 *
 * `Collection` carried ~380 lines of dispatch logic that belongs to the
 * derivation service, not to the always-on kernel. These are free functions
 * taking an explicit context so the spine keeps only a thin delegator.
 *
 * ## How the spine reaches this module
 *
 * By dynamic `import()`, never a static one. `check-architecture.mjs`'s
 * `port-layering` check forbids the spine from statically importing a
 * `with-*` service; `collection.ts` is grandfathered for ten
 * `with-formula/*` specifiers, but that list is frozen per file and a new
 * one is a violation. A dynamic import is the sanctioned S4 gate recipe, and
 * it keeps this chunk out of the floor bundle for consumers who never fire a
 * derivation.
 *
 * The `Collection` type reference below points back at the spine. That is
 * inward (service → kernel) and so allowed, and it is TYPE-ONLY — erased at
 * build, so no runtime cycle exists.
 *
 * @internal
 */

import type { NoydbStore } from '../../kernel/types.js'
import type { TxContext } from '../../with-commit/tx/transaction.js'
import type { DerivationRegistry } from './registry.js'
import type { ReadOnlyVaultFacade } from '../../with-audit/guards/types.js'
import type { Collection } from '../../kernel/collection.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'
import type { EncryptedEnvelope } from '../../kernel/types.js'
import type { ledgerAuditHook, WaveContext } from '../../kernel/via/dispatch.js'
import { putDerivedOutput, selfWriteFieldEqual } from '../../kernel/via/dispatch.js'
import { DerivationCapExceededError } from '../../kernel/errors.js'
import { tupleFromWritten, sameTuple, resolveTuple, tupleFromIntermediate, hopCollections } from './trigger-match.js'
import { markStale } from './stale.js'
import type { DerivationExecutor } from './executor.js'

/** The per-write dispatch context threaded into `putDerivedOutput`. */
interface DispatchCtx {
  emit: (e: string, p: unknown) => void
  source: { readonly collection: string; readonly id: string }
  audit: ReturnType<typeof ledgerAuditHook>
}

/**
 * What the dispatchers need from the collection that owns them. Passing this
 * explicitly is what lets the logic live outside the class.
 */
export interface DerivationDeleteCtx {
  readonly derivationSource: {
    registry(): DerivationRegistry
    getCollection(name: string): Collection<Record<string, unknown>>
    getActiveTxContext(): TxContext | null
    getReadOnlyFacade(): ReadOnlyVaultFacade
  }
  /** The collection the delete happened in. */
  readonly collectionName: string
  readonly adapter: NoydbStore
  readonly vault: string
  readonly getDEK: (collectionName: string) => Promise<EnclaveKey>
  readonly storeCiphertext: boolean
}

/**
 * Erase the derived rows a deleted source record fanned out to, and drop the
 * fan-out sidecars that recorded them.
 *
 * @param eraseRecordShapeToo also erase same-id `shape: 'record'` outputs.
 *   Restricted to a source-triggered strategy writing into a DIFFERENT
 *   collection — the self-denorm case would re-delete the record just
 *   tombstoned, and triggerBy/sibling strategies derive under a different id.
 * @returns rows ACTUALLY deleted, not edges visited (#622).
 */
export async function dispatchArrayDerivationsOnDelete(
  ctx: DerivationDeleteCtx,
  id: string,
  eraseRecordShapeToo = false,
): Promise<number> {
  const { derivationSource, collectionName, adapter, vault, getDEK, storeCiphertext } = ctx

  const strategies = derivationSource.registry().strategiesForSource(collectionName)
  if (strategies.length === 0) return 0

  const { loadFanoutSidecar, deleteFanoutSidecar } = await import('./fanout-sidecar.js')
  const txCtx = derivationSource.getActiveTxContext()
  let erased = 0

  for (const { spec } of strategies) {
    for (const [outputKey, outSpec] of Object.entries(spec.outputs)) {
      if (outSpec.shape === 'record') {
        if (eraseRecordShapeToo && spec.source === collectionName && outSpec.collection !== collectionName) {
          if (await derivationSource.getCollection(outSpec.collection)._internalDelete(id, txCtx)) erased += 1
        }
        continue
      }

      const sidecar = await loadFanoutSidecar(adapter, vault, spec.source, id, outputKey, getDEK, storeCiphertext)
      if (!sidecar) continue

      const outputCollection = derivationSource.getCollection(outSpec.collection)
      for (const derivedId of sidecar.keys) {
        if (await outputCollection._internalDelete(derivedId, txCtx)) erased += 1
      }
      await deleteFanoutSidecar(adapter, vault, spec.source, id, outputKey)
    }
  }

  return erased
}

/** Adds what the on-write derivation dispatch needs beyond the delete path. */
export interface DerivationDispatchCtx extends DerivationDeleteCtx {
  /** Via pipeline, for decoding the stored form back to canonical money shape. */
  readonly via: { canonicalizeStored(r: Record<string, unknown>): Record<string, unknown> } | undefined
  /** Recompute a rollup aggregate onto a parent. Stays on the spine — it walks collections. */
  readonly recomputeRollup: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spec: any,
    parentId: string,
    source: { readonly collection: string; readonly id: string },
    wave?: WaveContext,
  ) => Promise<unknown>
  /** Builds the per-write dispatch context threaded into `putDerivedOutput`. */
  readonly dispatchCtx: (source: { readonly collection: string; readonly id: string }) => DispatchCtx
  /** Registers a write on the active transaction for rollback. */
  readonly trackPut: (txCtx: TxContext, collectionName: string, id: string, priorEnvelope: EncryptedEnvelope | null) => void
}

/**
 * Fire registered derivation strategies for this source collection.
 *
 * Eager mode runs `derive` inline and writes each output; lazy mode records a
 * stale mark for cold-session recompute. Rollups are handled here rather than
 * by the executor — a write to the child recomputes the parent aggregate, and
 * a write to the parent recomputes its own.
 */
export async function dispatchDerivations(
  ctx: DerivationDispatchCtx,
  id: string,
  record: Record<string, unknown>,
  version: number,
  wave?: WaveContext,
  /** The pre-write record at `id` in THIS collection (undefined = not
   *  captured — no field-match trigger, or a sync-applied wave; null =
   *  captured and absent, i.e. a create). Only a `Record` re-fires the OLD
   *  matched set alongside the new one (spec §7). */
  prior?: Record<string, unknown> | null,
): Promise<void> {
  const { derivationSource, collectionName, via, recomputeRollup } = ctx

  // `record` is the stored form here (post-quantize) — decode so
  // derive(source, ctx) sees the canonical money shape.
  const incoming = (via ? via.canonicalizeStored(record) : record)
  if (incoming && typeof incoming === 'object' && '_derivedFrom' in incoming) return
  // `prior` is the raw stored pre-write record — canonicalize it the same
  // way as `incoming` before it feeds `tupleFromWritten` below, or a
  // via-shaped match field (e.g. a money field) compares canonical against
  // raw and never matches the old tuple (Min 5).
  const canonicalPrior = prior != null ? (via ? via.canonicalizeStored(prior) : prior) : prior
  const registry = derivationSource.registry()
  const strategies = registry.strategiesForSource(collectionName)
  if (strategies.length === 0) return
  // Dynamic-import the executor only on the first eager-mode
  // dispatch. Lazy-mode dispatches use `markStale` (a pure helper)
  // which doesn't reach into the executor at all. Keeps the
  // derivation executor chunk out of the floor bundle for any
  // consumer that doesn't fire an eager derivation.
  let executorClass: typeof DerivationExecutor | null = null
  for (const { spec, strategyHash, triggers } of strategies) {
    const mode = typeof spec.lifecycle === 'string' ? spec.lifecycle : spec.lifecycle.mode

    // Rollup: a write to the child `from` recomputes the
    // parent at id child[key]; a write to the parent (source = into)
    // recomputes its own aggregate. Handled here (the executor is not run).
    if (spec.rollup) {
      if (mode !== 'eager') continue
      const asParentId = (v: unknown): string | null =>
        (typeof v === 'string' || typeof v === 'number') ? String(v) : null
      let parentId: string | null
      // #1257 — a child that RE-PARENTS strands the old parent's aggregate
      // unless the old key is recomputed too. Reads the prior stored record
      // (canonicalized alongside `incoming`, so a via-shaped key compares like
      // for like). `undefined` prior — a sync-applied wave write or a tiers
      // restore, which do not thread it — degrades to new-parent-only, the
      // pre-#1257 behaviour, rather than guessing.
      let oldParentId: string | null = null
      if (collectionName === spec.rollup.from) {
        parentId = asParentId(incoming[spec.rollup.key])
        const priorKey = canonicalPrior != null ? asParentId(canonicalPrior[spec.rollup.key]) : null
        if (priorKey !== null && priorKey !== parentId) oldParentId = priorKey
      } else {
        parentId = id // a write to the parent recomputes its own aggregate
      }
      if (parentId !== null) await recomputeRollup(spec, parentId, { collection: collectionName, id }, wave)
      // The old parent is recomputed AFTER the new one so a `maxFanout`-style
      // failure on the new parent surfaces before extra work is spent.
      if (oldParentId !== null) await recomputeRollup(spec, oldParentId, { collection: collectionName, id }, wave)
      continue
    }

    // Determine how `collectionName` triggers this strategy, and build the list
    // of source records to (re-)derive:
    //   • source     — re-derive the written record itself (same-id).
    //   • sources[]  — re-derive the PRIMARY source at the same id.
    //   • triggerBy  — FK fan-out: re-derive every source record
    //                  whose `on` field equals the written parent's id.
    // `input` is passed to derive(); `base` is the raw stored source record
    // used as the patch base for a self-write reverse-denorm output.
    const isSource = spec.source === collectionName
    const isSibling = !isSource && (spec.sources?.includes(collectionName) ?? false)
    const triggerEntries = !isSource && !isSibling
      ? triggers.filter((t) => t.collection === collectionName)
      : []
    // #1277 option 2 — a write to an INTERMEDIATE collection fires the trigger
    // too. Without this, re-pointing the intermediate strands every source it
    // used to address: nothing is written to the trigger or source collection,
    // so no other path can notice. Kept separate from `triggerEntries` because
    // the tuple is derived differently (the intermediate IS the written record,
    // so no lookup is needed).
    const hopEntries = !isSource && !isSibling
      ? triggers.filter((t) => hopCollections(t.match).includes(collectionName))
      : []

    const runs: Array<{
      input: Record<string, unknown> & { id: string }
      base: Record<string, unknown>
      runId: string
      version: number
    }> = []

    if (isSource) {
      runs.push({ input: { ...incoming, id }, base: incoming, runId: id, version })
    } else if (isSibling) {
      const p = await derivationSource.getCollection(spec.source).get(id)
      if (p !== null && p !== undefined) {
        // Raw base for a (rare) sibling self-write; falls back to the
        // resolved primary if the raw read misses.
        const raw = await derivationSource.getCollection(spec.source)._getStoredRecord(id)
        runs.push({ input: { ...p, id }, base: raw ?? p, runId: id, version: 0 })
      }
    } else if (triggerEntries.length > 0 || hopEntries.length > 0) {
      const srcColl = derivationSource.getCollection(spec.source)
      const matched = new Set<string>()
      // One lookup per hop per written record — `take: 'id'` is a direct get,
      // anything else is a single field match on the intermediate. Never per
      // candidate row (#1266's bound).
      const lookup = async (coll: string, field: string, value: string): Promise<Record<string, unknown> | null> => {
        const c = derivationSource.getCollection(coll)
        if (field === 'id') return c._getStoredRecord(value)
        const ids = await c._findMatchingCompositeIds([{ field, value }])
        const first = ids[0]
        return first === undefined ? null : c._getStoredRecord(first)
      }
      // A write to an intermediate collection: fan out on its old ∪ new value.
      // The prior record is the intermediate's own, so #1249's capture already
      // supplies it — the same mechanism, pointed at a third collection.
      for (const trigger of hopEntries) {
        const tuples = [tupleFromIntermediate(trigger.match, collectionName, incoming)]
        if (canonicalPrior != null) {
          const old = tupleFromIntermediate(trigger.match, collectionName, canonicalPrior)
          if (!sameTuple(old, tuples[0]!)) tuples.push(old)
        }
        const ids = new Set<string>()
        for (const tuple of tuples) {
          if (tuple === null) continue
          for (const sid of await srcColl._findMatchingCompositeIds(tuple)) ids.add(sid)
        }
        if (trigger.maxFanout !== undefined && ids.size > trigger.maxFanout) {
          throw new DerivationCapExceededError(
            `triggerBy hop ${collectionName}→${spec.source} [${trigger.match.map(p => p.to).join(',')}]`,
            ids.size, trigger.maxFanout)
        }
        for (const sid of ids) matched.add(sid)
      }
      for (const trigger of triggerEntries) {
        // Union fan-out (spec §7): an update changing any matched component
        // must re-fire BOTH the old and the new matched set, or the old
        // set's derived output goes stale (never re-derived once it no
        // longer matches). `prior` is only ever a `Record` here — a wave
        // dispatch and a create both skip the old tuple outright.
        const tuples = [await resolveTuple(trigger.match, id, incoming, lookup)]
        if (canonicalPrior != null && trigger.match.some((p) => p.from !== 'id')) {
          const old = await resolveTuple(trigger.match, id, canonicalPrior, lookup)
          if (!sameTuple(old, tuples[0]!)) tuples.push(old)
        }
        const ids = new Set<string>()
        for (const tuple of tuples) {
          if (tuple === null) continue   // a from-value is absent/non-scalar: matches nothing
          for (const sid of await srcColl._findMatchingCompositeIds(tuple)) ids.add(sid)
        }
        if (trigger.maxFanout !== undefined && ids.size > trigger.maxFanout) {
          throw new DerivationCapExceededError(
            `triggerBy ${collectionName}→${spec.source} [${trigger.match.map(p => p.to).join(',')}]`,
            ids.size, trigger.maxFanout)
        }
        for (const sid of ids) matched.add(sid)
      }
      for (const sid of matched) {
        const raw = await srcColl._getStoredRecord(sid)
        if (raw === null) continue
        runs.push({ input: { ...raw, id: sid }, base: raw, runId: sid, version: 0 })
      }
    }

    if (runs.length === 0) continue

    if (mode !== 'eager') {
      for (const run of runs) await markStale(registry, spec, run.runId)
      continue
    }

    if (executorClass === null) {
      ;({ DerivationExecutor: executorClass } = await import('./executor.js'))
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const run of runs) await runOne(ctx, spec as any, strategyHash, executorClass, run)
  }
}

/**
 * Run the executor for one (spec, run) pair and write its outputs. Shared by
 * `dispatchDerivations`' eager loop and `dispatchTriggerDerivationsOnDelete`
 * (#1249) — the write-out logic (array diff, record self-write reverse-denorm,
 * normal record output) is identical for a live write and a delete-triggered
 * re-derive; only how `runs` gets built differs.
 */
async function runOne(
  ctx: DerivationDispatchCtx,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spec: any,
  strategyHash: string,
  executorClass: typeof DerivationExecutor,
  run: { input: Record<string, unknown> & { id: string }; base: Record<string, unknown>; runId: string; version: number },
): Promise<void> {
  const { derivationSource, adapter, vault, getDEK, storeCiphertext, dispatchCtx, trackPut } = ctx
  const execCtx = { vault: derivationSource.getReadOnlyFacade() }
  const outCtx = dispatchCtx({ collection: spec.source, id: run.runId })
  const result = await executorClass.run(spec, run.input, run.version, strategyHash, execCtx)
  for (const key of Object.keys(spec.outputs)) {
    const out = result.outputs[key]
    if (!out) continue
    if (out.kind === 'failed') {
      const err = out.error
      if (spec.strict) throw err
      console.warn(`[derivation] output "${key}" for source "${spec.source}" id="${run.runId}" failed:`, err)
      continue
    }
    const outSpec = spec.outputs[key]
    if (!outSpec) continue
    const outputCollection = derivationSource.getCollection(outSpec.collection)
    // If we're inside a multi-record transaction, register
    // derived writes as side-effect ops on the active ctx
    // BEFORE they fire. `revertExecuted` walks `_executed` in
    // reverse on rollback, so capturing the pre-write envelope
    // here lets a later mid-batch failure restore this output's
    // prior state alongside the source op. Outside a transaction
    // the context is null and tracking is skipped.
    const txCtx = derivationSource.getActiveTxContext()

    // ── Array-shape branch ─────────────────────────────────
    if (out.kind === 'array') {
      // Load the prior key set from the fanout sidecar.
      const { loadFanoutSidecar, saveFanoutSidecar } = await import('./fanout-sidecar.js')
      const prior = await loadFanoutSidecar(adapter, vault, spec.source, run.runId, key, getDEK, storeCiphertext)
      const prevKeys = new Set<string>(prior?.keys ?? [])
      const newKeysList = out.entries.map((e: { key: string }) => e.key)
      const newKeysSet = new Set<string>(newKeysList)

      // Diff — delete keys that were in prev but not in new.
      for (const k of prevKeys) {
        if (newKeysSet.has(k)) continue
        await outputCollection._internalDelete(k, txCtx)
      }

      // Upsert every entry in the new set. (Slice 1: no
      // identity-skip optimisation; write every row, idempotent
      // at the (collection, id) level.)
      for (const entry of out.entries) {
        if (txCtx !== null) {
          trackPut(txCtx, outSpec.collection, entry.key, await adapter.get(vault, outSpec.collection, entry.key))
        }
        await putDerivedOutput(outputCollection, entry.key, entry.value, outCtx, { source: 'derived' })
      }

      // Persist the new key set last, for failure-mode symmetry.
      await saveFanoutSidecar(adapter, vault, {
        source: spec.source,
        sourceId: run.runId,
        outputKey: key,
        outputCollection: outSpec.collection,
        keys: newKeysList,
      }, getDEK, storeCiphertext)
      continue
    }

    // ── Record-shape branch ────────────────────────────────
    if (out.skipped === true) {
      // Optional output returned null. Delete the
      // previously-emitted output at this id, if any. Routed
      // through `_internalDelete` so a user-registered
      // `onDelete` on the output collection does NOT
      // fire — this is a system-internal tombstone, not a
      // user-initiated delete. The txCtx hookup captures the
      // prior envelope inside `_internalDelete` for rollback
      // symmetry; delete-of-absent is a silent no-op.
      await outputCollection._internalDelete(run.runId, txCtx)
      continue
    }

    // ── Self-write reverse-denorm ───────────────────────────
    // An output back to its own source: patch ONLY the declared
    // `denorm` fields onto the raw stored record, never the whole
    // value (which would clobber user fields / i18n maps and carries
    // the executor's `_derivedFrom` tag). If the patch changes
    // nothing, skip the write — that value-equality is the cycle
    // guard: the self-write re-fires the source-path derivation,
    // which recomputes identical fields and terminates here.
    if (outSpec.shape === 'record' && outSpec.denorm !== undefined && outSpec.collection === spec.source) {
      const value = out.value
      const patched: Record<string, unknown> = { ...run.base }
      let changed = false
      for (const f of outSpec.denorm) {
        if (!selfWriteFieldEqual(run.base[f], value[f])) {
          patched[f] = value[f]
          changed = true
        }
      }
      if (!changed) continue // cycle guard — nothing to write
      if (txCtx !== null) {
        trackPut(txCtx, outSpec.collection, run.runId, await adapter.get(vault, outSpec.collection, run.runId))
      }
      await putDerivedOutput(outputCollection, run.runId, patched, outCtx, { source: 'derived' })
      continue
    }

    // ── Normal record output (separate output collection) ──
    if (txCtx !== null) {
      trackPut(txCtx, outSpec.collection, run.runId, await adapter.get(vault, outSpec.collection, run.runId))
    }
    await putDerivedOutput(outputCollection, run.runId, out.value, outCtx, { source: 'derived' })
  }
}

/**
 * Trigger fan-out for a DELETED parent record (#1249, spec §8). Distinct from
 * the "record-shape derivations not dispatched on delete" rule — that is
 * about deleting a SOURCE record; this fires when a TRIGGER collection's
 * record is deleted, re-deriving source records that still exist. Pairs
 * evaluate against the tombstoned record's values; matched sources re-derive
 * through the normal executor (their derive() reads the now-absent parent
 * and decides what that means — the engine never cascades deletes).
 */
export async function dispatchTriggerDerivationsOnDelete(
  ctx: DerivationDispatchCtx, id: string, deleted: Record<string, unknown>,
): Promise<void> {
  const { derivationSource, collectionName } = ctx
  const registry = derivationSource.registry()
  const strategies = registry.strategiesForSource(collectionName)
  if (strategies.length === 0) return
  let executorClass: typeof DerivationExecutor | null = null
  for (const { spec, strategyHash, triggers } of strategies) {
    if (spec.rollup) continue                                    // rollup-on-delete already exists
    if (spec.source === collectionName) continue                 // source delete: existing rule, untouched
    if (spec.sources?.includes(collectionName)) continue          // declared sibling source: same exclusion as the write path's isSibling check
    const entries = triggers.filter((t) => t.collection === collectionName)
    if (entries.length === 0) continue
    const mode = typeof spec.lifecycle === 'string' ? spec.lifecycle : spec.lifecycle.mode
    const srcColl = derivationSource.getCollection(spec.source)
    const matched = new Set<string>()
    for (const trigger of entries) {
      const tuple = tupleFromWritten(trigger.match, id, deleted)
      if (tuple === null) continue
      const ids = await srcColl._findMatchingCompositeIds(tuple)
      if (trigger.maxFanout !== undefined && ids.length > trigger.maxFanout) {
        throw new DerivationCapExceededError(
          `triggerBy ${collectionName}→${spec.source} [${trigger.match.map(p => p.to).join(',')}] (delete)`,
          ids.length, trigger.maxFanout)
      }
      for (const sid of ids) matched.add(sid)
    }
    if (matched.size === 0) continue
    if (mode !== 'eager') { for (const sid of matched) await markStale(registry, spec, sid); continue }
    if (executorClass === null) ({ DerivationExecutor: executorClass } = await import('./executor.js'))
    for (const sid of matched) {
      const raw = await srcColl._getStoredRecord(sid)
      if (raw === null) continue
      await runOne(ctx, spec, strategyHash, executorClass, { input: { ...raw, id: sid }, base: raw, runId: sid, version: 0 })
    }
  }
}
