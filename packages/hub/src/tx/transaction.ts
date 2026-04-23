/**
 * Multi-record atomic transactions (v0.16 #240).
 *
 * Lets an application stage writes across two or more collections (or
 * vaults) and commit them all-or-nothing.
 *
 * ```ts
 * await db.transaction(async (tx) => {
 *   const inv = tx.vault('acme').collection<Invoice>('invoices')
 *   const pay = tx.vault('acme').collection<Payment>('payments')
 *   await inv.put(invoiceId, { ...invoice, status: 'paid' })
 *   await pay.put(paymentId, { invoiceId, amount, paidAt })
 * })
 * // If the body throws before returning: nothing persisted.
 * // If the body returns: all puts committed; any CAS mismatch rolls
 * // the batch back and surfaces as ConflictError.
 * ```
 *
 * ## Atomicity semantics
 *
 * Ops are buffered during the body. On body-return the hub:
 *
 * 1. **Pre-flight** — re-reads every touched envelope and enforces
 *    any caller-supplied `expectedVersion`. A mismatch throws
 *    `ConflictError` with *no* writes performed.
 * 2. **Execute** — calls `Collection.put()` / `.delete()` for each
 *    staged op in declaration order. History snapshots, ledger
 *    appends, and change events fire as normal per op.
 * 3. **Unwind on failure** — if step 2 throws mid-batch, each
 *    already-committed op is reverted via the raw store (restoring
 *    the captured prior envelope, or deleting if none existed). The
 *    ledger is NOT rewritten — audit history preserves the partial
 *    commit and the revert.
 *
 * **Crash window.** Steps 2–3 are not a storage-layer transaction —
 * if the process dies between two executed ops, the on-disk state is
 * partial. True all-or-nothing atomicity requires a store that
 * implements `NoydbStore.tx()` (DynamoDB `TransactWriteItems`,
 * IndexedDB `readwrite` transaction, …). This executor declares
 * that future integration point via the `tx?()` method + the
 * `StoreCapabilities.txAtomic` bit, but v0.16 does not yet delegate
 * to it — the cascade into `Fork · Stores` tracks the per-adapter
 * wire-up.
 *
 * ## Not covered
 *
 * - Cross-sync-peer atomicity. Transactions commit against the
 *   primary store only; the sync engine pushes on its normal
 *   schedule. For cross-peer two-phase commit use `SyncTransaction`
 *   (v0.9 #135) via `db.transaction(vaultName)`.
 * - Read-your-writes within the body. `tx.collection().get(id)`
 *   returns the most-recently-staged value for that id when one
 *   exists; if no staged op has touched the id, it reads the current
 *   committed state. Version numbers returned by `get` reflect the
 *   pre-transaction state (staged puts have no version yet).
 *
 * @module
 */

import type { Noydb } from '../noydb.js'
import type { Vault } from '../vault.js'
import type { Collection } from '../collection.js'
import type { EncryptedEnvelope } from '../types.js'
import { ConflictError } from '../errors.js'

/** One op buffered inside a running `TxContext`. @internal */
interface StagedOp {
  type: 'put' | 'delete'
  vaultName: string
  collectionName: string
  id: string
  record?: unknown
  expectedVersion?: number
}

/**
 * Transaction handle passed to the user's body. Use
 * `tx.vault(name).collection<T>(name)` to get a per-collection
 * facade; its `put`/`delete`/`get` calls stage ops against the tx.
 */
export class TxContext {
  /** @internal */
  readonly _ops: StagedOp[] = []
  /** @internal */
  readonly _db: Noydb

  /** @internal */
  constructor(db: Noydb) {
    this._db = db
  }

  /** Scope subsequent `collection()` calls to the named vault. */
  vault(name: string): TxVault {
    const v = this._db.vault(name)
    return new TxVault(this, v)
  }
}

/** Per-vault facade inside a running transaction. */
export class TxVault {
  /** @internal */
  readonly _ctx: TxContext
  /** @internal */
  readonly _vault: Vault

  /** @internal */
  constructor(ctx: TxContext, vault: Vault) {
    this._ctx = ctx
    this._vault = vault
  }

  /** Scope subsequent op calls to the named collection. */
  collection<T>(name: string): TxCollection<T> {
    const c = this._vault.collection<T>(name)
    return new TxCollection<T>(this._ctx, this._vault, c, name)
  }
}

/** Per-collection facade inside a running transaction. */
export class TxCollection<T> {
  /** @internal */
  readonly _ctx: TxContext
  /** @internal */
  readonly _vault: Vault
  /** @internal */
  readonly _coll: Collection<T>
  /** @internal */
  readonly _name: string

  /** @internal */
  constructor(ctx: TxContext, vault: Vault, coll: Collection<T>, name: string) {
    this._ctx = ctx
    this._vault = vault
    this._coll = coll
    this._name = name
  }

