import type { NoydbStore, EncryptedEnvelope, ChangeEvent, HistoryConfig, HistoryOptions, HistoryEntry, PruneOptions, ListPageResult, LocaleReadOptions, ConflictPolicy, CollectionConflictResolver } from './types.js'
import { NOYDB_FORMAT_VERSION } from './types.js'
import type { CrdtMode, CrdtState, LwwMapState, RgaState } from './crdt.js'
import { resolveCrdtSnapshot, mergeCrdtStates, buildLwwMapState, buildRgaState } from './crdt.js'
import type { I18nTextDescriptor } from './i18n.js'
import { applyI18nLocale } from './i18n.js'
import type { DictKeyDescriptor } from './dictionary.js'
import { encrypt, decrypt } from './crypto.js'
import { ReadOnlyError, TranslatorNotConfiguredError } from './errors.js'
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
import { Query, ScanBuilder } from './query/index.js'
import type { QuerySource, JoinContext, JoinableSource } from './query/index.js'
import { CollectionIndexes, type IndexDef } from './query/indexes.js'
import type { RefDescriptor } from './refs.js'
import { Lru, parseBytes, estimateRecordBytes, type LruStats } from './cache/index.js'
import { generateULID } from './bundle/ulid.js'
import { PresenceHandle } from './presence.js'
import type { PresenceHandleOpts } from './presence.js'
import { BlobSet } from './blob-set.js'

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

/** A typed collection of records within a vault. */
export class Collection<T> {
  private readonly adapter: NoydbStore
  private readonly vault: string
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
   * Vault-default locale. Used as the fallback when no per-call
   * locale option is passed to `get()`/`list()`. Provided by Vault
   * at collection construction time via the `collection({ locale })` or
   * `openVault(name, { locale })` path.
   *
   * `undefined` means "no default locale set" — i18nText fields will
   * throw `LocaleNotSpecifiedError` unless a per-call locale is passed.
   */
  private readonly defaultLocale: string | undefined

  /**
   * Map of field name → `I18nTextDescriptor` for fields declared with
   * `i18nText()`. Used by:
   *   - `put()` via `i18nPutValidator` to enforce required translations
   *   - `get()`/`list()` to apply locale resolution after decryption
   *
   * Declared via the `i18nFields` collection option (v0.8 #82).
   */
  private readonly i18nFields: Record<string, I18nTextDescriptor> | undefined

  /**
   * Map of field name → `DictKeyDescriptor` for fields declared with
   * `dictKey()`. Used by `get()`/`list()` to add `<field>Label` virtual
   * fields when a locale is requested (v0.8 #81).
   */
  private readonly dictKeyFields: Record<string, DictKeyDescriptor> | undefined

  /**
   * Async callback provided by the Vault that resolves a dict key
   * to its label for a given locale. Used by the locale-read path for
   * dictKey fields.
   *
   * Signature: `(dictName, key, locale, fallback?) => Promise<string | undefined>`
   */
  private readonly dictLabelResolver:
    | ((
        dictName: string,
        key: string,
        locale: string,
        fallback?: string | readonly string[],
      ) => Promise<string | undefined>)
    | undefined

  /**
   * Synchronous callback provided by the Vault that validates
   * i18nText fields on `put()`. Throws `MissingTranslationError` when
   * a required translation is absent. Called after schema validation,
   * before encryption.
   */
  private readonly i18nPutValidator: ((record: unknown) => void) | undefined

  /**
   * Async translator callback provided by Noydb via Vault for
   * `i18nText` fields with `autoTranslate: true` (v0.8 #83). Called
   * before i18n validation so translated values are present when the
   * validator runs. `undefined` when no `plaintextTranslator` was
   * configured on `createNoydb()`.
   */
  private readonly autoTranslateHook:
    | ((text: string, from: string, to: string, field: string, collection: string) => Promise<string>)
    | undefined

  /**
   * Optional reference to the vault-level hash-chained audit
   * log. When present, every successful `put()` and `delete()` appends
   * an entry to the ledger AFTER the adapter write succeeds (so a
   * failed adapter write never produces an orphan ledger entry).
   *
   * The ledger is always a vault-wide singleton — all
   * collections in the same vault share the same LedgerStore.
   * Vault.ledger() does the lazy init; this field just holds
   * the reference so Collection doesn't need to reach back up to the
   * vault on every mutation.
   *
   * `undefined` means "no ledger attached" — supported for tests that
   * construct a Collection directly without a vault, and for
   * future backwards-compat scenarios. Production usage always has a
   * ledger because Vault.collection() passes one through.
   */
  private readonly ledger: LedgerStore | undefined

