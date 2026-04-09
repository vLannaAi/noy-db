/**
 * Generic LRU cache for `Collection`'s lazy hydration mode.
 *
 * Backed by a JavaScript `Map`, which preserves insertion order. Promotion
 * is implemented as `delete()` + `set()` — O(1) on `Map` since both
 * operations are constant-time. Eviction walks the iterator from the front
 * (least recently used) until both budgets are satisfied.
 *
 * v0.3 ships in-memory only. The cache is never persisted; on collection
 * close every entry is dropped. Persisting cache state is a follow-up
 * once the access patterns from real consumers tell us whether it would
 * pay back the complexity.
 */

export interface LruEntry<V> {
  /** The cached value. */
  readonly value: V
  /**
   * Approximate decrypted byte size of the entry. Used by the byte-budget
   * eviction path. Callers compute this once at insert time and pass it
   * in — recomputing on every access would dominate the per-record cost.
   */
  readonly size: number
}

export interface LruOptions {
  /** Maximum number of entries before eviction. Required if `maxBytes` is unset. */
  maxRecords?: number
  /** Maximum total bytes before eviction. Computed from per-entry `size`. */
  maxBytes?: number
}

export interface LruStats {
  /** Total cache hits since construction (or `resetStats()`). */
  hits: number
  /** Total cache misses since construction (or `resetStats()`). */
  misses: number
  /** Total entries evicted since construction (or `resetStats()`). */
  evictions: number
  /** Current number of cached entries. */
  size: number
  /** Current sum of cached entry sizes (in bytes, approximate). */
  bytes: number
}

/**
 * O(1) LRU cache. Both `get()` and `set()` promote the touched entry to
 * the most-recently-used end. Eviction happens after every insert and
 * walks the front of the Map iterator dropping entries until both
 * budgets are satisfied.
 */
export class Lru<K, V> {
  private readonly entries = new Map<K, LruEntry<V>>()
  private readonly maxRecords: number | undefined
  private readonly maxBytes: number | undefined
  private currentBytes = 0
  private hits = 0
  private misses = 0
  private evictions = 0

  constructor(options: LruOptions) {
    if (options.maxRecords === undefined && options.maxBytes === undefined) {
      throw new Error('Lru: must specify maxRecords, maxBytes, or both')
    }
    this.maxRecords = options.maxRecords
    this.maxBytes = options.maxBytes
  }

  /**
   * Look up a key. Hits promote the entry to most-recently-used; misses
   * return undefined. Both update the running stats counters.
   */
  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) {
      this.misses++
      return undefined
    }
    // Promote: re-insert moves the entry to the end of the iteration order.
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.hits++
    return entry.value
  }

  /**
   * Insert or update a key. If the key already exists, its size is
   * accounted for and the entry is promoted to MRU. After insertion,
   * eviction runs to maintain both budgets.
   */
  set(key: K, value: V, size: number): void {
    const existing = this.entries.get(key)
    if (existing) {
      // Update path: subtract the old size before adding the new one.
      this.currentBytes -= existing.size
      this.entries.delete(key)
    }
    this.entries.set(key, { value, size })
    this.currentBytes += size
    this.evictUntilUnderBudget()
  }

  /**
   * Remove a key without affecting hit/miss stats. Used by `Collection.delete()`.
   * Returns true if the key was present.
   */
  remove(key: K): boolean {
    const existing = this.entries.get(key)
    if (!existing) return false
    this.currentBytes -= existing.size
    this.entries.delete(key)
    return true
  }

  /** True if the cache currently holds an entry for the given key. */
  has(key: K): boolean {
    return this.entries.has(key)
  }

  /**
   * Drop every entry. Stats counters survive — call `resetStats()` if you
   * want a clean slate. Used by `Collection.invalidate()` on key rotation.
   */
  clear(): void {
    this.entries.clear()
    this.currentBytes = 0
  }

  /** Reset hit/miss/eviction counters to zero. Does NOT touch entries. */
  resetStats(): void {
    this.hits = 0
    this.misses = 0
    this.evictions = 0
  }

  /** Snapshot of current cache statistics. Cheap — no copying. */
  stats(): LruStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.entries.size,
      bytes: this.currentBytes,
    }
  }

  /**
   * Iterate over all currently-cached values. Order is least-recently-used
   * first. Used by tests and devtools — production callers should use
   * `Collection.scan()` instead.
   */
  *values(): IterableIterator<V> {
    for (const entry of this.entries.values()) yield entry.value
  }

  /**
   * Walk the cache from the LRU end and drop entries until both budgets
   * are satisfied. Called after every `set()`. Single pass — entries are
   * never re-promoted during eviction.
   */
  private evictUntilUnderBudget(): void {
    while (this.overBudget()) {
      const oldest = this.entries.keys().next()
      if (oldest.done) return // empty cache; nothing more to evict
      const key = oldest.value
      const entry = this.entries.get(key)
      if (entry) this.currentBytes -= entry.size
      this.entries.delete(key)
      this.evictions++
    }
  }

  private overBudget(): boolean {
    if (this.maxRecords !== undefined && this.entries.size > this.maxRecords) return true
    if (this.maxBytes !== undefined && this.currentBytes > this.maxBytes) return true
    return false
  }
}
