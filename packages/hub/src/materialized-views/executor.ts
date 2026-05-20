import type { Collection } from '../collection.js'
import type { TxContext } from '../tx/transaction.js'
import type { EncryptedEnvelope } from '../types.js'
import { MaterializedViewTooLargeError } from '../errors.js'
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
  /** Rows tombstoned via `_internalDelete` (only when `onEmpty: 'delete'`). */
  deleted: number
  /** Failed row writes (non-strict mode). */
  failed: number
}

/** Default cost ceiling — overridable per-MV via `spec.maxRows`. */
const DEFAULT_MAX_ROWS = 100_000

/**
 * Materialize a query terminal that may be a `Query<T>` (call
 * `.toArray()`), an `Aggregation<R>` (call `.run()` returning a
 * single object — wrap as a one-row array), or a `GroupedAggregation<R>`
 * (call `.run()` returning an array of grouped rows). Branches on
 * available terminal at runtime — no type-discrimination at registration.
 */
async function materializeQueryResult(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  q: any,
  mvName: string,
): Promise<ReadonlyArray<Record<string, unknown>>> {
  if (typeof q?.toArray === 'function') {
    // Query<T> — non-aggregate path. `.toArray()` returns Promise<T[]>.
    return await q.toArray()
  }
  if (typeof q?.run === 'function') {
    // Aggregation<R> or GroupedAggregation<R>. `.run()` is synchronous
    // and returns either a single object (Aggregation) or an array of
    // rows (GroupedAggregation). Promise.resolve() normalizes both
    // sync and async (future) variants.
    const result: unknown = await Promise.resolve(q.run())
    if (Array.isArray(result)) {
      return result as ReadonlyArray<Record<string, unknown>>
    }
    // Single-aggregate result — wrap as one-row array. The consumer's
    // `rowKey()` should return a stable identity (often a literal
    // constant like `'total'`) since there's only one row.
    return [result as Record<string, unknown>]
  }
  throw new Error(
    `MV "${mvName}": query() must return a Query<T>, Aggregation, or GroupedAggregation. ` +
      `Got something without a .toArray() or .run() terminal.`,
  )
}

/**
 * Run an MV's `query()` and write the result rows to the output
 * collection. Same-DEK encryption: routes through the standard
 * `Collection.put` pipeline, so the output collection's DEK is what
 * gets used (matches the v2 spec's "same DEK as the left-most source"
 * invariant — `Collection.put` looks up the DEK by collection name,
 * and the output collection IS the MV's owned collection).
 *
 * Stamps `_materializedFrom` onto every emitted row.
 *
 * **Tombstoning** (#152): when `spec.onEmpty: 'delete'` (default), rows
 * that existed in a prior refresh but no longer appear in the new
 * materialized result are deleted via `Collection._internalDelete` —
 * the housekeeping bypass primitive added in PR #148 prevents user
 * `onDelete` guards on the output collection from firing on these
 * system-internal deletes. `onEmpty: 'keep'` opts out (rows from
 * prior refreshes linger even when the new result lacks them).
 *
 * **Cost ceiling** (#152): if the materialized row count exceeds
 * `spec.maxRows` (default 100k), throws `MaterializedViewTooLargeError`
 * before any writes hit the store — so strict-mode rollback is
 * clean.
 *
 * **Strict mode** (#152): `spec.strict === true` re-throws on any
 * row-write failure; the active TxContext registration means the
 * source-write rolls back atomically via `revertExecuted` (#133).
 *
 * @internal
 */
export const MaterializedViewExecutor = {
  async refresh(
    reg: RegisteredMV,
    accessor: MVExecutorAccessor,
  ): Promise<RefreshResult> {
    const spec = reg.spec
    const outputColl = accessor.getCollection(reg.outputCollection)
    const maxRows = spec.maxRows ?? DEFAULT_MAX_ROWS
    const onEmpty = spec.onEmpty ?? 'delete'
    const strict = spec.strict ?? false

    // 1. Materialize the query (branches on terminal shape).
    const q = spec.query(accessor.getQueryContext())
    const rows = await materializeQueryResult(q, spec.name)

    // 2. Cost ceiling check BEFORE any writes — keeps the rollback
    //    clean if the source-write is wrapped in a transaction.
    if (rows.length > maxRows) {
      throw new MaterializedViewTooLargeError(spec.name, rows.length, maxRows)
    }

    const txCtx = accessor.getActiveTxContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = (outputColl as any).adapter as {
      get(v: string, c: string, i: string): Promise<EncryptedEnvelope | null>
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vaultName = (outputColl as any).vault as string

    // 3. Compute the post-refresh id set so we can diff against the
    //    prior-emitted id set for tombstoning (when onEmpty === 'delete').
    const newIds = new Set<string>()
    const enrichedRows: Array<{ id: string; record: Record<string, unknown> }> = []
    for (const row of rows) {
      const id = spec.rowKey(row)
      newIds.add(id)
      const meta: MaterializedFromMeta = {
        mvName: spec.name,
        queryHash: reg.queryHash,
        sourceVersions: {},
        materializedAt: new Date().toISOString(),
      }
      enrichedRows.push({ id, record: { ...row, _materializedFrom: meta } })
    }

    // 4. Write the new rows.
    let written = 0
    let failed = 0
    for (const { id, record } of enrichedRows) {
      try {
        if (txCtx !== null) {
          const prior = await adapter.get(vaultName, reg.outputCollection, id)
          txCtx._executed.push({
            op: { type: 'put', vaultName, collectionName: reg.outputCollection, id },
            priorEnvelope: prior,
          })
        }
        await outputColl.put(id, record)
        written++
      } catch (err) {
        failed++
        if (strict) throw err
        // eslint-disable-next-line no-console
        console.warn(`[mv] "${spec.name}" row write failed:`, err)
      }
    }

    // 5. Tombstone rows that existed before but don't appear now.
    //    `onEmpty: 'keep'` skips this pass entirely. Uses
    //    `_internalDelete` so a user-registered `onDelete` on the
    //    output collection does NOT fire on housekeeping (the #145
    //    composition fix).
    let deleted = 0
    if (onEmpty === 'delete') {
      const priorIds = await listOutputIds(outputColl)
      for (const priorId of priorIds) {
        if (newIds.has(priorId)) continue
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const outAny = outputColl as any
          if (typeof outAny._internalDelete === 'function') {
            await outAny._internalDelete(priorId, txCtx)
            deleted++
          } else {
            // Defensive fallback — should never hit in real flow since
            // every Collection has `_internalDelete`.
            await outputColl.delete(priorId)
            deleted++
          }
        } catch (err) {
          failed++
          if (strict) throw err
          // eslint-disable-next-line no-console
          console.warn(`[mv] "${spec.name}" tombstone failed for id="${priorId}":`, err)
        }
      }
    }

    return { written, deleted, failed }
  },
}

/**
 * List ids currently present in the MV's output collection via the
 * adapter directly (avoids triggering the lazy resolve-on-read path
 * we're INSIDE). Returns an empty array if the collection doesn't
 * exist or the adapter doesn't surface a list method.
 *
 * @internal
 */
async function listOutputIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outputColl: Collection<any>,
): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cAny = outputColl as any
  const adapter = cAny.adapter as { list?: (v: string, c: string) => Promise<readonly string[]> }
  const vault = cAny.vault as string
  const name = cAny.name as string
  if (typeof adapter?.list !== 'function') return []
  try {
    const ids = await adapter.list(vault, name)
    return [...ids]
  } catch {
    return []
  }
}
