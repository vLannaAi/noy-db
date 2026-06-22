import type { NoydbStore, EncryptedEnvelope, ChangeEvent, HistoryConfig, HistoryOptions, HistoryEntry, PruneOptions, ListPageResult, LocaleReadOptions, ConflictPolicy, CollectionConflictResolver, PutManyItemOptions, PutManyOptions, PutManyResult, DeleteManyResult } from './types.js'
import { NOYDB_FORMAT_VERSION } from './types.js'
import type { CrdtMode, CrdtState, LwwMapState, RgaState } from './crdt/crdt.js'
import { NO_CRDT, type CrdtStrategy } from './crdt/strategy.js'
import type { I18nTextDescriptor } from './i18n/core.js'
import { getAtPath, setAtPathInPlace, stripI18nFilled } from './i18n/core.js'
import type { DictKeyDescriptor, StaticDictDescriptor, DictionaryHandle } from './i18n/dictionary.js'
import { isStaticDictDescriptor } from './i18n/dictionary.js'
import type { MoneyDescriptor } from './money/descriptor.js'
import { quantizeMoneyFields, decodeMoneyFields, canonicalizeStoredMoney, canonicalizeIncomingMoney } from './money/normalize.js'
import { validateMoneyFieldPaths } from './money/paths.js'
import type { ComputedFields } from './computed/index.js'
import { evalComputedFields } from './computed/index.js'
import { NO_I18N, type I18nStrategy } from './i18n/strategy.js'
import { resolvePolicy } from './i18n/policy.js'
import { encrypt, decrypt, encryptDeterministic } from './crypto.js'
import {
  wrapCek,
  unwrapCek,
  isTombstone,
  buildTombstone,
  resolveStableCek,
  rewrapBodyToDek,
} from './record-keys/index.js'
import { ConflictError, ReadOnlyError, TranslatorNotConfiguredError, TierDemoteDeniedError, LocaleNotSpecifiedError } from './errors.js'
import { dekKey, assertTierAccess } from './team/tiers.js'
import type { GhostRecord, TierMode, CrossTierAccessEvent } from './types.js'
import type { UnlockedKeyring } from './team/keyring.js'
import { hasWritePermission } from './team/keyring.js'
import type { NoydbEventEmitter } from './events.js'
import type { WriteQueueTracker } from './write-queue.js'
import type { WriteHookRegistry, WriteEvent } from './write-hooks.js'
import type { SubsystemBus, GatePutEvent } from './subsystem-bus.js'
import type { SchemaUpdateGate } from './schema-update/gate.js'
import type { SchemaFenceController } from './schema-update/fence-controller.js'
import type { StandardSchemaV1 } from './schema.js'
import { validateSchemaInput, validateSchemaOutput } from './schema.js'
import type { LedgerStore } from './history/ledger/index.js'
import type { DiffEntry } from './history/diff.js'
import { NO_HISTORY, type HistoryStrategy } from './history/strategy.js'
import { Query, ScanBuilder } from './query/index.js'
import type { QuerySource, JoinContext, JoinableSource } from './query/index.js'
import type { CollectionIndexes, IndexDef } from './indexing/eager-indexes.js'
import { encodeIdxId, decodeIdxId } from './indexing/persisted-indexes.js'
import type { PersistedCollectionIndex, PersistedIndexDef } from './indexing/persisted-indexes.js'
import { LazyQuery } from './indexing/lazy-builder.js'
import type { LazyQuerySource } from './indexing/lazy-builder.js'
import { NO_INDEXING, type IndexStrategy, type IndexState } from './indexing/strategy.js'
import { searchScan, type SearchOptions, type SearchResult } from './search/index.js'
import { MemoryIndexStore, type IndexStore } from './search/index-store.js'
import { PersistedIndexStore, type PersistedIndexCallbacks } from './search/persisted-index-store.js'
import { extractSnippet } from './search/snippet.js'
import { buildStringFieldEntries, buildI18nFieldEntries, buildDictKeyFieldEntries, buildBlobFieldEntries } from './search/build-docs.js'
import type { IndexDoc, IndexHit } from './search/inverted-index.js'
import type { RetrieveOptions, RetrieveHit } from './search/retrieve-types.js'
import { IndexWriteFailureError, DerivationCapExceededError, DebugReservedFieldError, EmbeddingDimMismatchError } from './errors.js'
import { embeddingSourceText, VectorSet, type EmbeddingDescriptor, type StoredVector } from './embeddings/index.js'
import { buildUniqueConstraintSet, type UniqueConstraintSet } from './indexing/unique-constraints.js'
import type { RefDescriptor } from './refs.js'
import { Lru, parseBytes, estimateRecordBytes, type LruStats } from './cache/index.js'
import { generateULID } from './bundle/ulid.js'
import type { PresenceHandle, PresenceHandleOpts } from './team/presence.js'
import { NO_SYNC, type SyncStrategy } from './team/sync-strategy.js'
import type { BlobSet } from './blobs/blob-set.js'
import { NO_BLOBS, type BlobStrategy } from './blobs/strategy.js'
import type { ObjectProjection } from './blobs/object-projection.js'
import type { BlobFieldsConfig } from './blobs/blob-compaction.js'
import { NO_AGGREGATE, type AggregateStrategy } from './aggregate/strategy.js'
import type { ReadOnlyVaultFacade } from './guards/types.js'
import type { DerivationRegistry } from './derivations/registry.js'
import type { TxContext, ExecutedOp } from './tx/transaction.js'
import { revertExecuted } from './tx/transaction.js'
// Type-only — runtime class loaded via dynamic import in
// `dispatchDerivations` when an eager-mode strategy fires. Keeps the
// derivation executor chunk out of the floor bundle.
import type { DerivationExecutor as DerivationExecutorType } from './derivations/executor.js'
import type {
  loadFanoutSidecar as LoadFanoutSidecarType,
  deleteFanoutSidecar as DeleteFanoutSidecarType,
  saveFanoutSidecar as SaveFanoutSidecarType,
} from './derivations/fanout-sidecar.js'
import { markStale, resolveStaleOnRead } from './derivations/stale.js'
import type { MaterializedViewRegistry } from './materialized-views/registry.js'
import type { MVQueryContext } from './materialized-views/types.js'
import type { MaterializedViewExecutor as MVExecutorType } from './materialized-views/executor.js'
import type * as MVStaleModule from './materialized-views/stale.js'

/** Callback for dirty tracking (sync engine integration). */
export type OnDirtyCallback = (collection: string, id: string, action: 'put' | 'delete', version: number) => Promise<void>

/**
 * Value-equality for a single self-write reverse-denorm field (#376). Scalars
 * compare by identity; objects by canonical JSON (denorm values should be
 * deterministically shaped). Used as the cycle guard — when every denorm
 * field already matches, no write is issued and the self-write recursion ends.
 */
function selfWriteFieldEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/**
 * Event delivered to a `collection.subscribe()` callback. Distinct
 * from the hub-level `ChangeEvent` — this one is bound to a single
 * collection's type `T` and hydrates the record from cache on put.
 *
 * - `type: 'put'` — `record` is the current decrypted value, or
 *   `null` in the rare case where another op deleted the record
 *   between the emit and the handler firing.
 * - `type: 'delete'` — `record` is always `null`; the deletion is
 *   the only information.
 */
