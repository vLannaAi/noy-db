/**
 * Shadow vaults — `vault.frame()` returns a read-only view of the
 * CURRENT vault state.
 *
 * Companion to {@link VaultInstant} from `history/time-machine.ts`:
 *
 * | Type | Reads from | Use case |
 * |------|------------|----------|
 * | `VaultInstant` | past snapshots (ledger + history) | "books on date X" |
 * | `VaultFrame`   | live vault state                  | screen-share / demo / audit |
 *
 * ```ts
 * const readonly = vault.frame()
 * const invoices = await readonly.collection<Invoice>('invoices').list()
 * await readonly.collection<Invoice>('invoices').put(...)
 * // → throws ReadOnlyFrameError
 * ```
 *
 * ## Contract
 *
 * Every write method on {@link CollectionFrame} throws
 * {@link ReadOnlyFrameError}. Reads delegate to the underlying
 * collection, so validation, locale handling, and caching all work
 * exactly as they do on the live collection.
 *
 * ## Security note: behaviour-enforced, not cryptographically-enforced
 *
 * A VaultFrame rejects writes by contract in the JavaScript layer.
 * It does NOT strip the DEKs from the underlying keyring — the same
 * in-memory keys that decrypt records could, in principle, encrypt
 * new writes via a hand-crafted adapter call. Cryptographic
 * enforcement (keyring variants with the write half of each DEK
 * removed) is hierarchical-access work. Use a VaultFrame to
 * prevent *accidental* writes in a read-scoped flow — do not rely on
 * it as a security boundary against a hostile caller sharing the
 * same process.
 *
 * @module
 */
import type { Collection } from '../collection.js'
import type { Vault } from '../vault.js'
import type { LocaleReadOptions } from '../types.js'
import { ReadOnlyFrameError } from '../errors.js'

/**
 * A read-only view of a vault's current state. Produced by
 * `vault.frame()`. Cheap to construct; safe to throw away.
 */
export class VaultFrame {
  constructor(private readonly vault: Vault) {}

  /**
   * Get a read-only view of one collection. The returned
   * {@link CollectionFrame} delegates all reads to the underlying
   * live collection — cache, locale handling, and validation all
   * work identically to the live collection.
   */
  collection<T = unknown>(name: string): CollectionFrame<T> {
    return new CollectionFrame<T>(this.vault.collection<T>(name), name)
  }

  /** List all collection names visible in the underlying vault. */
  async collections(): Promise<string[]> {
    return this.vault.collections()
  }
}

/**
 * Read-only collection view. All write methods throw
 * {@link ReadOnlyFrameError}; all read methods delegate to the
 * underlying live {@link Collection}.
 */
export class CollectionFrame<T = unknown> {
  constructor(
    private readonly inner: Collection<T>,
    /** The underlying collection name. Captured at construction so
     *  we don't need to peek into the private Collection state. */
    public readonly name: string,
  ) {}

  // ── reads (delegated) ──────────────────────────────────────────────

  get(id: string, locale?: LocaleReadOptions): Promise<T | null> {
    return this.inner.get(id, locale)
  }

  list(locale?: LocaleReadOptions): Promise<T[]> {
    return this.inner.list(locale)
  }

  /**
   * Return the chainable query builder. Terminals like `.toArray()`,
   * `.first()`, `.count()`, `.aggregate()` all work; the builder has
   * no write surface of its own, so exposing it directly is safe.
   */
  query(...args: Parameters<Collection<T>['query']>): ReturnType<Collection<T>['query']> {
    return this.inner.query(...args)
  }

  /** History reads — allowed (history is read-only by nature). */
  history(...args: Parameters<Collection<T>['history']>): ReturnType<Collection<T>['history']> {
    return this.inner.history(...args)
  }

  getVersion(id: string, version: number): Promise<T | null> {
    return this.inner.getVersion(id, version)
  }

  // ── write guards ──────────────────────────────────────────────────

  async put(_id: string, _record: T): Promise<never> {
    throw new ReadOnlyFrameError('put')
  }
  async delete(_id: string): Promise<never> {
    throw new ReadOnlyFrameError('delete')
  }
  async update(_id: string, _patch: Partial<T>): Promise<never> {
    throw new ReadOnlyFrameError('update')
  }
  async revert(_id: string, _version: number): Promise<never> {
    throw new ReadOnlyFrameError('revert')
  }
  async putMany(_entries: ReadonlyArray<readonly [string, T]>): Promise<never> {
    throw new ReadOnlyFrameError('putMany')
  }
  async deleteMany(_ids: readonly string[]): Promise<never> {
    throw new ReadOnlyFrameError('deleteMany')
  }
}
