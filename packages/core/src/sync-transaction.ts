import type { SyncTransactionResult } from './types.js'
import type { SyncEngine } from './sync.js'
import type { Compartment } from './compartment.js'

interface TxOp {
  readonly type: 'put' | 'delete'
  readonly collection: string
  readonly id: string
  readonly record?: unknown
}

/**
 * Sync transaction (v0.9 #135).
 *
 * Stages local writes and then pushes only those records to remote in a
 * single batch. If any record conflicts during the push, the result
 * carries `status: 'conflict'` — no automatic rollback is performed;
 * the caller handles conflict resolution.
 *
 * Obtain via `db.transaction(compartmentName)`.
 */
export class SyncTransaction {
  private readonly comp: Compartment
  private readonly engine: SyncEngine
  private readonly ops: TxOp[] = []

  /** @internal — constructed by `Noydb.transaction()` */
  constructor(comp: Compartment, engine: SyncEngine) {
    this.comp = comp
    this.engine = engine
  }

  /** Stage a record write. Does not write to any adapter until `commit()`. */
  put(collection: string, id: string, record: unknown): this {
    this.ops.push({ type: 'put', collection, id, record })
    return this
  }

  /** Stage a record delete. Does not write to any adapter until `commit()`. */
  delete(collection: string, id: string): this {
    this.ops.push({ type: 'delete', collection, id })
    return this
  }

  /**
   * Commit the transaction.
   *
   * Phase 1 — writes all staged operations to the local adapter via the
   * collection layer (encryption + dirty-log tracking).
   *
   * Phase 2 — pushes only the records that were written in this
   * transaction to the remote adapter. Existing dirty entries from
   * outside this transaction are not affected.
   *
   * If any record conflicts during the push, `status` is `'conflict'`
   * and `conflicts` lists the affected records. No automatic rollback is
   * performed.
   */
  async commit(): Promise<SyncTransactionResult> {
    // Phase 1: write all staged ops to local via collection layer
    for (const op of this.ops) {
      if (op.type === 'put') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (this.comp.collection<any>(op.collection)).put(op.id, op.record as any)
      } else {
        await this.comp.collection(op.collection).delete(op.id)
      }
    }

    // Phase 2: push only the records from this transaction
    const opSet = new Set<string>()
    for (const op of this.ops) {
      opSet.add(`${op.collection}::${op.id}`)
    }

    const pushResult = await this.engine.pushFiltered(
      (entry) => opSet.has(`${entry.collection}::${entry.id}`),
    )

    return {
      status: pushResult.conflicts.length > 0 ? 'conflict' : 'committed',
      pushed: pushResult.pushed,
      conflicts: pushResult.conflicts,
    }
  }
}
