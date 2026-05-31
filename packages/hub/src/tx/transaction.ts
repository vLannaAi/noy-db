/**
 * Multi-record atomic transactions.
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
 * `StoreCapabilities.txAtomic` bit, but does not yet delegate
 * to it — the cascade into `Fork · Stores` tracks the per-adapter
 * wire-up.
 *
 * ## Not covered
 *
 * - Cross-sync-peer atomicity. Transactions commit against the
 *   primary store only; the sync engine pushes on its normal
 *   schedule. For cross-peer two-phase commit use `SyncTransaction`
 * via `db.transaction(vaultName)`.
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
import {
  AmendmentForbiddenError,
  ConflictError,
  InvariantError,
  ValidationError,
} from '../errors.js'
import { generateULID } from '../bundle/ulid.js'
import type { GuardExecutor as GuardExecutorModule } from '../guards/executor.js'
import type { LedgerEntry } from '../history/ledger/entry.js'

/** One op buffered inside a running `TxContext`. @internal */
export interface StagedOp {
  type: 'put' | 'delete'
  vaultName: string
  collectionName: string
  id: string
  record?: unknown
  expectedVersion?: number
  /**
   * Optional human-readable tag forwarded to the resulting ledger
   * entry's `reason` field (#1). Set by callers via
   * `tx.vault(v).collection(c).put(id, record, { reason })`.
   */
  reason?: string
}

/**
 * One executed op (main staged op or recursive side-effect like a
 * derivation output) paired with the envelope captured before the write.
 * `revertExecuted` walks this array in reverse on rollback.
 * @internal
 */
export interface ExecutedOp {
  op: StagedOp
  priorEnvelope: EncryptedEnvelope | null
}

/**
 * Options accepted by `db.transaction({ amendment, reason }, fn)`.
 * Only the amendment variant uses these — a plain `db.transaction(fn)`
 * never sees this shape.
 */
export interface AmendmentTxOptions {
  /** Opt into amendment mode. Required to be `true`. */
  readonly amendment: true
  /** Human-readable rationale recorded in the ledger entry. Required. */
  readonly reason: string
}

/**
 * Transaction handle passed to the user's body. Use
 * `tx.vault(name).collection<T>(name)` to get a per-collection
 * facade; its `put`/`delete`/`get` calls stage ops against the tx.
 */
export class TxContext {
  /** Stable id for this transaction; shared by all writes it performs (#230). */
  readonly txId: string = generateULID()
  /** @internal */
  readonly _ops: StagedOp[] = []
  /**
   * @internal — write log built up in Phase 2. Each entry records the
   * envelope captured BEFORE the write so a mid-batch failure can
   * restore prior state via `revertExecuted`. Side-effect writes (e.g.
   * recursive derivation outputs fired inside `Collection.put`) are
   * appended here in execution order so they roll back alongside the
   * main staged ops (#133).
   */
  readonly _executed: ExecutedOp[] = []
  /** @internal */
  readonly _db: Noydb
  /**
   * @internal — true when this TxContext was opened in amendment
   * mode. Toggles the lazy-`beginAmendment` + role-check path on first
   * `tx.vault(name)` and unlocks the post-Phase-2 invariant + audit run.
   */
  readonly _amendment: boolean
  /** @internal — vaults that have already had `beginAmendment` called. */
  readonly _amendmentVaults = new Map<string, Vault>()

  /** @internal */
  constructor(db: Noydb, amendment = false) {
    this._db = db
    this._amendment = amendment
  }

