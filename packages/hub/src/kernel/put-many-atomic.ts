/**
 * `Collection.putMany({ atomic: true })` — both commit strategies (#921).
 *
 * Extracted from `collection.ts` (kernel-surface budget) when the atomic
 * mode became the second consumer of the #904/#905 prepare/commit seam:
 *
 * - **Delegating branch** (#921): on a store that declares `txAtomic` AND
 *   implements `tx()`, with no duplicate id in the batch and
 *   `_txAtomicSafe('put')` on the collection, the batch is prepared via
 *   `_preparePut` (zero observable side effects), submitted as ONE
 *   `store.tx(ops)` call with per-leg CAS, then finalized via
 *   `_finalizePut` — same shape and failure semantics as #906's
 *   `commitAtomicBatch`: a `tx()` throw means the store applied NOTHING,
 *   so it rethrows without a revert pass; a finalize throw walks the
 *   existing revert path. History/ledger/cache/change events fire
 *   post-commit, in entry order.
 * - **Sequential branch** (pre-#921 behavior, unchanged): Phase-1
 *   pre-flight CAS, then per-entry `Collection.put()` with best-effort
 *   revert of executed ops (including nested derivation outputs, via the
 *   transient-TxContext mechanism) on mid-batch failure.
 *
 * The caller passes its private store/vault/name plus a structural view of
 * the collection ({@link PutManyAtomicHost}). Kernel spine file: it may
 * not import `with-commit` even type-only, so the transaction context it
 * shares with `dispatchDerivations` is typed STRUCTURALLY
 * ({@link BulkTxContext} — satisfied by the real `TxContext`), and reverts
 * go straight through the kernel-native `bestEffortRevert` (exactly what
 * `with-commit`'s `revertExecuted` does when handed no `db`).
 *
 * @internal
 */
import { ConflictError } from './errors.js'
import { bestEffortRevert } from './best-effort-revert.js'
import type { BestEffortRevertLeg } from './best-effort-revert.js'
import type { PreparedPut } from './prepared-write.js'
import type {
  EncryptedEnvelope,
  NoydbStore,
  PutManyItemOptions,
  PutManyResult,
  TxOp,
} from './types.js'

/** @internal Structural view of one executed op on a transaction context. */
interface BulkExecutedOp {
  readonly op: {
    readonly type: 'put' | 'delete'
    readonly vaultName: string
    readonly collectionName: string
    readonly id: string
  }
  readonly priorEnvelope: EncryptedEnvelope | null
}

/** @internal Structural slice of `with-commit`'s `TxContext` this module drives. */
interface BulkTxContext {
  readonly _executed: BulkExecutedOp[]
}

/** @internal The slice of `Collection` both branches drive. */
export interface PutManyAtomicHost<T> {
  put(id: string, record: T): Promise<void>
  _preparePut(id: string, record: T): Promise<PreparedPut<T>>
  _finalizePut(prepared: PreparedPut<T>): Promise<void>
  _fireAtomicAfterWrite(opType: 'put', prepared: PreparedPut<T>): Promise<void>
  _assertWriteGates(): Promise<void>
  _txAtomicSafe(opType: 'put' | 'delete'): boolean
  _invalidateCacheEntry(id: string): Promise<void>
}

/** @internal The owning collection's private coordinates + wiring. */
export interface PutManyAtomicContext<T> {
  readonly host: PutManyAtomicHost<T>
  readonly store: NoydbStore
  readonly vault: string
  readonly name: string
  readonly derivationSource?: {
    createTxContext(): BulkTxContext
    setActiveTxContext(ctx: BulkTxContext): void
    clearActiveTxContext(ctx: BulkTxContext): void
    getCollection(name: string): { _invalidateCacheEntry(id: string): Promise<void> }
  } | undefined
}

type PutManyEntries<T> = ReadonlyArray<readonly [id: string, record: T, opts?: PutManyItemOptions]>

const toRevertLeg = ({ op, priorEnvelope }: BulkExecutedOp): BestEffortRevertLeg => ({
  vaultName: op.vaultName,
  collectionName: op.collectionName,
  id: op.id,
  prior: priorEnvelope,
})

/** @internal Atomic-mode implementation of `Collection.putMany`. */
export async function runPutManyAtomic<T>(
  ctx: PutManyAtomicContext<T>,
  entries: PutManyEntries<T>,
): Promise<PutManyResult> {
  const { store, vault, name } = ctx
  // Phase 1 — pre-flight CAS + prior-envelope snapshot for revert. Shared by
  // both branches; the duplicate-id scan rides along because a single
  // `store.tx()` write set can't express "this key changes twice in sequence"
  // (same rule as `canCommitAtomically` condition 3).
  const priors = new Map<string, EncryptedEnvelope | null>()
  let duplicateId = false
  for (const [id, , opts] of entries) {
    if (priors.has(id)) duplicateId = true
    else priors.set(id, await store.get(vault, name, id))
    if (opts?.expectedVersion !== undefined) {
      const actual = priors.get(id)?._v ?? 0
      if (actual !== opts.expectedVersion) {
        throw new ConflictError(
          actual,
          `putMany atomic: ${vault}/${name}/${id} ` +
            `expected v${opts.expectedVersion}, found v${actual}`,
        )
      }
    }
  }
  // #921 — the single-collection puts-only reduction of the #906 gate:
  // store bits + no duplicate ids + `_txAtomicSafe('put')`.
  if (
    !duplicateId &&
    store.capabilities?.txAtomic === true &&
    typeof store.tx === 'function' &&
    ctx.host._txAtomicSafe('put')
  ) {
    return commitViaStoreTx(ctx, entries, priors)
  }
  return commitSequentially(ctx, entries, priors)
}

