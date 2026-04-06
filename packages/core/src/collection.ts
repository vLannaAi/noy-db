import type { NoydbAdapter, EncryptedEnvelope, ChangeEvent, HistoryConfig, HistoryOptions, HistoryEntry, PruneOptions, ListPageResult } from './types.js'
import { NOYDB_FORMAT_VERSION } from './types.js'
import { encrypt, decrypt } from './crypto.js'
import { ReadOnlyError } from './errors.js'
import type { UnlockedKeyring } from './keyring.js'
import { hasWritePermission } from './keyring.js'
import type { NoydbEventEmitter } from './events.js'
import {
  saveHistory,
  getHistory as getHistoryEntries,
  getVersionEnvelope,
  pruneHistory as pruneHistoryEntries,
  clearHistory,
} from './history.js'
import { diff as computeDiff } from './diff.js'
import type { DiffEntry } from './diff.js'
import { Query } from './query/index.js'
import type { QuerySource } from './query/index.js'
import { CollectionIndexes, type IndexDef } from './query/indexes.js'

/** Callback for dirty tracking (sync engine integration). */
export type OnDirtyCallback = (collection: string, id: string, action: 'put' | 'delete', version: number) => Promise<void>

/**
 * Track which adapter names have already triggered the listPage fallback
 * warning. We only emit once per adapter per process so consumers see the
 * heads-up without log spam.
 */
const fallbackWarned = new Set<string>()
function warnOnceFallback(adapterName: string): void {
  if (fallbackWarned.has(adapterName)) return
  fallbackWarned.add(adapterName)
  // Only warn in non-test environments — vitest runs are noisy enough.
  if (typeof process !== 'undefined' && process.env['NODE_ENV'] === 'test') return
  // eslint-disable-next-line no-console
  console.warn(
    `[noy-db] Adapter "${adapterName}" does not implement listPage(); ` +
    `Collection.scan()/listPage() are using a synthetic fallback (slower). ` +
    `Add a listPage method to opt into the streaming fast path.`,
  )
}

/** A typed collection of records within a compartment. */
export class Collection<T> {
  private readonly adapter: NoydbAdapter
  private readonly compartment: string
  private readonly name: string
  private readonly keyring: UnlockedKeyring
  private readonly encrypted: boolean
  private readonly emitter: NoydbEventEmitter
  private readonly getDEK: (collectionName: string) => Promise<CryptoKey>
  private readonly onDirty: OnDirtyCallback | undefined
  private readonly historyConfig: HistoryConfig

  // In-memory cache of decrypted records
  private readonly cache = new Map<string, { record: T; version: number }>()
  private hydrated = false

  /**
   * In-memory secondary indexes for the query DSL.
   *
   * Built during `ensureHydrated()` and maintained on every put/delete.
   * The query executor consults these for `==` and `in` operators on
   * indexed fields, falling back to a linear scan for unindexed fields
   * or unsupported operators.
   *
   * v0.3 ships in-memory only — persistence as encrypted blobs is a
   * follow-up. See `query/indexes.ts` for the design rationale.
   */
  private readonly indexes = new CollectionIndexes()

  constructor(opts: {
    adapter: NoydbAdapter
    compartment: string
    name: string
    keyring: UnlockedKeyring
    encrypted: boolean
    emitter: NoydbEventEmitter
    getDEK: (collectionName: string) => Promise<CryptoKey>
    historyConfig?: HistoryConfig | undefined
    onDirty?: OnDirtyCallback | undefined
    indexes?: IndexDef[] | undefined
  }) {
    this.adapter = opts.adapter
    this.compartment = opts.compartment
    this.name = opts.name
    this.keyring = opts.keyring
    this.encrypted = opts.encrypted
    this.emitter = opts.emitter
    this.getDEK = opts.getDEK
    this.onDirty = opts.onDirty
    this.historyConfig = opts.historyConfig ?? { enabled: true }
    if (opts.indexes) {
      for (const def of opts.indexes) {
        this.indexes.declare(def)
      }
    }
  }

  /** Get a single record by ID. Returns null if not found. */
  async get(id: string): Promise<T | null> {
    await this.ensureHydrated()
    const entry = this.cache.get(id)
    return entry ? entry.record : null
  }