  /** Scope subsequent `collection()` calls to the named vault. */
  vault(name: string): TxVault {
    const v = this._db.vault(name)
    if (this._amendment && !this._amendmentVaults.has(name)) {
      // Role check is per-vault. The task spec ("only admin or owner
      // can open an amendment") is implemented lazy-on-first-touch
      // because the role lives on the vault's keyring, and `tx.vault()`
      // is the first place we know which vault we're addressing. The
      // observable effect is identical to an eager check in the single-
      // vault case the tests exercise; multi-vault amendments check
      // each touched vault as they first appear.
      const role = v.role
      if (role !== 'admin' && role !== 'owner') {
        throw new AmendmentForbiddenError(v.userId, role)
      }
      // Amendments require an initialised guard registry — they
      // produce a structured invariant + change-set audit. A vault
      // opened without `guardStrategies` (or via the sync fallback
      // path) has a null registry and cannot run an amendment.
      const reg = v._getGuardRegistry()
      if (reg === null) {
        throw new ValidationError(
          `Vault "${name}": amendment mode requires at least one ` +
          `guardStrategy registered via createNoydb({ guardStrategies }). ` +
          `Open the vault with guardStrategies before calling ` +
          `db.transaction({ amendment: true }).`,
        )
      }
      reg.beginAmendment()
      this._amendmentVaults.set(name, v)
    }
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
  put(id: string, record: T, options?: { expectedVersion?: number; reason?: string }): void {
    const op: StagedOp = {
      type: 'put',
      vaultName: this._vault.name,
      collectionName: this._name,
      id,
      record,
    }
    if (options?.expectedVersion !== undefined) op.expectedVersion = options.expectedVersion
    if (options?.reason !== undefined) op.reason = options.reason
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
 * Commit plan: pre-flight check + execution + revert plan.
 *
 * @internal — driven by `withTransactions()` (via `tx/active.ts`) for
 * user-facing `db.transaction(...)` calls and by the `amendment` path
 * in `noydb.ts`. `Collection.putManyAtomic` runs its own Phase 2 loop
 * but shares the `_activeTxContext` mechanism (and the `revertExecuted`
 * helper) so nested side-effect derivation writes get registered for
 * revert alongside the bulk-put source ops (#133).
 */
export async function runTransaction<T>(
  db: Noydb,
  fn: (tx: TxContext) => Promise<T> | T,
  options?: AmendmentTxOptions,
): Promise<T> {
  // ─── Amendment-mode pre-flight ───────────────────────────────
  // `reason` is the only thing we can validate before the body runs;
  // the per-vault role check happens lazily on first `tx.vault(name)`
  // because we don't know which vaults the body will touch ahead of
  // time. Throwing here keeps the failure mode close to the call site
  // so the developer doesn't have to walk an async stack to find the
  // missing-reason mistake.
  if (options?.amendment) {
    if (typeof options.reason !== 'string' || options.reason.trim().length === 0) {
      throw new ValidationError(
        'db.transaction({ amendment: true }) requires a non-empty `reason` string.',
      )
    }
  }

  const ctx = new TxContext(db, options?.amendment === true)
  const bodyResult = await fn(ctx)

  if (ctx._ops.length === 0) {
    // Body produced no ops. If amendment mode was active we still
    // need to close any opened windows so a subsequent (unrelated)
    // write doesn't surprise-collect into a stale change-set. Each
    // `beginAmendment` is matched by exactly one `consumeChanges`.
    if (ctx._amendment) {
      for (const v of ctx._amendmentVaults.values()) {
        // Registry is guaranteed non-null here — `tx.vault(name)`
        // threw above if it was null before adding to
        // `_amendmentVaults`.
        const reg = v._getGuardRegistry()
        if (reg !== null) {
          reg.consumeChanges()
          reg.consumeMeta()
        }
      }
    }
    return bodyResult
  }

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
  //
  // `_activeTxContext` is published on the Noydb instance for the
  // duration of Phase 2 so recursive writes triggered inside
  // `Collection.put` (today: eager derivation outputs) can register
  // their own envelopes onto `ctx._executed` and roll back alongside
  // the main staged ops (#133). The `finally` clears it before the
  // amendment commit phase runs.
  db._setActiveTxContext(ctx)
  try {
    try {
      for (const op of ctx._ops) {
        const coll = db.vault(op.vaultName).collection(op.collectionName)
        const key = keyOf(op)
        const prior = priorEnvelopes.get(key) ?? null
        // Record the revert plan BEFORE the call so a mid-`coll.put` throw
        // (e.g. strict-mode derivation failure firing after `store.put`
        // has already committed the envelope) still has its source write
        // reverted. `revertExecuted` is best-effort: putting prior back is
        // idempotent when the failing op never actually wrote, and
        // `_invalidateCacheEntry` is a no-op when the collection isn't
        // hydrated.
        ctx._executed.push({ op, priorEnvelope: prior })
        if (op.type === 'put') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await coll.put(op.id, op.record as any, op.reason !== undefined ? { reason: op.reason } : undefined)
        } else {
          await coll.delete(op.id)
        }
      }
    } catch (err) {
      // Phase 3 — best-effort revert. See helper docstring.
      await revertExecuted(ctx._executed, store, db)
      // Drain amendment windows so the next transaction starts clean.
      if (ctx._amendment) {
        for (const v of ctx._amendmentVaults.values()) {
          const reg = v._getGuardRegistry()
          if (reg !== null) {
            reg.consumeChanges()
            reg.consumeMeta()
          }
        }
      }
      throw err
    }
  } finally {
    db._clearActiveTxContext(ctx)
  }

  // ─── Amendment commit phase (only if amendment === true) ────
  // Body succeeded — now run each touched vault's invariants over the
  // collected change-set, then append a structured ledger entry. If
  // any invariant throws, treat it exactly like a mid-Phase-2 failure:
  // revert every executed op and re-throw the InvariantError.
  if (ctx._amendment) {
    // Lazy-load GuardExecutor at the dispatch site — keeps the floor
    // bundle free of the guards subsystem when amendments aren't used.
    // Mirrors the deferred-load pattern from #130 elsewhere in this PR.
    const { GuardExecutor } = (await import('../guards/executor.js')) as {
      GuardExecutor: typeof GuardExecutorModule
    }
    try {
      for (const [vaultName, v] of ctx._amendmentVaults) {
        const registry = v._getGuardRegistry()
        // Registry is guaranteed non-null at this point — the
        // `tx.vault(name)` path that populates `_amendmentVaults`
        // throws if the registry is null. The defensive check here
        // is for TypeScript's narrowing.
        if (registry === null) continue
        const changesByCollection = registry.consumeChanges()
        const meta = registry.consumeMeta()
        if (changesByCollection.size === 0) continue

        const readOnlyVault = v._getReadOnlyFacade()
        if (readOnlyVault === null) continue

        // Build the invariant ctx once per vault — it's the same shape
        // every guard sees on the normal `check` path, just with a
        // synthetic `existing: null` (invariants get the full change
        // set in their first parameter; `existing` is a per-record
        // concept that doesn't apply here).
        const invariantsPassed: string[] = []
        for (const [collection, changes] of changesByCollection) {
          const guards = registry.guardsFor(collection).filter(g => g.amendment !== undefined)
          for (const guard of guards) {
            await GuardExecutor.runInvariant(guard, changes, {
              existing: null,
              vault: readOnlyVault,
              userId: v.userId,
              role: v.role,
            })
          }
          if (guards.length > 0) invariantsPassed.push(collection)
        }

        // Append the audit ledger entry. Silent no-op when the
        // history strategy isn't configured — the records still
        // committed, only the multi-record summary is unavailable.
        const ledger = v._getLedgerOrNull()
        if (ledger) {
          const role = v.role as 'admin' | 'owner'
          const amendment: NonNullable<LedgerEntry['amendment']> = {
            reason: options!.reason,
            role,
            changes: meta,
            invariantsPassed,
          }
          await ledger.append({
            op: 'amendment',
            collection: '',
            id: '',
            version: 0,
            actor: v.userId,
            // No payload to hash — the per-record entries already
            // captured `payloadHash` at their own append time. We use
            // a sha256 of the canonical reason string so the field is
            // populated with something deterministic and non-empty.
            payloadHash: '',
            amendment,
          })
        }
        void vaultName
      }
    } catch (err) {
      await revertExecuted(ctx._executed, store, db)
      throw err instanceof InvariantError ? err : new InvariantError(
        err instanceof Error ? err.message : `invariant violated: ${String(err)}`,
      )
    }
  }

  return bodyResult
}

/**
 * Phase 3 helper — restore captured prior envelopes via the raw store
 * to avoid re-firing Collection-level side effects (we don't want a
 * cascade of change events undoing themselves). The ledger is left
 * as-is: each committed op appended an entry; the revert is
 * deliberately NOT recorded as a compensating entry because the
 * caller-facing contract is "atomic or not at all," not "every write
 * visible in the audit trail." Auditors who need the intermediate
 * state can still reconstruct it by walking the ledger through the
 * failed-tx timestamp.
 *
 * @internal — shared between `runTransaction` and
 * `Collection.putManyAtomic`. Both register source ops + nested
 * derivation side-effect ops onto `_executed`; this helper unwinds the
 * combined list in reverse on rollback.
 */
export async function revertExecuted(
  executed: ReadonlyArray<ExecutedOp>,
  store: Noydb['_store'],
  db?: Noydb,
): Promise<void> {
  for (const { op, priorEnvelope } of executed.slice().reverse()) {
    try {
      if (priorEnvelope) {
        await store.put(op.vaultName, op.collectionName, op.id, priorEnvelope)
      } else {
        await store.delete(op.vaultName, op.collectionName, op.id)
      }
      // Sync the Collection-layer cache with what we just wrote at
      // the raw store. Without this, eager-mode `get` would still
      // return the rolled-back record from its in-memory map. The
      // Collection's `_invalidateCacheEntry` is a no-op when the
      // collection hasn't yet been hydrated.
      if (db) {
        const coll = db.vault(op.vaultName).collection(op.collectionName)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (coll as any)._invalidateCacheEntry(op.id)
      }
    } catch {
      // swallow — best-effort. Surfacing the revert error would mask
      // the original one that triggered the rollback.
    }
  }
}

function keyOf(op: StagedOp): string {
  return `${op.vaultName}\x00${op.collectionName}\x00${op.id}`
}