  /**
   * Read the current committed value, or the most-recently-staged
   * value from the same transaction if one exists.
   */
  async get(id: string): Promise<T | null> {
    for (let i = this._ctx._ops.length - 1; i >= 0; i--) {
      const op = this._ctx._ops[i]!
      if (
        op.vaultName === this._vault.name &&
        op.collectionName === this._name &&
        op.id === id
      ) {
        if (op.type === 'delete') return null
        return op.record as T
      }
    }
    return this._coll.get(id)
  }

  /**
   * Stage a put. Does not write until the transaction body returns.
   * Supply `{ expectedVersion }` to enforce optimistic concurrency
   * during the commit pre-flight.
   */
  put(id: string, record: T, options?: { expectedVersion?: number }): void {
    const op: StagedOp = {
      type: 'put',
      vaultName: this._vault.name,
      collectionName: this._name,
      id,
      record,
    }
    if (options?.expectedVersion !== undefined) op.expectedVersion = options.expectedVersion
    this._ctx._ops.push(op)
  }

  /**
   * Stage a delete. Does not write until the transaction body returns.
   * Supply `{ expectedVersion }` to enforce optimistic concurrency
   * during the commit pre-flight.
   */
  delete(id: string, options?: { expectedVersion?: number }): void {
    const op: StagedOp = {
      type: 'delete',
      vaultName: this._vault.name,
      collectionName: this._name,
      id,
    }
    if (options?.expectedVersion !== undefined) op.expectedVersion = options.expectedVersion
    this._ctx._ops.push(op)
  }
}

/**
 * Commit plan: pre-flight check + execution + revert plan. Returned
 * from `runTransaction`.
 *
 * @internal — exposed only for the `Collection.putMany({atomic:true})`
 * wire-up so the bulk path can share the executor without creating
 * an outer TxContext.
 */
export async function runTransaction<T>(
  db: Noydb,
  fn: (tx: TxContext) => Promise<T> | T,
): Promise<T> {
  const ctx = new TxContext(db)
  const bodyResult = await fn(ctx)

  if (ctx._ops.length === 0) return bodyResult

  // Phase 1 — pre-flight: snapshot every touched envelope and enforce
  // any caller-supplied expectedVersion. Same (vault, coll, id) touched
  // more than once in one tx snapshots only the *initial* committed
  // state; the in-order replay in Phase 2 takes care of successor ops.
  const priorEnvelopes = new Map<string, EncryptedEnvelope | null>()
  const store = db._store
  for (const op of ctx._ops) {
    const key = keyOf(op)
    if (!priorEnvelopes.has(key)) {
      const env = await store.get(op.vaultName, op.collectionName, op.id)
      priorEnvelopes.set(key, env)
    }
    if (op.expectedVersion !== undefined) {
      const env = priorEnvelopes.get(key) ?? null
      const actual = env?._v ?? 0
      if (actual !== op.expectedVersion) {
        throw new ConflictError(
          actual,
          `Transaction pre-flight: ${op.vaultName}/${op.collectionName}/${op.id} ` +
            `expected v${op.expectedVersion}, found v${actual}`,
        )
      }
    }
  }

  // Phase 2 — execute via the Collection layer so history snapshots,
  // ledger entries, and change events fire normally. We capture each
  // successful op so a mid-batch throw can revert in Phase 3.
  const executed: Array<{ op: StagedOp; priorEnvelope: EncryptedEnvelope | null }> = []
  try {
    for (const op of ctx._ops) {
      const coll = db.vault(op.vaultName).collection(op.collectionName)
      const key = keyOf(op)
      const prior = priorEnvelopes.get(key) ?? null
      if (op.type === 'put') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await coll.put(op.id, op.record as any)
      } else {
        await coll.delete(op.id)
      }
      executed.push({ op, priorEnvelope: prior })
    }
    return bodyResult
  } catch (err) {
    // Phase 3 — best-effort revert. Restore captured prior envelopes
    // via the raw store to avoid re-firing Collection-level side
    // effects (we don't want a cascade of change events undoing
    // themselves). The ledger is left as-is: each committed op
    // appended an entry; the revert is deliberately not recorded as a
    // compensating entry because #240's contract is "atomic or not at
    // all" from the caller's view, not "every write visible in the
    // audit trail." Auditors who need the intermediate state can still
    // reconstruct it by walking the ledger through the failed-tx
    // timestamp.
    for (const { op, priorEnvelope } of executed.slice().reverse()) {
      try {
        if (priorEnvelope) {
          await store.put(op.vaultName, op.collectionName, op.id, priorEnvelope)
        } else {
          await store.delete(op.vaultName, op.collectionName, op.id)
        }
      } catch {
        // swallow — best-effort. Surfacing the revert error would
        // mask the original one that triggered the rollback.
      }
    }
    throw err
  }
}

function keyOf(op: StagedOp): string {
  return `${op.vaultName}\x00${op.collectionName}\x00${op.id}`
}
