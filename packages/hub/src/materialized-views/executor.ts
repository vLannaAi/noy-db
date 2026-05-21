import type { Collection } from '../collection.js'
import type { TxContext } from '../tx/transaction.js'
import type { EncryptedEnvelope } from '../types.js'
import type { MaterializedFromMeta, MVQueryContext } from './types.js'
import type { RegisteredMV } from './registry.js'

/**
 * Accessor shape passed in from the owning Vault. Mirrors v1's
 * `DerivationStaleAccessor` — provides the per-collection resolver
 * and the active TxContext so refresh writes/tombstones register on
 * `_executed` for #133-style rollback symmetry.
 */
export interface MVExecutorAccessor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getCollection(name: string): Collection<any>
  getActiveTxContext(): TxContext | null
  /**
   * Vault-shaped accessor passed to the MV's `query()` callback at
   * each refresh. Same instance the registry used at registration
   * time; threading through the executor lets the refresh path
   * re-evaluate the closure against the live vault state.
   */
  getQueryContext(): MVQueryContext
}

export interface RefreshResult {
  /** Rows newly written / overwritten. */
  written: number
  /**
   * Rows tombstoned via `_internalDelete`. Always 0 in this iteration
   * (foundation + lazy/manual sub-issues #150/#151); populated by
   * #152's `onEmpty: 'delete'` tombstoning pass. Forward-compat shape
   * so `vault.refreshView()` callers get a stable contract.
   */
  deleted: number
  /** Failed row writes (non-strict mode). */
  failed: number
}

/**
 * Run an MV's `query()` and write the result rows to the output
 * collection. Same-DEK encryption: routes through the standard
 * `Collection.put` pipeline, so the output collection's DEK is what
 * gets used (matches the v2 spec's "same DEK as the left-most source"
 * invariant — `Collection.put` looks up the DEK by collection name,
 * and the output collection IS the MV's owned collection).
 *
 * Stamps `_materializedFrom` onto every emitted row. Tombstones
 * (rows that disappear between refreshes) are NOT handled by this
 * function — that's `onEmpty: 'delete'` (subtask #152).
 *
 * @internal
 */
export const MaterializedViewExecutor = {
  /**
   * Full re-materialize. Invokes `spec.query()`, executes against
   * the live collection state, writes each result row through
   * `Collection.put` (id = `spec.rowKey(row)`).
   *
   * Returns counts; throws only on contract-level failures (rowKey
   * collisions surface as ordinary `Collection.put` errors).
   */
  async refresh(
    reg: RegisteredMV,
    accessor: MVExecutorAccessor,
  ): Promise<RefreshResult> {
    const spec = reg.spec
    const outputColl = accessor.getCollection(reg.outputCollection)

    // Materialize the query. The Query<T> returned by spec.query() is
    // a fresh instance — we invoke `.toArray()` to materialize the
    // result rows. Foundation sub-issue (#150) handles non-aggregate
    // queries only — aggregate / groupBy-shaped MVs are deferred to
    // subtask #152 (the cost-ceiling + correctness sub-issue, where
    // `MaterializedViewTooLargeError` for groupBy explosions also
    // lands).
    const q = spec.query(accessor.getQueryContext())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: ReadonlyArray<Record<string, unknown>> = await (q as any).toArray()

    const txCtx = accessor.getActiveTxContext()

    let written = 0
    let failed = 0
    for (const row of rows) {
      try {
        const id = spec.rowKey(row)
        const meta: MaterializedFromMeta = {
          mvName: spec.name,
          queryHash: reg.queryHash,
          // Foundation: sourceVersions empty — populated by step 7+ when
          // we read the source records' versions during materialization.
          sourceVersions: {},
          materializedAt: new Date().toISOString(),
        }
        const enriched: Record<string, unknown> = {
          ...row,
          _materializedFrom: meta,
        }

        // Register the prior envelope on the active TxContext before
        // the write, so a mid-refresh failure rolls back via
        // `revertExecuted` (#133-style).
        if (txCtx !== null) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const adapter = (outputColl as any).adapter as {
            get(v: string, c: string, i: string): Promise<EncryptedEnvelope | null>
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const vaultName = (outputColl as any).vault as string
          const prior = await adapter.get(vaultName, reg.outputCollection, id)
          txCtx._executed.push({
            op: {
              type: 'put',
              vaultName,
              collectionName: reg.outputCollection,
              id,
            },
            priorEnvelope: prior,
          })
        }

        await outputColl.put(id, enriched)
        written++
      } catch (err) {
        failed++
        // Foundation: non-strict by default. Subtask #152 wires
        // strict-mode rollback through `withTransactions`.
        // eslint-disable-next-line no-console
        console.warn(`[mv] "${spec.name}" row write failed:`, err)
      }
    }
    return { written, deleted: 0, failed }
  },
}
