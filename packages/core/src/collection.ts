import type { NoydbAdapter, EncryptedEnvelope, ChangeEvent, HistoryConfig, HistoryOptions, HistoryEntry, PruneOptions, ListPageResult } from './types.js'
import { NOYDB_FORMAT_VERSION } from './types.js'
import { encrypt, decrypt } from './crypto.js'
import { ReadOnlyError } from './errors.js'
import type { UnlockedKeyring } from './keyring.js'
import { hasWritePermission } from './keyring.js'
import type { NoydbEventEmitter } from './events.js'
import type { StandardSchemaV1 } from './schema.js'
import { validateSchemaInput, validateSchemaOutput } from './schema.js'
import type { LedgerStore } from './ledger/index.js'
import { envelopePayloadHash } from './ledger/index.js'
import { computePatch } from './ledger/patch.js'
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
import { Lru, parseBytes, estimateRecordBytes, type LruStats } from './cache/index.js'

/** Callback for dirty tracking (sync engine integration). */
export type OnDirtyCallback = (collection: string, id: string, action: 'put' | 'delete', version: number) => Promise<void>

/**
 * Per-collection cache configuration. Only meaningful when paired with
 * `prefetch: false` (lazy mode); eager mode keeps the entire decrypted
 * cache in memory and ignores these bounds.
 */
export interface CacheOptions {
  /** Maximum number of records to keep in memory before LRU eviction. */
  maxRecords?: number
  /**
   * Maximum total decrypted byte size before LRU eviction. Accepts a raw
   * number or a human-friendly string: `'50KB'`, `'50MB'`, `'1GB'`.
   * Eviction picks the least-recently-used entry until both budgets
   * (maxRecords AND maxBytes, if both are set) are satisfied.
   */
  maxBytes?: number | string
}