/**
 * The delegating branch — mirrors `commitAtomicBatch`
 * (`with-commit/tx/transaction.ts`); see that function's comments for the
 * reasoning each step leans on.
 *
 * @internal
 */
async function commitViaStoreTx<T>(
  ctx: PutManyAtomicContext<T>,
  entries: PutManyEntries<T>,
  priors: ReadonlyMap<string, EncryptedEnvelope | null>,
): Promise<PutManyResult> {
  const { host, store, vault, name } = ctx
  // The two refusals `put()` asserts before anything else (schema-update
  // gate + schema fence). One collection and prepare writes nothing, so a
  // single up-front assertion is equivalent to the wrapper's per-op one.
  await host._assertWriteGates()

  // ─── Prepare ─── zero observable side effects; a throw here needs no
  // unwind. The revert plan is recorded all the same for the finalize path.
  const executed: BulkExecutedOp[] = []
  const legs: Array<{ prepared: PreparedPut<T>; txOp: TxOp }> = []
  for (const [id, record] of entries) {
    const prior = priors.get(id) ?? null
    executed.push({ op: { type: 'put', vaultName: vault, collectionName: name, id }, priorEnvelope: prior })
    const prepared = await host._preparePut(id, record)
    legs.push({
      prepared,
      // Every leg carries CAS against the Phase-1 snapshot, so a writer
      // landing between prepare and the batch reaching the store loses.
      txOp: { type: 'put', vault, collection: name, id, expectedVersion: prior?._v ?? 0, envelope: prepared.envelope },
    })
  }

  // ─── The batch ─── deliberately NOT revert-guarded: a rejection means the
  // all-or-nothing store applied nothing, and no ledger/history/event has
  // fired yet. The error (`ConflictError` when a leg lost its CAS) surfaces
  // unwrapped.
  await store.tx!(legs.map(l => l.txOp))

  // ─── Finalize ─── history snapshot, ledger entry, cache/index update,
  // change event — per record, in entry order, all AFTER the bytes are
  // durable (where the sequential branch interleaves them per op). #931:
  // then the after-write observers, which no longer gate eligibility.
  try {
    for (const leg of legs) {
      await host._finalizePut(leg.prepared)
      await host._fireAtomicAfterWrite('put', leg.prepared)
    }
  } catch (err) {
    // Bytes ARE durable now — best-effort unwind over the recorded plan,
    // plus the same cache-desync guard the sequential branch runs.
    await bestEffortRevert(executed.map(toRevertLeg), store)
    for (const { op } of [...executed].reverse()) {
      try { await host._invalidateCacheEntry(op.id) } catch { /* best-effort */ }
    }
    throw err
  }
  return { ok: true, success: entries.map(([id]) => id), failures: [] }
}

/**
 * The sequential branch — pre-#921 `putManyAtomic` Phase 2, moved verbatim.
 *
 * When a derivation registry is wired, publish a transient TxContext for the
 * duration of the loop so `dispatchDerivations` can register recursive
 * derived-output writes onto `ctx._executed`; the revert then unwinds the
 * combined list (source ops + side-effect ops) in reverse, matching the
 * `runTransaction` rollback semantics. When no derivation registry is
 * configured, a local `executed` list keeps a single code path.
 *
 * @internal
 */
async function commitSequentially<T>(
  ctx: PutManyAtomicContext<T>,
  entries: PutManyEntries<T>,
  priors: ReadonlyMap<string, EncryptedEnvelope | null>,
): Promise<PutManyResult> {
  const { host, store, vault, name, derivationSource } = ctx
  const txCtx = derivationSource?.createTxContext() ?? null
  if (txCtx !== null && derivationSource) {
    derivationSource.setActiveTxContext(txCtx)
  }
  const localExecuted: BulkExecutedOp[] = []
  try {
    for (const [id, record] of entries) {
      // Record the revert plan BEFORE the call so a mid-`put` throw
      // (e.g. strict derivation failure firing after `store.put`
      // already committed the source envelope) still has the source
      // write reverted. Mirrors `runTransaction`'s Phase 2 pattern.
      const entry: BulkExecutedOp = {
        op: { type: 'put', vaultName: vault, collectionName: name, id },
        priorEnvelope: priors.get(id) ?? null,
      }
      if (txCtx !== null) txCtx._executed.push(entry)
      else localExecuted.push(entry)
      await host.put(id, record)
    }
    return { ok: true, success: entries.map(([id]) => id), failures: [] }
  } catch (err) {
    const executedForRevert = txCtx !== null ? txCtx._executed : localExecuted
    // Restore prior envelopes via the raw store — walks in reverse,
    // best-effort on each restore, one atomic batch when the store can
    // (#886). Same semantics as `revertExecuted` handed no `db`.
    await bestEffortRevert(executedForRevert.map(toRevertLeg), store)
    // Cache desync guard. The revert above bypasses the Collection layer,
    // so walk the executed ops and invalidate caches via the source
    // collection for entries that target it, and via
    // `derivationSource.getCollection(name)` for nested derived outputs
    // that live in sibling collections — otherwise an eager cache on a
    // derived-output collection still serves the rolled-back record.
    for (const { op } of [...executedForRevert].reverse()) {
      if (op.vaultName !== vault) continue
      try {
        if (op.collectionName === name) {
          await host._invalidateCacheEntry(op.id)
        } else if (derivationSource) {
          await derivationSource.getCollection(op.collectionName)._invalidateCacheEntry(op.id)
        }
      } catch { /* best-effort */ }
    }
    throw err
  } finally {
    if (txCtx !== null && derivationSource) {
      derivationSource.clearActiveTxContext(txCtx)
    }
  }
}