  /** Create or update a record. */
  async put(id: string, record: T): Promise<void> {
    if (!hasWritePermission(this.keyring, this.name)) {
      throw new ReadOnlyError()
    }

    await this.ensureHydrated()

    const existing = this.cache.get(id)
    const version = existing ? existing.version + 1 : 1

    // Save history snapshot of the PREVIOUS version before overwriting
    if (existing && this.historyConfig.enabled !== false) {
      const historyEnvelope = await this.encryptRecord(existing.record, existing.version)
      await saveHistory(this.adapter, this.compartment, this.name, id, historyEnvelope)

      this.emitter.emit('history:save', {
        compartment: this.compartment,
        collection: this.name,
        id,
        version: existing.version,
      })

      // Auto-prune if maxVersions configured
      if (this.historyConfig.maxVersions) {
        await pruneHistoryEntries(this.adapter, this.compartment, this.name, id, {
          keepVersions: this.historyConfig.maxVersions,
        })
      }
    }

    const envelope = await this.encryptRecord(record, version)
    await this.adapter.put(this.compartment, this.name, id, envelope)

    this.cache.set(id, { record, version })
    // Update secondary indexes incrementally — no-op if no indexes are
    // declared. Pass the previous record (if any) so old buckets are
    // cleaned up before the new value is added.
    this.indexes.upsert(id, record, existing ? existing.record : null)

    await this.onDirty?.(this.name, id, 'put', version)

    this.emitter.emit('change', {
      compartment: this.compartment,
      collection: this.name,
      id,
      action: 'put',
    } satisfies ChangeEvent)
  }

  /** Delete a record by ID. */
  async delete(id: string): Promise<void> {
    if (!hasWritePermission(this.keyring, this.name)) {
      throw new ReadOnlyError()
    }

    const existing = this.cache.get(id)

    // Save history snapshot before deleting
    if (existing && this.historyConfig.enabled !== false) {
      const historyEnvelope = await this.encryptRecord(existing.record, existing.version)
      await saveHistory(this.adapter, this.compartment, this.name, id, historyEnvelope)
    }

    await this.adapter.delete(this.compartment, this.name, id)
    this.cache.delete(id)
    // Remove from secondary indexes — no-op if no indexes are declared
    // or the record wasn't previously indexed.
    if (existing) {
      this.indexes.remove(id, existing.record)
    }

    await this.onDirty?.(this.name, id, 'delete', existing?.version ?? 0)

    this.emitter.emit('change', {
      compartment: this.compartment,
      collection: this.name,
      id,
      action: 'delete',
    } satisfies ChangeEvent)
  }

  /** List all records in the collection. */
  async list(): Promise<T[]> {
    await this.ensureHydrated()
    return [...this.cache.values()].map(e => e.record)
  }

  /**
   * Build a chainable query against the collection. Returns a `Query<T>`
   * builder when called with no arguments.
   *
   * Backward-compatible overload: passing a predicate function returns
   * the filtered records directly (the v0.2 API). Prefer the chainable
   * form for new code.
   *
   * @example
   * ```ts
   * // New chainable API:
   * const overdue = invoices.query()
   *   .where('status', '==', 'open')
   *   .where('dueDate', '<', new Date())
   *   .orderBy('dueDate')
   *   .toArray();
   *
   * // Legacy predicate form (still supported):
   * const drafts = invoices.query(i => i.status === 'draft');
   * ```
   */
  query(): Query<T>
  query(predicate: (record: T) => boolean): T[]
  query(predicate?: (record: T) => boolean): Query<T> | T[] {
    if (predicate !== undefined) {
      // Legacy form: synchronous predicate filter against the cache.
      return [...this.cache.values()].map(e => e.record).filter(predicate)
    }
    // New form: return a chainable builder bound to this collection's cache.
    const source: QuerySource<T> = {
      snapshot: () => [...this.cache.values()].map(e => e.record),
      subscribe: (cb: () => void) => {
        const handler = (event: ChangeEvent): void => {
          if (event.compartment === this.compartment && event.collection === this.name) {
            cb()
          }
        }
        this.emitter.on('change', handler)
        return () => this.emitter.off('change', handler)
      },
      // Index-aware fast path for `==` and `in` operators on indexed
      // fields. The Query builder consults these when present and falls
      // back to a linear scan otherwise.
      getIndexes: () => this.getIndexes(),
      lookupById: (id: string) => this.cache.get(id)?.record,
    }
    return new Query<T>(source)
  }

  // ─── History Methods ────────────────────────────────────────────

  /** Get version history for a record, newest first. */
  async history(id: string, options?: HistoryOptions): Promise<HistoryEntry<T>[]> {
    const envelopes = await getHistoryEntries(
      this.adapter, this.compartment, this.name, id, options,
    )

    const entries: HistoryEntry<T>[] = []
    for (const env of envelopes) {
      const record = await this.decryptRecord(env)
      entries.push({
        version: env._v,
        timestamp: env._ts,
        userId: env._by ?? '',
        record,
      })
    }
    return entries
  }

  /** Get a specific past version of a record. */
  async getVersion(id: string, version: number): Promise<T | null> {
    const envelope = await getVersionEnvelope(
      this.adapter, this.compartment, this.name, id, version,
    )
    if (!envelope) return null
    return this.decryptRecord(envelope)
  }