  /** v0.9 #132 — per-collection CRDT mode, or undefined for normal LWW-at-record-level. */
  private readonly crdtMode: CrdtMode | undefined

  /** v0.9 #134 — optional remote/sync adapter for presence broadcasting. */
  private readonly syncAdapter: NoydbStore | undefined

  /**
   * Optional back-reference to the owning compartment's ref
   * enforcer. When present, `Collection.put` calls
   * `refEnforcer.enforceRefsOnPut(name, record)` before the adapter
   * write, and `Collection.delete` calls
   * `refEnforcer.enforceRefsOnDelete(name, id)` before its own
   * adapter delete. The Vault handles the actual registry
   * lookup and cross-collection enforcement — Collection just
   * notifies it at the right points in the lifecycle.
   *
   * Typed as a structural interface rather than `Vault`
   * directly to avoid a circular import. Vault implements
   * these two methods; any other object with the same shape would
   * work too (used only in unit tests).
   */
  private readonly refEnforcer:
    | {
        enforceRefsOnPut(collectionName: string, record: unknown): Promise<void>
        enforceRefsOnDelete(collectionName: string, id: string): Promise<void>
      }
    | undefined

  /**
   * Optional back-reference to the owning compartment's join resolver
   * (v0.6 #73 — eager single-FK `.join()`). When present,
   * `Collection.query()` builds a `JoinContext` that lets the Query
   * resolve `.join(field)` calls into target collections via this
   * resolver.
   *
   * Two methods:
   *   - `resolveSource(name)` — fetch a `JoinableSource` for the
   *     right-side collection by name. Returning `null` means "no
   *     such collection in this compartment" — the executor then
   *     throws an actionable error naming the missing target.
   *   - `resolveRef(leftCollection, field)` — look up the ref
   *     descriptor the left collection declared for this field.
   *     `null` when the field has no ref, which makes `.join()`
   *     throw at plan time before any records are touched.
   *
   * Typed structurally rather than as `Vault` to avoid a
   * circular import. Vault implements these two methods; any
   * other object with the same shape works too (used only in unit
   * tests against a plain object).
   */
  private readonly joinResolver:
    | {
        resolveSource(collectionName: string): JoinableSource | null
        resolveRef(leftCollection: string, field: string): RefDescriptor | null
        resolveDictSource?: (leftCollection: string, field: string) => JoinableSource | null
      }
    | undefined

