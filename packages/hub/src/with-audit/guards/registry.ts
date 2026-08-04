import { DuplicateBehaviorNameError } from '../../kernel/errors.js'
import type { GuardSpec, GuardContext, GuardChange } from './types.js'

/**
 * Per-record metadata attached to every entry in an amendment's
 * change-set. Carried in a parallel map alongside `_amendmentChanges`
 * so the public {@link GuardChange} shape (`{ before, after }`) stays
 * clean for invariant authors — the audit ledger reads this side
 * structure to produce the `{ collection, id, vBefore, vAfter }`
 * tuples for the amendment entry.
 *
 * @internal
 */
export interface AmendmentChangeMeta {
  readonly id: string
  readonly vBefore: number
  readonly vAfter: number
}

/**
 * Vault-internal singleton that holds the guard graph and dispatches
 * per-collection guard execution. Owned by `Vault`; not exported.
 *
 * @internal
 */
// Internal storage alias — guards are heterogeneous in their record type T,
// so the registry stores them at the upper bound of GuardSpec's T constraint.
type AnyGuard = GuardSpec<Record<string, unknown>>
type AnyChange = GuardChange<Record<string, unknown>>

export class GuardRegistry {
  private readonly _byCollection = new Map<string, AnyGuard[]>()
  private readonly _byName = new Map<string, AnyGuard>()
  private _amendmentChanges: Map<string, AnyChange[]> | null = null
  private _amendmentMeta: Map<string, AmendmentChangeMeta[]> | null = null

  /**
   * Register a guard. Multiple guards per collection are allowed. If
   * `spec.name` is given and already registered by another guard in this
   * vault, throws {@link DuplicateBehaviorNameError} before indexing.
   */
  register<T extends Record<string, unknown>>(spec: GuardSpec<T>): void {
    if (spec.name !== undefined) {
      if (this._byName.has(spec.name)) {
        throw new DuplicateBehaviorNameError(spec.name, 'guard')
      }
      this._byName.set(spec.name, spec as unknown as AnyGuard)
    }

    const existing = this._byCollection.get(spec.collection)
    if (existing) existing.push(spec as unknown as AnyGuard)
    else this._byCollection.set(spec.collection, [spec as unknown as AnyGuard])
  }

  /** All guards registered against `collection` in registration order. */
  guardsFor(collection: string): ReadonlyArray<AnyGuard> {
    return this._byCollection.get(collection) ?? []
  }

  /** Per-collection guard counts, for introspection. */
  summary(): { collection: string; count: number }[] {
    return [...this._byCollection.entries()].map(([collection, guards]) => ({
      collection,
      count: guards.length,
    }))
  }

  /** Every registered guard spec, in registration order. Used by `Vault.listBehaviors()` (#947). */
  all(): ReadonlyArray<AnyGuard> {
    return [...this._byCollection.values()].flat()
  }

  /**
   * Run every guard's `check` for this collection. First throw wins —
   * remaining guards are not invoked. Guards without a `check` skip.
   */
  async runChecks<T>(
    collection: string,
    incoming: T,
    ctx: GuardContext<T>,
  ): Promise<void> {
    const guards = this._byCollection.get(collection)
    if (!guards) return
    for (const g of guards) {
      if (g.check) {
        await g.check(
          incoming as unknown as Record<string, unknown>,
          ctx as unknown as GuardContext<Record<string, unknown>>,
        )
      }
    }
  }

  /**
   * Run every guard's `onDelete` for this collection. First throw wins —
   * remaining guards are not invoked. Guards without an `onDelete` skip.
   * Mirrors {@link runChecks} but for the delete path.
   */
  async runOnDelete<T>(
    collection: string,
    existing: T,
    ctx: GuardContext<T>,
  ): Promise<void> {
    const guards = this._byCollection.get(collection)
    if (!guards) return
    for (const g of guards) {
      if (g.onDelete) {
        await g.onDelete(
          existing as unknown as Record<string, unknown>,
          ctx as unknown as GuardContext<Record<string, unknown>>,
        )
      }
    }
  }

  /** True if any guard for `collection` declares an `amendment` block. */
  hasAmendment(collection: string): boolean {
    const guards = this._byCollection.get(collection)
    if (!guards) return false
    return guards.some(g => g.amendment !== undefined)
  }

  /** Open a new amendment change-collection window. */
  beginAmendment(): void {
    this._amendmentChanges = new Map()
    this._amendmentMeta = new Map()
  }

  /** True iff we're currently inside an amendment transaction. */
  isAmendmentActive(): boolean {
    return this._amendmentChanges !== null
  }

  /**
   * Record a {before, after} pair for the active amendment. `vBefore`
   * and `vAfter` are stored in a parallel meta structure so the public
   * {@link GuardChange} shape handed to invariant callbacks stays
   * `{ before, after }` only — the audit ledger reads version metadata
   * via {@link consumeMeta}.
   */
  collectChange<T>(
    collection: string,
    id: string,
    before: T | null,
    after: T,
    vBefore = 0,
    vAfter = 0,
  ): void {
    if (this._amendmentChanges === null || this._amendmentMeta === null) {
      throw new Error('GuardRegistry.collectChange called outside an amendment')
    }
    const list = this._amendmentChanges.get(collection)
    const entry = { before, after } as unknown as AnyChange
    if (list) list.push(entry)
    else this._amendmentChanges.set(collection, [entry])

    const metaList = this._amendmentMeta.get(collection)
    const metaEntry: AmendmentChangeMeta = { id, vBefore, vAfter }
    if (metaList) metaList.push(metaEntry)
    else this._amendmentMeta.set(collection, [metaEntry])
  }

  /**
   * Drain the change-set and close the amendment window. The caller
   * (transaction commit) feeds these to each affected guard's invariant.
   */
  consumeChanges(): ReadonlyMap<string, ReadonlyArray<AnyChange>> {
    const out = this._amendmentChanges ?? new Map()
    this._amendmentChanges = null
    return out
  }

  /**
   * Drain the parallel id/version metadata captured during the
   * amendment. Returned as a flat list with `collection` denormalised
   * so the audit ledger can emit one `{ collection, id, vBefore,
   * vAfter }` tuple per record. Must be called AFTER
   * {@link consumeChanges} (or independently) — calling it closes the
   * meta window in the same way.
   */
  consumeMeta(): ReadonlyArray<{ collection: string; id: string; vBefore: number; vAfter: number }> {
    const out: { collection: string; id: string; vBefore: number; vAfter: number }[] = []
    if (this._amendmentMeta) {
      for (const [collection, list] of this._amendmentMeta) {
        for (const m of list) {
          out.push({ collection, id: m.id, vBefore: m.vBefore, vAfter: m.vAfter })
        }
      }
    }
    this._amendmentMeta = null
    return out
  }
}