  /** Revert a record to a past version. Creates a new version with the old content. */
  async revert(id: string, version: number): Promise<void> {
    const oldRecord = await this.getVersion(id, version)
    if (!oldRecord) {
      throw new Error(`Version ${version} not found for record "${id}"`)
    }
    await this.put(id, oldRecord)
  }

  /**
   * Compare two versions of a record and return the differences.
   * Use version 0 to represent "before creation" (empty).
   * Omit versionB to compare against the current version.
   */
  async diff(id: string, versionA: number, versionB?: number): Promise<DiffEntry[]> {
    const recordA = versionA === 0 ? null : await this.resolveVersion(id, versionA)
    const recordB = versionB === undefined || versionB === 0
      ? (versionB === 0 ? null : await this.resolveCurrentOrVersion(id))
      : await this.resolveVersion(id, versionB)
    return computeDiff(recordA, recordB)
  }

  /** Resolve a version: try history first, then check if it's the current version. */
  private async resolveVersion(id: string, version: number): Promise<T | null> {
    // Check history
    const fromHistory = await this.getVersion(id, version)
    if (fromHistory) return fromHistory
    // Check if it's the current live version
    await this.ensureHydrated()
    const current = this.cache.get(id)
    if (current && current.version === version) return current.record
    return null
  }

  private async resolveCurrentOrVersion(id: string): Promise<T | null> {
    await this.ensureHydrated()
    return this.cache.get(id)?.record ?? null
  }

  /** Prune history entries for a record (or all records if id is undefined). */
  async pruneRecordHistory(id: string | undefined, options: PruneOptions): Promise<number> {
    const pruned = await pruneHistoryEntries(
      this.adapter, this.compartment, this.name, id, options,
    )
    if (pruned > 0) {
      this.emitter.emit('history:prune', {
        compartment: this.compartment,
        collection: this.name,
        id: id ?? '*',
        pruned,
      })
    }
    return pruned
  }

  /** Clear all history for this collection (or a specific record). */
  async clearHistory(id?: string): Promise<number> {
    return clearHistory(this.adapter, this.compartment, this.name, id)
  }

  // ─── Core Methods ─────────────────────────────────────────────

  /** Count records in the collection. */
  async count(): Promise<number> {
    await this.ensureHydrated()
    return this.cache.size
  }

  // ─── Pagination & Streaming ───────────────────────────────────

  /**
   * Fetch a single page of records via the adapter's optional `listPage`
   * extension. Returns the decrypted records for this page plus an opaque
   * cursor for the next page.
   *
   * Pass `cursor: undefined` (or omit it) to start from the beginning.
   * The final page returns `nextCursor: null`.
   *
   * If the adapter does NOT implement `listPage`, this falls back to a
   * synthetic implementation: it loads all ids via `list()`, sorts them,
   * and slices a window. The first call emits a one-time console.warn so
   * developers can spot adapters that should opt into the fast path.
   */
  async listPage(opts: { cursor?: string; limit?: number } = {}): Promise<{
    items: T[]
    nextCursor: string | null
  }> {
    const limit = opts.limit ?? 100

    if (this.adapter.listPage) {
      const result = await this.adapter.listPage(this.compartment, this.name, opts.cursor, limit)
      const decrypted: T[] = []
      for (const { record, version, id } of await this.decryptPage(result.items)) {
        // Update cache opportunistically — if the page-fetched record isn't
        // in cache yet, populate it. This makes a subsequent .get(id) free.
        if (!this.cache.has(id)) {
          this.cache.set(id, { record, version })
        }
        decrypted.push(record)
      }
      return { items: decrypted, nextCursor: result.nextCursor }
    }

    // Fallback: synthetic pagination over list() + get(). Slower than the
    // native path because every id requires its own round-trip, but
    // correct for adapters that haven't opted in.
    warnOnceFallback(this.adapter.name ?? 'unknown')
    const ids = (await this.adapter.list(this.compartment, this.name)).slice().sort()
    const start = opts.cursor ? parseInt(opts.cursor, 10) : 0
    const end = Math.min(start + limit, ids.length)
    const items: T[] = []
    for (let i = start; i < end; i++) {
      const id = ids[i]!
      const envelope = await this.adapter.get(this.compartment, this.name, id)
      if (envelope) {
        const record = await this.decryptRecord(envelope)
        items.push(record)
        if (!this.cache.has(id)) {
          this.cache.set(id, { record, version: envelope._v })
        }
      }
    }
    return {
      items,
      nextCursor: end < ids.length ? String(end) : null,
    }
  }