  constructor(opts: {
    adapter: NoydbStore
    vault: string
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
     * `LedgerStore.append()`. Constructed at the Vault level and
     * threaded through — see the Vault.collection() source for
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
    /**
     * Optional back-reference to the owning compartment's join
     * resolver (v0.6 #73). When present, `query()` builds a
     * `JoinContext` so `.join(field)` can resolve through the
     * existing `ref()` declaration into the target collection.
     * Absent in tests that construct a Collection directly without
     * a vault; production usage always has one because
     * Vault.collection() passes `this` through.
     */
    joinResolver?:
      | {
          resolveSource(collectionName: string): JoinableSource | null
          resolveRef(leftCollection: string, field: string): RefDescriptor | null
        }
      | undefined
    /** v0.8 #82 — i18nText field descriptors for locale-aware reads. */
    i18nFields?: Record<string, I18nTextDescriptor> | undefined
    /** v0.8 #81 — dictKey field descriptors for label resolution on reads. */
    dictKeyFields?: Record<string, DictKeyDescriptor> | undefined
    /**
     * v0.8 #81 — async callback that resolves a dict key to its label
     * for a given locale. Provided by the Vault.
     */
    dictLabelResolver?:
      | ((
          dictName: string,
          key: string,
          locale: string,
          fallback?: string | readonly string[],
        ) => Promise<string | undefined>)
      | undefined
    /**
     * v0.8 #82 — synchronous callback that validates i18nText fields
     * on put. Provided by the Vault. Throws MissingTranslationError.
     */
    i18nPutValidator?: ((record: unknown) => void) | undefined
    /**
     * v0.8 #83 — translator callback from Noydb. When present, missing
     * translations for `autoTranslate: true` i18nText fields are generated
     * before the i18n validator runs.
     */
    autoTranslateHook?:
      | ((text: string, from: string, to: string, field: string, collection: string) => Promise<string>)
      | undefined
    /**
     * v0.8 — vault-default locale, inherited from
     * `openVault(name, { locale })` or `vault.setLocale()`.
     */
    defaultLocale?: string | undefined
    /**
     * v0.9 #131 — collection-level conflict resolution policy.
     * Overrides the db-level `conflict` option for this collection only.
     */
    conflictPolicy?: ConflictPolicy<T> | undefined
    /**
     * v0.9 #131 — callback to register an envelope-level resolver with the
     * SyncEngine. Provided by the Vault (wired from the SyncEngine).
     */
    onRegisterConflictResolver?: ((name: string, resolver: CollectionConflictResolver) => void) | undefined
    /**
     * v0.9 #132 — CRDT mode for this collection. When set, `put()` stores
     * CRDT state in the envelope and `get()` returns the resolved snapshot.
     * `getRaw(id)` returns the full CRDT state for merge operations.
     */
    crdt?: CrdtMode | undefined
    /**
     * v0.9 #134 — optional remote/sync adapter. When present, `presence()`
     * writes heartbeats to this adapter so other devices can read them.
     * If the adapter implements pub/sub, presence updates are real-time.
     */
    syncAdapter?: NoydbStore | undefined
  }) {
    this.adapter = opts.adapter
    this.vault = opts.vault
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
    this.joinResolver = opts.joinResolver
    this.i18nFields = opts.i18nFields
    this.dictKeyFields = opts.dictKeyFields
    this.dictLabelResolver = opts.dictLabelResolver
    this.i18nPutValidator = opts.i18nPutValidator
    this.autoTranslateHook = opts.autoTranslateHook
    this.defaultLocale = opts.defaultLocale
    this.crdtMode = opts.crdt
    this.syncAdapter = opts.syncAdapter

    // v0.9 #132 — register CRDT conflict resolver with SyncEngine
    if (opts.crdt && opts.onRegisterConflictResolver) {
      const crdtMode = opts.crdt
      const crdtResolver: CollectionConflictResolver = async (_id, local, remote) => {
        if (crdtMode === 'yjs') {
          // Core cannot merge Yjs without the yjs package — take the higher version
          return local._v >= remote._v ? local : remote
        }
        const localJson = await this.decryptJsonString(local)
        const remoteJson = await this.decryptJsonString(remote)
        const localState = JSON.parse(localJson) as CrdtState
        const remoteState = JSON.parse(remoteJson) as CrdtState
        const merged = mergeCrdtStates(localState, remoteState)
        const mergedVersion = Math.max(local._v, remote._v) + 1
        return this.encryptJsonString(JSON.stringify(merged), mergedVersion)
      }
      opts.onRegisterConflictResolver(this.name, crdtResolver)
    }

    // v0.9 #131 — build and register per-collection conflict resolver with SyncEngine
    if (opts.conflictPolicy !== undefined && opts.onRegisterConflictResolver) {
      const policy = opts.conflictPolicy
      const compartmentName = this.vault
      const collectionName = this.name
      const emitter = this.emitter
      let resolver: CollectionConflictResolver

      if (policy === 'last-writer-wins') {
        resolver = async (_id, local, remote) => (local._ts >= remote._ts ? local : remote)
      } else if (policy === 'first-writer-wins') {
        resolver = async (_id, local, remote) => (local._v <= remote._v ? local : remote)
      } else if (policy === 'manual') {
        resolver = (id, local, remote) =>
          new Promise<EncryptedEnvelope | null>(resolvePromise => {
            let settled = false
            const resolveCallback = (winner: EncryptedEnvelope | null) => {
              if (!settled) {
                settled = true
                resolvePromise(winner)
              }
            }
            emitter.emit('sync:conflict', {
              vault: compartmentName,
              collection: collectionName,
              id,
              local,
              remote,
              localVersion: local._v,
              remoteVersion: remote._v,
              resolve: resolveCallback,
            })
            // Defer if no handler called resolve synchronously
            if (!settled) {
              settled = true
              resolvePromise(null)
            }
          })
      } else {
        // Custom merge fn: decrypt both → merge → re-encrypt
        const mergeFn = policy as (local: T, remote: T) => T
        resolver = async (_id, local, remote) => {
          const localRecord = await this.decryptRecord(local, { skipValidation: true })
          const remoteRecord = await this.decryptRecord(remote, { skipValidation: true })
          const merged = mergeFn(localRecord, remoteRecord)
          const mergedVersion = Math.max(local._v, remote._v) + 1
          return this.encryptRecord(merged, mergedVersion)
        }
      }

      opts.onRegisterConflictResolver(collectionName, resolver)
    }

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
   * Exposed (read-only) for the Vault-level export primitive,
   * which surfaces each collection's schema in the per-chunk metadata
   * so downstream serializers (`@noy-db/decrypt-*` packages, custom
   * exporters) can produce schema-aware output without poking at
   * collection internals. The validator object is returned by
   * reference — callers must treat it as immutable.
   */
  getSchema(): StandardSchemaV1<unknown, T> | undefined {
    return this.schema
  }

  /**
   * Get a single record by ID.
   *
   * @param id      Record identifier.
   * @param locale  Optional locale options (v0.8 #81 #82). When provided,
   *                `i18nText` fields are resolved to the requested locale
   *                string, and `dictKey` fields get a `<field>Label`
   *                virtual field added. Pass `{ locale: 'raw' }` to
   *                return the full `{ [locale]: string }` map instead.
   *
   * @returns The decrypted (and optionally locale-resolved) record, or
   *          `null` if not found.
   */
  async get(id: string, locale?: LocaleReadOptions): Promise<T | null> {
    let record: T | null

    if (this.lazy && this.lru) {
      // Cache hit: promote and return.
      const cached = this.lru.get(id)
      if (cached) {
        record = cached.record
      } else {
        // Cache miss: hit the adapter, decrypt, populate the LRU.
        const envelope = await this.adapter.get(this.vault, this.name, id)
        if (!envelope) return null
        record = await this.decryptRecord(envelope)
        this.lru.set(id, { record, version: envelope._v }, estimateRecordBytes(record))
      }
    } else {
      // Eager mode: load everything once, then serve from the in-memory map.
      await this.ensureHydrated()
      const entry = this.cache.get(id)
      record = entry ? entry.record : null
    }

    if (record === null) return null
    return this.applyLocaleToRecord(record, locale)
  }

  /**
   * Return the raw CRDT state for a record (v0.9 #132).
   * Only available on collections configured with `crdt: 'lww-map' | 'rga' | 'yjs'`.
   * Use this for merge operations or to pass to `@noy-db/yjs`.
   * Throws if the collection is not in CRDT mode.
   */
  async getRaw(id: string): Promise<CrdtState | null> {
    if (!this.crdtMode) {
      throw new Error(
        `Collection "${this.name}": getRaw() is only available when the collection ` +
        `is created with a 'crdt' option ('lww-map', 'rga', or 'yjs').`,
      )
    }
    const envelope = await this.adapter.get(this.vault, this.name, id)
    if (!envelope) return null
    const json = await this.decryptJsonString(envelope)
    return JSON.parse(json) as CrdtState
  }

  /**
   * Return a presence handle for this collection (v0.9 #134).
   *
   * The handle manages an encrypted ephemeral presence channel keyed by an
   * HKDF derivation of this collection's DEK. Presence payloads are invisible
   * to the adapter.
   *
   * @param opts.staleMs       Milliseconds before a peer is considered inactive.
   *                           Default: 30 000.
   * @param opts.pollIntervalMs Milliseconds between storage polls (fallback mode).
   *                           Default: 5 000.
   */
  presence<P = unknown>(opts?: { staleMs?: number; pollIntervalMs?: number }): PresenceHandle<P> {
    const presenceOpts: PresenceHandleOpts = {
      adapter: this.adapter,
      vault: this.vault,
      collectionName: this.name,
      userId: this.keyring.userId,
      encrypted: this.encrypted,
      getDEK: this.getDEK,
    }
    if (this.syncAdapter !== undefined) presenceOpts.syncAdapter = this.syncAdapter
    if (opts?.staleMs !== undefined) presenceOpts.staleMs = opts.staleMs
    if (opts?.pollIntervalMs !== undefined) presenceOpts.pollIntervalMs = opts.pollIntervalMs
    return new PresenceHandle<P>(presenceOpts)
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

    // Auto-translate missing i18nText translations (v0.8 #83).
    // Runs BEFORE i18n validation so translated values satisfy the
    // required-locale constraint. Throws TranslatorNotConfiguredError
    // when a field has autoTranslate: true but no hook was configured.
    if (this.i18nFields) {
      const obj = record as Record<string, unknown>
      for (const [field, descriptor] of Object.entries(this.i18nFields)) {
        if (!descriptor.options.autoTranslate) continue
        const value = obj[field]
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        const map = value as Record<string, string>
        // Determine which locales need translation. For 'all', translate all
        // declared languages that are missing. For 'any', only translate if
        // none are present. For string[], translate the listed required ones.
        const { languages, required } = descriptor.options
        const missing: string[] = languages.filter(
          (lang) => !(lang in map) || map[lang] === '',
        )
        if (missing.length === 0) continue
        // Find a source locale (first present non-empty value)
        const sourceLocale = languages.find((l) => l in map && map[l] !== '')
        if (!sourceLocale) continue
        if (!this.autoTranslateHook) {
          throw new TranslatorNotConfiguredError(field, this.name)
        }
        // Only translate locales that are actually needed
        const toTranslate =
          required === 'any'
            ? [] // 'any' is already satisfied since sourceLocale exists
            : required === 'all'
              ? missing
              : missing.filter((l) => required.includes(l))
        const translated = { ...map }
        for (const targetLocale of toTranslate) {
          translated[targetLocale] = await this.autoTranslateHook(
            map[sourceLocale]!,
            sourceLocale,
            targetLocale,
            field,
            this.name,
          )
        }
        ;(record as Record<string, unknown>)[field] = translated
      }
    }

    // i18nText validation (v0.8 #82) — runs AFTER schema validation so
    // the record shape is trustworthy. Throws MissingTranslationError
    // when required translations are absent.
    if (this.i18nPutValidator !== undefined) {
      this.i18nPutValidator(record)
    }

    // Foreign-key ref enforcement (v0.4 #45). Runs AFTER schema
    // validation (so the record shape is trustworthy) but BEFORE
    // any write (so a failed strict ref leaves no trace on disk,
    // in history, or in the ledger). The Vault handles the
    // actual target lookups — see `enforceRefsOnPut` over there.
    if (this.refEnforcer !== undefined) {
      await this.refEnforcer.enforceRefsOnPut(this.name, record)
    }

    // ─── CRDT mode (v0.9 #132) ─────────────────────────────────────────
    // In CRDT mode we always read the raw envelope from the adapter to get
    // the existing CRDT state, merge the incoming record into it, then
    // encrypt the merged CRDT state — bypassing the normal version path.
    if (this.crdtMode) {
      const existingEnvelope = await this.adapter.get(this.vault, this.name, id)
      const existingVersion = existingEnvelope?._v ?? 0
      const now = new Date().toISOString()

      let crdtState: CrdtState

      if (this.crdtMode === 'lww-map') {
        let existingState: LwwMapState | undefined
        if (existingEnvelope) {
          const prevJson = await this.decryptJsonString(existingEnvelope)
          const prevParsed = JSON.parse(prevJson) as unknown
          if (prevParsed !== null && typeof prevParsed === 'object' && '_crdt' in prevParsed) {
            existingState = prevParsed as LwwMapState
          }
        }
        crdtState = buildLwwMapState(record as Record<string, unknown>, existingState, now)
      } else if (this.crdtMode === 'rga') {
        let existingState: RgaState | undefined
        if (existingEnvelope) {
          const prevJson = await this.decryptJsonString(existingEnvelope)
          const prevParsed = JSON.parse(prevJson) as unknown
          if (prevParsed !== null && typeof prevParsed === 'object' && '_crdt' in prevParsed) {
            existingState = prevParsed as RgaState
          }
        }
        const arr = Array.isArray(record) ? record : [record]
        crdtState = buildRgaState(arr, existingState, generateULID)
      } else {
        // yjs: record is the base64 update string (produced by @noy-db/yjs)
        crdtState = { _crdt: 'yjs', update: record as unknown as string }
      }

      const version = existingVersion + 1
      const envelope = await this.encryptJsonString(JSON.stringify(crdtState), version)
      await this.adapter.put(this.vault, this.name, id, envelope)

      // Resolve snapshot for cache and history
      const resolvedRecord = resolveCrdtSnapshot(crdtState) as T
      const existingResolved = existingEnvelope
        ? { record: await this.decryptRecord(existingEnvelope, { skipValidation: true }), version: existingVersion }
        : undefined

      if (existingResolved && this.historyConfig.enabled !== false) {
        const histEnvelope = await this.encryptRecord(existingResolved.record, existingResolved.version)
        await saveHistory(this.adapter, this.vault, this.name, id, histEnvelope)
        this.emitter.emit('history:save', { vault: this.vault, collection: this.name, id, version: existingResolved.version })
        if (this.historyConfig.maxVersions) {
          await pruneHistoryEntries(this.adapter, this.vault, this.name, id, { keepVersions: this.historyConfig.maxVersions })
        }
      }

      if (this.ledger) {
        const appendInput: Parameters<typeof this.ledger.append>[0] = {
          op: 'put', collection: this.name, id, version, actor: this.keyring.userId,
          payloadHash: await envelopePayloadHash(envelope),
        }
        if (existingResolved) appendInput.delta = computePatch(resolvedRecord, existingResolved.record)
        await this.ledger.append(appendInput)
      }

      if (this.lazy && this.lru) {
        this.lru.set(id, { record: resolvedRecord, version }, estimateRecordBytes(resolvedRecord))
      } else {
        this.cache.set(id, { record: resolvedRecord, version })
        this.indexes.upsert(id, resolvedRecord, existingResolved ? existingResolved.record : null)
      }

      await this.onDirty?.(this.name, id, 'put', version)
      this.emitter.emit('change', { vault: this.vault, collection: this.name, id, action: 'put' } satisfies ChangeEvent)
      return
    }
    // ─── End CRDT mode ──────────────────────────────────────────────────

    // Resolve the previous record. In eager mode this comes from the
    // in-memory map (no I/O); in lazy mode we have to ask the adapter
    // because the record may have been evicted (or never loaded).
    let existing: { record: T; version: number } | undefined
    if (this.lazy && this.lru) {
      existing = this.lru.get(id)
      if (!existing) {
        const previousEnvelope = await this.adapter.get(this.vault, this.name, id)
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
      await saveHistory(this.adapter, this.vault, this.name, id, historyEnvelope)

      this.emitter.emit('history:save', {
        vault: this.vault,
        collection: this.name,
        id,
        version: existing.version,
      })

      // Auto-prune if maxVersions configured
      if (this.historyConfig.maxVersions) {
        await pruneHistoryEntries(this.adapter, this.vault, this.name, id, {
          keepVersions: this.historyConfig.maxVersions,
        })
      }
    }

    const envelope = await this.encryptRecord(record, version)
    await this.adapter.put(this.vault, this.name, id, envelope)

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
      vault: this.vault,
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
        const previousEnvelope = await this.adapter.get(this.vault, this.name, id)
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
      await saveHistory(this.adapter, this.vault, this.name, id, historyEnvelope)
    }

    // Capture the previous envelope's payloadHash BEFORE delete so we
    // have a stable reference for the ledger entry. The hash is of
    // whatever was last visible to readers — for a `delete` of a
    // never-existed record, we use the empty string (which the
    // ledger entry's `payloadHash` field tolerates).
    const previousEnvelope = await this.adapter.get(this.vault, this.name, id)
    const previousPayloadHash = await envelopePayloadHash(previousEnvelope)

    await this.adapter.delete(this.vault, this.name, id)

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
      vault: this.vault,
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
   *
   * @param locale  Optional locale options (v0.8 #81 #82). When provided,
   *                each record is locale-resolved before being returned.
   */
  async list(locale?: LocaleReadOptions): Promise<T[]> {
    if (this.lazy) {
      throw new Error(
        `Collection "${this.name}": list() is not available in lazy mode (prefetch: false). ` +
        `Use collection.scan({ pageSize }) to iterate over the full collection.`,
      )
    }
    await this.ensureHydrated()
    const records = [...this.cache.values()].map(e => e.record)
    if (!locale) return records
    return Promise.all(records.map(r => this.applyLocaleToRecord(r, locale)))
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
          if (event.vault === this.vault && event.collection === this.name) {
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
    // Build a JoinContext if the vault passed a join resolver.
    // Without one, .join() on the resulting Query will throw with an
    // actionable error — the case is unreachable in production but
    // matters for unit tests that construct Collection directly.
    const resolver = this.joinResolver
    const leftCollection = this.name
    const joinContext: JoinContext | undefined = resolver
      ? {
          leftCollection,
          resolveRef: (field: string) => resolver.resolveRef(leftCollection, field),
          resolveSource: (collectionName: string) => resolver.resolveSource(collectionName),
          ...(resolver.resolveDictSource
            ? { resolveDictSource: (field: string) => resolver.resolveDictSource!(leftCollection, field) }
            : {}),
        }
      : undefined
    return new Query<T>(source, undefined, joinContext)
  }

  /**
   * Return a minimal JoinableSource view of this collection's
   * in-memory cache. Used by the Vault's `resolveSource`
   * method when another collection's `.join()` needs to probe this
   * one as the right side.
   *
   * The returned object captures the cache reference through a
   * closure, so subsequent mutations to the cache are visible to
   * the joined query. That's intentional: a join that fires after
   * the right-side collection has been updated should see the
   * fresh data.
   *
   * Throws in lazy mode because the cache is bounded and could
   * silently miss records — consistent with the `query()` /
   * `list()` lazy-mode policy. If this becomes a blocker for a
   * real consumer, the fix is to add an async `scan()`-backed
   * variant of this method, which is exactly what #76 streaming
   * joins will need anyway.
   */
  querySourceForJoin(): JoinableSource {
    if (this.lazy) {
      throw new Error(
        `Collection "${this.name}": .join() cannot use a lazy-mode ` +
          `collection as the right side. Opening it in eager mode ` +
          `(prefetch: true, default) makes it joinable. Streaming joins ` +
          `over lazy collections are tracked in #76.`,
      )
    }
    // Structural source — the join executor calls snapshot() and
    // lookupById(); the live-join executor (#74) additionally calls
    // subscribe() so right-side mutations propagate. We capture
    // `this.cache` and `this.emitter` by closure so later mutations
    // are visible to the snapshot view AND drive live re-fires.
    return {
      snapshot: () => [...this.cache.values()].map(e => e.record),
      lookupById: (id: string) => this.cache.get(id)?.record,
      subscribe: (cb: () => void) => {
        const handler = (event: ChangeEvent): void => {
          if (event.vault === this.vault && event.collection === this.name) {
            cb()
          }
        }
        this.emitter.on('change', handler)
        return () => this.emitter.off('change', handler)
      },
    }
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
      this.adapter, this.vault, this.name, id, options,
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
      this.adapter, this.vault, this.name, id, version,
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
      this.adapter, this.vault, this.name, id, options,
    )
    if (pruned > 0) {
      this.emitter.emit('history:prune', {
        vault: this.vault,
        collection: this.name,
        id: id ?? '*',
        pruned,
      })
    }
    return pruned
  }

  /** Clear all history for this collection (or a specific record). */
  async clearHistory(id?: string): Promise<number> {
    return clearHistory(this.adapter, this.vault, this.name, id)
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
      const ids = await this.adapter.list(this.vault, this.name)
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
      const result = await this.adapter.listPage(this.vault, this.name, opts.cursor, limit)
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
    const ids = (await this.adapter.list(this.vault, this.name)).slice().sort()
    const start = opts.cursor ? parseInt(opts.cursor, 10) : 0
    const end = Math.min(start + limit, ids.length)
    const items: T[] = []
    for (let i = start; i < end; i++) {
      const id = ids[i]!
      const envelope = await this.adapter.get(this.vault, this.name, id)
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
   * Stream every record in the collection page-by-page as an async
   * iterable, with chainable `.where()` / `.filter()` clauses and a
   * memory-bounded `.aggregate(spec)` terminal.
   *
   * The whole point: process collections larger than RAM without
   * ever holding more than `pageSize` records decrypted at once.
   *
   * @example
   * ```ts
   * // Backward-compatible iteration — unchanged from the previous
   * // async-generator shape. `ScanBuilder` implements AsyncIterable.
   * for await (const record of invoices.scan({ pageSize: 500 })) {
   *   await processOne(record)
   * }
   *
   * // v0.6 #99 — streaming aggregation with O(reducers) memory.
   * const { total, n } = await invoices.scan()
   *   .where('year', '==', 2025)
   *   .aggregate({ total: sum('amount'), n: count() })
   * ```
   *
   * Returns a `ScanBuilder<T>` instead of the raw async iterator
   * that previous versions used. The builder implements
   * `AsyncIterable<T>`, so every existing `for await … of` call
   * continues to work unchanged. Direct `.next()` calls on the
   * iterator — not idiomatic, not used in the codebase — are no
   * longer supported; upgrade to `for await` or call the new
   * `.aggregate()` terminal.
   *
   * Uses `adapter.listPage` when available; otherwise falls back
   * to the synthetic pagination path with the same one-time
   * warning (`listPage()` routes through that fallback internally).
   */
  scan(opts: { pageSize?: number } = {}): ScanBuilder<T> {
    const pageSize = opts.pageSize ?? 100
    // Build a JoinContext if the vault passed a join resolver
    // — same machinery as `query()` (#73). Without one, `.join()`
    // on the resulting ScanBuilder will throw with an actionable
    // error. The resolver is unreachable in production but matters
    // for unit tests that construct Collection directly.
    const resolver = this.joinResolver
    const leftCollection = this.name
    const joinContext: JoinContext | undefined = resolver
      ? {
          leftCollection,
          resolveRef: (field: string) => resolver.resolveRef(leftCollection, field),
          resolveSource: (collectionName: string) => resolver.resolveSource(collectionName),
          ...(resolver.resolveDictSource
            ? { resolveDictSource: (field: string) => resolver.resolveDictSource!(leftCollection, field) }
            : {}),
        }
      : undefined
    // The page provider closure is bound to this collection's
    // listPage method so the builder is free of any `this`
    // coupling. Rebinding through the arrow keeps the unbound-
    // method lint rule happy — matches the pattern used in
    // builder.ts's candidateRecords helper.
    return new ScanBuilder<T>(
      {
        listPage: (listOpts) => this.listPage(listOpts),
      },
      pageSize,
      [],
      [],
      joinContext,
    )
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

    const ids = await this.adapter.list(this.vault, this.name)
    for (const id of ids) {
      const envelope = await this.adapter.get(this.vault, this.name, id)
      if (envelope) {
        const record = await this.decryptRecord(envelope)
        this.cache.set(id, { record, version: envelope._v })
      }
    }
    this.hydrated = true
    this.rebuildIndexes()
  }

  /** Hydrate from a pre-loaded snapshot (used by Vault). */
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

  /**
   * Return a `BlobSet` for the given record id (v0.12 #105).
   *
   * No I/O is performed until you call a method on the handle.
   *
   * ```ts
   * const blobs = invoices.blob('inv-001')
   *
   * // Upload a PDF (deduplicates automatically, MIME auto-detected)
   * await blobs.put('receipt.pdf', pdfBytes)
   *
   * // List slots
   * const files = await blobs.list()   // SlotInfo[]
   *
   * // Serve as HTTP response (Content-Type, ETag, streaming body)
   * const res = await blobs.response('receipt.pdf', { inline: true })
   *
   * // Publish a named version (amendment versioning)
   * await blobs.publish('receipt.pdf', 'issued-2025-01')
   *
   * // Raw bytes
   * const bytes = await blobs.get('receipt.pdf')
   * ```
   *
   * Blobs are stored in internal collections (`_blob_slots_*`, `_blob_index`,
   * `_blob_chunks`, `_blob_versions_*`) that are excluded from queries and
   * `list()`. Slot metadata uses this collection's DEK; chunk data uses a
   * vault-shared `_blob` DEK (enabling cross-collection deduplication).
   */
  blob(id: string): BlobSet {
    return new BlobSet({
      store: this.adapter,
      vault: this.vault,
      collection: this.name,
      recordId: id,
      getDEK: this.getDEK,
      encrypted: this.encrypted,
      userId: this.keyring.userId,
    })
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

  /**
   * Apply locale resolution to a record (v0.8 #81 #82).
   *
   * Called from `get()` and `list()` when locale options are present.
   * Uses the effective locale: per-call `locale` takes precedence over
   * `this.defaultLocale`.
   *
   * - i18nText fields: replaced with the resolved string (or the full
   *   map when `locale === 'raw'`).
   * - dictKey fields: `<field>Label` virtual fields added.
   *
   * Returns the record unchanged when no locale is active and no i18n/dict
   * fields are registered.
   */
  private async applyLocaleToRecord(
    record: T,
    localeOpts?: LocaleReadOptions,
  ): Promise<T> {
    const hasI18n = this.i18nFields && Object.keys(this.i18nFields).length > 0
    const hasDict = this.dictKeyFields && Object.keys(this.dictKeyFields).length > 0
    if (!hasI18n && !hasDict) return record

    const locale = localeOpts?.locale ?? this.defaultLocale
    if (!locale) return record

    let result = record as unknown as Record<string, unknown>

    // 1. i18nText resolution
    if (hasI18n && this.i18nFields) {
      result = applyI18nLocale(result, this.i18nFields, locale, localeOpts?.fallback)
    }

    // 2. dictKey label resolution
    if (hasDict && this.dictKeyFields && this.dictLabelResolver && locale !== 'raw') {
      const withLabels = { ...result }
      for (const [field, desc] of Object.entries(this.dictKeyFields)) {
        const key = result[field]
        if (typeof key !== 'string') continue
        const label = await this.dictLabelResolver(
          desc.name,
          key,
          locale,
          localeOpts?.fallback,
        )
        if (label !== undefined) {
          withLabels[`${field}Label`] = label
        }
      }
      result = withLabels
    }

    return result as T
  }

  /**
   * Low-level: encrypt a pre-serialised JSON string into an EncryptedEnvelope.
   * Used by both the normal record path and the CRDT path (which serialises
   * a CrdtState rather than a T).
   */
  private async encryptJsonString(json: string, version: number): Promise<EncryptedEnvelope> {
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

  private async encryptRecord(record: T, version: number): Promise<EncryptedEnvelope> {
    return this.encryptJsonString(JSON.stringify(record), version)
  }

  /** Low-level: decrypt an envelope and return the raw JSON string. */
  private async decryptJsonString(envelope: EncryptedEnvelope): Promise<string> {
    if (!this.encrypted) return envelope._data
    const dek = await this.getDEK(this.name)
    return decrypt(envelope._iv, envelope._data, dek)
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
    const json = await this.decryptJsonString(envelope)
    let parsed: unknown = JSON.parse(json)

    // CRDT resolution (v0.9 #132): if this collection is in CRDT mode, the
    // stored JSON is a CrdtState, not T directly. Resolve to the snapshot.
    if (this.crdtMode && parsed !== null && typeof parsed === 'object' && '_crdt' in parsed) {
      parsed = resolveCrdtSnapshot(parsed as CrdtState)
    }

    let record = parsed as T

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
