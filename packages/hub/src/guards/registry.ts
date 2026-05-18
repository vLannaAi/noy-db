import type { GuardStrategy, GuardContext, GuardChange } from './types.js'

/**
 * Vault-internal singleton that holds the guard graph and dispatches
 * per-collection guard execution. Owned by `Vault`; not exported.
 *
 * @internal
 */
export class GuardRegistry {
  private readonly _byCollection = new Map<string, GuardStrategy<any>[]>()
  private _amendmentChanges: Map<string, GuardChange<any>[]> | null = null

  /** Register a guard. Multiple guards per collection are allowed. */
  register<T extends Record<string, unknown>>(spec: GuardStrategy<T>): void {
    const existing = this._byCollection.get(spec.collection)
    if (existing) existing.push(spec as GuardStrategy<any>)
    else this._byCollection.set(spec.collection, [spec as GuardStrategy<any>])
  }

  /** All guards registered against `collection` in registration order. */
  guardsFor(collection: string): ReadonlyArray<GuardStrategy<any>> {
    return this._byCollection.get(collection) ?? []
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
      if (g.check) await g.check(incoming, ctx)
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
  }

  /** True iff we're currently inside an amendment transaction. */
  isAmendmentActive(): boolean {
    return this._amendmentChanges !== null
  }

  /** Record a {before, after} pair for the active amendment. */
  collectChange<T>(
    collection: string,
    _id: string,
    before: T | null,
    after: T,
  ): void {
    if (this._amendmentChanges === null) {
      throw new Error('GuardRegistry.collectChange called outside an amendment')
    }
    const list = this._amendmentChanges.get(collection)
    const entry: GuardChange<T> = { before, after }
    if (list) list.push(entry)
    else this._amendmentChanges.set(collection, [entry])
  }

  /**
   * Drain the change-set and close the amendment window. The caller
   * (transaction commit) feeds these to each affected guard's invariant.
   */
  consumeChanges(): ReadonlyMap<string, ReadonlyArray<GuardChange<any>>> {
    const out = this._amendmentChanges ?? new Map()
    this._amendmentChanges = null
    return out
  }
}