  /**
   * Stream every record in the collection page-by-page, yielding decrypted
   * records as an `AsyncIterable<T>`. The whole point: process collections
   * larger than RAM without ever holding more than `pageSize` records
   * decrypted at once.
   *
   * @example
   * ```ts
   * for await (const record of invoices.scan({ pageSize: 500 })) {
   *   await processOne(record)
   * }
   * ```
   *
   * Uses `adapter.listPage` when available; otherwise falls back to the
   * synthetic pagination path with the same one-time warning.
   */
  async *scan(opts: { pageSize?: number } = {}): AsyncIterableIterator<T> {
    const pageSize = opts.pageSize ?? 100
    // Start with no cursor (first page) and walk forward until the
    // adapter signals exhaustion via nextCursor === null.
    let page: { items: T[]; nextCursor: string | null } = await this.listPage({ limit: pageSize })
    while (true) {
      for (const item of page.items) {
        yield item
      }
      if (page.nextCursor === null) return
      page = await this.listPage({ cursor: page.nextCursor, limit: pageSize })
    }
  }

  /** Decrypt a page of envelopes returned by `adapter.listPage`. */
  private async decryptPage(
    items: ListPageResult['items'],
  ): Promise<Array<{ id: string; record: T; version: number }>> {
    const out: Array<{ id: string; record: T; version: number }> = []
    for (const { id, envelope } of items) {
      const record = await this.decryptRecord(envelope)
      out.push({ id, record, version: envelope._v })
    }
    return out
  }

  // ─── Internal ──────────────────────────────────────────────────

  /** Load all records from adapter into memory cache. */
  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) return

    const ids = await this.adapter.list(this.compartment, this.name)
    for (const id of ids) {
      const envelope = await this.adapter.get(this.compartment, this.name, id)
      if (envelope) {
        const record = await this.decryptRecord(envelope)
        this.cache.set(id, { record, version: envelope._v })
      }
    }
    this.hydrated = true
    this.rebuildIndexes()
  }

  /** Hydrate from a pre-loaded snapshot (used by Compartment). */
  async hydrateFromSnapshot(records: Record<string, EncryptedEnvelope>): Promise<void> {
    for (const [id, envelope] of Object.entries(records)) {
      const record = await this.decryptRecord(envelope)
      this.cache.set(id, { record, version: envelope._v })
    }
    this.hydrated = true
    this.rebuildIndexes()
  }

  /**
   * Rebuild secondary indexes from the current in-memory cache.
   *
   * Called after any bulk hydration. Incremental put/delete updates
   * are handled by `indexes.upsert()` / `indexes.remove()` directly,
   * so this only fires for full reloads.
   *
   * Synchronous and O(N × indexes.size); for the v0.3 target scale of
   * 1K–50K records this completes in single-digit milliseconds.
   */
  private rebuildIndexes(): void {
    if (this.indexes.fields().length === 0) return
    const snapshot: Array<{ id: string; record: T }> = []
    for (const [id, entry] of this.cache) {
      snapshot.push({ id, record: entry.record })
    }
    this.indexes.build(snapshot)
  }

  /**
   * Get the in-memory index store. Used by `Query` to short-circuit
   * `==` and `in` lookups when an index covers the where clause.
   *
   * Returns `null` if no indexes are declared on this collection.
   */
  getIndexes(): CollectionIndexes | null {
    return this.indexes.fields().length > 0 ? this.indexes : null
  }

  /** Get all records as encrypted envelopes (for dump). */
  async dumpEnvelopes(): Promise<Record<string, EncryptedEnvelope>> {
    await this.ensureHydrated()
    const result: Record<string, EncryptedEnvelope> = {}
    for (const [id, entry] of this.cache) {
      result[id] = await this.encryptRecord(entry.record, entry.version)
    }
    return result
  }

  private async encryptRecord(record: T, version: number): Promise<EncryptedEnvelope> {
    const json = JSON.stringify(record)
    const by = this.keyring.userId

    if (!this.encrypted) {
      return {
        _noydb: NOYDB_FORMAT_VERSION,
        _v: version,
        _ts: new Date().toISOString(),
        _iv: '',
        _data: json,
        _by: by,
      }
    }

    const dek = await this.getDEK(this.name)
    const { iv, data } = await encrypt(json, dek)

    return {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: version,
      _ts: new Date().toISOString(),
      _iv: iv,
      _data: data,
      _by: by,
    }
  }

  private async decryptRecord(envelope: EncryptedEnvelope): Promise<T> {
    if (!this.encrypted) {
      return JSON.parse(envelope._data) as T
    }

    const dek = await this.getDEK(this.name)
    const json = await decrypt(envelope._iv, envelope._data, dek)
    return JSON.parse(json) as T
  }
}
