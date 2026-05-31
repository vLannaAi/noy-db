/**
 * Observable write-queue (#227, M12 Slice 1).
 *
 * Tracks outstanding in-flight *logical* writes (a full Collection.put /
 * delete, including ledger + cache + derivation + MV dispatch — not just
 * the adapter call). The hub holds one tracker per instance; it is
 * framework-agnostic (no Vue/React dependency). UI layers subscribe via
 * onChange(); the migration drain (Slice 2) quiesces via onFlush().
 */

/** Public, read-only view of the hub's write-queue. */
export interface WriteQueue {
  /** True while one or more writes are in flight (`depth > 0`). */
  readonly pending: boolean
  /** Count of outstanding write operations. */
  readonly depth: number
  /**
   * Subscribe to depth changes (fires on every begin and settle).
   * Returns an unsubscribe function. Intended for reactive wrappers
   * (e.g. `@noy-db/in-vue` turns this into a `ref`).
   */
  onChange(handler: () => void): () => void
  /**
   * Resolves once `depth` reaches 0. If a write settled with an error
   * while this flush was waiting, the returned promise REJECTS with that
   * error instead — so a drain caller surfaces the failure rather than
   * hanging. Resolves immediately when already idle and error-free.
   */
  onFlush(): Promise<void>
}

interface FlushWaiter {
  resolve: () => void
  reject: (error: Error) => void
}

export class WriteQueueTracker implements WriteQueue {
  #depth = 0
  #error: Error | null = null
  readonly #changeHandlers = new Set<() => void>()
  #flushWaiters: FlushWaiter[] = []

  get pending(): boolean {
    return this.#depth > 0
  }

  get depth(): number {
    return this.#depth
  }

  /** Mark one write as started. */
  begin(): void {
    this.#depth++
    this.#emitChange()
  }

  /** Mark one write as finished. Pass the error if it failed. */
  settle(error?: Error): void {
    this.#depth = Math.max(0, this.#depth - 1)
    if (error) this.#error = error
    this.#emitChange()
    if (this.#depth === 0) this.#drainFlush()
  }

  onChange(handler: () => void): () => void {
    this.#changeHandlers.add(handler)
    return () => {
      this.#changeHandlers.delete(handler)
    }
  }

  onFlush(): Promise<void> {
    if (this.#depth === 0) {
      const error = this.#error
      this.#error = null
      return error ? Promise.reject(error) : Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      this.#flushWaiters.push({ resolve, reject })
    })
  }

  /**
   * Run `fn` as a tracked write: depth++ on entry, depth-- on settle
   * (success or failure). The fn's resolved value is returned; a thrown
   * error is re-thrown after the queue is decremented.
   */
  async track<R>(fn: () => Promise<R>): Promise<R> {
    this.begin()
    try {
      const value = await fn()
      this.settle()
      return value
    } catch (error) {
      this.settle(error as Error)
      throw error
    }
  }

  #emitChange(): void {
    for (const handler of this.#changeHandlers) handler()
  }

  #drainFlush(): void {
    const waiters = this.#flushWaiters
    this.#flushWaiters = []
    const error = this.#error
    this.#error = null
    for (const waiter of waiters) {
      if (error) waiter.reject(error)
      else waiter.resolve()
    }
  }
}