/** Statistics exposed via `Collection.cacheStats()`. */
export interface CacheStats extends LruStats {
  /** True if this collection is in lazy mode. */
  lazy: boolean
}

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

  // In-memory cache of decrypted records (eager mode only). Lazy mode
  // uses `lru` instead. Both fields exist so a single Collection instance
  // doesn't need a runtime branch on every cache access.
  private readonly cache = new Map<string, { record: T; version: number }>()
  private hydrated = false

  /**
   * Lazy mode flag. `true` when constructed with `prefetch: false`.
   * In lazy mode the cache is bounded by an LRU and `list()`/`query()`
   * throw — callers must use `scan()` or per-id `get()` instead.
   */
  private readonly lazy: boolean

  /**
   * LRU cache for lazy mode. Only allocated when `prefetch: false` is set.
   * Stores `{ record, version }` entries the same shape as `this.cache`.
   * Tree-shaking note: importing Collection without setting `prefetch:false`
   * still pulls in the Lru class today; future bundle-size work could
   * lazy-import the cache module.
   */
  private readonly lru: Lru<string, { record: T; version: number }> | null

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
   *
   * Indexes are INCOMPATIBLE with lazy mode in v0.3 — the constructor
   * rejects the combination because evicted records would silently
   * disappear from the index without notification.
   */
  private readonly indexes = new CollectionIndexes()

  /**
   * Optional Standard Schema v1 validator. When set, every `put()` runs
   * the input through `validateSchemaInput` before encryption, and every
   * record coming OUT of `decryptRecord` runs through
   * `validateSchemaOutput`. A rejected input throws
   * `SchemaValidationError` with `direction: 'input'`; drifted stored
   * data throws with `direction: 'output'`. Both carry the rich issue
   * list from the validator so UI code can render field-level messages.
   *
   * The schema is stored as `StandardSchemaV1<unknown, T>` because the
   * collection type parameter `T` is the OUTPUT type — whatever the
   * validator produces after transforms and coercion. Users who pass a
   * schema to `defineNoydbStore` (or `Collection.constructor`) get their
   * `T` inferred automatically via `InferOutput<Schema>`.
   */
  private readonly schema: StandardSchemaV1<unknown, T> | undefined

  /**
   * Optional reference to the compartment-level hash-chained audit
   * log. When present, every successful `put()` and `delete()` appends
   * an entry to the ledger AFTER the adapter write succeeds (so a
   * failed adapter write never produces an orphan ledger entry).
   *
   * The ledger is always a compartment-wide singleton — all
   * collections in the same compartment share the same LedgerStore.
   * Compartment.ledger() does the lazy init; this field just holds
   * the reference so Collection doesn't need to reach back up to the
   * compartment on every mutation.
   *
   * `undefined` means "no ledger attached" — supported for tests that
   * construct a Collection directly without a compartment, and for
   * future backwards-compat scenarios. Production usage always has a
   * ledger because Compartment.collection() passes one through.
   */
  private readonly ledger: LedgerStore | undefined

  /**
   * Optional back-reference to the owning compartment's ref
   * enforcer. When present, `Collection.put` calls
   * `refEnforcer.enforceRefsOnPut(name, record)` before the adapter
   * write, and `Collection.delete` calls
   * `refEnforcer.enforceRefsOnDelete(name, id)` before its own
   * adapter delete. The Compartment handles the actual registry
   * lookup and cross-collection enforcement — Collection just
   * notifies it at the right points in the lifecycle.
   *
   * Typed as a structural interface rather than `Compartment`
   * directly to avoid a circular import. Compartment implements
   * these two methods; any other object with the same shape would
   * work too (used only in unit tests).
   */
  private readonly refEnforcer:
    | {
        enforceRefsOnPut(collectionName: string, record: unknown): Promise<void>
        enforceRefsOnDelete(collectionName: string, id: string): Promise<void>
      }
    | undefined

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
    /**
     * Hydration mode. `'eager'` (default) loads everything into memory on
     * first access — matches v0.2 behavior exactly. `'lazy'` defers loads
     * to per-id `get()` calls and bounds memory via the `cache` option.
     */
    prefetch?: boolean
    /**
     * LRU cache options. Only meaningful when `prefetch: false`. At least
     * one of `maxRecords` or `maxBytes` must be set in lazy mode — an
     * unbounded lazy cache defeats the purpose.
     */
    cache?: CacheOptions | undefined
    /**
     * Optional Standard Schema v1 validator (Zod, Valibot, ArkType,
     * Effect Schema, etc.). When set, every `put()` is validated before
     * encryption and every read is validated after decryption. See the
     * `schema` field docstring for the error semantics.
     */
    schema?: StandardSchemaV1<unknown, T> | undefined
    /**
     * Optional reference to the compartment's hash-chained ledger.
     * When present, successful mutations append a ledger entry via
     * `LedgerStore.append()`. Constructed at the Compartment level and
     * threaded through — see the Compartment.collection() source for
     * the wiring.
     */
    ledger?: LedgerStore | undefined
    /**
     * Optional back-reference to the owning compartment's ref
     * enforcer (v0.4 #45 — foreign-key references via `ref()`).
     * Collection.put calls `enforceRefsOnPut` before the adapter
     * write; Collection.delete calls `enforceRefsOnDelete` before
     * its own adapter delete. See the `refEnforcer` field docstring
     * for the full protocol.
     */
    refEnforcer?:
      | {
          enforceRefsOnPut(collectionName: string, record: unknown): Promise<void>
          enforceRefsOnDelete(collectionName: string, id: string): Promise<void>
        }
      | undefined
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
    this.schema = opts.schema
    this.ledger = opts.ledger
    this.refEnforcer = opts.refEnforcer

    // Default `prefetch: true` keeps v0.2 semantics. Only opt-in to lazy
    // mode when the consumer explicitly sets `prefetch: false`.
    this.lazy = opts.prefetch === false

    if (this.lazy) {
      // Lazy mode is incompatible with eager-cache features. Reject the
      // combinations early so users see the error at construction time
      // rather than at first query.
      if (opts.indexes && opts.indexes.length > 0) {
        throw new Error(
          `Collection "${this.name}": secondary indexes are not supported in lazy mode (prefetch: false). ` +
          `Either remove the indexes option or use prefetch: true. ` +
          `Index + lazy support is tracked as a v0.4 follow-up.`,
        )
      }
      if (!opts.cache || (opts.cache.maxRecords === undefined && opts.cache.maxBytes === undefined)) {
        throw new Error(
          `Collection "${this.name}": lazy mode (prefetch: false) requires a cache option ` +
          `with maxRecords and/or maxBytes. An unbounded lazy cache defeats the purpose.`,
        )
      }
      const lruOptions: { maxRecords?: number; maxBytes?: number } = {}
      if (opts.cache.maxRecords !== undefined) lruOptions.maxRecords = opts.cache.maxRecords
      if (opts.cache.maxBytes !== undefined) lruOptions.maxBytes = parseBytes(opts.cache.maxBytes)
      this.lru = new Lru<string, { record: T; version: number }>(lruOptions)
      this.hydrated = true // lazy mode is always "hydrated" — no bulk load
    } else {
      this.lru = null
      if (opts.indexes) {
        for (const def of opts.indexes) {
          this.indexes.declare(def)
        }
      }
    }
  }

  /**
   * Return the Standard Schema validator attached to this collection,
   * or `undefined` if none was provided at construction time.
   *
   * Exposed (read-only) for the Compartment-level export primitive,
   * which surfaces each collection's schema in the per-chunk metadata
   * so downstream serializers (`@noy-db/decrypt-*` packages, custom
   * exporters) can produce schema-aware output without poking at
   * collection internals. The validator object is returned by
   * reference — callers must treat it as immutable.
   */
  getSchema(): StandardSchemaV1<unknown, T> | undefined {
    return this.schema
  }

  /** Get a single record by ID. Returns null if not found. */
  async get(id: string): Promise<T | null> {
    if (this.lazy && this.lru) {
      // Cache hit: promote and return.
      const cached = this.lru.get(id)
      if (cached) return cached.record
      // Cache miss: hit the adapter, decrypt, populate the LRU.
      const envelope = await this.adapter.get(this.compartment, this.name, id)
      if (!envelope) return null
      const record = await this.decryptRecord(envelope)
      this.lru.set(id, { record, version: envelope._v }, estimateRecordBytes(record))
      return record
    }

    // Eager mode: load everything once, then serve from the in-memory map.
    await this.ensureHydrated()
    const entry = this.cache.get(id)
    return entry ? entry.record : null
  }

  /** Create or update a record. */
  async put(id: string, record: T): Promise<void> {
    if (!hasWritePermission(this.keyring, this.name)) {
      throw new ReadOnlyError()
    }

    // Schema validation — runs BEFORE encryption so invalid records are
    // rejected at the store boundary. The validator may transform the
    // input (e.g., coerce strings → numbers, strip unknown fields), in
    // which case we persist the validated value rather than the raw one.
    // Users who pass a bad shape get a SchemaValidationError with a
    // structured issue list, not a stack trace from deep inside the
    // encrypt path.
    if (this.schema !== undefined) {
      record = await validateSchemaInput(this.schema, record, `put(${id})`)
    }

    // Foreign-key ref enforcement (v0.4 #45). Runs AFTER schema
    // validation (so the record shape is trustworthy) but BEFORE
    // any write (so a failed strict ref leaves no trace on disk,
    // in history, or in the ledger). The Compartment handles the
    // actual target lookups — see `enforceRefsOnPut` over there.
    if (this.refEnforcer !== undefined) {
      await this.refEnforcer.enforceRefsOnPut(this.name, record)
    }

    // Resolve the previous record. In eager mode this comes from the
    // in-memory map (no I/O); in lazy mode we have to ask the adapter
    // because the record may have been evicted (or never loaded).
    let existing: { record: T; version: number } | undefined
    if (this.lazy && this.lru) {
      existing = this.lru.get(id)
      if (!existing) {
        const previousEnvelope = await this.adapter.get(this.compartment, this.name, id)
        if (previousEnvelope) {
          const previousRecord = await this.decryptRecord(previousEnvelope)
          existing = { record: previousRecord, version: previousEnvelope._v }
        }
      }
    } else {
      await this.ensureHydrated()
      existing = this.cache.get(id)
    }

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

    // Ledger append — AFTER the adapter write succeeds so a failed
    // write never produces an orphan ledger entry. Computing the
    // payloadHash here uses the envelope we just wrote, which is the
    // exact bytes the adapter now holds. The ledger entry records
    // only metadata (collection, id, version, hash) — NOT the record
    // itself — and is then encrypted with the compartment's ledger
    // DEK, preserving zero-knowledge. See `LedgerStore.append`.
    //
    // **Delta history (#44)**: if there was a previous version, we
    // compute a JSON Patch from it to the new record and pass it
    // through `append.delta`. The LedgerStore stores the patch in
    // the sibling `_ledger_deltas/` collection and records its hash
    // in the entry's `deltaHash` field. Genesis puts (no existing
    // record) leave `delta` undefined — there's nothing to diff
    // against — and the ledger entry has no `deltaHash`.
    if (this.ledger) {
      const appendInput: Parameters<typeof this.ledger.append>[0] = {
        op: 'put',
        collection: this.name,
        id,
        version,
        actor: this.keyring.userId,
        payloadHash: await envelopePayloadHash(envelope),
      }
      if (existing) {
        // REVERSE patch: describes how to undo this put — i.e., how
        // to transform the NEW record back into the PREVIOUS one.
        // Storing reverse patches lets `ledger.reconstruct()` walk
        // backward from the current state (readily available in the
        // data collection) without needing a forward-walking base
        // snapshot, which would double the storage cost of the
        // delta scheme. See `LedgerStore.reconstruct` for the walk.
        appendInput.delta = computePatch(record, existing.record)
      }
      await this.ledger.append(appendInput)
    }

    if (this.lazy && this.lru) {
      this.lru.set(id, { record, version }, estimateRecordBytes(record))
    } else {
      this.cache.set(id, { record, version })
      // Update secondary indexes incrementally — no-op if no indexes are
      // declared. Pass the previous record (if any) so old buckets are
      // cleaned up before the new value is added. Indexes are NEVER
      // touched in lazy mode (rejected at construction).
      this.indexes.upsert(id, record, existing ? existing.record : null)
    }

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

    // Foreign-key ref enforcement on delete (v0.4 #45). Runs BEFORE
    // the adapter delete so a `strict` inbound ref with existing
    // references blocks the delete entirely (no partial state, no
    // history churn, no ledger entry for a rejected op). `cascade`
    // recursively deletes the referencing records first, then falls
    // through to the normal delete path below. `warn` is a no-op
    // here — violations surface through `checkIntegrity()`.
    if (this.refEnforcer !== undefined) {
      await this.refEnforcer.enforceRefsOnDelete(this.name, id)
    }

    // In lazy mode the record may not be cached; ask the adapter so we
    // can still write a history snapshot if history is enabled.
    let existing: { record: T; version: number } | undefined
    if (this.lazy && this.lru) {
      existing = this.lru.get(id)
      if (!existing && this.historyConfig.enabled !== false) {
        const previousEnvelope = await this.adapter.get(this.compartment, this.name, id)
        if (previousEnvelope) {
          const previousRecord = await this.decryptRecord(previousEnvelope)
          existing = { record: previousRecord, version: previousEnvelope._v }
        }
      }
    } else {
      existing = this.cache.get(id)
    }

    // Save history snapshot before deleting
    if (existing && this.historyConfig.enabled !== false) {
      const historyEnvelope = await this.encryptRecord(existing.record, existing.version)
      await saveHistory(this.adapter, this.compartment, this.name, id, historyEnvelope)
    }

    // Capture the previous envelope's payloadHash BEFORE delete so we
    // have a stable reference for the ledger entry. The hash is of
    // whatever was last visible to readers — for a `delete` of a
    // never-existed record, we use the empty string (which the
    // ledger entry's `payloadHash` field tolerates).
    const previousEnvelope = await this.adapter.get(this.compartment, this.name, id)
    const previousPayloadHash = await envelopePayloadHash(previousEnvelope)

    await this.adapter.delete(this.compartment, this.name, id)

    // Ledger append — same after-write timing as put(). The recorded
    // version is the version that WAS deleted (existing?.version), not
    // a successor. A delete of a missing record still appends an
    // entry with version 0 so the chain captures the intent.
    if (this.ledger) {
      await this.ledger.append({
        op: 'delete',
        collection: this.name,
        id,
        version: existing?.version ?? 0,
        actor: this.keyring.userId,
        payloadHash: previousPayloadHash,
      })
    }

    if (this.lazy && this.lru) {
      this.lru.remove(id)
    } else {
      this.cache.delete(id)
      // Remove from secondary indexes — no-op if no indexes are declared
      // or the record wasn't previously indexed. Indexes are never
      // declared in lazy mode (rejected at construction).
      if (existing) {
        this.indexes.remove(id, existing.record)
      }
    }

    await this.onDirty?.(this.name, id, 'delete', existing?.version ?? 0)

    this.emitter.emit('change', {
      compartment: this.compartment,
      collection: this.name,
      id,
      action: 'delete',
    } satisfies ChangeEvent)
  }

  /**
   * List all records in the collection.
   *
   * Throws in lazy mode — bulk listing defeats the purpose of lazy
   * hydration. Use `scan()` to iterate over the full collection
   * page-by-page without holding more than `pageSize` records in memory.
   */
  async list(): Promise<T[]> {
    if (this.lazy) {
      throw new Error(
        `Collection "${this.name}": list() is not available in lazy mode (prefetch: false). ` +
        `Use collection.scan({ pageSize }) to iterate over the full collection.`,
      )
    }
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
    if (this.lazy) {
      throw new Error(
        `Collection "${this.name}": query() is not available in lazy mode (prefetch: false). ` +
        `Use collection.scan({ pageSize }) and filter the streamed records with a regular ` +
        `for-await loop. Streaming queries land in v0.4.`,
      )
    }
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

  /**
   * Cache statistics — useful for devtools, monitoring, and verifying
   * that LRU eviction is happening as expected in lazy mode.
   *
   * In eager mode, returns size only (no hits/misses are tracked because
   * every read is a cache hit by construction). In lazy mode, returns
   * the full LRU stats: `{ hits, misses, evictions, size, bytes }`.
   */
  cacheStats(): CacheStats {
    if (this.lazy && this.lru) {
      return { ...this.lru.stats(), lazy: true }
    }
    return {
      hits: 0,
      misses: 0,
      evictions: 0,
      size: this.cache.size,
      bytes: 0,
      lazy: false,
    }
  }

  // ─── History Methods ────────────────────────────────────────────

  /** Get version history for a record, newest first. */
  async history(id: string, options?: HistoryOptions): Promise<HistoryEntry<T>[]> {
    const envelopes = await getHistoryEntries(
      this.adapter, this.compartment, this.name, id, options,
    )

    const entries: HistoryEntry<T>[] = []
    for (const env of envelopes) {
      // History reads skip schema validation — see getVersion() docs.
      const record = await this.decryptRecord(env, { skipValidation: true })
      entries.push({
        version: env._v,
        timestamp: env._ts,
        userId: env._by ?? '',
        record,
      })
    }
    return entries
  }

  /**
   * Get a specific past version of a record.
   *
   * History reads intentionally **skip schema validation** — historical
   * records predate the current schema by definition, so validating them
   * against today's shape would be a false positive on any schema
   * evolution. If a caller needs validated history, they should filter
   * and re-put the records through the normal `put()` path.
   */
  async getVersion(id: string, version: number): Promise<T | null> {
    const envelope = await getVersionEnvelope(
      this.adapter, this.compartment, this.name, id, version,
    )
    if (!envelope) return null
    return this.decryptRecord(envelope, { skipValidation: true })
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

  /**
   * Count records in the collection.
   *
   * In eager mode this returns the in-memory cache size (instant). In
   * lazy mode it asks the adapter via `list()` to enumerate ids — slower
   * but still correct, and avoids loading any record bodies into memory.
   */
  async count(): Promise<number> {
    if (this.lazy) {
      const ids = await this.adapter.list(this.compartment, this.name)
      return ids.length
    }
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
        // In LAZY mode we deliberately do NOT populate the LRU here:
        // streaming a 100K-record collection should not turn the LRU into
        // a giant write-once buffer that immediately evicts everything.
        // Random-access workloads via .get() are what the LRU is for.
        if (!this.lazy && !this.cache.has(id)) {
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
        // Same lazy-mode skip as the native path: don't pollute the LRU
        // with sequential scan results.
        if (!this.lazy && !this.cache.has(id)) {
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

  /**
   * Decrypt an envelope into a record of type `T`.
   *
   * When a schema is attached, the decrypted value is validated before
   * being returned. A divergence between the stored bytes and the
   * current schema throws `SchemaValidationError` with
   * `direction: 'output'` — silently returning drifted data would
   * propagate garbage into the UI and break the whole point of having
   * a schema.
   *
   * `skipValidation` exists for history reads: when calling
   * `getVersion()` the caller is explicitly asking for an old snapshot
   * that may predate a schema change, so validating it would be a
   * false positive. Every non-history read leaves this flag `false`.
   */
  private async decryptRecord(
    envelope: EncryptedEnvelope,
    opts: { skipValidation?: boolean } = {},
  ): Promise<T> {
    let record: T
    if (!this.encrypted) {
      record = JSON.parse(envelope._data) as T
    } else {
      const dek = await this.getDEK(this.name)
      const json = await decrypt(envelope._iv, envelope._data, dek)
      record = JSON.parse(json) as T
    }

    if (this.schema !== undefined && !opts.skipValidation) {
      // Context string deliberately avoids leaking the record id — the
      // envelope only carries the version, not the id (the id lives in
      // the adapter-side key). `<collection>@v<n>` is enough for the
      // developer to find the offending record.
      record = await validateSchemaOutput(
        this.schema,
        record,
        `${this.name}@v${envelope._v}`,
      )
    }

    return record
  }
}