export interface CollectionChangeEvent<T> {
  readonly type: 'put' | 'delete'
  readonly id: string
  readonly record: T | null
}

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
    `[noy-db] Store "${adapterName}" does not implement listPage(); ` +
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
  private readonly writeQueue: WriteQueueTracker | undefined
  private readonly schemaUpdateGate: SchemaUpdateGate | undefined
  private readonly schemaFence: SchemaFenceController | undefined
  private readonly writeHooks: WriteHookRegistry | undefined
  private readonly subsystemBus: SubsystemBus | undefined
  private readonly activeTxId: (() => string | null) | undefined
  private readonly getDEK: (collectionName: string) => Promise<CryptoKey>
  private readonly onDirty: OnDirtyCallback | undefined
  private readonly historyConfig: HistoryConfig

  /**
   * tree-shake seam — the strategy that backs `collection.blob(id)`.
   * Defaults to `NO_BLOBS`, a ~10-line stub that throws with an actionable
   * message. Consumers opt into real blob storage by importing
   * `{ blobs }` from `@noy-db/hub/blobs` and passing the returned
   * strategy to `createNoydb({ blobStrategy: blobs() })`. With the
   * default stub, none of the BlobSet / chunk / MIME-magic machinery
   * reaches the bundle.
   */
  private readonly blobStrategy: BlobStrategy
  private readonly objectStore: ObjectProjection | undefined
  private readonly blobFields: BlobFieldsConfig | undefined
  private readonly aggregateStrategy: AggregateStrategy
  private readonly crdtStrategy: CrdtStrategy
  private readonly historyStrategy: HistoryStrategy
  private readonly i18nStrategy: I18nStrategy
  private readonly syncStrategy: SyncStrategy

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
   * tree-shake seam — per-Collection indexing state. Owned by the
   * `IndexStrategy` passed through from `createNoydb({ indexStrategy })`.
   * Defaults to a disabled state (both accessors return null) so the
   * `CollectionIndexes` / `PersistedCollectionIndex` / `LazyQuery`
   * classes never reach the bundle when indexing is unused.
   *
   * Accessor helpers below (`get indexes()`, `get persistedIndexes()`)
   * preserve the field-access ergonomics without changing every
   * caller site.
   */
  private readonly indexState: IndexState

  /**
   * In-memory unique-constraint enforcement for eager mode.
   * `null` when no `unique:true` indexes are declared on this collection,
   * or when the collection is in lazy mode (which throws at registration).
   */
  private readonly uniqueConstraints: UniqueConstraintSet | null

  /**
   * True once `_idx/*` side-cars have been bulk-loaded into
   * `persistedIndexes`. Flipped by `ensurePersistedIndexesLoaded()` on
   * first lazy-mode query so subsequent queries skip the adapter round
   * trip. Invalidation (remote sync, rotation) resets it alongside
   * `persistedIndexes.clear()`.
   */
  private persistedIndexesLoaded = false

  /**
   * Accessor for the in-memory eager-mode index mirror. Returns `null`
   * when indexing is disabled on this Noydb instance (the
   * `NO_INDEXING` default) or when the collection is in lazy mode
   * (which uses the persisted mirror instead).
   */
  private get indexes(): CollectionIndexes | null {
    return this.indexState.getEagerIndexes()
  }

  /**
   * Accessor for the persisted-mirror (lazy-mode) index. Returns `null`
   * when indexing is disabled or the collection is in eager mode.
   */
  private get persistedIndexes(): PersistedCollectionIndex | null {
    return this.indexState.getPersistedIndexes()
  }

  /**
   * per-collection reconcile-on-open policy. Read once
   * from `CollectionOptions.reconcileOnOpen` and applied by
   * `ensurePersistedIndexesLoaded()` on the first lazy-mode query.
   */
  private readonly reconcileOnOpen: 'off' | 'dry-run' | 'auto'

  /**
   * Re-entrancy guard for the auto-reconcile path. `reconcileIndex`
   * reloads the mirror after applying fixes, which re-enters
   * `ensurePersistedIndexesLoaded`; without this flag we'd trigger a
   * second auto-reconcile pass and potentially infinite recursion.
   */
  private autoReconciling = false

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
   * Declared via the `i18nFields` collection option.
   */
  private readonly i18nFields: Record<string, I18nTextDescriptor> | undefined

  /**
   * #308 L1 — the configured string fields exposed to `retrieve()`. `undefined`
   * for ordinary collections, so the search path costs nothing when unused.
   */
  private readonly textIndexes: readonly string[] | undefined

  /**
   * #308 L1 — the session-scoped lexical index store. `undefined` (so the dirty
   * poke + retrieve are zero-cost) unless `textIndexes` is non-empty.
   */
  private readonly searchIndexStore: IndexStore | undefined

  /**
   * #435 — the densify-enabled subset of {@link i18nFields} (fields whose
   * descriptor opts in via `densifyOnWrite: true`). `undefined` when none opt
   * in, so the write path skips all densify work for ordinary collections.
   */
  private readonly i18nDensifyFields: Record<string, I18nTextDescriptor> | undefined

  /**
   * #308 L2 — embedding config for write-time vector derivation. `undefined`
   * for ordinary collections (zero cost). When set, `put()` encodes the
   * source field(s) and stores an encrypted `_vec` sidecar.
   */
  private readonly embeddings: EmbeddingDescriptor | undefined

  /**
   * #308 L2 — in-memory vector set, populated lazily from `_vec` sidecars.
   * `undefined` when no embedding config is declared.
   */
  private vectorSet: VectorSet | undefined

  /**
   * Map of field name → `DictKeyDescriptor` for fields declared with
   * `dictKey()`. Used by `get()`/`list()` to add `<field>Label` virtual
   * fields when a locale is requested.
   */
  private readonly dictKeyFields: Record<string, DictKeyDescriptor | StaticDictDescriptor> | undefined

  /**
   * Money field descriptors keyed by field path. Declared via the
   * `moneyFields` collection option: `put()` quantizes to a scaled-int
   * string, `get()`/`list()` decode back. Mutable so {@link _applyMoneyFields}
   * can attach descriptors to a collection MV-analysis pre-created.
   */
  private moneyFields: Record<string, MoneyDescriptor> | undefined

  /**
   * Computed scalar fields, evaluated first on every `put()`. Mutable for
   * the same MV-pre-creation reconcile as {@link moneyFields}.
   */
  private computed: ComputedFields | undefined

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
   * #308 L1 — async callback provided by the Vault to open a dynamic
   * dictionary handle (for label-map pre-computation in the search index).
   * Only used in `resolveDictLabelMaps()`; static dicts bypass this entirely.
   */
  private readonly getDictionary: ((name: string) => Promise<DictionaryHandle>) | undefined

  /**
   * Synchronous callback provided by the Vault that validates
   * i18nText fields on `put()`. Throws `MissingTranslationError` when
   * a required translation is absent. Called after schema validation,
   * before encryption.
   */
  private readonly i18nPutValidator: ((record: unknown) => void) | undefined

  /**
   * declared deterministic fields. `null` when the feature
   * is inactive for this collection; a frozen `Set` otherwise.
   */
  private readonly deterministicFields: ReadonlySet<string> | null

  /**
   * Per-record CEK opt-in (`perRecordKeys: true`). When set, writes mint /
   * reuse a per-record content-encryption key and stamp `_cek` on the
   * envelope (see {@link EncryptedEnvelope._cek}). OFF by default — a
   * non-adopting collection takes the byte-identical legacy path. The READ
   * path does not consult this flag: `_cek` presence on the envelope is the
   * format discriminant, so a mixed vault (and a recipient that never set the
   * flag) still decrypts CEK records.
   */
  private readonly perRecordCek: boolean

  /**
   * Per-record provenance opt-in (`provenance: true`). When set, `put()` calls
   * that supply a `source` option stamp `_source`/`_sourceTs` onto the
   * unencrypted envelope metadata. Off by default — zero cost for collections
   * that don't need lineage tracking (FR-5, #445).
   */
  private readonly provenance: boolean

  /**
   * Session-scoped `(id) → CEK` cache for this collection. Lets updates
   * reuse a record's stable CEK and lets repeated reads skip the AES-KW
   * unwrap. Bounded by LRU; never persisted. Dropped when the owning
   * collection instance is discarded — `vault.load()` clears the
   * collectionCache, so a keyring refresh drops every CEK alongside the
   * DEK cache. `null` unless `perRecordCek` is set.
   */
  private readonly cekCache: Lru<string, CryptoKey> | null

  /**
   * declared tiers for this collection. `null` when
   * tier-aware methods are disabled. Tier 0 is implicit and never
   * stored here.
   */
  private readonly tiers: ReadonlySet<number> | null
  private readonly tierMode: TierMode
  private readonly onCrossTierAccess: ((event: CrossTierAccessEvent) => void) | undefined

  /**
   * Async translator callback provided by Noydb via Vault for
   * `i18nText` fields with `autoTranslate: true`. Called
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

  /** — per-collection CRDT mode, or undefined for normal LWW-at-record-level. */
  private readonly crdtMode: CrdtMode | undefined

  /** — optional remote/sync adapter for presence broadcasting. */
  private readonly syncAdapter: NoydbStore | undefined

  /** — consent-audit hook, no-op when no scope is active. */
  private readonly onAccess:
    | ((op: 'get' | 'put' | 'delete', id: string) => Promise<void>)
    | undefined

  /**
   * Vault-internal hook for derivation dispatch. When set,
   * `Collection.put` consults the registry after the source-write
   * commits and writes derived outputs through `getCollection(name).put`.
   */
  private readonly derivationSource:
    | {
        registry(): DerivationRegistry
        getCollection(name: string): Collection<Record<string, unknown>>
        getReadOnlyFacade(): ReadOnlyVaultFacade
        getActiveTxContext(): TxContext | null
        /**
         * Construct a fresh transient TxContext bound to the owning
         * Noydb. Used by `Collection.putManyAtomic` to publish an
         * `_activeTxContext` for the duration of its Phase 2 loop so
         * recursive derived-output writes register their pre-write
         * envelopes on `ctx._executed` and roll back alongside the
         * bulk-put source ops.
         */
        createTxContext(): TxContext
        /** Publish a TxContext for the duration of a bulk-atomic loop. */
        setActiveTxContext(ctx: TxContext): void
        /** Drop a previously-published TxContext (defensive no-op if mismatched). */
        clearActiveTxContext(ctx: TxContext): void
      }
    | undefined

  /**
   * Vault-internal hook for materialized-view dispatch.
   * Parallel to `derivationSource` — when set, `Collection.put` fires
   * `MaterializedViewRegistry.onSourceWrite` after the source-write
   * commits + after `dispatchDerivations` has run.
   */
  private readonly materializedViewSource:
    | {
         
        registry(): MaterializedViewRegistry
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getCollection(name: string): Collection<any>
        getActiveTxContext(): TxContext | null
        getQueryContext(): MVQueryContext
      }
    | undefined

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
   *`). When present,
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
    /**
     * Vault-level in-flight write tracker. When present,
     * `put`/`delete` run inside `writeQueue.track()` so `hub.writeQueue`
     * reflects outstanding writes. Optional so direct Collection
     * construction in tests still works untracked.
     */
    writeQueue?: WriteQueueTracker | undefined
    /** Per-collection schema-update gate; `put`/`delete` await it. */
    schemaUpdateGate?: SchemaUpdateGate | undefined
    /** Vault-level fence controller; `put`/`delete` consult it. */
    schemaFence?: SchemaFenceController | undefined
    /** Hub-level write-hook registry; fired around put/delete. */
    writeHooks?: WriteHookRegistry | undefined
    /** The observe bus, threaded from Noydb. */
    subsystemBus?: SubsystemBus | undefined
    /** Active transaction id supplier (null outside a transaction). */
    activeTxId?: (() => string | null) | undefined
    getDEK: (collectionName: string) => Promise<CryptoKey>
    historyConfig?: HistoryConfig | undefined
    onDirty?: OnDirtyCallback | undefined
    /**
     * tree-shake seam. When omitted, `collection.blob(id)` throws
     * with a pointer at the `@noy-db/hub/blobs` subpath. When set (via
     * `createNoydb({ blobStrategy: blobs() })`), blob storage is live.
     * `@internal` by virtue of `BlobStrategy` being `@internal`.
     */
    blobStrategy?: BlobStrategy | undefined
    objectStore?: ObjectProjection | undefined
    blobFields?: BlobFieldsConfig | undefined
    aggregateStrategy?: AggregateStrategy | undefined
    crdtStrategy?: CrdtStrategy | undefined
    /**
     * tree-shake seam — strategy for optional history/ledger/
     * time-machine. When omitted, history snapshots and ledger appends
     * become silent no-ops (data still writes); the read APIs
     * (`history`, `getVersion`, `revert`, `diff`, `clearHistory`,
     * `pruneRecordHistory`) throw with a pointer at `@noy-db/hub/history`.
     */
    historyStrategy?: HistoryStrategy | undefined
    i18nStrategy?: I18nStrategy | undefined
    syncStrategy?: SyncStrategy | undefined
    /**
     * tree-shake seam. When omitted, indexing is off for this
     * collection — every `.lazyQuery()` call throws, `.rebuildIndexes()`
     * is a no-op, and `indexes: [...]` declarations are ignored. Enable
     * by passing `withIndexing()` from `@noy-db/hub/indexing` at
     * `createNoydb` time.
     */
    indexStrategy?: IndexStrategy | undefined
    indexes?: IndexDef[] | undefined
    /**
     * Auto-reconcile behavior for persisted-index drift on lazy-mode
     * collections. Defaults to `'off'` — operators call
     * `collection.reconcileIndex(field)` explicitly.
     *
     *   - `'off'` (default): no implicit work. Same semantics as.
     *   - `'dry-run'`: on first lazy-mode query, run
     *     `reconcileIndex(field, { dryRun: true })` per declared field
     *     and emit `index:reconciled` with the diff. Nothing is written.
     *   - `'auto'`: same walk as `'dry-run'` but with `dryRun: false`.
     *     Drift is repaired in-place and the fix count surfaces on the
     *     event.
     *
     * Unattended long-lived processes (Workers, Node services with no
     * human operator) should set `'auto'`. Attended desktop apps should
     * leave it `'off'` and surface a manual "rebuild indexes" button.
     */
    reconcileOnOpen?: 'off' | 'dry-run' | 'auto'
    /**
     * Hydration mode. `'eager'` (default) loads everything into memory on
     * first access — matches behavior exactly. `'lazy'` defers loads
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
     * enforcer`).
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
     * resolver. When present, `query()` builds a
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
    /** — i18nText field descriptors for locale-aware reads. */
    i18nFields?: Record<string, I18nTextDescriptor> | undefined
    /** — #308 L2: embedding config for write-time vector derivation + semantic retrieval. */
    embeddings?: EmbeddingDescriptor | undefined
    /** — #308 L1: string fields exposed to client-side `retrieve()`. */
    textIndexes?: readonly string[] | undefined
    /** — #308 L1: pre-build the lexical index on open (eager-only). */
    warmIndexOnOpen?: boolean | undefined
    /** — #308 L1.5: persist the lexical index as an opaque encrypted blob at `_ftindex/<name>`. */
    textIndexPersist?: boolean | undefined
    /** — dictKey field descriptors for label resolution on reads. */
    dictKeyFields?: Record<string, DictKeyDescriptor | StaticDictDescriptor> | undefined
    moneyFields?: Record<string, MoneyDescriptor> | undefined
    computed?: ComputedFields | undefined
    /**
     * async callback that resolves a dict key to its label
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
     * #308 L1 — async callback to open a dynamic dictionary handle.
     * Provided by the Vault for dynamic-dict label-map resolution in
     * the search index. Static dicts bypass this.
     */
    getDictionary?: ((name: string) => Promise<DictionaryHandle>) | undefined
    /**
     * synchronous callback that validates i18nText fields
     * on put. Provided by the Vault. Throws MissingTranslationError.
     */
    i18nPutValidator?: ((record: unknown) => void) | undefined
    /**
     * translator callback from Noydb. When present, missing
     * translations for `autoTranslate: true` i18nText fields are generated
     * before the i18n validator runs.
     */
    autoTranslateHook?:
      | ((text: string, from: string, to: string, field: string, collection: string) => Promise<string>)
      | undefined
    /**
     * vault-default locale, inherited from
     * `openVault(name, { locale })` or `vault.setLocale()`.
     */
    defaultLocale?: string | undefined
    /**
     * collection-level conflict resolution policy.
     * Overrides the db-level `conflict` option for this collection only.
     */
    conflictPolicy?: ConflictPolicy<T> | undefined
    /**
     * callback to register an envelope-level resolver with the
     * SyncEngine. Provided by the Vault (wired from the SyncEngine).
     */
    onRegisterConflictResolver?: ((name: string, resolver: CollectionConflictResolver) => void) | undefined
    /**
     * CRDT mode for this collection. When set, `put()` stores
     * CRDT state in the envelope and `get()` returns the resolved snapshot.
     * `getRaw(id)` returns the full CRDT state for merge operations.
     */
    crdt?: CrdtMode | undefined
    /**
     * optional remote/sync adapter. When present, `presence()`
     * writes heartbeats to this adapter so other devices can read them.
     * If the adapter implements pub/sub, presence updates are real-time.
     */
    syncAdapter?: NoydbStore | undefined
    /**
     * called by the collection after every successful
     * `get` / `put` / `delete`. The Vault installs a callback that
     * appends a consent-audit entry when `withConsent` is active;
     * outside a consent scope the callback is a no-op. Awaited so a
     * thrown audit write surfaces to the caller.
     */
    onAccess?: (op: 'get' | 'put' | 'delete', id: string) => Promise<void>
    /**
     * invoked by `put`/`delete` before any adapter
     * write. Receives the prior envelope timestamp + decrypted
     * record (or `null` if no prior) and the incoming record (or
     * `null` for delete). Throws `PeriodClosedError` to abort.
     */
    /**
     * opt-in deterministic-encryption index.
     *
     * Field names listed here get a deterministic AES-GCM ciphertext
     * attached to every envelope's `_det` map, which enables blind
     * equality search via `collection.findByDet(field, value)`.
     *
     * **Leaks equality.** Two records with the same value in a
     * deterministic field produce identical ciphertexts, so anyone
     * with store access can tell which records share a value without
     * learning the value itself. This is the textbook trade-off of
     * deterministic encryption — strictly opt-in for that reason.
     *
     * Declaring any field here without also passing
     * `acknowledgeDeterministicRisk: true` throws at construction,
     * so the risk must be explicitly acknowledged.
     */
    deterministicFields?: readonly string[] | undefined
    /**
     * gate for `deterministicFields`. Must be `true` when
     * any deterministic field is declared. Any other value throws.
     */
    acknowledgeDeterministicRisk?: boolean | undefined
    /**
     * Per-record content-encryption keys. When `true`, every record body
     * (and every history version of it) is encrypted under a fresh
     * per-record CEK, AES-KW-wrapped under the collection DEK and stored
     * on the envelope's `_cek`. Off by default. Foundation for per-record
     * erasure (#304) and record-scoped sealing (#306). `_det` slots stay
     * keyed to the collection DEK regardless.
     */
    perRecordKeys?: boolean | undefined
    /**
     * Per-record provenance tracking. When `true`, `put()` calls that
     * supply a `source` option stamp `_source` (opaque source id) and
     * `_sourceTs` (ISO-8601 timestamp) onto the unencrypted envelope
     * metadata. Off by default — zero cost for collections that don't
     * need lineage tracking. (FR-5, #445)
     */
    provenance?: boolean | undefined
    /**
     * declared tiers this collection supports. An
     * undefined or empty list disables the hierarchical-tier surface
     * on this collection (`putAtTier`, `getAtTier`, `elevate`, `demote`
     * throw). Tier 0 is implicit and always available.
     */
    tiers?: readonly number[] | undefined
    /**
     * what a lower-tier caller sees for above-tier
     * records. Default `'invisibility'`.
     */
    tierMode?: TierMode | undefined
    /**
     * optional callback fired on every cross-tier access.
     * Provided by the Vault; collects notification events and writes
     * to the ledger.
     */
    onCrossTierAccess?: ((event: CrossTierAccessEvent) => void) | undefined
    /**
    /**
     * Optional back-reference to the owning vault's derivation
     * registry + collection accessor. When present, successful
     * `put()` dispatches registered derivation strategies for the
     * source collection.
     */
    derivationSource?: {
      registry(): DerivationRegistry
      getCollection(name: string): Collection<Record<string, unknown>>
      /**
       * Read-only vault facade handed to `derive(source, ctx)` so a
       * derivation can fetch sibling records. Same shape and
       * instance the guards subsystem uses for `check(incoming, ctx)`.
       */
      getReadOnlyFacade(): ReadOnlyVaultFacade
      /**
       * Read access to the owning Noydb's currently-active multi-record
       * transaction context, or `null` when no transaction is running.
       * `dispatchDerivations` consults this so a recursive derived-output
       * write can register its pre-write envelope onto `ctx._executed`
       * and roll back alongside the source op on mid-batch failure.
       */
      getActiveTxContext(): TxContext | null
      /**
       * Construct a transient TxContext bound to the owning Noydb. Used
       * by `Collection.putManyAtomic` to publish an active context for
       * its Phase 2 loop.
       */
      createTxContext(): TxContext
      /** Publish a TxContext for the duration of a bulk-atomic loop. */
      setActiveTxContext(ctx: TxContext): void
      /** Drop a previously-published TxContext. */
      clearActiveTxContext(ctx: TxContext): void
    } | undefined
    /**
     * Vault-internal hook for materialized-view dispatch.
     * Parallel to `derivationSource`. When set, `Collection.put` fires
     * registered MV `onSourceWrite` after the standard derivation
     * dispatch.
     */
    materializedViewSource?: {
       
      registry(): MaterializedViewRegistry
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getCollection(name: string): Collection<any>
      getActiveTxContext(): TxContext | null
      getQueryContext(): MVQueryContext
    } | undefined
  }) {
    this.adapter = opts.adapter
    this.vault = opts.vault
    this.name = opts.name
    this.keyring = opts.keyring
    this.encrypted = opts.encrypted
    this.emitter = opts.emitter
    this.writeQueue = opts.writeQueue
    this.schemaUpdateGate = opts.schemaUpdateGate
    this.schemaFence = opts.schemaFence
    this.writeHooks = opts.writeHooks
    this.subsystemBus = opts.subsystemBus
    this.activeTxId = opts.activeTxId
    this.blobStrategy = opts.blobStrategy ?? NO_BLOBS
    this.objectStore = opts.objectStore
    this.blobFields = opts.blobFields
    this.aggregateStrategy = opts.aggregateStrategy ?? NO_AGGREGATE
    this.crdtStrategy = opts.crdtStrategy ?? NO_CRDT
    this.historyStrategy = opts.historyStrategy ?? NO_HISTORY
    this.i18nStrategy = opts.i18nStrategy ?? NO_I18N
    this.syncStrategy = opts.syncStrategy ?? NO_SYNC
    this.reconcileOnOpen = opts.reconcileOnOpen ?? 'off'
    this.getDEK = opts.getDEK
    this.onDirty = opts.onDirty
    this.historyConfig = opts.historyConfig ?? { enabled: true }
    this.schema = opts.schema
    this.ledger = opts.ledger
    this.refEnforcer = opts.refEnforcer
    this.joinResolver = opts.joinResolver
    this.i18nFields = opts.i18nFields
    // #308 L1 — only spin up an index store when text fields are declared, so
    // ordinary collections pay nothing (the dirty poke + retrieve see undefined).
    this.textIndexes = opts.textIndexes
    this.searchIndexStore =
      opts.textIndexes && opts.textIndexes.length > 0
        ? opts.textIndexPersist
          ? new PersistedIndexStore(this.buildPersistedIndexCallbacks())
          : new MemoryIndexStore()
        : undefined
    // #435 — precompute the densify-enabled subset (undefined when none opt in)
    // so the write path skips work for non-densify collections.
    const densifyFields = opts.i18nFields
      ? Object.fromEntries(
          Object.entries(opts.i18nFields).filter(([, d]) => d.options.densifyOnWrite === true),
        )
      : {}
    this.i18nDensifyFields =
      Object.keys(densifyFields).length > 0 ? densifyFields : undefined
    // #308 L2 — wire embedding descriptor + vector set (undefined for non-embedding collections).
    // Guard: CRDT collections cannot use embeddings (the embedding-derive block is unreachable
    // after the CRDT early-return in putInternal; full CRDT-derivation is out of L2 scope).
    if (opts.embeddings && opts.crdt) {
      throw new Error(
        `Collection "${opts.name}": embeddings are not supported on CRDT collections (L2). Use a non-CRDT collection for semantic search.`,
      )
    }
    this.embeddings = opts.embeddings
    this.vectorSet = opts.embeddings ? new VectorSet() : undefined
    this.dictKeyFields = opts.dictKeyFields
    if (opts.moneyFields) validateMoneyFieldPaths(opts.moneyFields)
    this.moneyFields = opts.moneyFields
    this.computed = opts.computed
    this.dictLabelResolver = opts.dictLabelResolver
    this.getDictionary = opts.getDictionary
    this.i18nPutValidator = opts.i18nPutValidator
    this.autoTranslateHook = opts.autoTranslateHook
    this.defaultLocale = opts.defaultLocale
    this.crdtMode = opts.crdt
    this.syncAdapter = opts.syncAdapter
    this.onAccess = opts.onAccess
    this.derivationSource = opts.derivationSource
    this.materializedViewSource = opts.materializedViewSource

    // hierarchical-tier wiring
    this.tiers = opts.tiers && opts.tiers.length > 0 ? new Set(opts.tiers) : null
    this.tierMode = opts.tierMode ?? 'invisibility'
    this.onCrossTierAccess = opts.onCrossTierAccess

    // deterministic-encryption wiring
    if (opts.deterministicFields && opts.deterministicFields.length > 0) {
      if (opts.acknowledgeDeterministicRisk !== true) {
        throw new Error(
          `Collection "${opts.name}": deterministicFields requires \`acknowledgeDeterministicRisk: true\`. ` +
          `Deterministic encryption leaks equality between records — two records with the same field value ` +
          `produce identical ciphertexts visible to anyone with store access. If that trade-off is acceptable ` +
          `for your threat model, set \`acknowledgeDeterministicRisk: true\` to enable.`,
        )
      }
      this.deterministicFields = Object.freeze(new Set(opts.deterministicFields))
    } else {
      this.deterministicFields = null
    }

    // per-record CEK wiring. The cache is bounded by record count; CEKs
    // are tiny CryptoKey handles, so a generous entry budget is cheap.
    this.perRecordCek = opts.perRecordKeys === true
    this.cekCache = this.perRecordCek ? new Lru<string, CryptoKey>({ maxRecords: 4096 }) : null

    // per-record provenance opt-in (FR-5). Zero cost when off.
    this.provenance = opts.provenance === true

    // register CRDT conflict resolver with SyncEngine
    if (opts.crdt && opts.onRegisterConflictResolver) {
      const crdtMode = opts.crdt
      const crdtResolver: CollectionConflictResolver = async (id, local, remote) => {
        if (crdtMode === 'yjs') {
          // Core cannot merge Yjs without the yjs package — take the higher version
          return local._v >= remote._v ? local : remote
        }
        const localJson = await this.decryptJsonString(local, id)
        const remoteJson = await this.decryptJsonString(remote, id)
        // Tombstone (shredded) on either side: the live envelope is the
        // authoritative merge result — a shred must win and stay shredded.
        if (localJson === null) return local
        if (remoteJson === null) return remote
        const localState = JSON.parse(localJson) as CrdtState
        const remoteState = JSON.parse(remoteJson) as CrdtState
        const merged = this.crdtStrategy.mergeCrdtStates(localState, remoteState)
        const mergedVersion = Math.max(local._v, remote._v) + 1
        const cek = this.perRecordCek ? await this.resolveRecordCek(id) : undefined
        return this.encryptJsonString(JSON.stringify(merged), mergedVersion, cek)
      }
      opts.onRegisterConflictResolver(this.name, crdtResolver)
    }

    // build and register per-collection conflict resolver with SyncEngine
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
        resolver = async (id, local, remote) => {
          const localRecord = await this.decryptRecord(local, { skipValidation: true, id })
          const remoteRecord = await this.decryptRecord(remote, { skipValidation: true, id })
          // Tombstone on either side wins — a shredded record must not be
          // resurrected by a merge against a still-live peer.
          if (localRecord === null) return local
          if (remoteRecord === null) return remote
          const merged = mergeFn(localRecord, remoteRecord)
          const mergedVersion = Math.max(local._v, remote._v) + 1
          const cek = this.perRecordCek ? await this.resolveRecordCek(id) : undefined
          return this.encryptRecord(merged, mergedVersion, cek)
        }
      }

      opts.onRegisterConflictResolver(collectionName, resolver)
    }

    // Default `prefetch: true` keeps semantics. Only opt-in to lazy
    // mode when the consumer explicitly sets `prefetch: false`.
    this.lazy = opts.prefetch === false

    if (this.lazy) {
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
    }

    // delegate mirror construction + declaration to the active
    // indexing strategy. `NO_INDEXING` returns a state whose accessors
    // both return null; the active strategy (from `@noy-db/hub/indexing`)
    // constructs the appropriate mirror based on lazy vs eager mode and
    // declares every IndexDef. With NO_INDEXING the heavy index classes
    // never reach the bundle.
    const strategy = opts.indexStrategy ?? NO_INDEXING
    this.indexState = strategy.createState({
      defs: opts.indexes ?? [],
      lazy: this.lazy,
    })

    // Unique-constraint enforcement (eager mode only). Declaring `unique` on
    // a lazy/CRDT/tiered collection throws UnsupportedIndexOptionError here —
    // see buildUniqueConstraintSet (kept out of this kernel file).
    this.uniqueConstraints = buildUniqueConstraintSet(this.name, opts.indexes, {
      lazy: this.lazy,
      crdt: this.crdtMode != null,
      tiered: this.tiers != null,
    })
  }

  /**
   * Return the Standard Schema validator attached to this collection,
   * or `undefined` if none was provided at construction time.
   *
   * Exposed (read-only) for the Vault-level export primitive,
   * which surfaces each collection's schema in the per-chunk metadata
   * so downstream serializers (`@noy-db/as-*` packages, custom
   * exporters) can produce schema-aware output without poking at
   * collection internals. The validator object is returned by
   * reference — callers must treat it as immutable.
   */
  getSchema(): StandardSchemaV1<unknown, T> | undefined {
    return this.schema
  }

  /**
   * @internal — attach money descriptors post-construction. MV dependency
   * analysis auto-creates a source collection (without options) during
   * `openVault`, before the user's `collection(name, { moneyFields })`
   * declaration; this reconciles that ordering. First-wins. Not public.
   */
  _applyMoneyFields(moneyFields: Record<string, MoneyDescriptor>): void {
    if (this.moneyFields !== undefined) return
    validateMoneyFieldPaths(moneyFields)
    this.moneyFields = moneyFields
  }

  /** @internal — attach computed fields post-construction. See {@link _applyMoneyFields}. */
  _applyComputed(computed: ComputedFields): void {
    if (this.computed === undefined) this.computed = computed
  }

  /**
   * Get a single record by ID.
   *
   * @param id      Record identifier.
   * @param locale  Optional locale options. When provided,
   *                `i18nText` fields are resolved to the requested locale
   *                string, and `dictKey` fields get a `<field>Label`
   *                virtual field added. Pass `{ locale: 'raw' }` to
   *                return the full `{ [locale]: string }` map instead.
   *
   * @returns The decrypted (and optionally locale-resolved) record, or
   *          `null` if not found.
   */
  async get(id: string, locale?: LocaleReadOptions): Promise<T | null> {
    // --- Lazy derivation resolution ---
    // If this collection is the output of a lazy-mode derivation
    // strategy, consult the stale map and re-derive on demand before
    // reading. No-op when nothing is pending — keeps the read fast
    // path cheap.
    if (this.derivationSource !== undefined) {
      const registry = this.derivationSource.registry()
      if (registry.strategiesProducingOutput(this.name).length > 0) {
        await resolveStaleOnRead(this.derivationSource, this.name, id)
      }
    }

    // Lazy-MV resolve-on-read. When the collection being read
    // is the output of a registered lazy MV that has at least one
    // pending stale flag, run the executor before returning. No-op
    // when nothing is pending.
    if (this.materializedViewSource !== undefined) {
      const { resolveStaleMVOnRead } = await import('./materialized-views/stale.js')
      await resolveStaleMVOnRead(this.materializedViewSource, this.name)
    }

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
        // Tombstone tolerance (decision 5): a shredded record carries no
        // body / CEK. Reads return null rather than throwing TamperedError.
        if (isTombstone(envelope, this.encrypted)) return null
        record = await this.decryptRecord(envelope, { id })
        if (record === null) return null
        this.lru.set(id, { record, version: envelope._v }, estimateRecordBytes(record))
      }
    } else {
      // Eager mode: load everything once, then serve from the in-memory map.
      await this.ensureHydrated()
      const entry = this.cache.get(id)
      record = entry ? entry.record : null
    }

    if (record === null) return null
    await this.onAccess?.('get', id)
    return this.applyLocaleToRecord(record, locale)
  }

  /**
   * Return the raw CRDT state for a record.
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
    if (json === null) return null // shredded (tombstone)
    return JSON.parse(json) as CrdtState
  }

  /**
   * Read a record's unencrypted envelope metadata (version, timestamps,
   * provenance) without decrypting the body.
   *
   * Returns `null` when no envelope exists for `id` (record absent or never
   * written). Only `_source`/`_sourceTs` fields are populated when the
   * collection was opened with `provenance: true` AND the record was written
   * with a `source` option — but this method works on any collection because
   * it reads the raw envelope directly.
   *
   * @returns `{ version, timestamp, by?, source?, sourceTs? }` or `null`.
   *
   * @example
   * const meta = await clients.getMetadata('c1')
   * if (meta) console.log(meta.source, meta.timestamp)
   */
  async getMetadata(id: string): Promise<{
    readonly version: number
    readonly timestamp: string
    readonly by?: string
    readonly source?: string
    readonly sourceTs?: string
  } | null> {
    const env = await this.adapter.get(this.vault, this.name, id)
    if (!env) return null
    return {
      version: env._v,
      timestamp: env._ts,
      ...(env._by !== undefined ? { by: env._by } : {}),
      ...(env._source !== undefined ? { source: env._source } : {}),
      ...(env._sourceTs !== undefined ? { sourceTs: env._sourceTs } : {}),
    }
  }

  /**
   * Return a presence handle for this collection.
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
    return this.syncStrategy.buildPresence<P>(presenceOpts)
  }

  /**
   * Create or update a record. Runs inside the hub's write-queue tracker
   * so `hub.writeQueue.pending` reflects this write.
   *
   * @param id      Record identifier.
   * @param record  The record body (validated by the collection's schema
   *                if one was attached at `vault.collection(...)` time).
   * @param options Optional metadata for audit + import workflows.
   *                `reason` is stamped onto the resulting ledger entry
   *                so audit consumers can filter via
   *                `entries.filter(e => e.reason?.startsWith('import:'))`.
   *                `source` is an opaque source id (e.g. `'crm-sync'`, `'firm-A'`)
   *                stamped onto the envelope as `_source`/`_sourceTs` when
   *                the collection has `provenance: true`. Ignored otherwise
   *                (zero cost). (FR-5, #445)
   *                `sourceTs` is an optional ISO-8601 origin timestamp override;
   *                when supplied together with `source` on a provenance collection,
   *                replaces the machine-stamped `now()` so re-merges preserve the
   *                ORIGIN refresh time across vaults. (FR-4)
   */
  async put(id: string, record: T, options?: { readonly reason?: string; readonly source?: string; readonly sourceTs?: string }): Promise<void> {
    // Refuse the write if an update strategy rejected the schema
    // change. Awaited OUTSIDE track() so a rejected write never counts
    // toward writeQueue.depth.
    await this.schemaUpdateGate?.assertWritable()
    await this.schemaFence?.assertWritable(this.name)
    // TODO: putManyAtomic / tx-execute / CRDT /
    // blob write paths are not yet tracked by writeQueue nor fired through
    // the write hooks.
    // User write-hooks AND the observe bus both need the
    // WriteEvent. Build it if EITHER consumer is active so the bus is not
    // coupled to write-hooks being present.
    const hooksActive = this.#hooksActive()
    const busAfterPut = (this.subsystemBus?.hasHandlers('afterPut') ?? false)
      && !(this.subsystemBus?.dispatching ?? false)
    let event: WriteEvent | undefined
    if (hooksActive || busAfterPut) {
      const prior = await this.#priorForHook(id)
      event = {
        op: prior.record === null ? 'create' : 'update',
        vault: this.vault, collection: this.name, docId: id, before: prior.record, after: record,
        userId: this.keyring.userId, timestamp: Date.now(), txId: this.#txIdForHook(),
        baseVersion: prior.version, version: prior.version + 1,
      }
      if (hooksActive) await this.writeHooks!.runBefore(event) // throw → aborts the write
    }
    if (this.writeQueue) await this.writeQueue.track(() => this.putInternal(id, record, options))
    else await this.putInternal(id, record, options)
    if (event) {
      // Ordering: user afterWrite hooks run BEFORE observe-bus dispatch in
      // slice 1. Revisit when internal observe subsystems (e.g. MV-refresh
      // notification) need to settle before user hooks observe state.
      if (hooksActive) await this.writeHooks!.runAfter(event)
      if (busAfterPut) await this.subsystemBus!.dispatch('afterPut', event)
    }
  }

  /**
   * #435 — resolve the prior stored record (with its `_i18nFilled` marker) for
   * densify. Eager: in-memory cache; lazy: LRU then adapter. undefined if absent.
   */
  private async resolveDensifyPrior(id: string): Promise<Record<string, unknown> | undefined> {
    if (this.lazy && this.lru) {
      const cached = this.lru.get(id)
      if (cached) return cached.record as Record<string, unknown>
      const env = await this.adapter.get(this.vault, this.name, id)
      if (!env) return undefined
      const rec = await this.decryptRecord(env)
      return rec === null ? undefined : (rec as Record<string, unknown>)
    }
    await this.ensureHydrated()
    return this.cache.get(id)?.record as Record<string, unknown> | undefined
  }

  /**
   * #435 — densify provenance for a record: which i18n slots were auto-filled,
   * e.g. `{ name: ['en'] }`. undefined when nothing was filled. The marker is
   * stripped from ordinary reads; this is the sanctioned audit accessor.
   */
  async i18nProvenance(id: string): Promise<Record<string, readonly string[]> | undefined> {
    const prior = await this.resolveDensifyPrior(id)
    const marker = prior?.['_i18nFilled'] as Record<string, string[]> | undefined
    return marker && Object.keys(marker).length > 0 ? marker : undefined
  }

  /**
   * Validate a record against this collection's schema WITHOUT writing it.
   * Returns the (possibly coerced) record on success; throws
   * {@link SchemaValidationError} (direction: `'input'`) on violation.
   * A no-op pass-through when no schema is declared.
   *
   * Used by FR-8 migrate-then-merge to pre-validate all staged records
   * before `mergeDecryptedRecords` writes anything — so a failed upgrade
   * never half-writes the receiver.
   */
  async validateInput(record: T): Promise<T> {
    if (this.schema === undefined) return record
    return validateSchemaInput(this.schema, record, `validateInput(${this.name})`)
  }

  /** @internal — true when hooks should fire for this write (handlers exist, not re-entrant). */
  #hooksActive(): boolean {
    return this.writeHooks !== undefined && this.writeHooks.hasHandlers && !this.writeHooks.suppressed
  }

  /**
   * @internal — resolve the prior record for a hook's `before` and
   * its version. Critically, this uses the SAME basis `putInternal` writes from
   * (the in-memory cache in eager mode; lru-then-adapter in lazy) — NOT a fresh
   * store read — so `baseVersion`/`version` match the version actually written.
   * A separate store read would diverge once another tab has advanced the shared
   * store past this tab's cache, breaking cross-tab conflict detection.
   */
  async #priorForHook(id: string): Promise<{ record: unknown; version: number }> {
    if (this.lazy && this.lru) {
      const cached = this.lru.get(id)
      if (cached) return { record: cached.record, version: cached.version }
      const env = await this.adapter.get(this.vault, this.name, id)
      if (!env) return { record: null, version: 0 }
      return { record: (await this.decryptRecord(env, { skipValidation: true })) as unknown ?? null, version: env._v }
    }
    await this.ensureHydrated()
    const cached = this.cache.get(id)
    return cached ? { record: cached.record, version: cached.version } : { record: null, version: 0 }
  }

  #txIdForHook(): string {
    return this.activeTxId?.() ?? generateULID()
  }

  /** @internal Untracked put body — call {@link put}, not this. */
  private async putInternal(id: string, record: T, options?: { readonly reason?: string; readonly source?: string; readonly sourceTs?: string }): Promise<void> {
    if (!hasWritePermission(this.keyring, this.name)) {
      throw new ReadOnlyError()
    }

    // One canonical money encoding from the FIRST pipeline stage (#335):
    // gates, computed fields, and schema validation all see the decoded
    // `get()` shape. Best-effort — bad input passes through and the
    // quantize stage below throws the real error.
    record = canonicalizeIncomingMoney(record, this.moneyFields) as T

    // Gate bus (Track A) — write-gating subsystems (guards: record-lock /
    // field-freeze / amendment-collect; periods: closed-period guard) run here,
    // before any schema/i18n/history work. A throwing gate handler propagates
    // and aborts the write; the amendment branch collects without throwing.
    // Zero-cost when no gate handler is registered.
    if (this.subsystemBus?.hasGateHandlers('beforePut')) {
      const existingEnv = await this.adapter.get(this.vault, this.name, id)
      let existingRecord: unknown = null
      if (existingEnv) {
        try {
          existingRecord = await this.decryptRecord(existingEnv, { skipValidation: true })
        } catch {
          existingRecord = null
        }
      }
      const gateEvent: GatePutEvent = {
        op: existingEnv ? 'update' : 'create',
        vault: this.vault, collection: this.name, docId: id,
        incoming: record,
        existing: canonicalizeStoredMoney(existingRecord, this.moneyFields),
        existingVersion: existingEnv?._v ?? 0,
        existingTs: existingEnv?._ts,
        userId: this.keyring.userId,
        role: this.keyring.role,
        ...(this.computed !== undefined
          ? { computedFieldNames: new Set(Object.keys(this.computed)) }
          : {}),
      }
      await this.subsystemBus.dispatchGate('beforePut', gateEvent)
    }

    // Computed scalar fields — evaluated FIRST so the user need not supply
    // them and the schema validates the computed result. Throws
    // ComputedFieldError if a function throws.
    if (this.computed !== undefined) {
      record = evalComputedFields(record as Record<string, unknown>, this.computed, id) as T
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

    // Quantize money fields to their stored form (scaled-int string).
    // After schema validation — descriptor owns precision/scale/currency.
    if (this.moneyFields) {
      record = quantizeMoneyFields(record as Record<string, unknown>, this.moneyFields) as T
    }

    // Auto-translate missing i18nText translations.
    // Runs BEFORE i18n validation so translated values satisfy the
    // required-locale constraint. Throws TranslatorNotConfiguredError
    // when a field has autoTranslate: true but no hook was configured.
    if (this.i18nFields) {
      const obj = record as Record<string, unknown>
      for (const [field, descriptor] of Object.entries(this.i18nFields)) {
        if (!descriptor.options.autoTranslate) continue
        // getAtPath returns [] for array-wildcard paths — auto-translate on
        // 'contacts[].field' style paths is not supported; skip silently.
        const leafValues = getAtPath(obj, field)
        if (leafValues.length !== 1) continue
        const value = leafValues[0]
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
        setAtPathInPlace(obj, field, translated)
      }
    }

    // #435 densifyOnWrite (decision A): read prior fills so a round-tripped
    // derived copy is exempt from script enforcement and can be refreshed.
    // `densifyPrior` is read once here and reused by densify() below.
    let densifyPrior: Record<string, unknown> | undefined
    let exemptFills: Map<string, Set<string>> | undefined
    if (this.i18nDensifyFields) {
      densifyPrior = await this.resolveDensifyPrior(id)
      exemptFills = this.i18nStrategy.computeExemptFills(
        densifyPrior,
        record as Record<string, unknown>,
        this.i18nDensifyFields,
      )
    }

    // i18nText script enforcement — runs AFTER auto-translate (so
    // generated values are checked too). Throws ScriptViolationError
    // under the default 'reject'; 'filter' strips disallowed chars in
    // place (getAtPath returns live leaf references, so the write-back
    // covers nested and array-wildcard paths uniformly); 'warn' leaves
    // the value unchanged.
    if (this.i18nFields) {
      const obj = record as Record<string, unknown>
      for (const [field, descriptor] of Object.entries(this.i18nFields)) {
        if (!descriptor.options.script) continue
        for (const leaf of getAtPath(obj, field)) {
          if (!leaf || typeof leaf !== 'object' || Array.isArray(leaf)) continue
          const leafMap = leaf as Record<string, unknown>
          const { value: cleaned, warnings } = this.i18nStrategy.enforceScript(
            leafMap,
            field,
            descriptor,
            exemptFills?.get(field),
          )
          if (cleaned !== leafMap) Object.assign(leafMap, cleaned)
          // enforceScript only returns warnings under 'warn'/'filter' ('reject'
          // throws first), so this guard never fires — it makes that invariant
          // explicit and keeps `mode` off the optional-undefined type.
          const mode = descriptor.options.onScriptViolation
          if (mode === 'warn' || mode === 'filter') {
            for (const w of warnings) {
              this.emitter.emit('i18n:script-violation', {
                vault: this.vault,
                collection: this.name,
                id,
                mode,
                warning: w,
              })
            }
          }
        }
      }
    }

    // i18nText validation — runs AFTER schema validation so
    // the record shape is trustworthy. Throws MissingTranslationError
    // when required translations are absent.
    if (this.i18nPutValidator !== undefined) {
      this.i18nPutValidator(record)
    }

    // #435 — eager-fill empty slots + record provenance. Runs AFTER the
    // authored gates (required + script) so only authored slots are validated;
    // filled slots are recorded in the internal `_i18nFilled` marker.
    if (this.i18nDensifyFields) {
      this.i18nStrategy.densify(
        record as Record<string, unknown>,
        densifyPrior,
        this.i18nDensifyFields,
      )
    }

    // Foreign-key ref enforcement. Runs AFTER schema
    // validation (so the record shape is trustworthy) but BEFORE
    // any write (so a failed strict ref leaves no trace on disk,
    // in history, or in the ledger). The Vault handles the
    // actual target lookups — see `enforceRefsOnPut` over there.
    if (this.refEnforcer !== undefined) {
      await this.refEnforcer.enforceRefsOnPut(this.name, record)
    }

    // ─── CRDT mode ─────────────────────────────────────────
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
          if (prevJson !== null) {
            const prevParsed = JSON.parse(prevJson) as unknown
            if (prevParsed !== null && typeof prevParsed === 'object' && '_crdt' in prevParsed) {
              existingState = prevParsed as LwwMapState
            }
          }
        }
        crdtState = this.crdtStrategy.buildLwwMapState(record as Record<string, unknown>, existingState, now)
      } else if (this.crdtMode === 'rga') {
        let existingState: RgaState | undefined
        if (existingEnvelope) {
          const prevJson = await this.decryptJsonString(existingEnvelope)
          if (prevJson !== null) {
            const prevParsed = JSON.parse(prevJson) as unknown
            if (prevParsed !== null && typeof prevParsed === 'object' && '_crdt' in prevParsed) {
              existingState = prevParsed as RgaState
            }
          }
        }
        const arr = Array.isArray(record) ? record : [record]
        crdtState = this.crdtStrategy.buildRgaState(arr, existingState, generateULID)
      } else {
        // yjs: record is the base64 update string (produced by @noy-db/yjs)
        crdtState = { _crdt: 'yjs', update: record as unknown as string }
      }

      const version = existingVersion + 1
      // Stable per-record CEK shared by the new CRDT body and its history
      // snapshot (undefined on non-CEK collections → legacy path).
      const cek = this.perRecordCek ? await this.resolveRecordCek(id) : undefined
      const envelope = await this.encryptJsonString(JSON.stringify(crdtState), version, cek, options?.source, options?.sourceTs)
      await this.adapter.put(this.vault, this.name, id, envelope)

      // Resolve snapshot for cache and history
      const resolvedRecord = this.crdtStrategy.resolveCrdtSnapshot(crdtState) as T
      // A tombstone (shredded) prior envelope yields a null record → treat as
      // "no previous version" so we don't snapshot/diff an erased value.
      const existingResolvedRecord = existingEnvelope
        ? await this.decryptRecord(existingEnvelope, { skipValidation: true })
        : null
      const existingResolved = existingResolvedRecord !== null
        ? { record: existingResolvedRecord, version: existingVersion }
        : undefined

      if (existingResolved && this.historyConfig.enabled !== false) {
        // History snapshot of the PRIOR version — does NOT carry source from the new write
        const histEnvelope = await this.encryptRecord(existingResolved.record, existingResolved.version, cek)
        await this.historyStrategy.saveHistory(this.adapter, this.vault, this.name, id, histEnvelope)
        this.emitter.emit('history:save', { vault: this.vault, collection: this.name, id, version: existingResolved.version })
        if (this.historyConfig.maxVersions) {
          await this.historyStrategy.pruneHistory(this.adapter, this.vault, this.name, id, { keepVersions: this.historyConfig.maxVersions })
        }
      }

      if (this.ledger) {
        const appendInput: Parameters<typeof this.ledger.append>[0] = {
          op: 'put', collection: this.name, id, version, actor: this.keyring.userId,
          payloadHash: await this.historyStrategy.envelopePayloadHash(envelope),
        }
        if (existingResolved) appendInput.delta = this.historyStrategy.computePatch(resolvedRecord, existingResolved.record)
        if (options?.reason !== undefined) appendInput.reason = options.reason
        await this.ledger.append(appendInput)
      }

      if (this.lazy && this.lru) {
        this.lru.set(id, { record: resolvedRecord, version }, estimateRecordBytes(resolvedRecord))
        await this.maintainPersistedIndexesOnPut(
          id,
          resolvedRecord,
          existingResolved ? existingResolved.record : null,
          version,
        )
      } else {
        this.cache.set(id, { record: resolvedRecord, version })
        this.indexes?.upsert(id, resolvedRecord, existingResolved ? existingResolved.record : null)
      }

      await this.onDirty?.(this.name, id, 'put', version)
      this.emitter.emit('change', { vault: this.vault, collection: this.name, id, action: 'put' } satisfies ChangeEvent)
      this.searchIndexStore?.markDirty() // #308 L1 — zero-cost for non-search collections
      await this.onAccess?.('put', id)
      await this.dispatchDerivations(id, record, version)
      await this.dispatchMaterializedViews(id, record)
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
          // Tombstone (shredded) prior → treat as no previous version.
          if (previousRecord !== null) {
            existing = { record: previousRecord, version: previousEnvelope._v }
          }
        }
      }
    } else {
      await this.ensureHydrated()
      existing = this.cache.get(id)
    }

    const version = existing ? existing.version + 1 : 1

    // Unique-constraint pre-flight — BEFORE history-save so a violation
    // never writes a history snapshot or fires 'history:save'. Runs after
    // ensureHydrated() (eager path above) so the constraint map already
    // reflects records from prior sessions. No-op when no unique indexes
    // are declared.
    this.uniqueConstraints?.check(id, record)

    // Per-record CEK: resolve the record's stable CEK ONCE (insert mints,
    // update reuses the live envelope's CEK), then encrypt BOTH the history
    // snapshot of the prior version AND the new body under it — so every
    // version of a record carries the same `_cek` and dies together on a
    // future shred. `undefined` on a legacy / non-CEK collection → the
    // byte-identical legacy write path.
    const cek = this.perRecordCek ? await this.resolveRecordCek(id) : undefined

    // Save history snapshot of the PREVIOUS version before overwriting.
    // CRITICAL: the history snapshot is a record of the PRIOR version — it must
    // NOT carry the source from the current write (source belongs to the new write only).
    if (existing && this.historyConfig.enabled !== false) {
      const historyEnvelope = await this.encryptRecord(existing.record, existing.version, cek)
      await this.historyStrategy.saveHistory(this.adapter, this.vault, this.name, id, historyEnvelope)

      this.emitter.emit('history:save', {
        vault: this.vault,
        collection: this.name,
        id,
        version: existing.version,
      })

      // Auto-prune if maxVersions configured
      if (this.historyConfig.maxVersions) {
        await this.historyStrategy.pruneHistory(this.adapter, this.vault, this.name, id, {
          keepVersions: this.historyConfig.maxVersions,
        })
      }
    }

    const envelope = await this.encryptRecord(record, version, cek, options?.source, options?.sourceTs)
    await this.adapter.put(this.vault, this.name, id, envelope)

    // #308 L2 — derive the embedding vector at write (encode → encrypted _vec sidecar).
    // Placed AFTER the main adapter.put so `version` (computed above) is in scope and
    // the record write is committed first. The _vec envelope _v is not OCC-checked.
    if (this.embeddings) {
      const text = embeddingSourceText(record as Record<string, unknown>, this.embeddings.source)
      const vec = await this.embeddings.encode(text)
      if (vec.length !== this.embeddings.dim) throw new EmbeddingDimMismatchError('embeddings', this.embeddings.dim, vec.length)
      const body = JSON.stringify({ vec: Array.from(vec), model: this.embeddings.model, dim: this.embeddings.dim })
      const vecEnv = await this.encryptJsonString(body, version)
      await this.adapter.put(this.vault, '_vec', id, vecEnv)
      this.vectorSet?.markDirty()
    }

    // Ledger append — AFTER the adapter write succeeds so a failed
    // write never produces an orphan ledger entry. Computing the
    // payloadHash here uses the envelope we just wrote, which is the
    // exact bytes the adapter now holds. The ledger entry records
    // only metadata (collection, id, version, hash) — NOT the record
    // itself — and is then encrypted with the compartment's ledger
    // DEK, preserving zero-knowledge. See `LedgerStore.append`.
    //
    // **Delta history**: if there was a previous version, we
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
        payloadHash: await this.historyStrategy.envelopePayloadHash(envelope),
      }
      if (existing) {
        // REVERSE patch: describes how to undo this put — i.e., how
        // to transform the NEW record back into the PREVIOUS one.
        // Storing reverse patches lets `ledger.reconstruct()` walk
        // backward from the current state (readily available in the
        // data collection) without needing a forward-walking base
        // snapshot, which would double the storage cost of the
        // delta scheme. See `LedgerStore.reconstruct` for the walk.
        appendInput.delta = this.historyStrategy.computePatch(record, existing.record)
      }
      if (options?.reason !== undefined) appendInput.reason = options.reason
      await this.ledger.append(appendInput)
    }

    if (this.lazy && this.lru) {
      this.lru.set(id, { record, version }, estimateRecordBytes(record))
      // Maintain persisted-index side-cars. Lazy mode is the
      // only place `persistedIndexes` is populated; eager mode uses the
      // in-memory `CollectionIndexes` above.
      await this.maintainPersistedIndexesOnPut(id, record, existing ? existing.record : null, version)
    } else {
      this.cache.set(id, { record, version })
      // Update secondary indexes incrementally — no-op if no indexes are
      // declared. Pass the previous record (if any) so old buckets are
      // cleaned up before the new value is added.
      this.indexes?.upsert(id, record, existing ? existing.record : null)
      // Update unique-constraint maps to reflect the successful write.
      this.uniqueConstraints?.upsert(id, record, existing?.record)
    }

    await this.onDirty?.(this.name, id, 'put', version)

    this.emitter.emit('change', {
      vault: this.vault,
      collection: this.name,
      id,
      action: 'put',
    } satisfies ChangeEvent)
    this.searchIndexStore?.markDirty() // #308 L1 — zero-cost for non-search collections

    await this.onAccess?.('put', id)

    // Derivation dispatch — AFTER store + ledger + emitter commit so a
    // failed source-write never produces orphan derived outputs. The
    // recursive `put` into output collections re-enters this pipeline
    // (encrypt + ledger + emit) intentionally; cycle detection at vault
    // open is the primary defense against infinite recursion.
    await this.dispatchDerivations(id, record, version)
    await this.dispatchMaterializedViews(id, record)
  }

  /**
   * Fire registered MV strategies whose dependency set includes this
   * collection. Eager-mode MVs re-materialize inline via
   * `MaterializedViewExecutor.refresh`; lazy / manual modes are
   * no-ops in the foundation; wired in the lazy-mode implementation.
   *
   * Skips entirely when the record being written is itself an
   * MV-emitted row (carries `_materializedFrom`) — defensive guard
   * against missed cycle detection.
   *
   * @internal
   */
  private async dispatchMaterializedViews(id: string, record: T): Promise<void> {
    void id
    if (this.materializedViewSource === undefined) return
    const incoming = record as unknown as Record<string, unknown>
    if (incoming && typeof incoming === 'object' && '_materializedFrom' in incoming) return
    const registry = this.materializedViewSource.registry()
    const mvs = registry.mvsForSource(this.name)
    if (mvs.length === 0) return
    // Dynamic-import the executor only on first eager-MV dispatch —
    // keeps the MV executor chunk out of the floor bundle (mirrors the
    // dynamic-import pattern used for derivations). Lazy mode
    // uses the pure-helper `markMVStale` which lives in `stale.js` and
    // is also dynamic-imported (only when at least one lazy MV depends
    // on this source).
    let executor: typeof MVExecutorType | null = null
    let staleHelpers: typeof MVStaleModule | null = null
    for (const reg of mvs) {
      const mode = reg.spec.refresh
      if (mode === 'eager') {
        if (executor === null) {
          ;({ MaterializedViewExecutor: executor } = await import('./materialized-views/executor.js'))
        }
        await executor.refresh(reg, {
          getCollection: (name) => this.materializedViewSource!.getCollection(name),
          getActiveTxContext: () => this.materializedViewSource!.getActiveTxContext(),
          getQueryContext: () => this.materializedViewSource!.getQueryContext(),
        })
      } else if (mode === 'lazy') {
        if (staleHelpers === null) {
          staleHelpers = await import('./materialized-views/stale.js')
        }
        staleHelpers.markMVStale(registry, reg.spec.name)
      }
      // manual: no-op on source-write. `vault.refreshView(name)` is
      // the only path that materializes a manual MV.
    }
  }

  /**
   * Fire registered derivation strategies for this source collection.
   * Eager mode runs `derive` inline and writes each output via the
   * sibling `Collection.put`; lazy mode marks dependent outputs stale
   * (D11 stub today). Errors in non-strict mode are logged and
   * skipped; strict mode propagates the first failing output's error.
   *
   * Skips entirely when the record being written is itself a derived
   * output (carries `_derivedFrom`) — defensive guard against missed
   * cycle detection.
   */
  /**
   * @internal #376 — the RAW stored record (canonical-money form, i18n maps
   * intact), WITHOUT the locale resolution `get()` applies. Used as the
   * patch base for self-write reverse-denorm so writing back never clobbers
   * an i18n map or re-quantizes money incorrectly. Returns null for
   * missing / tombstoned records.
   */
  async _getStoredRecord(id: string): Promise<T | null> {
    let raw: T | null
    if (this.lazy && this.lru) {
      const cached = this.lru.get(id)
      if (cached) raw = cached.record
      else {
        const env = await this.adapter.get(this.vault, this.name, id)
        if (!env || isTombstone(env, this.encrypted)) return null
        raw = await this.decryptRecord(env, { id })
        if (raw === null) return null
        this.lru.set(id, { record: raw, version: env._v }, estimateRecordBytes(raw))
      }
    } else {
      await this.ensureHydrated()
      raw = this.cache.get(id)?.record ?? null
    }
    if (raw === null) return null
    return canonicalizeStoredMoney(raw, this.moneyFields) as T
  }

  /**
   * @internal #376 — ids of records whose top-level `field` equals `value`.
   * Uses the FK index when the field is indexed (O(matches)); otherwise a
   * linear scan (O(N) — fine for small child sets; index the FK to scale).
   */
  async _findMatchingIds(field: string, value: unknown): Promise<string[]> {
    const hit = this.getIndexes()?.lookupEqual(field, value)
    if (hit) return [...hit]
    const target = String(value)
    const matches = (rec: Record<string, unknown>): boolean => {
      const fv = rec[field]
      // FK values are scalars; ignore object/array fields (never a valid FK).
      return (typeof fv === 'string' || typeof fv === 'number') && String(fv) === target
    }
    if (!this.lazy) {
      await this.ensureHydrated()
      const out: string[] = []
      for (const [rid, e] of this.cache) {
        if (matches(e.record as Record<string, unknown>)) out.push(rid)
      }
      return out
    }
    const ids = await this.adapter.list(this.vault, this.name)
    const out: string[] = []
    for (const rid of ids) {
      const raw = await this._getStoredRecord(rid)
      if (raw !== null && matches(raw as Record<string, unknown>)) out.push(rid)
    }
    return out
  }

  /**
   * @internal #376 slice 2 — recompute a rollup aggregate onto the parent.
   * Gathers every child of `parentId`, runs `compute`, and patches only the
   * rollup `field` onto the parent's raw stored record (value-equality
   * guarded). No-op when the parent record does not exist.
   */
  private async recomputeRollup(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spec: { source: string; rollup?: { from: string; key: string; field: string; compute: (children: any[]) => unknown } },
    parentId: string,
  ): Promise<void> {
    if (this.derivationSource === undefined || spec.rollup === undefined) return
    const { from, key, field, compute } = spec.rollup
    const into = spec.source
    const intoColl = this.derivationSource.getCollection(into)
    const base = await intoColl._getStoredRecord(parentId)
    if (base === null) return // no parent record to patch

    const fromColl = this.derivationSource.getCollection(from)
    const childIds = await fromColl._findMatchingIds(key, parentId)
    const children: Array<Record<string, unknown>> = []
    for (const cid of childIds) {
      const c = await fromColl.get(cid)
      if (c !== null && c !== undefined) children.push(c)
    }

    const newValue = compute(children)
    if (selfWriteFieldEqual(base[field], newValue)) return // no change → no write

    const patched = { ...base, [field]: newValue }
    const txCtx = this.derivationSource.getActiveTxContext()
    if (txCtx !== null) {
      const prior = await this.adapter.get(this.vault, into, parentId)
      txCtx._executed.push({
        op: { type: 'put', vaultName: this.vault, collectionName: into, id: parentId },
        priorEnvelope: prior,
      })
    }
    await intoColl.put(parentId, patched)
  }

  /**
   * @internal #376 slice 2 — fire any rollups for which THIS collection is the
   * child `from`, recomputing the affected parent after a child delete. Called
   * from the delete path with the just-removed record's key value. Other
   * derivation kinds do not react to deletes (unchanged).
   */
  private async dispatchRollupsOnDelete(deleted: T): Promise<void> {
    if (this.derivationSource === undefined) return
    const registry = this.derivationSource.registry()
    const rec = deleted as Record<string, unknown>
    for (const { spec } of registry.strategiesForSource(this.name)) {
      if (!spec.rollup || spec.rollup.from !== this.name) continue
      const kv = rec[spec.rollup.key]
      if (typeof kv !== 'string' && typeof kv !== 'number') continue
      await this.recomputeRollup(spec, String(kv))
    }
  }

  private async dispatchDerivations(id: string, record: T, version: number): Promise<void> {
    if (this.derivationSource === undefined) return
    // `record` is the stored form here (post-quantize) — decode so
    // derive(source, ctx) sees the canonical money shape (#335).
    const incoming = canonicalizeStoredMoney(record, this.moneyFields) as Record<string, unknown>
    if (incoming && typeof incoming === 'object' && '_derivedFrom' in incoming) return
    const registry = this.derivationSource.registry()
    const strategies = registry.strategiesForSource(this.name)
    if (strategies.length === 0) return
    // Dynamic-import the executor only on the first eager-mode
    // dispatch. Lazy-mode dispatches use `markStale` (a pure helper)
    // which doesn't reach into the executor at all. Keeps the
    // derivation executor chunk out of the floor bundle for any
    // consumer that doesn't fire an eager derivation.
    let DerivationExecutor: typeof DerivationExecutorType | null = null
    for (const { spec, strategyHash } of strategies) {
      const mode = typeof spec.lifecycle === 'string' ? spec.lifecycle : spec.lifecycle.mode

      // Rollup (#376 slice 2): a write to the child `from` recomputes the
      // parent at id child[key]; a write to the parent (source = into)
      // recomputes its own aggregate. Handled here (the executor is not run).
      if (spec.rollup) {
        if (mode !== 'eager') continue
        let parentId: string | null
        if (this.name === spec.rollup.from) {
          const kv = incoming[spec.rollup.key]
          parentId = (typeof kv === 'string' || typeof kv === 'number') ? String(kv) : null
        } else {
          parentId = id // a write to the parent recomputes its own aggregate
        }
        if (parentId !== null) await this.recomputeRollup(spec, parentId)
        continue
      }

      // Determine how `this.name` triggers this strategy, and build the list
      // of source records to (re-)derive:
      //   • source     — re-derive the written record itself (same-id).
      //   • sources[]  — re-derive the PRIMARY source at the same id (#344).
      //   • triggerBy  — FK fan-out (#376): re-derive every source record
      //                  whose `on` field equals the written parent's id.
      // `input` is passed to derive(); `base` is the raw stored source record
      // used as the patch base for a self-write reverse-denorm output.
      const isSource = spec.source === this.name
      const isSibling = !isSource && (spec.sources?.includes(this.name) ?? false)
      const trigger = !isSource && !isSibling
        ? spec.triggerBy?.find(t => t.collection === this.name)
        : undefined

      const runs: Array<{
        input: Record<string, unknown> & { id: string }
        base: Record<string, unknown>
        runId: string
        version: number
      }> = []

      if (isSource) {
        runs.push({ input: { ...incoming, id }, base: incoming, runId: id, version })
      } else if (isSibling) {
        const p = await this.derivationSource.getCollection(spec.source).get(id)
        if (p !== null && p !== undefined) {
          // Raw base for a (rare) sibling self-write; falls back to the
          // resolved primary if the raw read misses.
          const raw = await this.derivationSource.getCollection(spec.source)._getStoredRecord(id)
          runs.push({ input: { ...p, id }, base: raw ?? p, runId: id, version: 0 })
        }
      } else if (trigger) {
        const srcColl = this.derivationSource.getCollection(spec.source)
        const ids = await srcColl._findMatchingIds(trigger.on, id)
        if (trigger.maxFanout !== undefined && ids.length > trigger.maxFanout) {
          throw new DerivationCapExceededError(`triggerBy ${this.name}→${spec.source}`, ids.length, trigger.maxFanout)
        }
        for (const sid of ids) {
          const raw = await srcColl._getStoredRecord(sid)
          if (raw === null) continue
          runs.push({ input: { ...raw, id: sid }, base: raw, runId: sid, version: 0 })
        }
      }

      if (runs.length === 0) continue

      if (mode !== 'eager') {
        for (const run of runs) await markStale(registry, spec, run.runId)
        continue
      }

      if (DerivationExecutor === null) {
        ({ DerivationExecutor } = (await import('./derivations/executor.js')) as { DerivationExecutor: typeof DerivationExecutorType })
      }

      for (const run of runs) {
        const ctx = { vault: this.derivationSource.getReadOnlyFacade() }
        const result = await DerivationExecutor.run(spec, run.input, run.version, strategyHash, ctx)
        for (const key of Object.keys(spec.outputs)) {
          const out = result.outputs[key]
          if (!out) continue
          if (out.kind === 'failed') {
            const err = out.error
            if (spec.strict) throw err
            console.warn(`[derivation] output "${key}" for source "${spec.source}" id="${run.runId}" failed:`, err)
            continue
          }
          const outSpec = spec.outputs[key]
          if (!outSpec) continue
          const outputCollection = this.derivationSource.getCollection(outSpec.collection)
          // If we're inside a multi-record transaction, register
          // derived writes as side-effect ops on the active ctx
          // BEFORE they fire. `revertExecuted` walks `_executed` in
          // reverse on rollback, so capturing the pre-write envelope
          // here lets a later mid-batch failure restore this output's
          // prior state alongside the source op. Outside a transaction
          // the context is null and tracking is skipped.
          const txCtx = this.derivationSource.getActiveTxContext()

          // ── Array-shape branch ─────────────────────────────────
          if (out.kind === 'array') {
            // Load the prior key set from the fanout sidecar.
            const { loadFanoutSidecar, saveFanoutSidecar } = await import('./derivations/fanout-sidecar.js')
            const prior = await loadFanoutSidecar(
              this.adapter,
              this.vault,
              spec.source,
              run.runId,
              key,
            )
            const prevKeys = new Set<string>(prior?.keys ?? [])
            const newKeysList = out.entries.map(e => e.key)
            const newKeysSet = new Set<string>(newKeysList)

            // Diff — delete keys that were in prev but not in new.
            for (const k of prevKeys) {
              if (newKeysSet.has(k)) continue
              await outputCollection._internalDelete(k, txCtx)
            }

            // Upsert every entry in the new set. (Slice 1: no
            // identity-skip optimisation; write every row, idempotent
            // at the (collection, id) level.)
            for (const entry of out.entries) {
              if (txCtx !== null) {
                const priorEnvelope = await this.adapter.get(this.vault, outSpec.collection, entry.key)
                txCtx._executed.push({
                  op: {
                    type: 'put',
                    vaultName: this.vault,
                    collectionName: outSpec.collection,
                    id: entry.key,
                  },
                  priorEnvelope,
                })
              }
              await outputCollection.put(entry.key, entry.value, { source: 'derived' })
            }

            // Persist the new key set (last step — see spec §5.1
            // on failure-mode symmetry).
            await saveFanoutSidecar(this.adapter, this.vault, {
              source: spec.source,
              sourceId: run.runId,
              outputKey: key,
              outputCollection: outSpec.collection,
              keys: newKeysList,
            })
            continue
          }

          // ── Record-shape branch ────────────────────────────────
          if (out.skipped === true) {
            // Optional output returned null. Delete the
            // previously-emitted output at this id, if any. Routed
            // through `_internalDelete` so a user-registered
            // `onDelete` on the output collection does NOT
            // fire — this is a system-internal tombstone, not a
            // user-initiated delete. The txCtx hookup captures the
            // prior envelope inside `_internalDelete` for rollback
            // symmetry; delete-of-absent is a silent no-op.
            await outputCollection._internalDelete(run.runId, txCtx)
            continue
          }

          // ── Self-write reverse-denorm (#376) ───────────────────
          // An output back to its own source: patch ONLY the declared
          // `denorm` fields onto the raw stored record, never the whole
          // value (which would clobber user fields / i18n maps and carries
          // the executor's `_derivedFrom` tag). If the patch changes
          // nothing, skip the write — that value-equality is the cycle
          // guard: the self-write re-fires the source-path derivation,
          // which recomputes identical fields and terminates here.
          if (outSpec.shape === 'record' && outSpec.denorm !== undefined && outSpec.collection === spec.source) {
            const value = out.value
            const patched: Record<string, unknown> = { ...run.base }
            let changed = false
            for (const f of outSpec.denorm) {
              if (!selfWriteFieldEqual(run.base[f], value[f])) {
                patched[f] = value[f]
                changed = true
              }
            }
            if (!changed) continue // cycle guard — nothing to write
            if (txCtx !== null) {
              const prior = await this.adapter.get(this.vault, outSpec.collection, run.runId)
              txCtx._executed.push({
                op: { type: 'put', vaultName: this.vault, collectionName: outSpec.collection, id: run.runId },
                priorEnvelope: prior,
              })
            }
            await outputCollection.put(run.runId, patched, { source: 'derived' })
            continue
          }

          // ── Normal record output (separate output collection) ──
          if (txCtx !== null) {
            const prior = await this.adapter.get(this.vault, outSpec.collection, run.runId)
            txCtx._executed.push({
              op: {
                type: 'put',
                vaultName: this.vault,
                collectionName: outSpec.collection,
                id: run.runId,
              },
              priorEnvelope: prior,
            })
          }
          await outputCollection.put(run.runId, out.value, { source: 'derived' })
        }
      }
    }
  }

  /**
   * Delete a record by ID. Runs inside the hub's write-queue tracker
   * so `hub.writeQueue.pending` reflects this write.
   */
  async delete(id: string): Promise<void> {
    await this.schemaUpdateGate?.assertWritable()
    await this.schemaFence?.assertWritable(this.name)
    // #230 user write-hooks AND the Track A observe bus both need the
    // WriteEvent. Build it if EITHER consumer is active so the bus is not
    // coupled to write-hooks being present. Mirrors the put() path.
    const hooksActive = this.#hooksActive()
    const busAfterDelete = (this.subsystemBus?.hasHandlers('afterDelete') ?? false)
      && !(this.subsystemBus?.dispatching ?? false)
    let event: WriteEvent | undefined
    if (hooksActive || busAfterDelete) {
      const prior = await this.#priorForHook(id)
      event = {
        op: 'delete', vault: this.vault, collection: this.name, docId: id, before: prior.record, after: null,
        userId: this.keyring.userId, timestamp: Date.now(), txId: this.#txIdForHook(),
        baseVersion: prior.version, version: prior.version + 1,
      }
      if (hooksActive) await this.writeHooks!.runBefore(event)
    }
    if (this.writeQueue) await this.writeQueue.track(() => this.deleteInternal(id))
    else await this.deleteInternal(id)
    if (event) {
      // Ordering: user afterWrite hooks run before observe-bus dispatch.
      if (hooksActive) await this.writeHooks!.runAfter(event)
      if (busAfterDelete) await this.subsystemBus!.dispatch('afterDelete', event)
    }
  }

  /**
   * @internal — bulk-rewrite every record through a cutover transform.
   * Raw adapter path (bypasses the write gate + guards — the transform is
   * trusted and runs only during the `migrating` phase). Bumps each
   * record's `_v` and appends a ledger `op:'migration'` entry.
   */
  async _applyCutoverTransform(
    transform: (doc: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<number> {
    const ids = await this.adapter.list(this.vault, this.name)
    let count = 0
    for (const id of ids) {
      const env = await this.adapter.get(this.vault, this.name, id)
      if (!env || isTombstone(env, this.encrypted)) continue
      const decoded = await this.decryptRecord(env, { skipValidation: true, id })
      if (decoded === null) continue // defensive: shredded between list and get
      const record = decoded as unknown as Record<string, unknown>
      const next = transform(record)
      const nextVersion = (env._v ?? 0) + 1
      // Migration pass: on a `perRecordKeys` collection, a legacy (no-`_cek`)
      // record gets a freshly minted CEK here (legacy → CEK re-encrypt), while
      // an already-CEK record reuses its stable CEK. This is the
      // erasure-completeness pass — once migrated, the record body is keyed
      // off a per-record CEK and a future shred can erase it. Until then it
      // stays directly under the collection DEK. `forget()`/shred (step 2,
      // #304) reports un-migrated records explicitly rather than claiming
      // erasure.
      const cek = this.perRecordCek ? await this.resolveRecordCek(id) : undefined
      const newEnv = await this.encryptRecord(next as unknown as T, nextVersion, cek)
      await this.adapter.put(this.vault, this.name, id, newEnv)
      await this._invalidateCacheEntry(id) // refresh in-memory cache after the raw write
      if (this.ledger) {
        await this.ledger.append({
          op: 'migration', collection: this.name, id, version: nextVersion,
          actor: this.keyring.userId, payloadHash: '', reason: 'schema:coordinated-cutover',
        }).catch(() => { /* ledger is best-effort here */ })
      }
      count++
    }
    return count
  }

  /** @internal Untracked delete body — call {@link delete}, not this. */
  private async deleteInternal(id: string): Promise<void> {
    await this._doDelete(id, false)
  }

  /**
   * @internal — system-internal delete that bypasses user-facing
   * delete hooks (`onDelete`, FK ref enforcer). Used by derivation tombstones and MV refresh
   * (Dim 14 v2) — system housekeeping shouldn't trip user invariants
   * registered against the output collection. The ledger entry and
   * history snapshot still fire so backup integrity and time-travel
   * reconstruction stay consistent.
   *
   * Returns silently for delete-of-absent (idempotent contract — both
   * paths honour this: the `txCtx === null` path also reads the prior
   * envelope and short-circuits before the ledger/event side-effects).
   *
   * When a `txCtx` is supplied, the prior envelope is captured and
   * pushed onto `txCtx._executed` BEFORE the delete fires — mirrors
   * the rollback hardening for puts. Callers outside a
   * multi-record transaction pass `null` and skip the tracking.
   *
   * Amendment composition: if `_internalDelete` runs while a vault's
   * `GuardRegistry` has an amendment window open, the `{before, after:
   * null}` change pair is pushed onto the amendment change-set the
   * same way a user-initiated delete would. The `onDelete` user-hook
   * is still skipped (housekeeping must not trip user invariants in
   * normal mode), but the amendment's invariant DOES see the change
   * — so a `RCT-CANCEL-001`-style invariant pairing can reject a
   * derivation-driven tombstone fired during an admin amendment.
   *
   * Constraint to surface to consumers: output collections of
   * derivations with `optional: true` outputs should not be the
   * targets of `strict` or `cascade` inbound foreign-key refs —
   * `_internalDelete` bypasses the ref enforcer by design (the
   * `onDelete` bypass primitive). Treat the housekeeping path as
   * "system can tombstone its own emissions regardless of FK shape."
   *
   * Permission handling is unchanged: the caller must still hold
   * write permission on the collection (derivations run under the
   * user's keyring).
   */
  async _internalDelete(id: string, txCtx: TxContext | null = null): Promise<void> {
    // Idempotency contract: short-circuit before any ledger/event
    // side-effect when the target is absent. Both txCtx-aware and
    // txCtx-null callers honour this — `deriveAll` recomputes
    // expense-only allocations that never emitted a receipt without
    // writing spurious v0 ledger entries.
    const prior = await this.adapter.get(this.vault, this.name, id)
    if (prior === null) return
    if (txCtx !== null) {
      txCtx._executed.push({
        op: {
          type: 'delete',
          vaultName: this.vault,
          collectionName: this.name,
          id,
        },
        priorEnvelope: prior,
      })
    }
    await this._doDelete(id, true)
  }

  private async _doDelete(id: string, internal: boolean): Promise<void> {
    if (!hasWritePermission(this.keyring, this.name)) {
      throw new ReadOnlyError()
    }

    // Gate bus (Track A) — fires for ALL deletes (carrying `internal`), so a
    // gate handler can collect amendment changes on system-internal deletes
    // while branching off `onDelete`/period checks for them. Delete-of-absent
    // (no envelope) does not fire.
    if (this.subsystemBus?.hasGateHandlers('beforeDelete')) {
      const existingEnv = await this.adapter.get(this.vault, this.name, id)
      if (existingEnv) {
        let existingRecord: unknown = null
        try {
          existingRecord = await this.decryptRecord(existingEnv, { skipValidation: true })
        } catch {
          existingRecord = null
        }
        await this.subsystemBus.dispatchGate('beforeDelete', {
          vault: this.vault, collection: this.name, docId: id,
          existing: canonicalizeStoredMoney(existingRecord, this.moneyFields),
          existingVersion: existingEnv._v,
          existingTs: existingEnv._ts,
          internal,
          userId: this.keyring.userId,
          role: this.keyring.role,
        })
      }
    }

    // Foreign-key ref enforcement on delete. Runs BEFORE
    // the adapter delete so a `strict` inbound ref with existing
    // references blocks the delete entirely (no partial state, no
    // history churn, no ledger entry for a rejected op). `cascade`
    // recursively deletes the referencing records first, then falls
    // through to the normal delete path below. `warn` is a no-op
    // here — violations surface through `checkIntegrity()`.
    if (!internal && this.refEnforcer !== undefined) {
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
          // Tombstone (shredded) prior → no record to snapshot on delete.
          if (previousRecord !== null) {
            existing = { record: previousRecord, version: previousEnvelope._v }
          }
        }
      }
    } else {
      existing = this.cache.get(id)
    }

    // Save history snapshot before deleting. On a CEK collection the
    // snapshot reuses the record's stable CEK so the displaced version
    // stays in the same key chain as the rest of its history.
    if (existing && this.historyConfig.enabled !== false) {
      const cek = this.perRecordCek ? await this.resolveRecordCek(id) : undefined
      const historyEnvelope = await this.encryptRecord(existing.record, existing.version, cek)
      await this.historyStrategy.saveHistory(this.adapter, this.vault, this.name, id, historyEnvelope)
    }

    // Capture the previous envelope's payloadHash BEFORE delete so we
    // have a stable reference for the ledger entry. The hash is of
    // whatever was last visible to readers — for a `delete` of a
    // never-existed record, we use the empty string (which the
    // ledger entry's `payloadHash` field tolerates).
    const previousEnvelope = await this.adapter.get(this.vault, this.name, id)
    const previousPayloadHash = await this.historyStrategy.envelopePayloadHash(previousEnvelope)

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
      // Tear down persisted-index side-cars for any declared fields on
      // this record. No-op when no fields are declared or the record
      // had never been indexed (e.g. a delete of a missing id).
      if (existing) {
        await this.maintainPersistedIndexesOnDelete(id, existing.record)
      }
    } else {
      this.cache.delete(id)
      // Remove from secondary indexes — no-op if no indexes are declared
      // or the record wasn't previously indexed.
      if (existing) {
        this.indexes?.remove(id, existing.record)
        // Remove from unique-constraint maps so the deleted value is freed.
        this.uniqueConstraints?.remove(id, existing.record)
      }
    }

    await this.onDirty?.(this.name, id, 'delete', existing?.version ?? 0)

    this.emitter.emit('change', {
      vault: this.vault,
      collection: this.name,
      id,
      action: 'delete',
    } satisfies ChangeEvent)
    this.searchIndexStore?.markDirty() // #308 L1 — zero-cost for non-search collections

    await this.onAccess?.('delete', id)

    // Symmetric to put: user-initiated deletes must fire MV
    // refresh so `onEmpty: 'delete'` MVs tombstone their now-orphan
    // output rows. Gated on `!internal` to prevent recursion — the
    // MV executor's own tombstoning round-trips through
    // `_internalDelete → _doDelete(_, true)` and must NOT re-fire
    // dispatch (matches put's `_materializedFrom` skip in spirit).
    //
    // Record-shape derivations intentionally NOT dispatched on delete:
    // their derived-output id equals the source id, so the user can
    // delete the output directly with `outputCollection.delete(id)` if
    // they want. Array-shape derivations DO cascade on delete
    // because their derived ids are opaque (from the `key(out)`
    // extractor) — without cascade the rows become unfindable orphans.
    if (!internal) {
      await this.dispatchMaterializedViewsOnDelete(id)
      await this.dispatchArrayDerivationsOnDelete(id)
      // Rollup-on-delete (#376 slice 2): recompute the parent aggregate now
      // that this child is gone. `existing.record` carries the deleted child's
      // FK; the recompute gathers the REMAINING children (this one already
      // removed from the store/cache above).
      if (existing) await this.dispatchRollupsOnDelete(existing.record)
    }
  }

  /**
   * @internal — GDPR crypto-shred a LIVE record to a tombstone (#304).
   *
   * Rewrites the on-disk envelope to `{ _noydb, _v, _ts, _by, _iv:'', _data:'' }`,
   * dropping `_iv`/`_data`/`_cek`/`_det`. The wrapped per-record CEK is gone, so
   * the body — and (via {@link tombstoneHistory}) every history version under
   * the same CEK — is permanently undecryptable; the collection DEK and every
   * other record are untouched. `_det` is stripped too, so `findByDet` no
   * longer matches the shredded record (avoiding a post-shred TamperedError).
   *
   * Unlike `delete()`/`_internalDelete`, this:
   *   - does NOT fire onDelete guards / MV / derivation dispatch (a shred is an
   *     erasure, not a domain delete — re-running those would be wrong),
   *   - does NOT append a per-record ledger entry (`vault.forget()` appends a
   *     single `op:'forget'` summary for the whole subject),
   *   - keeps the record KEY present (it's an overwrite, not an adapter delete)
   *     so the version counter + "record existed" survive for audit.
   *
   * Idempotent: returns `null` when the record is absent or already a tombstone.
   * Otherwise returns `{ previousVersion }`. Invalidates the eager cache, the
   * lazy LRU, and the per-record CEK cache for this id.
   */
  /**
   * @internal — decrypt an envelope to a plain record for subject-index
   * rebuild (#304). Returns `null` for a tombstone or unreadable envelope.
   * Skips schema validation — the rebuild only reads the subject field.
   */
  async _decodeEnvelope(envelope: EncryptedEnvelope, id: string): Promise<Record<string, unknown> | null> {
    try {
      const rec = await this.decryptRecord(envelope, { skipValidation: true, id })
      return rec === null ? null : (rec as unknown as Record<string, unknown>)
    } catch {
      return null
    }
  }

  async _writeTombstone(id: string, actor: string): Promise<{ previousVersion: number } | null> {
    const live = await this.adapter.get(this.vault, this.name, id)
    if (!live || isTombstone(live, this.encrypted)) return null

    await this.adapter.put(this.vault, this.name, id, buildTombstone(live._v, actor))

    // Invalidate every in-memory view of this record so subsequent reads see
    // the tombstone (→ null), not a stale decrypted value.
    this.cache.delete(id)
    this.lru?.remove(id)
    this.cekCache?.remove(id)

    return { previousVersion: live._v }
  }

  /**
   * Cascade deletes of array-shape derived rows when a source row is
   * deleted. Reads each registered strategy's fanout sidecar
   * for this source id, deletes every listed derived row, then
   * deletes the sidecar itself.
   *
   * Record-shape derivations are skipped — see _doDelete's comment
   * for why the asymmetry is correct.
   *
   * @internal
   */
  private async dispatchArrayDerivationsOnDelete(id: string): Promise<void> {
    if (this.derivationSource === undefined) return
    const registry = this.derivationSource.registry()
    const strategies = registry.strategiesForSource(this.name)
    if (strategies.length === 0) return

    // Dynamic-import the sidecar helpers — keeps the derivation
    // chunk out of the floor bundle for consumers that don't use
    // array-shape derivations.
    let helpers: {
      loadFanoutSidecar: typeof LoadFanoutSidecarType
      deleteFanoutSidecar: typeof DeleteFanoutSidecarType
      saveFanoutSidecar: typeof SaveFanoutSidecarType
    } | null = null
    const txCtx = this.derivationSource.getActiveTxContext()

    for (const { spec } of strategies) {
      for (const [outputKey, outSpec] of Object.entries(spec.outputs)) {
        if (outSpec.shape !== 'array') continue
        if (helpers === null) {
          helpers = await import('./derivations/fanout-sidecar.js')
        }
        const sidecar = await helpers.loadFanoutSidecar(
          this.adapter,
          this.vault,
          spec.source,
          id,
          outputKey,
        )
        if (!sidecar) continue
        const outputCollection = this.derivationSource.getCollection(outSpec.collection)
        for (const derivedId of sidecar.keys) {
          await outputCollection._internalDelete(derivedId, txCtx)
        }
        await helpers.deleteFanoutSidecar(this.adapter, this.vault, spec.source, id, outputKey)
      }
    }
  }

  /**
   * Mirror of {@link dispatchMaterializedViews} for the delete path.
   * No record content is available (it's gone), so the
   * `_materializedFrom` skip used by the put-side dispatch doesn't
   * apply here — instead, the recursion guard is the `internal` gate
   * at the `_doDelete` call site above.
   *
   * @internal
   */
  private async dispatchMaterializedViewsOnDelete(id: string): Promise<void> {
    void id
    if (this.materializedViewSource === undefined) return
    const registry = this.materializedViewSource.registry()
    const mvs = registry.mvsForSource(this.name)
    if (mvs.length === 0) return
    let executor: typeof MVExecutorType | null = null
    let staleHelpers: typeof MVStaleModule | null = null
    for (const reg of mvs) {
      const mode = reg.spec.refresh
      if (mode === 'eager') {
        if (executor === null) {
          ;({ MaterializedViewExecutor: executor } = await import('./materialized-views/executor.js'))
        }
        await executor.refresh(reg, {
          getCollection: (name) => this.materializedViewSource!.getCollection(name),
          getActiveTxContext: () => this.materializedViewSource!.getActiveTxContext(),
          getQueryContext: () => this.materializedViewSource!.getQueryContext(),
        })
      } else if (mode === 'lazy') {
        if (staleHelpers === null) {
          staleHelpers = await import('./materialized-views/stale.js')
        }
        staleHelpers.markMVStale(registry, reg.spec.name)
      }
      // manual: no-op — `vault.refreshView(name)` is the only path.
    }
  }

  /**
   * List all records in the collection.
   *
   * Throws in lazy mode — bulk listing defeats the purpose of lazy
   * hydration. Use `scan()` to iterate over the full collection
   * page-by-page without holding more than `pageSize` records in memory.
   *
   * @param locale  Optional locale options. When provided,
   *                each record is locale-resolved before being returned.
   */
  async list(locale?: LocaleReadOptions): Promise<T[]> {
    if (this.lazy) {
      throw new Error(
        `Collection "${this.name}": list() is not available in lazy mode (prefetch: false). ` +
        `Use collection.scan({ pageSize }) to iterate over the full collection.`,
      )
    }
    // Lazy-MV resolve-on-read: if this collection is the
    // output of a registered lazy MV with a pending stale flag, run
    // the executor before returning so callers see fresh data. No-op
    // when nothing is pending — keeps the read path negligible.
    if (this.materializedViewSource !== undefined) {
      const { resolveStaleMVOnRead } = await import('./materialized-views/stale.js')
      await resolveStaleMVOnRead(this.materializedViewSource, this.name)
    }
    await this.ensureHydrated()
    const records = [...this.cache.values()].map(e => e.record)
    // #322 — money decode (stored scaled-int → canonical decimal) must run
    // even with no locale, so list() matches get(). applyLocaleToRecord
    // decodes money regardless of locale and only resolves i18n/dict virtuals
    // when a locale is active. Keep the no-transform fast path.
    if (!this.hasReadTransforms()) return records
    return Promise.all(records.map(r => this.applyLocaleToRecord(r, locale)))
  }

  /**
   * @internal — whether any read-side record transform is registered
   * (money decode, i18nText resolution, dictKey labels). Gates the
   * no-transform fast path in {@link list}.
   */
  private hasReadTransforms(): boolean {
    return (
      (this.moneyFields !== undefined && Object.keys(this.moneyFields).length > 0) ||
      (this.i18nFields !== undefined && Object.keys(this.i18nFields).length > 0) ||
      (this.dictKeyFields !== undefined && Object.keys(this.dictKeyFields).length > 0)
    )
  }

  /**
   * Scan-mode full-text search over a plain-text `field` (#308). Decrypts the
   * collection in memory and ranks records by BM25 against the tokenized query.
   * **Zero added store leakage** — pure client-side scan; nothing searchable is
   * written to the store. (A store-usable blind index for at-scale search is a
   * separate, gated opt-in — see the #308 design note.) Eager mode only.
   *
   * `opts.match` (`'any'` default | `'all'`), `opts.prefix` (last query term as
   * a prefix → typeahead), `opts.limit` (top-N). Returns `{ id, score, record }`
   * ranked by descending score. The default tokenizer is word-boundary based —
   * see `src/search/tokenize.ts` for the Thai/CJK caveat.
   */
  async search(field: string, query: string, opts: SearchOptions = {}): Promise<SearchResult<T>[]> {
    if (this.lazy) {
      throw new Error(
        `Collection "${this.name}": search() (scan mode) requires eager mode (prefetch: true). ` +
          `A store-usable blind index for lazy / at-scale search is a separate gated opt-in (#308).`,
      )
    }
    await this.ensureHydrated()
    const entries: { id: string; record: T }[] = []
    // #435 — strip the internal densify marker from the user-facing records.
    // Non-mutating: never touches the cached record object. The search index
    // is built over the same (marker-free) record, which is fine — the marker
    // is never a searchable field.
    for (const [id, e] of this.cache) entries.push({ id, record: stripI18nFilled(e.record as Record<string, unknown>) as T })
    return searchScan(entries, field, query, opts)
  }

  /** #308 L1 — build IndexDoc[] for the configured text fields over the live cache. */
  private buildRetrievalDocs(
    labelMaps: Map<string, Map<string, Record<string, string>>>,
    blobFilenames: Map<string, Map<string, string[]>>,
    only?: readonly string[],
  ): IndexDoc[] {
    const docs: IndexDoc[] = []
    for (const [id, e] of this.cache) {
      const rec = stripI18nFilled(e.record as Record<string, unknown>)
      const fields = buildStringFieldEntries(rec, this.textIndexes ?? [], only)
      if (this.i18nFields) fields.push(...buildI18nFieldEntries(rec, this.i18nFields, this.textIndexes ?? [], only))
      if (this.dictKeyFields) fields.push(...buildDictKeyFieldEntries(rec, this.dictKeyFields, labelMaps, this.textIndexes ?? [], only))
      const blobNames = blobFilenames.get(id)
      if (blobNames) fields.push(...buildBlobFieldEntries(blobNames))
      if (fields.length > 0) docs.push({ id, fields })
    }
    return docs
  }

  /** #308 L1 — true iff any configured text index is also a blob field (gates ALL slot I/O). */
  private hasIndexedBlobFields(only?: readonly string[]): boolean {
    if (!this.blobFields || !this.textIndexes) return false
    const fields = only ? this.textIndexes.filter((f) => only.includes(f)) : this.textIndexes
    return fields.some((f) => f in this.blobFields!)
  }

  /**
   * #308 L1 — resolve `recordId -> (blobField -> filenames[])` by listing slots
   * for the configured blob fields of each cached record. Blob slot metadata is
   * NOT inline on the record: it lives in a separate `_blob_slots_*` collection,
   * so this costs ONE `blob(id).list()` (a `listSlots`) per record at build time
   * — the heaviest indexing source. Fully gated by {@link hasIndexedBlobFields};
   * non-blob (and blob-but-not-indexed) collections do ZERO slot I/O.
   */
  private async resolveBlobFilenames(only?: readonly string[]): Promise<Map<string, Map<string, string[]>>> {
    const out = new Map<string, Map<string, string[]>>()
    if (!this.hasIndexedBlobFields(only)) return out
    const indexed = (only ? this.textIndexes!.filter((f) => only.includes(f)) : this.textIndexes!)
      .filter((f) => f in this.blobFields!)
    const indexedSet = new Set(indexed)
    for (const id of this.cache.keys()) {
      let slots
      try {
        slots = await this.blob(id).list()
      } catch {
        continue
      }
      let byField: Map<string, string[]> | undefined
      for (const slot of slots) {
        if (!indexedSet.has(slot.name) || !slot.filename) continue
        if (!byField) { byField = new Map(); out.set(id, byField) }
        const names = byField.get(slot.name)
        if (names) names.push(slot.filename)
        else byField.set(slot.name, [slot.filename])
      }
    }
    return out
  }

  /** #308 L1 — field -> (key -> {locale->label}) for dictKey fields; static from table, dynamic via getDictionary().list(). */
  private async resolveDictLabelMaps(): Promise<Map<string, Map<string, Record<string, string>>>> {
    const maps = new Map<string, Map<string, Record<string, string>>>()
    if (!this.dictKeyFields || !this.textIndexes) return maps
    for (const field of this.textIndexes) {
      const desc = this.dictKeyFields[field]
      if (!desc) continue
      const m = new Map<string, Record<string, string>>()
      if (isStaticDictDescriptor(desc)) {
        for (const [key, labels] of Object.entries(desc.table)) m.set(key, labels as Record<string, string>)
      } else {
        if (this.getDictionary) {
          const handle = await this.getDictionary(desc.name)
          for (const e of await handle.list()) m.set(e.key, e.labels)
        }
      }
      maps.set(field, m)
    }
    return maps
  }

  /** #308 L1.5 — force-persist the lexical index now (e.g. on save/idle). Persists only when textIndexPersist is enabled; a no-op otherwise. */
  async flushIndex(): Promise<void> {
    if (!this.searchIndexStore) return
    await this.ensureHydrated()
    const labelMaps = await this.resolveDictLabelMaps()
    const blobFilenames = await this.resolveBlobFilenames()
    await this.searchIndexStore.ensureBuilt(() => this.buildRetrievalDocs(labelMaps, blobFilenames))
    await this.searchIndexStore.flush?.()
  }

  /** #308 L2 — load + decrypt all _vec sidecars into StoredVector[] for the VectorSet. */
  private buildVectorLoad(): () => Promise<StoredVector[]> {
    return async () => {
      const ids = await this.adapter.list(this.vault, '_vec')
      const out: StoredVector[] = []
      for (const id of ids) {
        const env = await this.adapter.get(this.vault, '_vec', id)
        if (!env) continue
        const body = await this.decryptJsonString(env)
        if (body === null) continue
        const parsed = JSON.parse(body) as { vec: number[]; model: string }
        out.push({ id, vec: new Float32Array(parsed.vec), model: parsed.model })
      }
      return out
    }
  }

  /**
   * #308 L1.5 — build the PersistedIndexCallbacks bridge: crypto lives here
   * (collection has getDEK / encryptJsonString / decryptJsonString / adapter),
   * the index store itself is crypto-free.
   *
   * Fingerprint encoding: body-wrap approach — save(json, fp) stores
   * JSON.stringify({ fp, idx: json }) as the encrypted body so the standard
   * EncryptedEnvelope shape is never extended. load() decrypts and JSON.parses
   * the wrapper back out.
   *
   * Cache shape: this.cache stores { record, version } — currentFingerprint()
   * iterates over e.version.
   */
  private buildPersistedIndexCallbacks(): PersistedIndexCallbacks {
    const FT = '_ftindex'
    return {
      load: async () => {
        const env = await this.adapter.get(this.vault, FT, this.name)
        if (!env) return null
        const body = await this.decryptJsonString(env)
        if (body === null) return null
        try {
          const wrapped = JSON.parse(body) as { fp: { count: number; maxVersion: number }; idx: string }
          return { json: wrapped.idx, fingerprint: wrapped.fp }
        } catch {
          return null
        }
      },
      save: async (json, fp) => {
        const body = JSON.stringify({ fp, idx: json })
        const env = await this.encryptJsonString(body, fp.count)
        await this.adapter.put(this.vault, FT, this.name, env)
      },
      remove: async () => { await this.adapter.delete(this.vault, FT, this.name) },
      currentFingerprint: () => {
        let maxVersion = 0
        for (const e of this.cache.values()) if (e.version > maxVersion) maxVersion = e.version
        return { count: this.cache.size, maxVersion }
      },
    }
  }

  /** #308 L1 — pre-build the lexical index (e.g. on open) so the first retrieve() pays no build scan. */
  async warmIndex(): Promise<void> {
    if (!this.searchIndexStore) return
    if (this.lazy) {
      throw new Error(
        `Collection "${this.name}": warmIndex() requires eager mode (prefetch: true).`,
      )
    }
    await this.ensureHydrated()
    const built = this.searchIndexStore.built
    const labelMaps = built ? new Map() : await this.resolveDictLabelMaps()
    const blobFilenames = built ? new Map() : await this.resolveBlobFilenames()
    await this.searchIndexStore.ensureBuilt(() => this.buildRetrievalDocs(labelMaps, blobFilenames))
  }

  /** #308 L1 — client-side lexical retrieval; ranked { id, score, field, snippet, locale? }. */
  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrieveHit<T>[]> {
    if (opts.mode === 'semantic') return this.retrieveSemantic(query, opts)
    if (!this.searchIndexStore) {
      throw new Error(`Collection "${this.name}": retrieve() requires a textIndexes config.`)
    }
    if (this.lazy) {
      throw new Error(
        `Collection "${this.name}": retrieve() requires eager mode (prefetch: true).`,
      )
    }
    await this.ensureHydrated()
    const built = this.searchIndexStore.built
    const labelMaps = built ? new Map() : await this.resolveDictLabelMaps()
    const blobFilenames = built ? new Map() : await this.resolveBlobFilenames()
    const index = await this.searchIndexStore.ensureBuilt(() => this.buildRetrievalDocs(labelMaps, blobFilenames))
    const hits = index.query(query, {
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.match ? { match: opts.match } : {}),
      ...(opts.prefix ? { prefix: opts.prefix } : {}),
      ...(opts.fields ? { fields: opts.fields } : {}),
    })
    const window = opts.snippetWindow ?? 80
    return hits.map((h: IndexHit, i: number) => {
      const base: RetrieveHit<T> = {
        id: h.id,
        score: h.score,
        rank: i + 1,
        field: h.field,
        snippet: extractSnippet(h.text, h.offset, window),
        ...(h.locale !== undefined ? { locale: h.locale } : {}),
        ...(opts.includeRecord
          ? (() => {
              const e = this.cache.get(h.id)
              return e ? { record: stripI18nFilled(e.record as Record<string, unknown>) as T } : {}
            })()
          : {}),
      }
      return base
    })
  }

  /** #308 L2 — semantic branch of retrieve(): encode query → similarTo(). */
  private async retrieveSemantic(query: string, opts: RetrieveOptions): Promise<RetrieveHit<T>[]> {
    if (!this.embeddings) throw new Error(`Collection "${this.name}": retrieve({mode:'semantic'}) requires an embeddings config.`)
    if (this.lazy) throw new Error(`Collection "${this.name}": retrieve() requires eager mode (prefetch: true).`)
    const qVec = await this.embeddings.encode(query)
    return this.similarTo(qVec, {
      ...(opts.limit !== undefined ? { k: opts.limit } : {}),
      ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}),
      ...(opts.includeRecord ? { includeRecord: true } : {}),
    })
  }

  /** #308 L2 — raw-vector kNN over the encrypted vector set (decrypted in the trusted tier).
   *  Snippet is '' for vector hits in v1 (semantic match isn't span-located). */
  async similarTo(vector: Float32Array, opts: { k?: number; minScore?: number; includeRecord?: boolean } = {}): Promise<RetrieveHit<T>[]> {
    if (!this.embeddings || !this.vectorSet) throw new Error(`Collection "${this.name}": similarTo() requires an embeddings config.`)
    if (this.lazy) throw new Error(`Collection "${this.name}": similarTo() requires eager mode (prefetch: true).`)
    await this.ensureHydrated()
    await this.vectorSet.ensureLoaded(this.buildVectorLoad())
    const hits = this.vectorSet.cosineTopK(vector, opts.k ?? 10, {
      ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}),
      expectModel: this.embeddings.model,
    })
    return hits.map((h, i) => {
      const base: RetrieveHit<T> = { id: h.id, score: h.score, rank: i + 1, field: '(vector)', snippet: '' }
      if (opts.includeRecord) { const e = this.cache.get(h.id); if (e) (base as { record?: T }).record = stripI18nFilled(e.record as Record<string, unknown>) as T }
      return base
    })
  }

  // ─── Bulk operations ─────────────────────────────────────

  /**
   * Put many records in one call. Each item is processed sequentially
   * through the normal `put()` path — meaning per-item validation,
   * history snapshots, ledger appends, and change events all still
   * fire. The round-trip saving comes from the adapter staying hot
   * across the batch (no connection re-open, no keyring re-unlock).
   *
   * ## Semantics
   *
   * **Best-effort with per-item results.** If item 5 of 10 fails, items
   * 1–4 are already persisted and items 6–10 are still attempted.
   * The returned {@link PutManyResult} lists every success and failure
   * individually so the caller can decide whether to roll forward
   * (retry the failures) or roll back (manually delete the successes).
   *
   * **True tx-atomic putMany** — pass `{ atomic: true }` to switch
   * to the  transaction executor: pre-flight CAS against every
   * item's `expectedVersion`, then commit all ops with best-effort
   * revert on mid-batch failure. Atomic mode throws on failure rather
   * than returning a mixed-results object.
   *
   * ## Change events
   *
   * One `change` event per successfully-written record, same as N
   * single-record puts. Subscribers don't need to special-case bulk.
   */
  async putMany(
    entries: ReadonlyArray<readonly [id: string, record: T, opts?: PutManyItemOptions]>,
    options?: PutManyOptions,
  ): Promise<PutManyResult> {
    if (options?.atomic) {
      return this.putManyAtomic(entries)
    }
    const success: string[] = []
    const failures: Array<{ id: string; error: Error }> = []
    for (const entry of entries) {
      const [id, record] = entry
      try {
        await this.put(id, record)
        success.push(id)
      } catch (error) {
        failures.push({ id, error: error as Error })
      }
    }
    return { ok: failures.length === 0, success, failures }
  }

  /**
   * Atomic-mode implementation of {@link putMany}. Pre-flights every
   * `expectedVersion`, executes all puts in declaration order, and
   * reverts executed ops via the raw adapter on mid-batch failure.
   * See `runTransaction` for the shared semantics + crash-window caveat.
   *
   * @internal
   */
  private async putManyAtomic(
    entries: ReadonlyArray<readonly [id: string, record: T, opts?: PutManyItemOptions]>,
  ): Promise<PutManyResult> {
    // Phase 1 — pre-flight CAS + prior-envelope snapshot for revert.
    const priors = new Map<string, EncryptedEnvelope | null>()
    for (const [id, , opts] of entries) {
      if (!priors.has(id)) {
        priors.set(id, await this.adapter.get(this.vault, this.name, id))
      }
      if (opts?.expectedVersion !== undefined) {
        const env = priors.get(id) ?? null
        const actual = env?._v ?? 0
        if (actual !== opts.expectedVersion) {
          throw new ConflictError(
            actual,
            `putMany atomic: ${this.vault}/${this.name}/${id} ` +
              `expected v${opts.expectedVersion}, found v${actual}`,
          )
        }
      }
    }
    // Phase 2 — execute; revert on failure.
    //
    // When a derivation registry is wired, publish a transient
    // TxContext for the duration of this loop so `dispatchDerivations`
    // can register recursive derived-output writes onto `ctx._executed`.
    // The shared `revertExecuted` helper then unwinds the combined list
    // (source ops + side-effect ops) in reverse, matching the
    // `runTransaction` rollback semantics. When no derivation registry
    // is configured, we still build a local `executed` list and revert
    // it via `revertExecuted` — keeps a single code path.
    const txCtx = this.derivationSource?.createTxContext() ?? null
    if (txCtx !== null && this.derivationSource) {
      this.derivationSource.setActiveTxContext(txCtx)
    }
    const localExecuted: ExecutedOp[] = []
    try {
      for (const [id, record] of entries) {
        // Record the revert plan BEFORE the call so a mid-`put` throw
        // (e.g. strict derivation failure firing after `store.put`
        // already committed the source envelope) still has the source
        // write reverted. Mirrors `runTransaction`'s Phase 2 pattern.
        const entry: ExecutedOp = {
          op: { type: 'put', vaultName: this.vault, collectionName: this.name, id },
          priorEnvelope: priors.get(id) ?? null,
        }
        if (txCtx !== null) txCtx._executed.push(entry)
        else localExecuted.push(entry)
        await this.put(id, record)
      }
      return { ok: true, success: entries.map(([id]) => id), failures: [] }
    } catch (err) {
      const executedForRevert = txCtx !== null ? txCtx._executed : localExecuted
      // Restore prior envelopes via the raw store. Same helper as
      // `runTransaction` for symmetric semantics — walks in reverse,
      // best-effort on each restore.
      await revertExecuted(executedForRevert, this.adapter)
      // Cache desync guard. `revertExecuted` only invalidates caches
      // when given a `Noydb` reference (which we don't have here
      // without widening the constructor surface). Walk the executed
      // ops and invalidate caches via the source collection (this)
      // for entries that target this collection, and via
      // `derivationSource.getCollection(name)` for nested derived
      // outputs that live in sibling collections — otherwise an eager
      // cache on a derived-output collection still serves the
      // rolled-back record.
      for (const { op } of [...executedForRevert].reverse()) {
        if (op.vaultName !== this.vault) continue
        try {
          if (op.collectionName === this.name) {
            await this._invalidateCacheEntry(op.id)
          } else if (this.derivationSource) {
            const sibling = this.derivationSource.getCollection(op.collectionName)
            await sibling._invalidateCacheEntry(op.id)
          }
        } catch { /* best-effort */ }
      }
      throw err
    } finally {
      if (txCtx !== null && this.derivationSource) {
        this.derivationSource.clearActiveTxContext(txCtx)
      }
    }
  }

  /**
   * Get many records in one call. Returns a `Map<id, T | null>` —
   * missing records surface as `null` entries so the caller can
   * distinguish "not found" from "lookup failed". Order-stable
   * iteration (Map preserves insertion order = input `ids` order).
   *
   * Reads go through the per-id `get()` path, which means the cache
   * / hydration logic stays consistent with single-record reads.
   */
  async getMany(ids: readonly string[]): Promise<Map<string, T | null>> {
    const result = new Map<string, T | null>()
    for (const id of ids) {
      result.set(id, await this.get(id))
    }
    return result
  }

  /**
   * Delete many records in one call. Same best-effort contract as
   * {@link putMany}: if item 5 fails, items 1–4 are already deleted
   * and items 6–10 are still attempted.
   *
   * Deleting a non-existent id is not a failure — matches the
   * idempotent semantics of single-record `delete()`.
   */
  async deleteMany(ids: readonly string[]): Promise<DeleteManyResult> {
    const success: string[] = []
    const failures: Array<{ id: string; error: Error }> = []
    for (const id of ids) {
      try {
        await this.delete(id)
        success.push(id)
      } catch (error) {
        failures.push({ id, error: error as Error })
      }
    }
    return { ok: failures.length === 0, success, failures }
  }

  /**
   * Build a chainable query against the collection. Returns a `Query<T>`
   * builder when called with no arguments.
   *
   * Backward-compatible overload: passing a predicate function returns
   * the filtered records directly (the API). Prefer the chainable
   * form for new code.
   *
   * **Lazy-MV gap:** `query()` is synchronous and does NOT
   * trigger lazy materialized-view resolve-on-read. If this
   * collection is a lazy MV's output and the MV is currently stale,
   * `query().toArray()` returns the pre-stale snapshot. To force a
   * fresh read on a lazy MV, either call `list()` (which DOES
   * trigger resolve) or `vault.refreshView(mvName)` before querying.
   * The proper fix — extending `QuerySource` with an async prepare
   * hook — is a separate PR.
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
        `Use collection.lazyQuery() for indexed reads, or collection.scan({ pageSize }) ` +
        `and filter the streamed records with a regular for-await loop.`,
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
      ...(this.moneyFields ? { moneyFields: this.moneyFields } : {}),
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
          // #285 §3 — flow the vault/collection default locale to joins so a
          // joined i18n field resolves like get()/list() when no per-call
          // locale is given; toArray({ locale }) overrides it.
          ...(this.defaultLocale !== undefined ? { defaultLocale: this.defaultLocale } : {}),
          ...(resolver.resolveDictSource
            ? { resolveDictSource: (field: string) => resolver.resolveDictSource!(leftCollection, field) }
            : {}),
        }
      : undefined
    return new Query<T>(source, undefined, joinContext, this.aggregateStrategy)
  }

  /**
   * Subscribe to every put/delete on this collection. Returns an
   * unsubscribe function.
   *
   * Fires **after** the store write has committed — subscribers see
   * only materialised state, never in-flight or rolled-back writes.
   *
   * This is an event stream, not a reactive value. For reactive
   * "current array state" semantics use `query().live()`. Typical
   * use cases for `subscribe()`:
   *   - audit-trail / activity-feed UI that lists events as they happen
   *   - Pinia-per-collection wiring where each store subscribes once
   *   - outbox-style workers that process every new record
   *
   * The callback receives a `CollectionChangeEvent<T>`:
   *   - `{ type: 'put', id, record }` — record is the current
   *     decrypted value. May be `null` if another op deleted the
   *     record between the emit and the handler firing (rare race).
   *   - `{ type: 'delete', id, record: null }` — deletion event;
   *     the record content is gone by the time the handler runs.
   *
   * The callback is invoked synchronously *with respect to the emit
   * moment*, but the record lookup is async (cache hit for eager
   * collections; one `get()` for lazy collections). If your handler
   * does not need the record, cast it away and ignore — the lookup
   * is still performed, but it's cheap on the hydrated path.
   *
   * ergonomic wrapper over `db.on('change', …)` that
   * filters to this collection and hydrates the record.
   */
  subscribe(cb: (event: CollectionChangeEvent<T>) => void): () => void {
    const handler = (event: ChangeEvent): void => {
      if (event.vault !== this.vault || event.collection !== this.name) return
      if (event.action === 'put') {
        // Cache hit in eager mode; get() in lazy mode.
        void this.get(event.id).then(record => {
          cb({ type: 'put', id: event.id, record: record ?? null })
        }).catch(() => {
          // Record vanished between emit + lookup (race). Emit with null
          // so subscribers still see the event they were promised.
          cb({ type: 'put', id: event.id, record: null })
        })
      } else {
        // delete
        cb({ type: 'delete', id: event.id, record: null })
      }
    }
    this.emitter.on('change', handler)
    return () => {
      this.emitter.off('change', handler)
    }
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
   * variant of this method, which is exactly what  streaming
   * joins will need anyway.
   */
  querySourceForJoin(): JoinableSource {
    if (this.lazy) {
      throw new Error(
        `Collection "${this.name}": .join() cannot use a lazy-mode ` +
          `collection as the right side. Opening it in eager mode ` +
          `(prefetch: true, default) makes it joinable. Streaming joins ` +
          `over lazy collections are not yet supported.`,
      )
    }
    // Structural source — the join executor calls snapshot() and
    // lookupById(); the live-join executor additionally calls
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
      // #285 §3 — expose this (right-side) collection's i18nText descriptors so
      // the join executor can resolve joined i18n fields at the `join` layer.
      ...(this.i18nFields !== undefined ? { i18nFields: this.i18nFields } : {}),
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
    const envelopes = await this.historyStrategy.getHistoryEntries(
      this.adapter, this.vault, this.name, id, options,
    )

    const entries: HistoryEntry<T>[] = []
    for (const env of envelopes) {
      // History reads skip schema validation — see getVersion() docs.
      const record = await this.decryptRecord(env, { skipValidation: true })
      // Shredded (tombstoned) history version: the body is permanently gone,
      // so there is nothing to return — skip it. The version still counted in
      // the audit ledger; history() just can't surface its erased content.
      if (record === null) continue
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
    const envelope = await this.historyStrategy.getVersionEnvelope(
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
    return this.historyStrategy.diff(recordA, recordB)
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
    const pruned = await this.historyStrategy.pruneHistory(
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
    return this.historyStrategy.clearHistory(this.adapter, this.vault, this.name, id)
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
        if (record === null) continue // shredded (tombstone) — skip
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
   * // — streaming aggregation with O(reducers) memory.
   * const { total, n } = await invoices.scan()
   *   .where('year', '==', 2025)
   *   .aggregate({ total: sum('amount'), n: count() })
   * ```
   *
   * **Lazy-MV gap:** `scan()` is synchronous-build and does
   * NOT trigger lazy materialized-view resolve-on-read. For lazy
   * MVs, call `list()` (which DOES resolve) or `vault.refreshView(name)`
   * before scanning. Same shape as the `query()` limitation.
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
    // — same machinery as `query()`. Without one, `.join()`
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
          // #285 §3 — flow the vault/collection default locale to joins so a
          // joined i18n field resolves like get()/list() when no per-call
          // locale is given; toArray({ locale }) overrides it.
          ...(this.defaultLocale !== undefined ? { defaultLocale: this.defaultLocale } : {}),
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
      this.moneyFields,
    )
  }

  /** Decrypt a page of envelopes returned by `adapter.listPage`. */
  private async decryptPage(
    items: ListPageResult['items'],
  ): Promise<Array<{ id: string; record: T; version: number }>> {
    const out: Array<{ id: string; record: T; version: number }> = []
    for (const { id, envelope } of items) {
      const record = await this.decryptRecord(envelope)
      if (record === null) continue // shredded (tombstone) — skip the page row
      out.push({ id, record, version: envelope._v })
    }
    return out
  }

  // ─── Internal ──────────────────────────────────────────────────

  /** Load all records from adapter into memory cache. */
  /**
   * @internal — refresh the in-memory cache entry for a single id by
   * re-reading from the adapter. Used by the transaction executor's
   * Phase-3 revert path: that path writes the prior envelope directly
   * via the raw store (to avoid re-firing Collection-level side
   * effects), which would otherwise leave this Collection's eager
   * cache holding the rolled-back value. After revert, the executor
   * calls this hook so subsequent `get` / `query` reads see the
   * actual on-disk state.
   *
   * Lazy mode: drops the LRU entry; the next `get` repopulates from
   * the adapter. Eager mode: re-reads the envelope and either sets
   * the cache entry (record still present) or deletes it (record was
   * gone before the tx and the revert deleted it again).
   */
  /**
   * @internal — evict ONLY the per-record CEK cache entry for `id`. Used by
   * `vault.rotateRecordCek()`: after a hard CEK rotation the cached unwrapped
   * CEK is stale (it would decrypt the pre-rotation body and fail GCM auth on
   * the post-rotation body). Eviction must be synchronous with the live-envelope
   * rewrite so no concurrent read observes the old CEK. Paired with
   * {@link _invalidateCacheEntry} (which refreshes the decrypted-record cache).
   * No-op when the collection is not `perRecordKeys`.
   */
  _invalidateCekCacheEntry(id: string): void {
    this.cekCache?.remove(id)
  }

  async _invalidateCacheEntry(id: string): Promise<void> {
    if (this.lazy && this.lru) {
      this.lru.remove(id)
      return
    }
    if (!this.hydrated) return
    const previous = this.cache.get(id)
    const envelope = await this.adapter.get(this.vault, this.name, id)
    if (!envelope) {
      this.cache.delete(id)
      if (previous) {
        this.indexes?.remove(id, previous.record)
        this.uniqueConstraints?.remove(id, previous.record)
      }
      return
    }
    const record = await this.decryptRecord(envelope)
    if (record === null) {
      // The on-disk envelope is now a tombstone (shredded). Treat exactly
      // like a deleted record: drop the cache entry and its index rows.
      this.cache.delete(id)
      if (previous) {
        this.indexes?.remove(id, previous.record)
        this.uniqueConstraints?.remove(id, previous.record)
      }
      return
    }
    this.cache.set(id, { record, version: envelope._v })
    this.indexes?.upsert(id, record, previous ? previous.record : null)
    this.uniqueConstraints?.upsert(id, record, previous?.record)
  }

  /**
   * Apply a peer tab's committed write to THIS tab's in-memory view:
   * re-read the (already-persisted) envelope from the shared store + refresh
   * cache/indexes, then emit a `change` event so reactive consumers re-render.
   * Never writes to the store and never fires write hooks, so it cannot loop.
   */
  async _applyRemoteChange(id: string, action: 'put' | 'delete'): Promise<void> {
    await this._invalidateCacheEntry(id)
    this.emitter.emit('change', { vault: this.vault, collection: this.name, id, action })
    this.searchIndexStore?.markDirty() // #308 L1 — peer write changed the cache; rebuild on next retrieve
  }

  /** @internal — the current in-memory record without a store read (for conflict capture). */
  _peekCached(id: string): T | null {
    const entry = this.lazy && this.lru ? this.lru.get(id) : this.cache.get(id)
    return entry ? entry.record : null
  }

  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) return

    const ids = await this.adapter.list(this.vault, this.name)
    for (const id of ids) {
      const envelope = await this.adapter.get(this.vault, this.name, id)
      if (envelope && !isTombstone(envelope, this.encrypted)) {
        const record = await this.decryptRecord(envelope, { id })
        if (record === null) continue
        this.cache.set(id, { record, version: envelope._v })
      }
    }
    this.hydrated = true
    this.rebuildEagerIndexesFromCache()
    this.rebuildUniqueConstraintsFromCache()
  }

  /** Hydrate from a pre-loaded snapshot (used by Vault). */
  async hydrateFromSnapshot(records: Record<string, EncryptedEnvelope>): Promise<void> {
    for (const [id, envelope] of Object.entries(records)) {
      if (isTombstone(envelope, this.encrypted)) continue
      const record = await this.decryptRecord(envelope, { id })
      if (record === null) continue
      this.cache.set(id, { record, version: envelope._v })
    }
    this.hydrated = true
    this.rebuildEagerIndexesFromCache()
    this.rebuildUniqueConstraintsFromCache()
  }

  /**
   * Rebuild secondary indexes from the current in-memory cache.
   *
   * Called after any bulk hydration. Incremental put/delete updates
   * are handled by `indexes.upsert()` / `indexes.remove()` directly,
   * so this only fires for full reloads.
   *
   * Synchronous and O(N × indexes.size); for the target scale of
   * 1K–50K records this completes in single-digit milliseconds.
   */
  private rebuildEagerIndexesFromCache(): void {
    const eager = this.indexes
    if (!eager || eager.fields().length === 0) return
    const snapshot: Array<{ id: string; record: T }> = []
    for (const [id, entry] of this.cache) {
      snapshot.push({ id, record: entry.record })
    }
    eager.build(snapshot)
  }

  /**
   * Rebuild unique-constraint maps from the current in-memory cache.
   * Called after any bulk hydration alongside `rebuildEagerIndexesFromCache`.
   */
  private rebuildUniqueConstraintsFromCache(): void {
    if (!this.uniqueConstraints) return
    this.uniqueConstraints.build(
      (function* (cache: Map<string, { record: T }>) {
        for (const [id, entry] of cache) yield [id, entry.record] as const
      })(this.cache),
    )
  }

  /**
   * Rebuild every declared index from scratch.
   *
   * Eager mode: refreshes the in-memory `CollectionIndexes` from the
   * current cache — O(records × declaredFields).
   *
   * Lazy mode: tears down every `_idx/<field>/<recordId>`
   * side-car, walks the canonical record namespace, and materialises
   * fresh side-cars for every declared field. The in-memory mirror is
   * cleared and re-ingested. Intended for two scenarios:
   *   1. Adding a new indexed field to a collection that already holds
   *      records — after the schema change, call `rebuildIndexes()` to
   *      backfill the side-cars.
   *   2. Recovery from a catastrophic drift (audit noticed many
   *      `index:write-partial` events, operator wants a clean slate).
   *
   * The rebuild is NOT incremental — it's a full bulk-replace. For
   * per-field drift repair, use `reconcileIndex(field)` instead.
   */
  async rebuildIndexes(): Promise<void> {
    if (!this.lazy) {
      await this.ensureHydrated()
      this.rebuildEagerIndexesFromCache()
      return
    }

    const persisted = this.persistedIndexes
    if (!persisted) return
    const fields = persisted.fields()
    if (fields.length === 0) return

    // 1. Collect canonical ids (skip every reserved-namespace id —
    //    `_idx/`, `_keyring`, `_history/`, `_ledger_deltas/`, `_meta/`,
    //    `_ledger`, `_blob_`, etc. User records may not start with `_`
    //    per the monorepo convention used across the hub).
    const allIds = await this.adapter.list(this.vault, this.name)
    const canonicalIds: string[] = []
    const staleIdxIds: string[] = []
    for (const id of allIds) {
      if (decodeIdxId(id)) {
        staleIdxIds.push(id)
      } else if (!id.startsWith('_')) {
        canonicalIds.push(id)
      }
    }

    // 2. Drop every existing side-car. Errors here are tolerated — the
    //    next step overwrites any remnants. If a side-car is for a
    //    field that is no longer declared, the delete still removes
    //    the stale row from storage.
    for (const id of staleIdxIds) {
      try { await this.adapter.delete(this.vault, this.name, id) } catch { /* ignore */ }
    }
    persisted.clear()

    // 3. Walk records and write fresh side-cars for every declared field.
    for (const recordId of canonicalIds) {
      const envelope = await this.adapter.get(this.vault, this.name, recordId)
      if (!envelope) continue
      const record = await this.decryptRecord(envelope, { skipValidation: true })
      if (record === null) continue // shredded (tombstone) — no side-car to build
      await this.maintainPersistedIndexesOnPut(recordId, record, null, envelope._v)
    }

    this.persistedIndexesLoaded = true
  }

  /**
   * Compare the persisted `_idx/<field>/*` side-cars against the
   * canonical records for a single field, reporting the drift (and
   * optionally repairing it).
   *
   * Lazy mode only. Eager mode throws — the in-memory index cannot
   * drift.
   *
   * `missing` — record ids whose value is indexable but no side-car
   *   exists. Happens when a `put()` succeeded but the side-car put
   *   failed (surfaced as `index:write-partial`).
   * `stale` — side-car ids pointing to a record that no longer exists
   *   or whose current value no longer matches the side-car body.
   * `applied` — number of writes that were actually applied (always 0
   *   when `dryRun: true`).
   *
   * Design reference: acceptance criteria.
   */
  async reconcileIndex(
    field: string,
    opts: { dryRun?: boolean } = {},
  ): Promise<{ field: string; missing: string[]; stale: string[]; applied: number }> {
    if (!this.lazy) {
      throw new Error(
        `Collection "${this.name}": reconcileIndex is only meaningful in lazy mode ` +
        `(prefetch: false). Eager mode maintains indexes in memory with no drift.`,
      )
    }
    const persisted = this.persistedIndexes
    if (!persisted) {
      throw new Error(
        `Collection "${this.name}": indexing is disabled on this Noydb instance. ` +
        `Pass \`withIndexing()\` from "@noy-db/hub/indexing" to \`createNoydb({ indexStrategy })\`.`,
      )
    }
    if (!persisted.has(field)) {
      throw new Error(
        `Collection "${this.name}": field "${field}" is not declared in indexes. ` +
        `Declare it in the collection options before reconciling.`,
      )
    }

    const dryRun = opts.dryRun === true
    const allIds = await this.adapter.list(this.vault, this.name)

    // Map side-car recordId → stored value (if readable). Also capture
    // "stale" side-cars whose field matches but whose record is gone.
    const sidecar = new Map<string, unknown>()
    const sidecarIds = new Map<string, string>() // recordId -> sidecar id
    for (const id of allIds) {
      const decoded = decodeIdxId(id)
      if (!decoded || decoded.field !== field) continue
      sidecarIds.set(decoded.recordId, id)
      const env = await this.adapter.get(this.vault, this.name, id)
      if (!env) continue
      try {
        const sidecarJson = await this.decryptJsonString(env)
        if (sidecarJson === null) {
          // Tombstone side-car (shredded) — treat as stale so it's rewritten.
          sidecar.set(decoded.recordId, undefined)
        } else {
          const body = JSON.parse(sidecarJson) as { value: unknown }
          sidecar.set(decoded.recordId, body.value)
        }
      } catch {
        // Unreadable — treat as stale so it gets rewritten.
        sidecar.set(decoded.recordId, undefined)
      }
    }

    // Walk canonical records and compare against side-car state.
    const missing: string[] = []
    const stale: string[] = []
    const fixesPut: Array<{ recordId: string; record: T; version: number }> = []
    for (const id of allIds) {
      if (decodeIdxId(id)) continue
      if (id.startsWith('_')) continue
      const env = await this.adapter.get(this.vault, this.name, id)
      if (!env) continue
      const record = await this.decryptRecord(env, { skipValidation: true })
      // Shredded (tombstone) canonical record: treat like a vanished record —
      // leave its `id` in `sidecarIds` so any lingering side-car is marked
      // stale (and deleted) by the leftover loop below.
      if (record === null) continue
      const live = readPersistedValue(record as unknown as Record<string, unknown>, field)
      const stored = sidecar.get(id)
      const hasSidecar = sidecarIds.has(id)
      const indexable = live !== null && live !== undefined

      if (indexable && !hasSidecar) {
        missing.push(id)
        fixesPut.push({ recordId: id, record, version: env._v })
      } else if (indexable && hasSidecar && !valuesMatch(stored, live)) {
        // Side-car body drifted from live value (e.g. partial write
        // after an update). Rewrite so lookups agree with reality.
        missing.push(id)
        fixesPut.push({ recordId: id, record, version: env._v })
      } else if (!indexable && hasSidecar) {
        // Record exists but its value is no longer indexable (null/
        // undefined). The side-car is stale.
        stale.push(sidecarIds.get(id)!)
      }
      sidecarIds.delete(id)
    }
    // Any side-car whose canonical record vanished is stale.
    for (const [, idxId] of sidecarIds) stale.push(idxId)

    let applied = 0
    if (!dryRun) {
      for (const idxId of stale) {
        try {
          await this.adapter.delete(this.vault, this.name, idxId)
          applied++
        } catch { /* ignore — next reconcile picks it up */ }
      }
      for (const fix of fixesPut) {
        await this.maintainPersistedIndexesOnPut(fix.recordId, fix.record, null, fix.version)
        applied++
      }
      // In-memory mirror is authoritative for query dispatch — make
      // sure it matches what's on disk now.
      persisted.clear()
      this.persistedIndexesLoaded = false
      await this.ensurePersistedIndexesLoaded()
    }

    return { field, missing, stale, applied }
  }

  /**
   * Get the in-memory index store. Used by `Query` to short-circuit
   * `==` and `in` lookups when an index covers the where clause.
   *
   * Returns `null` if no indexes are declared on this collection.
   */
  getIndexes(): CollectionIndexes | null {
    const eager = this.indexes
    return eager && eager.fields().length > 0 ? eager : null
  }

  /**
   * Return a `BlobSet` for the given record id.
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
    // tree-shake refactor: delegate to `blobStrategy`. The default
    // is `NO_BLOBS` (throws with a message pointing at the `@noy-db/hub/blobs`
    // subpath). Users who want blob storage pass `blobs()` from that
    // subpath into `createNoydb({ blobStrategy: blobs() })`, which
    // threads the active strategy through Vault → Collection.
    return this.blobStrategy.openSlot({
      store: this.adapter,
      vault: this.vault,
      collection: this.name,
      recordId: id,
      getDEK: this.getDEK,
      encrypted: this.encrypted,
      userId: this.keyring.userId,
      erasableBlobs: this.perRecordCek,
      debugPlaintext: this.keyring.debugPlaintext === true,
      ...(this.objectStore !== undefined ? { objectStore: this.objectStore } : {}),
      ...(this.blobFields !== undefined ? { blobFields: this.blobFields } : {}),
    })
  }

  /** Get all records as encrypted envelopes (for dump). */
  async dumpEnvelopes(): Promise<Record<string, EncryptedEnvelope>> {
    await this.ensureHydrated()
    const result: Record<string, EncryptedEnvelope> = {}
    for (const [id, entry] of this.cache) {
      // Reuse the record's stable CEK on a `perRecordKeys` collection so the
      // dumped envelope matches the stored format and stays in the same key
      // chain. `undefined` → legacy path.
      const cek = this.perRecordCek ? await this.resolveRecordCek(id) : undefined
      result[id] = await this.encryptRecord(entry.record, entry.version, cek)
    }
    return result
  }

  /**
   * Apply locale resolution to a record.
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
    const hasMoney = this.moneyFields && Object.keys(this.moneyFields).length > 0
    if (!hasI18n && !hasDict && !hasMoney) return record

    const locale = localeOpts?.locale ?? this.defaultLocale

    let result = record as unknown as Record<string, unknown>

    // Money decode runs regardless of locale (stored int → decimal string);
    // virtuals are gated on `locale !== 'raw'` inside decodeMoneyFields.
    if (hasMoney && this.moneyFields) {
      result = decodeMoneyFields(result, this.moneyFields, typeof locale === 'string' ? locale : undefined)
    }

    // i18nText / dictKey resolution require an active locale — EXCEPT a
    // static dict declaring a `displayLocale`, which resolves its
    // `<field>Label` even under a locale-less read (the #291 hybrid hinge).
    // The first early-return (above, `!hasI18n && !hasDict && !hasMoney`) is
    // UNCHANGED; only this second return relaxes, and ONLY for static-display
    // fields — folding `hasI18n` in here would let an i18nText-only
    // collection fall through to applyI18nLocale(…, undefined) on a
    // locale-less read, breaking the raw-{th,en}-map invariant.
    const hasStaticDisplay =
      hasDict &&
      this.dictKeyFields !== undefined &&
      Object.values(this.dictKeyFields).some(
        (d) => isStaticDictDescriptor(d) && d.displayLocale !== undefined,
      )
    // #435 — strip the internal densify marker even when no locale is active
    // (applyI18nLocale, which normally strips it, is skipped on this path).
    // Non-mutating: never touches the cached/stored record object.
    if (!locale && !hasStaticDisplay) return stripI18nFilled(result) as T

    // 1. i18nText resolution — guarded on `locale`, because the relaxed gate
    // above can now be entered with `locale === undefined` (static-display).
    // The layer (`'read'` by default; `'guard'`/`'derivation'` when read
    // through a layer-tagged facade, #285) selects the field's per-layer
    // `onMissing` policy inside applyI18nLocale.
    const layer = localeOpts?._layer ?? 'read'
    if (locale && hasI18n && this.i18nFields) {
      result = this.i18nStrategy.applyI18nLocale(result, this.i18nFields, locale, localeOpts?.fallback, layer)
    }

    // 2. dictKey / staticDict label resolution
    if (hasDict && this.dictKeyFields && this.dictLabelResolver && locale !== 'raw') {
      const withLabels = { ...result }
      const resolver = this.dictLabelResolver
      for (const [field, desc] of Object.entries(this.dictKeyFields)) {
        // dictKey default policy is 'null' (omit/null on miss) — today's
        // behavior — unless the field declares onMissing. 'substitute'
        // walks the declared substitute chain (passed as the resolver's
        // fallback); 'throw' raises LocaleNotSpecifiedError.
        const policy = desc.onMissing ? resolvePolicy(desc.onMissing, layer) : 'null'
        const fallback =
          policy === 'substitute'
            ? (localeOpts?.fallback ?? desc.substitute)
            : localeOpts?.fallback
        // Per-field effective locale: a static dict falls back to its
        // `displayLocale` when no locale is active (the #291 hybrid hinge);
        // a plain dictKey with no displayLocale gets `undefined` → its
        // <field>Label is omitted on a locale-less read (today's behavior).
        const effLocale =
          locale ??
          (isStaticDictDescriptor(desc) ? desc.displayLocale : undefined)
        // Resolve one key → label | null, honoring the policy. With no
        // effective locale there is nothing to resolve against.
        const resolveKey = async (key: string): Promise<string | null> => {
          if (!effLocale) {
            if (policy === 'throw') {
              throw new LocaleNotSpecifiedError(
                field,
                `dictKey "${field}": no locale active to resolve key "${key}".`,
              )
            }
            return null
          }
          const label = await resolver(desc.name, key, effLocale, fallback)
          if (label === undefined) {
            if (policy === 'throw') {
              throw new LocaleNotSpecifiedError(
                field,
                `dictKey "${field}": no label for key "${key}" in locale "${effLocale}".`,
              )
            }
            return null
          }
          return label
        }

        if (field.includes('[].')) {
          // Wildcard path `arrayKey[].leaf` (#282): add a per-element
          // sibling `<leaf>Label`. Single level + simple leaf.
          const parts = field.split('[].')
          const arrayKey = parts[0]!
          const leaf = parts[1]
          if (!leaf || leaf.includes('.')) continue
          const arr = (withLabels as Record<string, unknown>)[arrayKey]
          if (!Array.isArray(arr)) continue
          const labelKey = `${leaf}Label`
          ;(withLabels as Record<string, unknown>)[arrayKey] = await Promise.all(
            arr.map(async (el) => {
              if (!el || typeof el !== 'object' || Array.isArray(el)) return el
              const k = (el as Record<string, unknown>)[leaf]
              if (typeof k !== 'string') return el
              return { ...(el as Record<string, unknown>), [labelKey]: await resolveKey(k) }
            }),
          )
          continue
        }

        const val = result[field]
        if (Array.isArray(val)) {
          // Array-of-keys → [{ key, label }] pair objects (key preserved).
          withLabels[`${field}Label`] = await Promise.all(
            val.map(async (k) => ({
              key: k,
              label: typeof k === 'string' ? await resolveKey(k) : null,
            })),
          )
        } else if (typeof val === 'string') {
          const label = await resolveKey(val)
          // Scalar under 'null'/default omits the label key (today's
          // behavior); 'substitute' returns a value; 'throw' threw above.
          if (label !== null) withLabels[`${field}Label`] = label
        }
      }
      result = withLabels
    }

    // #435 — final guard: the locale-less static-display path skips
    // applyI18nLocale's strip, so ensure the densify marker never leaks here
    // either. Non-mutating (no-op when absent or already stripped above).
    return stripI18nFilled(result) as T
  }

  /**
   * Low-level: encrypt a pre-serialised JSON string into an EncryptedEnvelope.
   * Used by both the normal record path and the CRDT path (which serialises
   * a CrdtState rather than a T).
   */
  /**
   * Write / update / delete the `_idx/<field>/<recordId>` side-cars for
   * every declared persistence-index field on this collection after a
   * successful main-record `put()`.
   *
   * Timing: called AFTER `adapter.put()` of the main record succeeds, so
   * a failed main write never leaves a stale index entry. Side-car write
   * failures do NOT fail the overall `put()` — the main record is already
   * durably committed. Per-field failures surface as
   * `IndexWriteFailureError` on the emitter's `index:write-partial`
   * channel and the operator runs a reconcile pass later.
   *
   * Null/undefined field values are not indexed — matches the
   * `PersistedCollectionIndex.stringifyKey` contract. If the prior value
   * was non-null and the new value is null, the side-car is deleted.
   */
  private async maintainPersistedIndexesOnPut(
    id: string,
    newRecord: T,
    previousRecord: T | null,
    version: number,
  ): Promise<void> {
    const persisted = this.persistedIndexes
    if (!persisted) return
    const defs = persisted.definitions()
    if (defs.length === 0) return

    const newRec = newRecord as unknown as Record<string, unknown>
    const prevRec = previousRecord as unknown as Record<string, unknown> | null

    for (const def of defs) {
      const newValue = extractIndexValue(newRec, def)
      const previousValue = prevRec ? extractIndexValue(prevRec, def) : null

      // Update the in-memory mirror first — it's the authoritative source
      // for query dispatch. If the adapter write below fails, the mirror
      // still reflects intended state; the reconciler compares mirror
      // against side-cars on next run.
      persisted.upsert(id, def.key, newValue, previousValue)

      const idxId = encodeIdxId(def.key, id)
      try {
        if (newValue === null || newValue === undefined) {
          // Clear any pre-existing side-car for this (field, record).
          if (previousValue !== null && previousValue !== undefined) {
            await this.adapter.delete(this.vault, this.name, idxId)
          }
        } else {
          const body = JSON.stringify({
            field: def.key,
            value: serializeIndexValue(newValue),
            recordId: id,
            writtenAt: new Date().toISOString(),
          })
          const envelope = await this.encryptJsonString(body, version)
          await this.adapter.put(this.vault, this.name, idxId, envelope)
        }
      } catch (cause) {
        this.emitter.emit('index:write-partial', {
          vault: this.vault,
          collection: this.name,
          id,
          action: 'put',
          error: new IndexWriteFailureError({ recordId: id, field: def.key, op: 'put', cause }),
        })
      }
    }
  }

  /**
   * Tear down `_idx/<field>/<recordId>` side-cars for a deleted record.
   * Mirror state updates regardless of adapter outcome; adapter failures
   * surface on `index:write-partial` the same way put does.
   */
  private async maintainPersistedIndexesOnDelete(id: string, previousRecord: T): Promise<void> {
    const persisted = this.persistedIndexes
    if (!persisted) return
    const defs = persisted.definitions()
    if (defs.length === 0) return

    const prevRec = previousRecord as unknown as Record<string, unknown>
    for (const def of defs) {
      const previousValue = extractIndexValue(prevRec, def)
      if (previousValue !== null && previousValue !== undefined) {
        persisted.remove(id, def.key, previousValue)
      }

      const idxId = encodeIdxId(def.key, id)
      try {
        await this.adapter.delete(this.vault, this.name, idxId)
      } catch (cause) {
        this.emitter.emit('index:write-partial', {
          vault: this.vault,
          collection: this.name,
          id,
          action: 'delete',
          error: new IndexWriteFailureError({ recordId: id, field: def.key, op: 'delete', cause }),
        })
      }
    }
  }

  /**
   * @internal — hard-delete this record's persisted `_idx/<field>/<recordId>`
   * side-cars for the erasure path (#401). `forget()` crypto-shreds the body but
   * keeps the collection DEK, under which these side-cars are encrypted — so
   * without this they leave the indexed field VALUES readable after a "forget".
   *
   * Content-free: the side-car id is `encodeIdxId(def.key, id)`, so it needs no
   * body decode (the body is being shredded). Eager mode has no durable side-car
   * → no-op. The in-memory mirror is left as-is: it is ephemeral (rebuilt from
   * the now-deleted side-cars on reopen) and live reads skip the tombstone, so a
   * stale mirror hit cannot surface the erased record. Returns the count deleted
   * + the `def.key`s whose delete FAILED (residue that still leaks the value).
   */
  async _purgePersistedIndexes(id: string): Promise<{ purged: number; residue: string[] }> {
    const persisted = this.persistedIndexes
    if (!persisted) return { purged: 0, residue: [] }
    let purged = 0
    const residue: string[] = []
    for (const def of persisted.definitions()) {
      try {
        await this.adapter.delete(this.vault, this.name, encodeIdxId(def.key, id))
        purged++
      } catch {
        residue.push(def.key)
      }
    }
    return { purged, residue }
  }

  /** #308 L2 — drop a record's encrypted _vec sidecar on erasure (a vector is text-invertible).
   *  Called by vault.ts forget() inside a resilient try/catch; residue is reported in ForgetResult. */
  async _purgeVector(id: string): Promise<void> {
    await this.adapter.delete(this.vault, '_vec', id)
    this.vectorSet?.markDirty()
  }

  /** #308 L1.5 — drop the persisted lexical-index blob (forget/erasure): an opaque
   *  all-records index must not survive crypto-shred. Idempotent; no-op without persist. */
  async _purgeSearchIndex(): Promise<void> {
    const store = this.searchIndexStore
    if (store && 'removePersisted' in store) await (store as { removePersisted(): Promise<void> }).removePersisted()
    else store?.markDirty()
  }

  /**
   * Bulk-load the persisted-index mirror from `_idx/<field>/*` side-cars
   * on first lazy-mode query. Idempotent — subsequent calls short-circuit
   * on the `persistedIndexesLoaded` flag.
   *
   * Listing the whole id namespace is acceptable here because the caller
   * has already decided to pay a first-query cost (this is the indexed
   * equivalent of lazy-mode hydration, not a per-query scan).
   */
  private async ensurePersistedIndexesLoaded(): Promise<void> {
    if (this.persistedIndexesLoaded) return
    const persisted = this.persistedIndexes
    if (!persisted || persisted.fields().length === 0) {
      this.persistedIndexesLoaded = true
      return
    }

    const ids = await this.adapter.list(this.vault, this.name)
    const byField = new Map<string, Array<{ recordId: string; value: unknown }>>()
    for (const id of ids) {
      const decoded = decodeIdxId(id)
      if (!decoded) continue
      if (!persisted.has(decoded.field)) continue
      const envelope = await this.adapter.get(this.vault, this.name, id)
      if (!envelope) continue
      try {
        const json = await this.decryptJsonString(envelope)
        if (json === null) continue // tombstone side-car — skip
        const body = JSON.parse(json) as { value: unknown; recordId: string }
        if (typeof body.recordId !== 'string') continue
        const rows = byField.get(decoded.field) ?? []
        rows.push({ recordId: body.recordId, value: body.value })
        byField.set(decoded.field, rows)
      } catch {
        // Skip unreadable side-cars — the reconciler picks them up later.
      }
    }
    for (const [field, rows] of byField) {
      persisted.ingest(field, rows)
    }
    this.persistedIndexesLoaded = true

    // auto-reconcile on first query. The mirror is now
    // populated from whatever side-cars existed; reconcileIndex will
    // diff that against the canonical records and repair (or just
    // report) drift per-field. Skip on the inner reload triggered by
    // reconcileIndex itself — see `autoReconciling` guard.
    if (this.reconcileOnOpen !== 'off' && !this.autoReconciling) {
      await this.autoReconcile()
    }
  }

  /**
   * Walk every declared persisted-index field, run `reconcileIndex`
   * per the configured policy, and emit `index:reconciled` for each.
   * Called internally by `ensurePersistedIndexesLoaded()` — exposed as
   * a private helper for readability, not as a public API (the public
   * entry points are `reconcileIndex` and `rebuildIndexes`).
   */
  private async autoReconcile(): Promise<void> {
    const persisted = this.persistedIndexes
    if (!persisted) return
    this.autoReconciling = true
    try {
      const dryRun = this.reconcileOnOpen === 'dry-run'
      for (const def of persisted.definitions()) {
        try {
          const report = await this.reconcileIndex(def.key, { dryRun })
          this.emitter.emit('index:reconciled', {
            vault: this.vault,
            collection: this.name,
            field: def.key,
            missing: report.missing,
            stale: report.stale,
            applied: report.applied,
            skipped: false,
          })
        } catch {
          // Tolerate a single field's failure — a broken reconcile
          // shouldn't prevent the rest of the collection from
          // working. The `index:write-partial` channel captures
          // per-field failures during put/delete; this is its
          // sibling for the reconcile path.
        }
      }
    } finally {
      this.autoReconciling = false
    }
  }

  /**
   * Construct a `LazyQuery<T>` bound to this collection. Used by the
   * lazy-mode branch of `query()` and kept private because callers should
   * always go through `query()` to pick up the eager/lazy dispatch.
   */
  /**
   * Build a chainable indexed-read query against a lazy-mode collection.
   *
   * Companion to `query()`, which is eager-mode only and materialises a
   * snapshot. `lazyQuery()` dispatches every read through the persisted
   * index side-cars — no bulk decrypt, no snapshot. Every field touched by
   * `.where(...)` or `.orderBy(...)` MUST be declared in `indexes`;
   * otherwise `.toArray()` throws `IndexRequiredError`.
   *
   * The returned builder is always Promise-returning on its terminals
   * (`toArray`, `first`, `count`) because candidate records are decrypted
   * from the adapter on demand.
   *
   * @example
   * ```ts
   * const disbursements = vault.collection<Disbursement>('disbursements', {
   *   prefetch: false,
   *   cache: { maxRecords: 1000 },
   *   indexes: ['clientId', 'period'],
   * })
   * const rows = await disbursements.lazyQuery()
   *   .where('clientId', '==', 'c-42')
   *   .orderBy('period', 'desc')
   *   .limit(50)
   *   .toArray()
   * ```
   *
   * Throws at call time when the collection is in eager mode — use
   * `query()` there. Throws if no index is declared, because a lazy
   * query with no index would need to enumerate the whole collection.
   */
  lazyQuery(): LazyQuery<T> {
    if (!this.lazy) {
      throw new Error(
        `Collection "${this.name}": lazyQuery() is only available in lazy mode ` +
        `(prefetch: false). Use collection.query() for eager-mode chainable reads.`,
      )
    }
    const persisted = this.persistedIndexes
    if (!persisted) {
      throw new Error(
        `Collection "${this.name}": lazyQuery() requires indexing to be enabled. ` +
        `Pass \`withIndexing()\` from "@noy-db/hub/indexing" to ` +
        `\`createNoydb({ indexStrategy: withIndexing() })\`.`,
      )
    }
    if (persisted.fields().length === 0) {
      throw new Error(
        `Collection "${this.name}": lazyQuery() requires at least one field declared ` +
        `in \`indexes\`. Declare the fields you'll filter or sort by, or use ` +
        `collection.scan({ pageSize }) for non-indexed iteration.`,
      )
    }
    const source: LazyQuerySource<T> = {
      collectionName: this.name,
      persistedIndexes: persisted,
      ensurePersistedIndexesLoaded: () => this.ensurePersistedIndexesLoaded(),
      getRecord: (id: string) => this.get(id),
    }
    return new LazyQuery<T>(source)
  }

  /**
   * Resolve the stable CEK for a record on the WRITE path — see
   * {@link resolveStableCek}. Thin delegate that supplies the collection's
   * CEK cache, live-envelope reader, and DEK resolver.
   */
  private resolveRecordCek(id: string): Promise<CryptoKey> {
    return resolveStableCek(
      {
        cache: this.cekCache,
        getLive: (rid) => this.adapter.get(this.vault, this.name, rid),
        getDEK: () => this.getDEK(this.name),
      },
      id,
    )
  }

  /**
   * Encrypt a JSON body into an envelope.
   *
   * When `cek` is supplied (per-record CEK collections), the body is
   * encrypted under the CEK and the CEK is AES-KW-wrapped under the
   * collection DEK and stamped on `_cek`. When `cek` is omitted, the legacy
   * path encrypts the body directly under the collection DEK — byte-identical
   * to pre-CEK behaviour, so non-adopting collections pay nothing.
   */
  /**
   * Build a debug-plaintext envelope: the record's own fields inlined as
   * top-level keys beside the reserved `_`-metadata, with `_debug: 1` and an
   * empty `_data`. Lets native store tooling read the record without
   * unwrapping. Only reached for user collections under `debugPlaintext`
   * (see {@link encryptRecord}). Rejects `_`-prefixed record fields, which
   * would collide with the reserved metadata namespace.
   */
  private buildDebugEnvelope(record: T, version: number, source?: string, sourceTs?: string): EncryptedEnvelope {
    const rec = record as unknown as Record<string, unknown>
    for (const key of Object.keys(rec)) {
      if (key.startsWith('_')) throw new DebugReservedFieldError(this.name, key)
    }
    return {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: version,
      _ts: new Date().toISOString(),
      _iv: '',
      _data: '',
      _by: this.keyring.userId,
      _debug: NOYDB_FORMAT_VERSION,
      ...(this.provenance && source !== undefined ? { _source: source, _sourceTs: sourceTs ?? new Date().toISOString() } : {}),
      ...rec,
    } as unknown as EncryptedEnvelope
  }

  private async encryptJsonString(
    json: string,
    version: number,
    cek?: CryptoKey,
    source?: string,
    sourceTs?: string,
  ): Promise<EncryptedEnvelope> {
    const by = this.keyring.userId
    const provenanceFields = this.provenance && source !== undefined
      ? { _source: source, _sourceTs: sourceTs ?? new Date().toISOString() }
      : {}

    if (!this.encrypted) {
      return {
        _noydb: NOYDB_FORMAT_VERSION,
        _v: version,
        _ts: new Date().toISOString(),
        _iv: '',
        _data: json,
        _by: by,
        ...provenanceFields,
      }
    }

    const dek = await this.getDEK(this.name)

    if (cek !== undefined) {
      const { iv, data } = await encrypt(json, cek)
      const wrapped = await wrapCek(cek, dek)
      return {
        _noydb: NOYDB_FORMAT_VERSION,
        _v: version,
        _ts: new Date().toISOString(),
        _iv: iv,
        _data: data,
        _by: by,
        _cek: wrapped,
        ...provenanceFields,
      }
    }

    const { iv, data } = await encrypt(json, dek)

    return {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: version,
      _ts: new Date().toISOString(),
      _iv: iv,
      _data: data,
      _by: by,
      ...provenanceFields,
    }
  }

  private async encryptRecord(
    record: T,
    version: number,
    cek?: CryptoKey,
    source?: string,
    sourceTs?: string,
  ): Promise<EncryptedEnvelope> {
    // Debug-plaintext: write user-collection records with their fields inlined
    // beside the envelope metadata so native store tools read them directly.
    // Internal (`_`-prefixed) collections keep the classic shape — some store
    // `_`-prefixed fields that the inline layout would collide with.
    if (!this.encrypted && this.keyring.debugPlaintext === true && !this.name.startsWith('_')) {
      return this.buildDebugEnvelope(record, version, source, sourceTs)
    }
    const base = await this.encryptJsonString(JSON.stringify(record), version, cek, source, sourceTs)
    if (!this.deterministicFields || !this.encrypted) return base

    // compute deterministic-ciphertext slots for every
    // declared field. Non-primitive values are JSON-stringified so
    // objects/arrays still dedupe on structural equality.
    const dek = await this.getDEK(this.name)
    const rec = record as unknown as Record<string, unknown>
    const det: Record<string, string> = {}
    for (const field of this.deterministicFields) {
      const value = rec[field]
      if (value === undefined || value === null) continue
      const plaintext = typeof value === 'string' ? value : JSON.stringify(value)
      const { iv, data } = await encryptDeterministic(plaintext, dek, `${this.name}/${field}`)
      det[field] = `${iv}:${data}`
    }
    if (Object.keys(det).length === 0) return base
    return { ...base, _det: det }
  }

  /**
   * find the first record whose deterministic field matches
   * the given plaintext. Returns `null` when no match exists.
   *
   * Reads every envelope via the adapter and compares the stored
   * `_det[field]` to a freshly computed deterministic ciphertext — no
   * record bodies are decrypted during the search, which is the whole
   * point of a deterministic index.
   *
   * Throws when the field is not declared in `deterministicFields`, so a
   * typo fails loudly at the call site rather than silently returning
   * null forever.
   */
  async findByDet(field: string, value: unknown): Promise<T | null> {
    if (!this.deterministicFields || !this.deterministicFields.has(field)) {
      throw new Error(
        `Collection "${this.name}": field "${field}" is not declared in deterministicFields`,
      )
    }
    if (!this.encrypted) {
      throw new Error(
        `Collection "${this.name}": findByDet is only meaningful on encrypted collections`,
      )
    }
    const dek = await this.getDEK(this.name)
    const plaintext = typeof value === 'string' ? value : JSON.stringify(value)
    const { iv, data } = await encryptDeterministic(plaintext, dek, `${this.name}/${field}`)
    const target = `${iv}:${data}`

    const ids = await this.adapter.list(this.vault, this.name)
    for (const id of ids) {
      const env = await this.adapter.get(this.vault, this.name, id)
      if (!env || !env._det) continue
      if (env._det[field] === target) {
        return this.decryptRecord(env)
      }
    }
    return null
  }

  /**
   * return every record whose deterministic field matches.
   * Same semantics as {@link findByDet} but without the short-circuit.
   */
  async queryByDet(field: string, value: unknown): Promise<T[]> {
    if (!this.deterministicFields || !this.deterministicFields.has(field)) {
      throw new Error(
        `Collection "${this.name}": field "${field}" is not declared in deterministicFields`,
      )
    }
    if (!this.encrypted) {
      throw new Error(
        `Collection "${this.name}": queryByDet is only meaningful on encrypted collections`,
      )
    }
    const dek = await this.getDEK(this.name)
    const plaintext = typeof value === 'string' ? value : JSON.stringify(value)
    const { iv, data } = await encryptDeterministic(plaintext, dek, `${this.name}/${field}`)
    const target = `${iv}:${data}`

    const ids = await this.adapter.list(this.vault, this.name)
    const matches: T[] = []
    for (const id of ids) {
      const env = await this.adapter.get(this.vault, this.name, id)
      if (!env || !env._det) continue
      if (env._det[field] === target) {
        const rec = await this.decryptRecord(env)
        if (rec !== null) matches.push(rec) // skip tombstone (defensive)
      }
    }
    return matches
  }

  // ─── Hierarchical Access ──────────────────────────

  private assertTiersEnabled(): void {
    if (!this.tiers) {
      throw new Error(
        `Collection "${this.name}": hierarchical tiers are not enabled. ` +
        `Pass { tiers: [0, 1, 2, …] } to vault.collection() to opt in.`,
      )
    }
  }

  private assertDeclaredTier(tier: number): void {
    if (tier < 0 || !Number.isInteger(tier)) {
      throw new Error(`Collection "${this.name}": tier must be a non-negative integer, got ${tier}`)
    }
    if (tier === 0) return
    if (!this.tiers || !this.tiers.has(tier)) {
      throw new Error(
        `Collection "${this.name}": tier ${tier} is not declared in { tiers: [...] }`,
      )
    }
  }

  /**
   * tier-aware put. Encrypts the record with the
   * collection's tier-N DEK and stamps `_tier: N` on the envelope. The
   * caller's keyring must hold the tier-N DEK (directly, by
   * delegation, or by virtue of being the grantor); otherwise throws
   * `TierNotGrantedError`.
   *
   * accepts an optional `elevation` context. When
   * present, the emitted cross-tier event is stamped with
   * `authorization: 'elevation'`, the elevation's reason, and the
   * caller's pre-elevation tier. `vault.elevate(...).collection().put`
   * threads this through; direct `putAtTier` calls leave it undefined
   * and fall back to the inherent-write event shape.
   */
  async putAtTier(
    id: string,
    record: T,
    tier: number,
    opts?: { elevation?: { reason: string; fromTier: number }; source?: string; sourceTs?: string },
  ): Promise<void> {
    this.assertTiersEnabled()
    this.assertDeclaredTier(tier)
    assertTierAccess(this.keyring, this.name, tier)

    const key = dekKey(this.name, tier)
    const dek = await this.getDEK(key)

    const existing = await this.adapter.get(this.vault, this.name, id)
    const version = existing ? existing._v + 1 : 1
    const json = JSON.stringify(record)
    const { iv, data } = await encrypt(json, dek)
    const envelope: EncryptedEnvelope = {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: version,
      _ts: new Date().toISOString(),
      _iv: iv,
      _data: data,
      _by: this.keyring.userId,
      ...(tier > 0 && { _tier: tier }),
      ...(this.provenance && opts?.source !== undefined ? { _source: opts.source, _sourceTs: opts.sourceTs ?? new Date().toISOString() } : {}),
    }

    await this.adapter.put(this.vault, this.name, id, envelope)

    if (tier > 0) {
      this.emitCrossTierEvent({
        actor: this.keyring.userId,
        collection: this.name,
        id,
        tier,
        authorization: opts?.elevation ? 'elevation' : 'inherent',
        op: 'put',
        ts: envelope._ts,
        ...(opts?.elevation && {
          reason: opts.elevation.reason,
          elevatedFrom: opts.elevation.fromTier,
        }),
      })
    }
  }

  /**
   * tier-aware get. When the stored record is at a
   * tier the caller cannot decrypt:
   *   - `'invisibility'` mode (default) → returns `null`.
   *   - `'ghost'` mode → returns a `GhostRecord` placeholder with the
   *     tier and the record id (the record exists but contents are
   *     withheld).
   *
   * Fully-cleared reads return the plaintext record and fire a
   * cross-tier event when `_tier > 0`.
   */
  async getAtTier(id: string): Promise<T | GhostRecord | null> {
    this.assertTiersEnabled()
    const envelope = await this.adapter.get(this.vault, this.name, id)
    if (!envelope) return null
    const tier = envelope._tier ?? 0
    if (tier === 0) {
      return this.decryptRecord(envelope)
    }

    const key = dekKey(this.name, tier)
    if (!this.keyring.deks.has(key)) {
      if (this.tierMode === 'ghost') {
        return { _ghost: true, _tier: tier } as GhostRecord
      }
      return null
    }

    const dek = await this.getDEK(key)
    // A tiered record may carry a per-record CEK (e.g. a CEK record
    // elevated via `elevate()`): the CEK is wrapped under the TIER DEK, so
    // unwrap under the tier DEK then decrypt the body under the CEK. Legacy
    // tiered records decrypt directly under the tier DEK.
    let plaintext: string
    if (envelope._cek !== undefined) {
      const cek = await unwrapCek(envelope._cek, dek)
      this.cekCache?.set(id, cek, 1)
      plaintext = await decrypt(envelope._iv, envelope._data, cek)
    } else {
      plaintext = await decrypt(envelope._iv, envelope._data, dek)
    }
    const record = JSON.parse(plaintext) as T

    this.emitCrossTierEvent({
      actor: this.keyring.userId,
      collection: this.name,
      id,
      tier,
      authorization: this.isElevatorOrOwner() ? 'inherent' : 'delegation',
      op: 'get',
      ts: new Date().toISOString(),
    })

    return record
  }

  /**
   * list ids grouped by the caller's readability.
   * Returns only ids whose tier the caller can read. Above-tier ids
   * are omitted in `'invisibility'` mode and included (with tier
   * metadata) in `'ghost'` mode.
   */
  async listAtTier(): Promise<Array<{ id: string; tier: number; readable: boolean }>> {
    this.assertTiersEnabled()
    const ids = await this.adapter.list(this.vault, this.name)
    const out: Array<{ id: string; tier: number; readable: boolean }> = []
    for (const id of ids) {
      const env = await this.adapter.get(this.vault, this.name, id)
      if (!env) continue
      const tier = env._tier ?? 0
      const readable = tier === 0 || this.keyring.deks.has(dekKey(this.name, tier))
      if (!readable && this.tierMode === 'invisibility') continue
      out.push({ id, tier, readable })
    }
    return out
  }

  /**
   * elevate a record to a higher tier. Re-encrypts with
   * the target tier's DEK. The caller must hold DEKs for both the
   * current tier (to decrypt) and the target tier (to re-encrypt).
   * Stamps `_elevatedBy` with the caller id so `demote()` can check
   * the reverse operation.
   */
  async elevate(id: string, toTier: number): Promise<void> {
    this.assertTiersEnabled()
    this.assertDeclaredTier(toTier)
    assertTierAccess(this.keyring, this.name, toTier)

    const envelope = await this.adapter.get(this.vault, this.name, id)
    if (!envelope) throw new Error(`Record "${id}" not found in collection "${this.name}"`)
    const fromTier = envelope._tier ?? 0
    if (toTier === fromTier) return
    if (toTier < fromTier) {
      throw new Error(`Use demote() to lower the tier of "${id}" from ${fromTier} to ${toTier}`)
    }
    // Caller must have access at the existing tier to decrypt.
    if (fromTier > 0) assertTierAccess(this.keyring, this.name, fromTier)

    const fromKey = dekKey(this.name, fromTier)
    const toKey = dekKey(this.name, toTier)
    const fromDek = await this.getDEK(fromKey)
    const toDek = await this.getDEK(toKey)

    // Per-record CEK composes with tiers: the body key is unchanged (history
    // chain identity preserved); only the wrapping key moves with the tier.
    // Legacy (no `_cek`) records take the direct-DEK path unchanged.
    const now = new Date().toISOString()
    const body = await rewrapBodyToDek(envelope, fromDek, toDek)
    if (body.cek) this.cekCache?.set(id, body.cek, 1)
    const next: EncryptedEnvelope = {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: envelope._v + 1,
      _ts: now,
      _iv: body._iv,
      _data: body._data,
      _by: this.keyring.userId,
      _tier: toTier,
      _elevatedBy: this.keyring.userId,
      ...(body._cek !== undefined ? { _cek: body._cek } : {}),
    }
    await this.adapter.put(this.vault, this.name, id, next)

    this.emitCrossTierEvent({
      actor: this.keyring.userId,
      collection: this.name,
      id,
      tier: toTier,
      authorization: 'elevation',
      op: 'elevate',
      ts: now,
    })
  }

  /**
   * demote a record to a lower tier. Allowed only for
   * the user who performed the last elevation or an owner.
   */
  async demote(id: string, toTier: number): Promise<void> {
    this.assertTiersEnabled()
    if (toTier < 0) throw new Error(`Cannot demote to negative tier ${toTier}`)

    const envelope = await this.adapter.get(this.vault, this.name, id)
    if (!envelope) throw new Error(`Record "${id}" not found in collection "${this.name}"`)
    const fromTier = envelope._tier ?? 0
    if (toTier === fromTier) return
    if (toTier > fromTier) {
      throw new Error(`Use elevate() to raise the tier of "${id}" from ${fromTier} to ${toTier}`)
    }
    const isOwner = this.keyring.role === 'owner'
    const isOriginalElevator = envelope._elevatedBy === this.keyring.userId
    if (!isOwner && !isOriginalElevator) {
      throw new TierDemoteDeniedError(id, fromTier)
    }
    // Caller must still hold the DEK of the current tier to decrypt.
    assertTierAccess(this.keyring, this.name, fromTier)
    if (toTier > 0) this.assertDeclaredTier(toTier)

    const fromDek = await this.getDEK(dekKey(this.name, fromTier))
    const toDek = await this.getDEK(dekKey(this.name, toTier))

    // CEK re-wrap on demote — same body key, moved from the source tier
    // DEK to the target tier DEK. Legacy records take the direct-DEK path.
    const now = new Date().toISOString()
    const body = await rewrapBodyToDek(envelope, fromDek, toDek)
    if (body.cek) this.cekCache?.set(id, body.cek, 1)
    const next: EncryptedEnvelope = {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: envelope._v + 1,
      _ts: now,
      _iv: body._iv,
      _data: body._data,
      _by: this.keyring.userId,
      ...(toTier > 0 && { _tier: toTier }),
      ...(body._cek !== undefined ? { _cek: body._cek } : {}),
    }
    await this.adapter.put(this.vault, this.name, id, next)

    this.emitCrossTierEvent({
      actor: this.keyring.userId,
      collection: this.name,
      id,
      tier: fromTier,
      authorization: 'elevation',
      op: 'demote',
      ts: now,
    })
  }

  private isElevatorOrOwner(): boolean {
    return this.keyring.role === 'owner' || this.keyring.role === 'admin'
  }

  private emitCrossTierEvent(event: CrossTierAccessEvent): void {
    try {
      this.onCrossTierAccess?.(event)
    } catch {
      // notification sink failures must never block a tier operation
    }
  }

  /**
   * Low-level: decrypt an envelope and return the raw JSON string.
   *
   * `_cek` presence is the format discriminant (NOT `this.perRecordCek`),
   * so a mixed vault — and a recipient that never opted into
   * `perRecordKeys` — decrypts both legacy and CEK records:
   *  - `_cek` present → unwrap the CEK under the collection DEK, decrypt the
   *    body under the CEK (cache the unwrapped CEK so repeated reads skip it).
   *  - `_cek` absent → legacy path, body decrypts directly under the
   *    collection DEK.
   *
   * The optional `id` lets reads populate the CEK cache; it is omitted by
   * callers (history, conflict merge) that have only the envelope.
   */
  private async decryptJsonString(envelope: EncryptedEnvelope, id?: string): Promise<string | null> {
    // RISK #1 (forget cascade): a shred tombstone carries `_data: ''` and no
    // `_cek`. Decrypting it would call `decrypt('', '', dek)` → AES-GCM
    // OperationError → TamperedError. Return null so every read callsite
    // treats it as "absent / skip", matching how get()/list already drop
    // tombstones. Legacy plaintext collections (`!this.encrypted`) legitimately
    // have empty `_iv`/`_data`, so `isTombstone` is false for them — preserved.
    if (isTombstone(envelope, this.encrypted)) return null
    if (!this.encrypted) {
      // Debug-plaintext layout: record fields were inlined as top-level keys
      // (see buildDebugEnvelope). Reconstruct the record from the non-`_`
      // keys. Self-describing via `_debug`, so a classic plaintext reader
      // handles debug-written envelopes too.
      if (envelope._debug !== undefined) {
        const rec: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(envelope)) {
          if (!key.startsWith('_')) rec[key] = value
        }
        return JSON.stringify(rec)
      }
      return envelope._data
    }
    const dek = await this.getDEK(this.name)
    if (envelope._cek !== undefined) {
      const cached = id !== undefined ? this.cekCache?.get(id) : undefined
      const cek = cached ?? (await unwrapCek(envelope._cek, dek))
      if (cached === undefined && id !== undefined) this.cekCache?.set(id, cek, 1)
      return decrypt(envelope._iv, envelope._data, cek)
    }
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
    opts: { skipValidation?: boolean; id?: string } = {},
  ): Promise<T | null> {
    const json = await this.decryptJsonString(envelope, opts.id)
    // Tombstone (shredded record) → null, propagated from decryptJsonString.
    // Callers skip null exactly as they already skip a tombstone envelope.
    if (json === null) return null
    let parsed: unknown = JSON.parse(json)

    // CRDT resolution: if this collection is in CRDT mode, the
    // stored JSON is a CrdtState, not T directly. Resolve to the snapshot.
    if (this.crdtMode && parsed !== null && typeof parsed === 'object' && '_crdt' in parsed) {
      parsed = this.crdtStrategy.resolveCrdtSnapshot(parsed as CrdtState)
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

/**
 * Read a field value from a plain record for persisted-index maintenance.
 * Supports dotted paths so declarations like `indexes: ['billing.clientId']`
 * work the same way `readPath` handles them for the eager-mode builder.
 */
function readPersistedValue(record: Record<string, unknown>, field: string): unknown {
  if (!field.includes('.')) return record[field]
  const segments = field.split('.')
  let cursor: unknown = record
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

/**
 * Canonicalize a typed value for storage inside the side-car body so it
 * round-trips through `JSON.parse` without losing fidelity. Dates are
 * serialised as ISO strings; everything else passes through.
 *
 * The in-memory mirror compares on the stringified bucket key, so the
 * exact storage form is not query-critical — this just protects the
 * reconciler, which compares the stored body against the
 * live record value and would otherwise mismatch on Date objects.
 */
function serializeIndexValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  return value
}

/**
 * Extract the indexable value for a declaration — a scalar for
 * single-field, or a tuple array for composite. Returns `null` when
 * the value is not indexable (single-field null/undefined, composite
 * with any null/undefined component — the whole composite is skipped
 * if any part is missing).
 */
function extractIndexValue(
  record: Record<string, unknown>,
  def: PersistedIndexDef,
): unknown {
  if (def.kind === 'single') {
    const v = readPersistedValue(record, def.field)
    return v === undefined || v === null ? null : v
  }
  const tuple: unknown[] = []
  for (const f of def.fields) {
    const v = readPersistedValue(record, f)
    if (v === undefined || v === null) return null
    tuple.push(v)
  }
  return tuple
}

/**
 * Compare the decrypted side-car body's `value` against the live record
 * field value, in the same canonical form used for storage. Handles the
 * Date-is-ISO-string round trip so reconcile doesn't flag a false drift.
 */
function valuesMatch(stored: unknown, live: unknown): boolean {
  const serialized = serializeIndexValue(live)
  if (stored === serialized) return true
  if (stored === undefined || serialized === undefined) return stored === serialized
  // JSON-stringify both sides for structural equality on arrays/objects.
  try {
    return JSON.stringify(stored) === JSON.stringify(serialized)
  } catch {
    return false
  }
}
