import type { NoydbStore, EncryptedEnvelope, ChangeEvent, HistoryConfig, HistoryOptions, HistoryEntry, PruneOptions, ListPageResult, LocaleReadOptions, CollectionConflictResolver, PutManyItemOptions, PutManyOptions, PutManyResult, DeleteManyResult, SealedView, VdigFieldPolicy, ClassifiedVerdict } from './types.js'
import type { FieldMeta } from '../with-shape/introspection/field-meta.js'
import type { CollectionMeta } from '../with-shape/introspection/meta.js'
import { resolveClassifiedFields, guardClassifiedCompat, type ClassifiedEntry, type ClassifiedFieldSpec, type ResolvedClassified, type ClassifiedGuardCtx, type ClassifiedStrategy, type ClassifiedVerifyCtx } from '../port/with/classified-strategy.js'
import type { CrdtMode, CrdtState, LwwMapState, RgaState } from '../with-commit/crdt/crdt.js'
import type { CrdtStrategy } from '../with-commit/crdt/strategy.js'
import type { I18nTextDescriptor, DictKeyDescriptor, StaticDictDescriptor, DictionaryHandle } from '../port/with/i18n-strategy.js'
import { isStaticDictDescriptor } from '../port/with/i18n-strategy.js'
import type { LookupDescriptor } from '../port/with/lookup-strategy.js'
import { ViaPipeline } from './via-pipeline.js'
import { viaBinder, type ViaDescriptor, type ViaWriteCtx, type ViaEraseReport } from './via.js'
import type { MutationOrigin } from './mutation.js'
import { putDerivedOutput, ledgerAuditHook, resolveRollupDeleteIntents, findRollupSpecForIntent, type WaveContext, type RollupOutcome, type RollupDeleteIntent } from './via-dispatch.js'
import type { ComputedFields } from '../with-formula/computed/index.js'
import {
  isTombstone,
  isDeleteMarker,
  buildTombstone,
  buildDeleteMarker,
  resolveStableCek,
  findByDet,
  queryByDet,
  RecordCodec,
  type DeterministicContext,
  type EnclaveKey,
  type SealedShredSlot,
} from './enclave/index.js'
import {
  classifySealedShred as classifySealedShredImpl,
  type TiersContext,
} from '../with-audit/tiers/index.js'
import type { TiersStrategy } from '../with-audit/tiers/strategy.js'
import {
  buildPersistedIndexCallbacks as buildPersistedIndexCallbacksImpl,
  type SearchContext,
} from '../with-lookup/search/collection-facade.js'
import type { SearchStrategy } from '../with-lookup/search/strategy.js'
import {
  rebuildEagerIndexesFromCache as rebuildEagerIndexesFromCacheImpl,
  rebuildUniqueConstraintsFromCache as rebuildUniqueConstraintsFromCacheImpl,
  rebuildIndexes as rebuildIndexesImpl,
  reconcileIndex as reconcileIndexImpl,
  maintainPersistedIndexesOnPut as maintainPersistedIndexesOnPutImpl,
  maintainPersistedIndexesOnDelete as maintainPersistedIndexesOnDeleteImpl,
  purgePersistedIndexes as purgePersistedIndexesImpl,
  type IndexingContext,
} from '../with-lookup/indexing/collection-facade.js'
import { ConflictError, ReadOnlyError, ClassifiedConfigError, ClassifiedRevealError, ClassifiedVerifyError } from './errors.js'
import type { GhostRecord, TierMode, CrossTierAccessEvent } from './types.js'
import type { UnlockedKeyring } from '../with-party/team/keyring.js'
import { hasWritePermission } from '../with-party/team/keyring.js'
import type { NoydbEventEmitter } from './events.js'
import type { WriteQueueTracker } from './write-queue.js'
import type { WriteHookRegistry, WriteEvent } from '../port/with/write-hooks.js'
import type { ServiceBus, GatePutEvent, GatePoint } from '../port/with/service-bus.js'
import type { SchemaUpdateGate } from '../with-shape/schema-update/gate.js'
import type { SchemaFenceController } from '../with-shape/schema-update/fence-controller.js'
import type { StandardSchemaV1 } from './schema.js'
import { validateSchemaInput } from './schema.js'
import { derivePersistedSchema } from '../with-shape/persisted-schemas/derive.js'
import type { LedgerStore } from '../with-commit/history/ledger/index.js'
import type { DiffEntry } from '../with-commit/history/diff.js'
import type { HistoryStrategy } from '../with-commit/history/strategy.js'
import { Query, ScanBuilder } from './query/index.js'
import type { QuerySource, JoinContext, JoinableSource } from './query/index.js'
import type { CollectionIndexes } from '../with-lookup/indexing/eager-indexes.js'
import { decodeIdxId } from '../with-lookup/indexing/persisted-indexes.js'
import type { PersistedCollectionIndex } from '../with-lookup/indexing/persisted-indexes.js'
import { LazyQuery } from '../with-lookup/indexing/lazy-builder.js'
import type { LazyQuerySource } from '../with-lookup/indexing/lazy-builder.js'
import { NO_INDEXING, type IndexState } from '../with-lookup/indexing/strategy.js'
import type { SearchOptions, SearchResult } from '../with-lookup/search/index.js'
import { MemoryIndexStore, type IndexStore } from '../with-lookup/search/index-store.js'
import { PersistedIndexStore } from '../with-lookup/search/persisted-index-store.js'
import type { RetrieveOptions, RetrieveHit } from '../with-lookup/search/retrieve-types.js'
import { DerivationCapExceededError } from './errors.js'
import type { VectorSet, EmbeddingDescriptor } from '../with-lookup/embeddings/index.js'
import { buildUniqueConstraintSet, type UniqueConstraintSet } from '../with-lookup/indexing/unique-constraints.js'
import type { RefDescriptor } from './refs.js'
import { buildDescription, deriveZodFields, type CollectionDescription, type DescribeOptions } from '../with-shape/introspection/describe.js'
import type { CollectionConfig } from '../with-shape/introspection/types.js'
import { estimateRecordBytes, type Lru, type LruStats } from './cache/index.js'
import { IMPLICIT_LAZY } from '../port/with/lazy-strategy.js'
import { generateULID } from '../with-pod/ulid.js'
import type { PresenceHandle, PresenceHandleOpts } from '../with-party/team/presence.js'
import type { SyncStrategy } from '../with-party/team/sync-strategy.js'
import type { BlobSet } from '../with-shape/blobs/blob-set.js'
import type { BlobStrategy } from '../port/with/blob-strategy.js'
import type { ObjectProjection } from '../with-shape/blobs/object-projection.js'
import type { BlobFieldsConfig } from '../with-shape/blobs/blob-compaction.js'
import type { AggregateStrategy } from '../with-lookup/aggregate/strategy.js'
import type { ReadOnlyVaultFacade } from '../with-audit/guards/types.js'
import type { DerivationRegistry } from '../with-formula/derivations/registry.js'
import type { TxContext, ExecutedOp } from '../with-commit/tx/transaction.js'
import { revertExecuted } from '../with-commit/tx/transaction.js'
// Type-only — runtime class loaded via dynamic import in
// `dispatchDerivations` when an eager-mode strategy fires. Keeps the
// derivation executor chunk out of the floor bundle.
import type { DerivationExecutor as DerivationExecutorType } from '../with-formula/derivations/executor.js'
import type {
  loadFanoutSidecar as LoadFanoutSidecarType,
  deleteFanoutSidecar as DeleteFanoutSidecarType,
  saveFanoutSidecar as SaveFanoutSidecarType,
} from '../with-formula/derivations/fanout-sidecar.js'
import { markStale, resolveStaleOnRead } from '../with-formula/derivations/stale.js'
import type { MaterializedViewRegistry } from '../with-formula/materialized-views/registry.js'
import type { MVQueryContext } from '../with-formula/materialized-views/types.js'
import type { MaterializedViewExecutor as MVExecutorType } from '../with-formula/materialized-views/executor.js'
import type * as MVStaleModule from '../with-formula/materialized-views/stale.js'
import { resolveCollectionConfig, type CollectionOpts } from './collection-config.js'
import { loadEvalComputedFields } from '../with-formula/computed/lazy.js'

/**
 * Callback for dirty tracking (sync engine integration). `action: 'revert'`
 * (spec #591) means "un-dirty" — the fan-out wiring in `noydb.ts` routes it
 * to `SyncEngine.removeDirty` instead of `trackChange`; `version` is unused
 * for that action.
 */
export type OnDirtyCallback = (collection: string, id: string, action: 'put' | 'delete' | 'revert', version: number) => Promise<void>

/**
 * Value-equality for a single self-write reverse-denorm field. Scalars
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
export class Collection<T, S extends keyof T = never, Q extends keyof T & string = never, M extends keyof T & string = never> {
  private readonly adapter: NoydbStore
  private readonly vault: string
  private readonly name: string
  private readonly keyring: UnlockedKeyring
  private readonly storeCiphertext: boolean
  private readonly ramCiphertext: boolean
  private readonly emitter: NoydbEventEmitter
  private readonly writeQueue: WriteQueueTracker | undefined
  private readonly schemaUpdateGate: SchemaUpdateGate | undefined
  private readonly schemaFence: SchemaFenceController | undefined
  private readonly writeHooks: WriteHookRegistry | undefined
  private readonly subsystemBus: ServiceBus | undefined
  private readonly activeTxId: (() => string | null) | undefined
  private readonly getDEK: (collectionName: string) => Promise<EnclaveKey>
  private readonly onDirty: OnDirtyCallback | undefined
  private readonly historyConfig: HistoryConfig
  /** True when the caller explicitly provided a `historyConfig` option (vs. inheriting the vault default). */
  private readonly historyConfigExplicit: boolean

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
  private readonly tiersStrategy: TiersStrategy
  private readonly searchStrategy: SearchStrategy
  private readonly historyStrategy: HistoryStrategy
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

  /** Field name → `I18nTextDescriptor` for `i18nText()` fields (`i18nFields` option); write/read
   *  runs through the compiled `via` i18n binding — this remains for `describe()`
   *  and the search-index build path. */
  private readonly i18nFields: Record<string, I18nTextDescriptor> | undefined

  /** The configured string fields exposed to `retrieve()`; `undefined` for ordinary collections (zero-cost). */
  private readonly textIndexes: readonly string[] | undefined

  /** Session-scoped lexical index store; `undefined` (zero-cost) unless `textIndexes` is non-empty. */
  private readonly searchIndexStore: IndexStore | undefined

  /** Embedding config for write-time vector derivation; `undefined` (zero-cost) for ordinary
   *  collections. When set, `put()` encodes the source field(s) and stores an encrypted `_vec` sidecar. */
  private readonly embeddings: EmbeddingDescriptor | undefined

  /** In-memory vector set, populated lazily from `_vec` sidecars; `undefined` when no embedding config is declared. */
  private vectorSet: VectorSet | undefined

  /** Field name → `DictKeyDescriptor` for `dictKey()` fields; used by `get()`/`list()` to add
   *  `<field>Label` virtual fields when a locale is requested. */
  private readonly dictKeyFields: Record<string, DictKeyDescriptor | StaticDictDescriptor> | undefined

  /** Field name → `LookupDescriptor` for native `lookup()`/`enumOf()`/`dict()` fields (#650 Task 2) — describe()-only in this task. */
  private readonly lookupFields: Record<string, LookupDescriptor> | undefined
  /** Sync join-dressing hook (#650 Task 6, #626 retirement) — `querySourceForJoin()`'s `presentForJoin`. */
  private readonly presentForJoin: ((record: unknown, locale: string) => unknown) | undefined

  /** Consumer-neutral per-field descriptors declared via `fieldMeta`; read by `getFieldMeta()`, merged by `describe()`. */
  private fieldMeta: Record<string, FieldMeta> | undefined

  /** Collection-level descriptive metadata declared via `meta`; read by `getMeta()`, surfaced in `describe()`. */
  private meta: CollectionMeta | undefined

  /** Outbound ref declarations (snapshot from vault refRegistry at construction time); used by `describe()`. */
  private readonly _refs: Record<string, RefDescriptor>

  /** Money field descriptors keyed by field path, typed as the opaque {@link ViaDescriptor} marker
   *  (the kernel never inspects the concrete shape); `put()` quantizes to a scaled-int string,
   *  `get()`/`list()` decode back. Mutable so {@link _applyMoneyFields} can attach. */
  private moneyFields: Record<string, ViaDescriptor> | undefined; private via: ViaPipeline | undefined // compiled Via pipeline (money, i18n); rebuilt by {@link _applyMoneyFields}

  /**
   * Computed scalar fields, evaluated first on every `put()`. Mutable for
   * the same MV-pre-creation reconcile as {@link moneyFields}.
   */
  private computed: ComputedFields | undefined

  /**
   * Resolved classified() sensitive-field descriptors, declared via the
   * `classifiedFields` collection option. Mutable so {@link _applyClassifiedFields}
   * can attach a declaration to a collection MV-analysis pre-created.
   */
  private classified: ResolvedClassified | undefined

  /**
   * Frozen construction-time facts the refusal matrix (R1-R5) checks against.
   * Stored so {@link _applyClassifiedFields} — door 2, the reconcile seam —
   * can re-run the SAME guard the config resolver ran at door 1 (C5's lesson:
   * crdt/conflictPolicy/perRecordKeys are construction-only but
   * classifiedFields can attach later).
   */
  private readonly classifiedGuardCtx: ClassifiedGuardCtx

  /**
   * Digest-only classified fields (`storage: 'digest-only'`), keyed by field
   * name — the enclave-consumable policy map the codec's write path carries
   * `_vdig` forward under (C6). `null` when the collection declares none.
   */
  private readonly vdigFields: ReadonlyMap<string, VdigFieldPolicy> | null

  /** C-A/R10 memoization: marker declared-set lookup (undefined=unresolved) + classified-handle persist-once flag. */
  private _markerDigestOnlyCache: readonly string[] | undefined = undefined
  private _markerPersisted = false

  /**
   * Tree-shake seam for `reveal()` — defaults to `NO_CLASSIFIED`, which
   * throws `ClassifiedNotEnabledError`. Set via the `classifiedStrategy`
   * `createNoydb()` option (opt in with `withClassified()`).
   */
  private readonly classifiedStrategy: ClassifiedStrategy

  /**
   * Async callback provided by the Vault to open a dynamic
   * dictionary handle (for label-map pre-computation in the search index).
   * Only used in `resolveDictLabelMaps()`; static dicts bypass this entirely.
   */
  private readonly getDictionary: ((name: string) => Promise<DictionaryHandle>) | undefined

  /**
   * declared deterministic fields. `null` when the feature
   * is inactive for this collection; a frozen `Set` otherwise.
   */
  private readonly deterministicFields: ReadonlySet<string> | null

  /**
   * Declared structural-group-encryption fields (`sensitive`). Each is
   * sealed into its own `_sealed[field]` slot under a per-field key and kept
   * out of the open `_data` blob. Empty set ⇒ feature off (byte-identical
   * output). See {@link encryptRecord} / {@link decryptRecord}.
   */
  private readonly sensitiveFields: ReadonlySet<string>

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
   * that don't need lineage tracking.
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
  private readonly cekCache: Lru<string, EnclaveKey> | null

  /**
   * The per-record envelope build + encrypt/decrypt + per-record-CEK +
   * sealed-field crypto, extracted off this god-object. Holds no mutable
   * state of its own — it shares this collection's `cekCache` reference (so
   * tier methods and `vault.invalidateRecordCaches` evictions stay visible to
   * it) and reads the rest of its dependencies as a frozen context snapshot.
   */
  private readonly codec: RecordCodec<T>

  /**
   * declared tiers for this collection. `null` when
   * tier-aware methods are disabled. Tier 0 is implicit and never
   * stored here.
   */
  private readonly tiers: ReadonlySet<number> | null
  private readonly tierMode: TierMode
  private readonly onCrossTierAccess: ((event: CrossTierAccessEvent) => void) | undefined

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
    | ((op: 'get' | 'put' | 'delete' | 'reveal' | 'verify' | 'find', id: string) => Promise<void>)
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

  /** #638 Task 4 — `Vault._collectGraphTouch`; a no-op absent an open batch. `collectDelete` (#640) is the sync-apply delete socket. */
  private readonly graphDispatch: { collect(collection: string, id: string): void; collectDelete(collection: string, id: string, intents: readonly RollupDeleteIntent[]): void } | undefined

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

  constructor(opts: CollectionOpts<T>) {
    const cfg = resolveCollectionConfig(opts)
    this.adapter = cfg.adapter
    this.vault = cfg.vault
    this.name = cfg.name
    this.keyring = cfg.keyring
    this.storeCiphertext = cfg.storeCiphertext
    this.ramCiphertext = cfg.ramCiphertext
    this.emitter = cfg.emitter
    this.writeQueue = cfg.writeQueue
    this.schemaUpdateGate = cfg.schemaUpdateGate
    this.schemaFence = cfg.schemaFence
    this.writeHooks = cfg.writeHooks
    this.subsystemBus = cfg.subsystemBus
    this.activeTxId = cfg.activeTxId
    this.blobStrategy = cfg.blobStrategy
    this.objectStore = cfg.objectStore
    this.blobFields = cfg.blobFields
    this.aggregateStrategy = cfg.aggregateStrategy
    this.crdtStrategy = cfg.crdtStrategy
    this.tiersStrategy = cfg.tiersStrategy
    this.searchStrategy = cfg.searchStrategy
    this.historyStrategy = cfg.historyStrategy
    this.syncStrategy = cfg.syncStrategy
    this.reconcileOnOpen = cfg.reconcileOnOpen
    this.getDEK = cfg.getDEK
    this.onDirty = cfg.onDirty
    this.historyConfig = cfg.historyConfig
    this.historyConfigExplicit = cfg.historyConfigExplicit
    this.schema = cfg.schema
    this.ledger = cfg.ledger
    this.refEnforcer = cfg.refEnforcer
    this.joinResolver = cfg.joinResolver
    this.i18nFields = cfg.i18nFields
    // Only spin up an index store when text fields are declared, so
    // ordinary collections pay nothing (the dirty poke + retrieve see undefined).
    this.textIndexes = cfg.textIndexes
    // `searchIndexStore` is `this`-dependent: the persisted-store callback thunk
    // closes over `this.searchContext()`. Built BEFORE `this.codec` exists — the
    // thunk is lazy (NOT evaluated here), so the A14 codec-after-this ordering holds.
    this.searchIndexStore =
      opts.textIndexes && opts.textIndexes.length > 0
        ? opts.textIndexPersist
          ? new PersistedIndexStore(buildPersistedIndexCallbacksImpl(() => this.searchContext()))
          : new MemoryIndexStore()
        : undefined
    this.embeddings = cfg.embeddings
    this.vectorSet = cfg.vectorSet
    this.dictKeyFields = cfg.dictKeyFields
    this.lookupFields = cfg.lookupFields
    this.presentForJoin = cfg.presentForJoin
    this.fieldMeta = cfg.fieldMeta
    this.meta = cfg.meta
    this._refs = cfg._refs
    this.moneyFields = cfg.moneyFields
    this.via = cfg.via
    this.classified = cfg.classified
    this.classifiedGuardCtx = cfg.classifiedGuardCtx
    this.vdigFields = cfg.vdigFields
    this.classifiedStrategy = cfg.classifiedStrategy
    this.computed = cfg.computed
    this.getDictionary = cfg.getDictionary
    this.defaultLocale = cfg.defaultLocale
    this.crdtMode = cfg.crdtMode
    this.syncAdapter = cfg.syncAdapter
    this.onAccess = cfg.onAccess
    this.derivationSource = cfg.derivationSource
    this.materializedViewSource = cfg.materializedViewSource
    this.graphDispatch = cfg.graphDispatch
    this.tiers = cfg.tiers
    this.tierMode = cfg.tierMode
    this.onCrossTierAccess = cfg.onCrossTierAccess
    this.deterministicFields = cfg.deterministicFields
    this.sensitiveFields = cfg.sensitiveFields
    this.perRecordCek = cfg.perRecordCek
    this.cekCache = cfg.cekCache
    this.provenance = cfg.provenance

    // Fix 3: warn when `sensitive` is a no-op in debug-plaintext mode. When
    // storeCiphertext is false the sealing path is skipped entirely, so
    // sensitive fields are written in plaintext.
    if (this.sensitiveFields.size > 0 && !this.storeCiphertext) {
      console.warn(
        `[noy-db] collection "${opts.name}": \`sensitive\` fields are NOT sealed in ` +
        `plaintext (debug) mode — they are written unencrypted.`,
      )
    }

    // Warn when a sealed `sensitive` field is also declared in `indexes`: a
    // plaintext secondary index defeats non-residency (the index buckets hold
    // the cleartext value the seal was meant to hide). Compile-time refusal is
    // a deferred follow-up.
    if (this.sensitiveFields.size > 0 && opts.indexes) {
      const indexedFields = new Set<string>()
      for (const def of opts.indexes) {
        if (typeof def === 'string') indexedFields.add(def)
        else if (Array.isArray(def)) for (const f of def) indexedFields.add(f)
        else for (const f of (def as { fields: readonly string[] }).fields) indexedFields.add(f)
      }
      const leaked = [...this.sensitiveFields].filter((f) => indexedFields.has(f))
      if (leaked.length > 0) {
        console.warn(
          `[noy-db] collection "${opts.name}": sealed \`sensitive\` field(s) ` +
          `${leaked.map((f) => `"${f}"`).join(', ')} also appear in \`indexes\` — a ` +
          `plaintext secondary index stores the cleartext value and defeats non-residency.`,
        )
      }
    }

    // Build the record codec once, AFTER every dependency it reads is assigned
    // (name, keyring, storeCiphertext, provenance, sensitiveFields, deterministicFields,
    // crdtMode, crdtStrategy, schema, getDEK, cekCache, via). `cekCache` is the SAME
    // reference (not a copy) — the codec's resolveEnvelopeCek and the tier/forget cache evictions share it.
    this.codec = new RecordCodec<T>({
      name: this.name,
      actor: this.keyring.userId,
      storeCiphertext: this.storeCiphertext,
      debugPlaintext: this.keyring.debugPlaintext === true,
      provenance: this.provenance,
      sensitiveFields: this.sensitiveFields,
      deterministicFields: this.deterministicFields,
      vdigFields: this.vdigFields,
      crdtMode: this.crdtMode,
      crdtStrategy: this.crdtStrategy,
      schema: this.schema,
      getDEK: (collection) => this.getDEK(collection ?? this.name),
      cekCache: this.cekCache,
      classifiedMarkerDigestOnly: () => this._classifiedMarkerDigestOnly(),
      via: this.via,
    }) // #629 T10: classifySealedShred wired onto cfg.classifiedEraseCfg just below, once this.codec exists
    if (cfg.classifiedEraseCfg) cfg.classifiedEraseCfg.classifySealedShred = (live) => this.codec.classifySealedShred(live as EncryptedEnvelope)
    // Build + register this collection's SyncEngine conflict resolvers (the CRDT
    // merge resolver + the per-collection `conflictPolicy` resolver). Kept inline
    // here: the closures capture private `this` state (this.codec,
    // this.crdtStrategy, this.resolveRecordCek) AND close over `conflictPolicy:
    // ConflictPolicy<T>`, whose custom-merge `(T, T) => T` is invariant in T —
    // exposing them through a method parameter would break the `Collection<T>` →
    // `Collection<unknown>` assignment the Vault relies on. MUST run after
    // `this.codec` (both resolvers decrypt through it) and BEFORE the lazy/index
    // cluster below, preserving the original registration→validation order.
    // register CRDT conflict resolver with SyncEngine
    if (opts.crdt && opts.onRegisterConflictResolver) {
      const crdtMode = opts.crdt
      const crdtResolver: CollectionConflictResolver = async (id, local, remote) => {
        if (crdtMode === 'yjs') {
          // Core cannot merge Yjs without the yjs package — take the higher version
          return local._v >= remote._v ? local : remote
        }
        const localJson = await this.codec.decryptJsonString(local, id)
        const remoteJson = await this.codec.decryptJsonString(remote, id)
        // Tombstone (shredded) on either side: the live envelope is the
        // authoritative merge result — a shred must win and stay shredded.
        if (localJson === null) return local
        if (remoteJson === null) return remote
        const localState = JSON.parse(localJson) as CrdtState
        const remoteState = JSON.parse(remoteJson) as CrdtState
        const merged = this.crdtStrategy.mergeCrdtStates(localState, remoteState)
        const mergedVersion = Math.max(local._v, remote._v) + 1
        const cek = this.perRecordCek ? await this.resolveRecordCek(id) : undefined
        return this.codec.encryptJsonString(JSON.stringify(merged), mergedVersion, cek)
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
          const localRecord = await this.codec.decryptRecord(local, { skipValidation: true, id })
          const remoteRecord = await this.codec.decryptRecord(remote, { skipValidation: true, id })
          // Tombstone on either side wins — a shredded record must not be
          // resurrected by a merge against a still-live peer.
          if (localRecord === null) return local
          if (remoteRecord === null) return remote
          const merged = mergeFn(localRecord, remoteRecord)
          const mergedVersion = Math.max(local._v, remote._v) + 1
          const cek = this.perRecordCek ? await this.resolveRecordCek(id) : undefined
          // R2 refuses digest-only × conflictPolicy; on a vdig collection this path is
          // unreachable and the codec fail-loud guard backstops it.
          return this.codec.encryptRecord(merged, mergedVersion, cek, undefined, undefined, undefined, id)
        }
      }

      opts.onRegisterConflictResolver(collectionName, resolver)
    }

    // Default `prefetch: true` keeps semantics. Only opt-in to lazy
    // mode when the consumer explicitly sets `prefetch: false`.
    this.lazy = opts.prefetch === false

    if (this.lazy) {
      // #267 lazy service — budget validation + LRU construction live on the
      // strategy seam (withLazy(); IMPLICIT_LAZY = deprecated implicit path).
      this.lru = (opts.lazyStrategy ?? IMPLICIT_LAZY)
        .createCache<{ record: T; version: number }>(this.name, opts.cache)
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

  /** The declared consumer-neutral field metadata channel (canonical). */
  getFieldMeta(): Record<string, FieldMeta> | undefined { return this.fieldMeta }

  /** The collection's declared descriptive metadata. */
  getMeta(): CollectionMeta | undefined { return this.meta }

  /**
   * Aggregate all collection-level configuration options that are actively set
   * into a {@link CollectionConfig} snapshot. Returns `undefined` when no options
   * are configured (omitting the `config` block from `dumpSchema()` output).
   * Consumed by `walk.ts` to populate `CollectionDescriptor.config`.
   */
  getConfig(): CollectionConfig | undefined {
    const i18nFields = this.i18nFields !== undefined
      ? Object.keys(this.i18nFields)
      : undefined
    const embeddings = this.embeddings !== undefined
      ? {
          source: this.embeddings.source,
          dim: this.embeddings.dim,
          ...(this.embeddings.model !== undefined ? { model: this.embeddings.model } : {}),
        }
      : undefined
    const textIndexes = this.textIndexes !== undefined && this.textIndexes.length > 0
      ? this.textIndexes
      : undefined
    const textIndexPersist = this.searchIndexStore instanceof PersistedIndexStore ? true : undefined
    const perRecordKeys = this.perRecordCek ? true : undefined
    const provenance = this.provenance ? true : undefined
    const tiers = this.tiers !== null ? Array.from(this.tiers) : undefined
    const tierMode = this.tiers !== null ? (this.tierMode as string) : undefined
    const crdt = this.crdtMode !== undefined ? (this.crdtMode as string) : undefined
    /**
     * `true` when history is explicitly enabled for this collection (i.e. the
     * caller supplied a `historyConfig` option and history is not disabled).
     * Omitted when no per-collection config was provided or history is disabled.
     */
    const history = this.historyConfigExplicit && this.historyConfig.enabled !== false
      ? true
      : undefined

    const hasAny =
      i18nFields !== undefined ||
      embeddings !== undefined ||
      textIndexes !== undefined ||
      textIndexPersist !== undefined ||
      perRecordKeys !== undefined ||
      provenance !== undefined ||
      tiers !== undefined ||
      crdt !== undefined ||
      history !== undefined

    if (!hasAny) return undefined

    return {
      ...(i18nFields !== undefined ? { i18nFields } : {}),
      ...(embeddings !== undefined ? { embeddings } : {}),
      ...(textIndexes !== undefined ? { textIndexes } : {}),
      ...(textIndexPersist !== undefined ? { textIndexPersist } : {}),
      ...(perRecordKeys !== undefined ? { perRecordKeys } : {}),
      ...(provenance !== undefined ? { provenance } : {}),
      ...(tiers !== undefined ? { tiers } : {}),
      ...(tierMode !== undefined ? { tierMode } : {}),
      ...(crdt !== undefined ? { crdt } : {}),
      ...(history !== undefined ? { history } : {}),
    }
  }

  /**
   * Describe the collection's field schema from in-memory config — zero store I/O.
   * Sync overload (no args): merges moneyFields/dictKeyFields/refs/computed/fieldMeta/
   * taint into a {@link CollectionDescription} (types inferred from config; the async
   * overload also derives validator-exact types and resolves dynamic dict labels).
   */
  describe(): CollectionDescription
  describe(opts: DescribeOptions): Promise<CollectionDescription>
  describe(opts?: DescribeOptions): CollectionDescription | Promise<CollectionDescription> {
    if (opts) {
      return this.describeAsync(opts)
    }
    return buildDescription({
      collection: this.name,
      fieldMeta: this.fieldMeta,
      moneyFields: this.moneyFields,
      dictKeyFields: this.dictKeyFields,
      ...(this.lookupFields !== undefined ? { lookupFields: this.lookupFields } : {}),
      computed: this.computed,
      refs: this._refs,
      zodFields: undefined,
      ...(this.meta !== undefined ? { meta: this.meta } : {}),
      ...(this.i18nFields !== undefined ? { i18nFields: this.i18nFields } : {}),
      ...(this.classified !== undefined ? { classified: this.classified.byField } : {}),
      ...(this.via?.taint !== undefined ? { taint: this.via.taint } : {}),
      ...(this.via ? { viaFragments: this.via.describeFragments() } : {}), // #650 Task 7
    })
  }

  /**
   * Async describe implementation. Derives validator-exact types via deriveZodFields
   * (lazy, no static zod import), optionally resolves dynamic-dict labels from vault.dictionary(name).list(),
   * then delegates to buildDescription (which also runs fieldMeta key-validation).
   */
  private async describeAsync(opts: DescribeOptions): Promise<CollectionDescription> {
    // 1. Derive per-field type/optional/constraints/meta from the validator (if any).
    const zodFields = this.schema !== undefined
      ? await deriveZodFields(this.schema)
      : undefined

    // 2. Optionally resolve dynamic-dict labels — dictKeyFields AND reserved-tier
    // lookupFields (native dict()) share the SAME `_dict_<name>` backing (review fix).
    let dictLabels: Record<string, Record<string, string>> | undefined
    if (opts.resolveDictLabels === true && this.getDictionary !== undefined) {
      const names = new Set<string>()
      for (const desc of Object.values(this.dictKeyFields ?? {})) if (!isStaticDictDescriptor(desc)) names.add(desc.name)
      for (const desc of Object.values(this.lookupFields ?? {})) if (desc.backing === 'reserved') names.add(desc.dimension)
      if (names.size > 0) {
        dictLabels = {}
        for (const name of names) {
          const handle = await this.getDictionary(name)
          const entries = await handle.list()
          const valueToLabel: Record<string, string> = {}
          for (const entry of entries) {
            // Pick the first available locale label as the display label.
            const label = Object.values(entry.labels)[0]
            if (label !== undefined) valueToLabel[entry.key] = label
          }
          dictLabels[name] = valueToLabel
        }
      }
    }

    return buildDescription({
      collection: this.name,
      fieldMeta: this.fieldMeta,
      moneyFields: this.moneyFields,
      dictKeyFields: this.dictKeyFields,
      ...(this.lookupFields !== undefined ? { lookupFields: this.lookupFields } : {}),
      computed: this.computed,
      refs: this._refs,
      zodFields,
      ...(dictLabels !== undefined ? { dictLabels } : {}),
      ...(this.meta !== undefined ? { meta: this.meta } : {}),
      ...(this.i18nFields !== undefined ? { i18nFields: this.i18nFields } : {}),
      ...(this.classified !== undefined ? { classified: this.classified.byField } : {}),
      ...(this.via?.taint !== undefined ? { taint: this.via.taint } : {}),
      ...(this.via ? { viaFragments: this.via.describeFragments() } : {}), // #650 Task 7
    })
  }

  /** JSON Schema for this collection with describe() metadata as x- extensions. */
  async toJSONSchema(): Promise<object> {
    // Lazy import (#553) -- only reachable through this async method.
    const { buildJsonSchema } = await import('../with-shape/introspection/json-schema.js')
    const desc = await this.describe({})
    let base: Record<string, unknown> | null = null
    if (this.schema !== undefined) {
      const env = await derivePersistedSchema(this.schema)
      base = (env.jsonSchema as Record<string, unknown> | null) ?? null
    }
    return buildJsonSchema(desc, base)
  }

  /** Single-point audited reveal of one classified field. Requires withClassified(). */
  async reveal(id: string, field: string): Promise<unknown> {
    const spec = this.classified?.byField[field]
    if (spec === undefined) throw new ClassifiedRevealError(this.name, field, 'field is not classified')
    if (spec.storage === 'never') {
      throw new ClassifiedRevealError(this.name, field, `storage:'never' — nothing is stored to reveal`)
    }
    if (spec.storage === 'digest-only') {
      throw new ClassifiedRevealError(this.name, field, `storage:'digest-only' — verify-only; nothing recoverable to reveal`)
    }
    return this.classifiedStrategy.reveal({
      collection: this.name,
      spec,
      encrypted: this.storeCiphertext,
      getEnvelope: (rid) => this.adapter.get(this.vault, this.name, rid),
      resolveCek: (env) => this.codec.resolveEnvelopeCek(env),
      getDEK: () => this.getDEK(this.name),
      ...(this.onAccess !== undefined
        ? { onAccess: async (_op: 'reveal', rid: string) => { await this.onAccess!('reveal', rid) } }
        : {}),
    }, id, field)
  }

  /** Verify-without-reveal: verdict-only oracle for one classified field. Requires withClassified(). */
  async verify(id: string, field: string, candidate: string): Promise<ClassifiedVerdict> {
    const spec = this.classified?.byField[field]
    if (spec === undefined) throw new ClassifiedVerifyError(this.name, field, 'field is not classified')
    if (spec.storage === 'never') {
      throw new ClassifiedVerifyError(this.name, field, `storage:'never' — nothing is stored to verify against`)
    }
    const ctx = this._classifiedVerifyCtx(spec)
    return spec.storage === 'digest-only'
      ? this.classifiedStrategy.verify(ctx, id, field, candidate)
      : this.classifiedStrategy.verifyText(ctx, id, field, candidate)
  }

  /** k-of-n challenge over the collection's secretAnswer members. Requires withClassified(). */
  async verifyGroup(id: string, answers: Record<string, string>, opts: { readonly min: number }): Promise<{ readonly passed: boolean }> {
    const members = Object.entries(this.classified?.byField ?? {})
      .filter(([, s]) => s.storage === 'digest-only' && s.verifyGroupMember === true)
      .map(([field, spec]) => ({ field, spec }))
    if (members.length === 0) {
      throw new ClassifiedVerifyError(this.name, '*', 'no groupable digest-only (secretAnswer) fields declared')
    }
    const ctx = { ...this._classifiedVerifyCtx(members[0]!.spec), groupMembers: members }
    return this.classifiedStrategy.matchGroup(ctx, id, answers, opts)
  }

  private _classifiedVerifyCtx(spec: ClassifiedFieldSpec): ClassifiedVerifyCtx {
    return {
      collection: this.name,
      spec,
      getEnvelope: (rid) => this.adapter.get(this.vault, this.name, rid),
      resolveCek: (env) => this.codec.resolveEnvelopeCek(env),
      getDEK: () => this.getDEK(this.name),
      now: () => Date.now(), // Q7: injected here; engine tests inject their own
      ...(this.onAccess !== undefined
        ? { onAccess: async (_op: 'verify' | 'find', rid: string) => { await this.onAccess!('verify', rid) } }
        : {}),
    }
  }

  /**
   * Equatable blind-index lookup: the ids whose classified digest-only
   * `equatable` field carries a `_bidx` tag matching `candidate` AND whose
   * `_vdig` payload confirms it. Requires the field to be declared
   * `classified.password({ equatable: true })` (or `secretAnswer`) and the
   * collection to have opened its `acknowledgeEquatableRisk` door.
   *
   * The algorithm order is load-bearing (spec §3):
   *  1. Caller-bug refusals thrown at ~0 elapsed, BEFORE any PBKDF2 (R9 /
   *     Oracle #6): the three field mis-declarations share ONE constant,
   *     field-name-free message so the refusal text cannot enumerate which
   *     fields are classified / digest-only / equatable.
   *  2. Derive the ONE blind-index target UNCONDITIONALLY (I-1 / F1): an empty
   *     collection still pays exactly one 600K PBKDF2, so wall-time can never
   *     distinguish "no records" from "no match". No early return may precede
   *     this line.
   *  3. Scan `list + one get` per id, string-comparing the stored `_bidx` tag —
   *     decrypting NOTHING — and retain each hit's already-fetched envelope.
   *  4. Emit the single sweep consent op (`onAccess('find', '*')`) now — after
   *     the scan, before confirm (Oracle #5) — fixing its store-write timestamp
   *     independent of hit count.
   *  5. Confirm-by-verify against the ALREADY-FETCHED envelope (C-B): run the
   *     enclave `verifyDigestField` on an in-memory `getEnvelope` closure so the
   *     confirm reads ZERO additional envelopes. A tag-hit whose `_vdig` fails
   *     to confirm is dropped silently (a splice is indistinguishable from a
   *     stale tag). Store-shape law: the only store calls are `list + N get`.
   */
  async findByDigest(field: string, candidate: string): Promise<readonly string[]> {
    // 1. Caller-bug refusals — pad-exempt, before any PBKDF2. R9 single message.
    const spec = this.classified?.byField[field]
    if (spec === undefined || spec.storage !== 'digest-only' || spec.equatable !== true) {
      throw new ClassifiedVerifyError(this.name, '*',
        'not a declared equatable digest-only classified field')
    }
    if (typeof candidate !== 'string') {
      throw new ClassifiedVerifyError(this.name, '*', 'candidate must be a string')
    }

    // 2. ONE full 600K PBKDF2, run UNCONDITIONALLY before the scan (I-1). A
    //    NO_CLASSIFIED strategy surfaces ClassifiedNotEnabledError here.
    const target = await this.classifiedStrategy.computeTarget(this._classifiedVerifyCtx(spec), field, candidate)

    // 3. Scan: list + one get per id; string-compare the stored tag; decrypt
    //    nothing; retain each hit's already-fetched envelope for the confirm.
    const ids = await this.adapter.list(this.vault, this.name)
    const hits: string[] = []
    const hitMap = new Map<string, EncryptedEnvelope>()
    for (const id of ids) {
      const env = await this.adapter.get(this.vault, this.name, id)
      if (target !== null && env?._bidx?.[field] === target) {
        hits.push(id)
        hitMap.set(id, env)
      }
    }

    // 4. Single sweep consent op — after the scan, before confirm (Oracle #5).
    await this.onAccess?.('find', '*')

    // 5. Confirm-by-verify on the IN-HAND envelope (C-B) — the enclave verify
    //    door via a dynamic import (the kernel spine reaches the enclave only
    //    through import(), never a static deep import). NOT strategy.verify —
    //    that re-fetches via ctx.getEnvelope AND emits a per-id 'verify' op.
    if (hits.length === 0) return []
    const { verifyDigestField } = await import('./enclave/classify/verify.js')
    const policy: VdigFieldPolicy = {
      normalize: spec.verifyNormalize ?? 'password',
      notLastN: spec.notLastN ?? 0,
      equatable: true,
      ...(spec.rotateDays !== undefined ? { rotateDays: spec.rotateDays } : {}),
    }
    const confirmCtx = {
      collection: this.name,
      getEnvelope: async (rid: string) => hitMap.get(rid) ?? null,   // in-memory: zero extra store.get
      resolveCek: (env: EncryptedEnvelope) => this.codec.resolveEnvelopeCek(env),
      getDEK: () => this.getDEK(this.name),
      now: () => Date.now(),
    }
    const confirmed: string[] = []
    for (const id of hits) {
      const verdict = await verifyDigestField(confirmCtx, id, field, candidate, policy)
      if (verdict.ok === true) confirmed.push(id)   // discard mustRotate; drop failures silently
    }
    return confirmed
  }

  /**
   * Retire a field's equatable blind-index (`_bidx`) coverage across every
   * live record — the SOLE lazy-write-independent drop-path for a still-live
   * record's tag (besides clear / `forget()` / DEK-rotation). For each envelope
   * carrying `_bidx[field]`, rewrite it WITHOUT that slot (dropping the whole
   * `_bidx` map when it becomes empty), leaving `_vdig[field]` and everything
   * else INTACT — the field stays `digest-only`, only the index coverage is
   * retired. NO crypto, NO re-mint, NO re-encrypt: a targeted envelope rewrite.
   * Returns the count of records scrubbed.
   *
   * This is a maintenance write, not a read-egress: it emits NO `'find'` op and
   * no consent. The field is validated to a declared equatable digest-only
   * classified field (only such a field ever carries `_bidx`).
   *
   * **Ledger consistency**: dropping `_bidx[field]` changes the envelope's
   * payload hash (`_bidx` is bound into `envelopeBodyForHash`), so a raw
   * `adapter.put` of the scrubbed envelope WITHOUT a matching ledger entry would
   * desync the chain and make a future integrity cross-check flag false
   * tampering. After each rewrite we therefore append an `op:'migration'` entry
   * recording the NEW payloadHash at the SAME version — this is index retirement,
   * not a new record version, so `_v` is NOT bumped; the migration op is
   * reverse-delta-inert (`ledger.reconstruct` skips non-put/delete ops) yet
   * keeps the hash chain and the record's latest recorded payloadHash correct.
   */
  async scrubEquatableTags(field: string): Promise<number> {
    const spec = this.classified?.byField[field]
    if (spec === undefined || spec.storage !== 'digest-only' || spec.equatable !== true) {
      throw new ClassifiedVerifyError(this.name, '*',
        'not a declared equatable digest-only classified field')
    }
    const ids = await this.adapter.list(this.vault, this.name)
    let count = 0
    for (const id of ids) {
      const env = await this.adapter.get(this.vault, this.name, id)
      if (env?._bidx?.[field] === undefined) continue

      // Rewrite without the field's tag; drop the whole `_bidx` map if it
      // empties (a fresh mutable copy — `EncryptedEnvelope._bidx` is readonly).
      const nextBidx: Record<string, string> = { ...env._bidx }
      delete nextBidx[field]
      const scrubbedRaw: Record<string, unknown> = { ...env }
      delete scrubbedRaw._bidx
      if (Object.keys(nextBidx).length > 0) scrubbedRaw._bidx = nextBidx
      const scrubbed = scrubbedRaw as unknown as EncryptedEnvelope
      await this.adapter.put(this.vault, this.name, id, scrubbed)

      // Keep the ledger verifiable: the scrubbed envelope has a new payload
      // hash, so record it (no `_v` bump — index retirement, not a version).
      if (this.ledger) {
        await this.ledger.append({
          op: 'migration', collection: this.name, id, version: scrubbed._v,
          actor: this.keyring.userId,
          payloadHash: await this.historyStrategy.envelopePayloadHash(scrubbed),
          reason: 'classified:scrub-equatable-tags',
        })
      }
      count++
    }
    return count
  }

  /**
   * @internal — attach money descriptors post-construction. MV dependency
   * analysis auto-creates a source collection (without options) during
   * `openVault`, before the user's `collection(name, { moneyFields })`
   * declaration; this reconciles that ordering. First-wins. Not public.
   *
   * PREPENDS money rather than appending: {@link compileViaBindings} always
   * compiles money before i18n (money-first pipeline order — see its
   * docstring), and by the time this reconcile runs an i18n binding may
   * already be sitting in `this.via.bindings` (declared at construction).
   * Appending here would yield `[i18n, money]` on this path vs `[money,
   * i18n]` from compile — prepending keeps both paths money-first.
   */
  _applyMoneyFields(moneyFields: Record<string, ViaDescriptor>): void {
    if (this.moneyFields !== undefined) return
    this.via = ViaPipeline.build([viaBinder('money')(moneyFields), ...(this.via?.bindings ?? [])])
    this.moneyFields = moneyFields
  }

  /** @internal — attach computed fields post-construction. See {@link _applyMoneyFields}. */
  _applyComputed(computed: ComputedFields): void {
    if (this.computed === undefined) this.computed = computed
  }

  /** @internal — attach fieldMeta post-construction. See {@link _applyMoneyFields}. First-wins. */
  _applyFieldMeta(fieldMeta: Record<string, FieldMeta>): void {
    if (this.fieldMeta === undefined) this.fieldMeta = fieldMeta
  }

  /** @internal — attach collection-level meta post-construction. See {@link _applyMoneyFields}. First-wins. */
  _applyMeta(meta: CollectionMeta): void {
    if (this.meta === undefined) this.meta = meta
  }

  /**
   * @internal — attach classified fields post-construction. See {@link _applyMoneyFields}.
   * First-wins. Note: unlike money/computed/meta, this cannot retro-seal a
   * collection that was already auto-created — `sensitiveFields` is frozen at
   * construction time. A reconciled declaration is only accepted when none of
   * its members are `storage: 'recoverable'` (those require sealing at first
   * open); otherwise this throws rather than silently persisting the value as
   * inline plaintext while `describe()` advertises protection.
   */
  _applyClassifiedFields(classifiedFields: Record<string, ClassifiedEntry>): void {
    const resolved = resolveClassifiedFields(this.name, classifiedFields)
    if (this.classified !== undefined) {
      // R6 (session): first-wins, but a re-declaration that CHANGES a field's
      // storage form is refused — never a silent form flip.
      for (const [field, spec] of Object.entries(resolved.byField)) {
        const prior = this.classified.byField[field]
        if (prior !== undefined && prior.storage !== spec.storage) {
          throw new ClassifiedConfigError(this.name,
            `field "${field}" was already declared storage:'${prior.storage}' — ` +
            `storage-form transitions are refused (R6); migrate explicitly`)
        }
      }
      return // identical / compatible re-declaration → first-wins no-op
    }
    // Door 2 (C5): re-run the refusal matrix R1-R5 against the frozen
    // construction-time facts before accepting a late-attached declaration.
    guardClassifiedCompat(this.name, resolved.byField, this.classifiedGuardCtx)
    // Check for collisions: each rider-computed key must not already exist in this.computed
    for (const key of Object.keys(resolved.riderComputed)) {
      if (this.computed?.[key] !== undefined) {
        throw new ClassifiedConfigError(this.name, `rider companion "${key}" collides with a declared field`)
      }
    }
    // Digest-only can NEVER retro-attach: the codec's `vdigFields` map is
    // construction-frozen (`null` here, since this collection was built
    // without a classified declaration), so accepting a late digest-only
    // member would write the secret into `_data` recoverably while
    // describe() advertises digest-only. Same "both doors" lesson as the
    // recoverable check below (C5).
    const retroDigest = Object.entries(resolved.byField)
      .filter(([, spec]) => spec.storage === 'digest-only')
      .map(([field]) => field)
    if (retroDigest.length > 0) {
      throw new ClassifiedConfigError(this.name,
        `digest-only classified field(s) ${retroDigest.map((f) => `"${f}"`).join(', ')} were declared after the `
        + `collection was first opened without them — the digest write path is fixed at first open, so these `
        + `values would persist recoverably in _data. Declare classifiedFields at the collection's first `
        + `vault.collection() call.`)
    }
    const unsealable = Object.entries(resolved.byField)
      .filter(([field, spec]) => spec.storage === 'recoverable' && !this.sensitiveFields.has(field))
      .map(([field]) => field)
    if (unsealable.length > 0) {
      throw new ClassifiedConfigError(this.name,
        `recoverable classified field(s) ${unsealable.map((f) => `"${f}"`).join(', ')} were declared after the `
        + `collection was first opened without them — sealing is fixed at first open, so these values would `
        + `persist as inline plaintext. Declare classifiedFields at the collection's first vault.collection() call `
        + `(for materialized-view sources this means recoverable classified fields are not supported in stage 1).`)
    }
    this.classified = resolved
    this.computed = { ...resolved.riderComputed, ...(this.computed ?? {}) }
    // APPEND (not prepend, unlike {@link _applyMoneyFields}) — compile order
    // is money→i18n→classified; this keeps classified last regardless of order.
    this.via = ViaPipeline.build([...(this.via?.bindings ?? []), viaBinder('classified')({
      entries: classifiedFields, collectionName: this.name, guardCtx: this.classifiedGuardCtx, classifySealedShred: (live: unknown) => this.codec.classifySealedShred(live as EncryptedEnvelope), // #629 T10
    })])
  }

  /** @internal — used only in tests; do not read in production code. */
  get _ramCiphertext(): boolean { return this.ramCiphertext }

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
  async get(id: string, locale?: LocaleReadOptions): Promise<SealedView<T, S> | null> {
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
      const { resolveStaleMVOnRead } = await import('../with-formula/materialized-views/stale.js')
      await resolveStaleMVOnRead(this.materializedViewSource, this.name, this.#dispatchCtx({ collection: this.name, id: 'resolve-on-read' }))
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
        if (isTombstone(envelope, this.storeCiphertext) || isDeleteMarker(envelope)) return null
        record = await this.codec.decryptRecord(envelope, { id, sealedAsHandles: true })
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
    // The cache/decrypt path already substituted Sealed handles for declared
    // sensitive fields (S); the cast reflects that runtime shape. For
    // collections with no sensitive fields S = never and SealedView<T, never>
    // collapses to T, so this is a no-op widening.
    return this.applyLocaleToRecord(record, locale) as unknown as SealedView<T, S>
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
    const json = await this.codec.decryptJsonString(envelope)
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
      encrypted: this.storeCiphertext,
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
   *                (zero cost).
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
    if (this.writeQueue) await this.writeQueue.track(() => this._putInternal(id, record, options))
    else await this._putInternal(id, record, options)
    if (event) {
      // Ordering: user afterWrite hooks run BEFORE observe-bus dispatch in
      // slice 1. Revisit when internal observe services (e.g. MV-refresh
      // notification) need to settle before user hooks observe state.
      if (hooksActive) await this.writeHooks!.runAfter(event)
      if (busAfterPut) await this.subsystemBus!.dispatch('afterPut', event)
    }
  }

  /**
   * Resolve the prior stored record (with its `_i18nFilled` marker) for
   * densify. Eager: in-memory cache; lazy: LRU then adapter. undefined if absent.
   */
  private async resolveDensifyPrior(id: string): Promise<Record<string, unknown> | undefined> {
    if (this.lazy && this.lru) {
      const cached = this.lru.get(id)
      if (cached) return cached.record as Record<string, unknown>
      const env = await this.adapter.get(this.vault, this.name, id)
      if (!env) return undefined
      const rec = await this.codec.decryptRecord(env, { id })
      return rec === null ? undefined : (rec as Record<string, unknown>)
    }
    await this.ensureHydrated()
    return this.cache.get(id)?.record as Record<string, unknown> | undefined
  }

  /**
   * Densify provenance for a record: which i18n slots were auto-filled,
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
   * its version. Critically, this uses the SAME basis `_putInternal` writes from
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
      return { record: (await this.codec.decryptRecord(env, { skipValidation: true, id })) as unknown ?? null, version: env._v }
    }
    await this.ensureHydrated()
    const cached = this.cache.get(id)
    return cached ? { record: cached.record, version: cached.version } : { record: null, version: 0 }
  }

  #txIdForHook(): string {
    return this.activeTxId?.() ?? generateULID()
  }

  /**
   * Resolve the prior record as REAL VALUES for the eager write/delete paths
   * (history snapshot, ledger patch, index upkeep). The eager cache holds
   * {@link Sealed} handles for sensitive fields (non-residency), so when the
   * collection seals anything we re-decrypt the stored envelope to materialise
   * real values — re-encrypting a handle would otherwise persist the marker
   * `'[sealed]'` in place of the value. `via?.hasAtRestHooks` (#642) catches
   * hook-only sealing (taint/classified, no local `sensitiveFields`).
   */
  private async resolvePriorValues(id: string): Promise<{ record: T; version: number } | undefined> {
    if (this.sensitiveFields.size > 0 || this.via?.hasAtRestHooks === true) {
      const env = await this.adapter.get(this.vault, this.name, id)
      if (!env || isTombstone(env, this.storeCiphertext)) return undefined
      const rec = await this.codec.decryptRecord(env, { skipValidation: true, id })
      return rec === null ? undefined : { record: rec, version: env._v }
    }
    const cached = this.cache.get(id)
    return cached ? { record: cached.record, version: cached.version } : undefined
  }

  /** Resolves the prior envelope/record for a gate event; elides the read (#267) when no handler at `point` needs it (`elided: true`, `env`/`record` null). */
  private async resolveGatePrior(point: GatePoint, id: string): Promise<{ env: EncryptedEnvelope | null; record: unknown; elided: boolean }> {
    if (!this.subsystemBus!.gateNeedsPrior(point)) return { env: null, record: null, elided: true }
    const env = await this.adapter.get(this.vault, this.name, id)
    if (!env) return { env: null, record: null, elided: false }
    try {
      return { env, record: await this.codec.decryptRecord(env, { skipValidation: true, id }), elided: false }
    } catch {
      return { env, record: null, elided: false }
    }
  }

  /**
   * Wraps {@link RecordCodec.toCacheRecord} with an additional strip for
   * digest-only classified fields: the codec already omits them from `_data`
   * on write, but the write path caches the pre-encrypt `record` object
   * directly (to skip a redundant decrypt) — without this, a vdig field's
   * plaintext would sit in the working-set cache and `get()` would leak it
   * right back out, defeating C6.
   */
  private async _toCacheableRecord(record: T, envelope: EncryptedEnvelope, id: string): Promise<T> {
    const base = await this.codec.toCacheRecord(record, envelope, id)
    if (this.vdigFields === null) return base
    const clone = { ...(base as unknown as Record<string, unknown>) }
    for (const field of this.vdigFields.keys()) delete clone[field]
    return clone as unknown as T
  }

  /** @internal Untracked put body — call {@link put}, not this. */
  private async _putInternal(id: string, record: T, options?: { readonly reason?: string; readonly source?: string; readonly sourceTs?: string }): Promise<void> {
    if (!hasWritePermission(this.keyring, this.name)) {
      throw new ReadOnlyError()
    }

    // One canonical money encoding from the FIRST pipeline stage:
    // gates, computed fields, and schema validation all see the decoded
    // `get()` shape. Best-effort — bad input passes through and the
    // quantize stage below throws the real error.
    if (this.via) record = this.via.ingest(record as Record<string, unknown>) as T

    // Gate bus (Track A) — write-gating services (guards: record-lock /
    // field-freeze / amendment-collect; periods: closed-period guard) run here,
    // before any schema/i18n/history work. A throwing gate handler propagates
    // and aborts the write; the amendment branch collects without throwing.
    // Zero-cost when no gate handler is registered; elides its own
    // prior-read (#267) too — see {@link resolveGatePrior}.
    if (this.subsystemBus?.hasGateHandlers('beforePut')) {
      const { env: existingEnv, record: existingRecord } = await this.resolveGatePrior('beforePut', id)
      const gateEvent: GatePutEvent = {
        op: existingEnv ? 'update' : 'create',
        vault: this.vault, collection: this.name, docId: id,
        incoming: record,
        existing: this.via ? this.via.canonicalizeStored(existingRecord as Record<string, unknown>) : existingRecord,
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

    // Shared Via write ctx for enforceWrite + encodeWrite below (`prior` is
    // lazy — paid only if a binding calls it, e.g. i18n densify).
    const viaWriteCtx: ViaWriteCtx = {
      id,
      vault: this.vault,
      prior: async () => (await this.resolveDensifyPrior(id)) ?? null,
      emit: (e: string, p: unknown) => (this.emitter.emit as (ev: string, pl: unknown) => void)(e, p),
    }

    // Via enforceWrite phase — classified storage:'never' rejection +
    // validators, before riders derive/schema sees the record (#629 Task 6:
    // was a direct enforceClassifiedWrite call, now the pipeline's hook).
    if (this.via) await this.via.enforceWrite(record as Record<string, unknown>, viaWriteCtx)

    // Computed scalar fields — evaluated FIRST so the user need not supply
    // them and the schema validates the computed result. Throws
    // ComputedFieldError if a function throws.
    if (this.computed !== undefined) {
      record = (await loadEvalComputedFields())(record as Record<string, unknown>, this.computed, id) as T
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

    // Single Via encode-write phase: money quantize, then i18nText
    // translate→densify→script→validate→densify (via the i18n binding) —
    // binding order is money-first (see {@link compileViaBindings}).
    if (this.via) {
      record = await this.via.encodeWrite(record as Record<string, unknown>, viaWriteCtx) as T
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
          const prevJson = await this.codec.decryptJsonString(existingEnvelope)
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
          const prevJson = await this.codec.decryptJsonString(existingEnvelope)
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
      const envelope = await this.codec.encryptJsonString(JSON.stringify(crdtState), version, cek, options?.source, options?.sourceTs)
      await this.adapter.put(this.vault, this.name, id, envelope)

      // Resolve snapshot for cache and history
      const resolvedRecord = this.crdtStrategy.resolveCrdtSnapshot(crdtState) as T
      // A tombstone (shredded) prior envelope yields a null record → treat as
      // "no previous version" so we don't snapshot/diff an erased value.
      const existingResolvedRecord = existingEnvelope
        ? await this.codec.decryptRecord(existingEnvelope, { skipValidation: true })
        : null
      const existingResolved = existingResolvedRecord !== null
        ? { record: existingResolvedRecord, version: existingVersion }
        : undefined

      if (existingResolved && this.historyConfig.enabled !== false) {
        // History snapshot of the PRIOR version — does NOT carry source from the new write
        const vdigCtx = this.vdigFields !== null ? { id, prev: existingEnvelope } : undefined
        const histEnvelope = await this.codec.encryptRecord(existingResolved.record, existingResolved.version, cek, undefined, undefined, vdigCtx, id)
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

      await this._onRecordMutated(id, 'put', 'local-write', { record, version })
      return
    }
    // ─── End CRDT mode ──────────────────────────────────────────────────

    // Resolve the previous record. In eager mode this comes from the
    // in-memory map (no I/O); in lazy mode we have to ask the adapter
    // because the record may have been evicted (or never loaded).
    let existing: { record: T; version: number } | undefined
    // Raw envelope read already performed while resolving `existing` (lazy
    // path below) — reused by the #589 continuity check so the re-create
    // path never pays a second `adapter.get`.
    let priorRaw: EncryptedEnvelope | null = null
    if (this.lazy && this.lru) {
      existing = this.lru.get(id)
      if (!existing) {
        priorRaw = await this.adapter.get(this.vault, this.name, id)
        if (priorRaw) {
          const previousRecord = await this.codec.decryptRecord(priorRaw, { id })
          // Tombstone (shredded) prior → treat as no previous version.
          if (previousRecord !== null) {
            existing = { record: previousRecord, version: priorRaw._v }
          }
        }
      }
    } else {
      await this.ensureHydrated()
      // Real values, not cache handles — the prior record is re-encrypted into
      // a history snapshot below; a handle would seal the `'[sealed]'` marker.
      existing = await this.resolvePriorValues(id)
    }

    let version = existing ? existing.version + 1 : 1
    // #589: a put re-creating a deleted id must continue past the delete
    // marker's version so it wins convergence — resetting to 1 would lose to
    // the marker's higher `_v` on sync. Markers exist only under sync, so this
    // is gated on `onDirty`; the lazy branch above may have already read the
    // raw envelope, so this reuses it instead of reading twice. Forget
    // tombstones (`isTombstone`, no `_del`) are terminal and are NOT
    // continued — they still reset to 1.
    if (!existing && this.onDirty) {
      if (priorRaw === null) priorRaw = await this.adapter.get(this.vault, this.name, id)
      if (priorRaw && isDeleteMarker(priorRaw)) version = priorRaw._v + 1
    }

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

    // Digest-only classified fields need the PREVIOUS live envelope: the codec
    // carries `_vdig` forward when a field is absent from this write (C6).
    // One adapter read, only on vdig collections — zero-cost otherwise.
    const vdigCtx = this.vdigFields !== null
      ? { id, prev: await this.adapter.get(this.vault, this.name, id) }
      : undefined

    // Save history snapshot of the PREVIOUS version before overwriting.
    // CRITICAL: the history snapshot is a record of the PRIOR version — it must
    // NOT carry the source from the current write (source belongs to the new write only).
    if (existing && this.historyConfig.enabled !== false) {
      const historyEnvelope = await this.codec.encryptRecord(existing.record, existing.version, cek, undefined, undefined, vdigCtx, id)
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

    const envelope = await this.codec.encryptRecord(record, version, cek, options?.source, options?.sourceTs, vdigCtx, id)
    await this.adapter.put(this.vault, this.name, id, envelope)

    // C-A/R10: persist the x-classified marker on the first classified write
    // (cross-session drift signal). Memoized; no-op for non-classified handles.
    await this._ensureClassifiedMarker()

    // Derive the embedding vector at write (encode → encrypted _vec sidecar).
    // Placed AFTER the main adapter.put so `version` (computed above) is in scope and
    // the record write is committed first. The _vec envelope _v is not OCC-checked.
    // Gated behind `searchStrategy: withSearch()`: a collection declaring
    // `embeddings` but not opting into search hits NO_SEARCH's throw here.
    if (this.embeddings) {
      await this.searchStrategy.embedOnWrite(this.searchContext(), id, record, version)
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
      // Cache the handle-form (sealed fields → Sealed handles) so plaintext
      // for sensitive fields is never resident in the working set.
      this.lru.set(id, { record: await this._toCacheableRecord(record, envelope, id), version }, estimateRecordBytes(record))
      // Maintain persisted-index side-cars. Lazy mode is the
      // only place `persistedIndexes` is populated; eager mode uses the
      // in-memory `CollectionIndexes` above.
      await this.maintainPersistedIndexesOnPut(id, record, existing ? existing.record : null, version)
    } else {
      this.cache.set(id, { record: await this._toCacheableRecord(record, envelope, id), version })
      // Update secondary indexes incrementally — no-op if no indexes are
      // declared. Pass the previous record (if any) so old buckets are
      // cleaned up before the new value is added.
      this.indexes?.upsert(id, record, existing ? existing.record : null)
      // Update unique-constraint maps to reflect the successful write.
      this.uniqueConstraints?.upsert(id, record, existing?.record)
    }

    // Derivation dispatch (inside `_onRecordMutated`) runs AFTER store +
    // ledger + emitter commit so a failed source-write never produces
    // orphan derived outputs. The recursive `put` into output collections
    // re-enters this pipeline (encrypt + ledger + emit) intentionally;
    // cycle detection at vault open is the primary defense against
    // infinite recursion.
    await this._onRecordMutated(id, 'put', 'local-write', { record, version })
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
   * @internal `wave` (#638 Task 4): when present (the sync/cutover/restore dispatch wave),
   * an eager MV already refreshed this wave is skipped (per-target dedup, keyed on spec name).
   */
  async dispatchMaterializedViews(id: string, record: T, wave?: WaveContext): Promise<void> {
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
        if (wave?.seen(`mv\0${reg.spec.name}`)) continue
        if (executor === null) {
          ;({ MaterializedViewExecutor: executor } = await import('../with-formula/materialized-views/executor.js'))
        }
        await executor.refresh(reg, {
          getCollection: (name) => this.materializedViewSource!.getCollection(name),
          getActiveTxContext: () => this.materializedViewSource!.getActiveTxContext(),
          getQueryContext: () => this.materializedViewSource!.getQueryContext(),
          dispatchCtx: this.#dispatchCtx({ collection: this.name, id }),
        })
      } else if (mode === 'lazy') {
        if (staleHelpers === null) {
          staleHelpers = await import('../with-formula/materialized-views/stale.js')
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
   * @internal The RAW stored record (canonical-money form, i18n maps
   * intact), WITHOUT the locale resolution `get()` applies. Used as the
   * patch base for self-write reverse-denorm so writing back never clobbers
   * an i18n map or re-quantizes money incorrectly. Returns null for
   * missing / tombstoned records.
   */
  async _getStoredRecord(id: string): Promise<T | null> {
    let raw: T | null
    if (this.lazy && this.lru) {
      if (this.sensitiveFields.size > 0 || this.via?.hasAtRestHooks === true) {
        // Sealed collection (lazy mirror of the eager `resolvePriorValues`):
        // the LRU holds {@link Sealed} handles for sensitive fields (non-
        // residency), but `_getStoredRecord` is the reverse-denorm / rollup
        // PATCH BASE — re-encrypting a handle would persist the marker
        // `'[sealed]'` in place of the value. So always re-decrypt the stored
        // envelope to REAL values for the returned base. On a miss, populate
        // the LRU in HANDLE form via `toCacheRecord` — never `record: raw`
        // plaintext, which would leak sealed plaintext into the working set
        // (a later public `get()` would then return it, defeating the gate).
        const cached = this.lru.get(id)
        const env = await this.adapter.get(this.vault, this.name, id)
        if (!env || isTombstone(env, this.storeCiphertext) || isDeleteMarker(env)) return null
        raw = await this.codec.decryptRecord(env, { id })
        if (raw === null) return null
        if (!cached) {
          this.lru.set(id, { record: await this.codec.toCacheRecord(raw, env, id), version: env._v }, estimateRecordBytes(raw))
        }
      } else {
        const cached = this.lru.get(id)
        if (cached) raw = cached.record
        else {
          const env = await this.adapter.get(this.vault, this.name, id)
          if (!env || isTombstone(env, this.storeCiphertext) || isDeleteMarker(env)) return null
          raw = await this.codec.decryptRecord(env, { id })
          if (raw === null) return null
          this.lru.set(id, { record: raw, version: env._v }, estimateRecordBytes(raw))
        }
      }
    } else {
      await this.ensureHydrated()
      // Patch base for self-write reverse-denorm → must be real values, not
      // the cache's Sealed handles, or a write-back would re-seal the marker.
      raw = (await this.resolvePriorValues(id))?.record ?? null
    }
    if (raw === null) return null
    return (this.via ? this.via.canonicalizeStored(raw as Record<string, unknown>) : raw) as T
  }

  /** @internal #638 Task 4 — decrypted STORED-form record + envelope version for the sync/cutover/
   *  restore dispatch wave (id threaded into decrypt, matching `_invalidateCacheEntry`'s contract). */
  async _getStoredRecordForDispatch(id: string): Promise<{ record: T; version: number } | null> {
    const env = await this.adapter.get(this.vault, this.name, id)
    if (!env || isTombstone(env, this.storeCiphertext) || isDeleteMarker(env)) return null
    const record = await this.codec.decryptRecord(env, { id })
    return record === null ? null : { record, version: env._v }
  }

  /**
   * @internal Ids of records whose top-level `field` equals `value`.
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

  /** @internal — ctx for `putDerivedOutput`'s frozen-period skip+audit (#638 Task 5). */
  #dispatchCtx(source: { readonly collection: string; readonly id: string }) {
    return { emit: (e: string, p: unknown) => (this.emitter.emit as (ev: string, pl: unknown) => void)(e, p), source, audit: ledgerAuditHook(this.ledger, this.keyring.userId) }
  }

  /** @internal Recompute a rollup aggregate onto the parent from `parentId`'s current children (value-equality guarded; no-op absent parent).
   *  `wave` (#638 T4, #640): per-target dedup. Returns the `putDerivedOutput` outcome, or `'noop'` (no parent/no-op/deduped) — `dispatchRollupsOnDelete`'s forget-fanout caller + #640's `_recomputeDeletedRollups` need this to fill their reports. */
  private async recomputeRollup(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spec: { source: string; rollup?: { from: string; key: string; field: string; compute: (children: any[]) => unknown } }, parentId: string, source: { readonly collection: string; readonly id: string }, wave?: WaveContext,
  ): Promise<RollupOutcome> {
    if (this.derivationSource === undefined || spec.rollup === undefined) return 'noop'
    const { from, key, field, compute } = spec.rollup
    const into = spec.source
    if (wave?.seen(`rollup\0${into}\0${parentId}\0${field}`)) return 'noop'
    const intoColl = this.derivationSource.getCollection(into)
    const base = await intoColl._getStoredRecord(parentId)
    if (base === null) return 'noop' // no parent record to patch

    const fromColl = this.derivationSource.getCollection(from)
    const childIds = await fromColl._findMatchingIds(key, parentId)
    const children: Array<Record<string, unknown>> = []
    for (const cid of childIds) {
      const c = await fromColl.get(cid)
      if (c !== null && c !== undefined) children.push(c)
    }

    const newValue = compute(children)
    if (selfWriteFieldEqual(base[field], newValue)) return 'noop' // no change → no write

    const patched = { ...base, [field]: newValue }
    const txCtx = this.derivationSource.getActiveTxContext()
    if (txCtx !== null) {
      const prior = await this.adapter.get(this.vault, into, parentId)
      txCtx._executed.push({
        op: { type: 'put', vaultName: this.vault, collectionName: into, id: parentId },
        priorEnvelope: prior,
      })
    }
    return putDerivedOutput(intoColl, parentId, patched, this.#dispatchCtx(source))
  }

  /** @internal #640 — this deleted child's rollup PARENT intents (see via-dispatch.ts#resolveRollupDeleteIntents). */
  _rollupDeleteIntents(deleted: T): RollupDeleteIntent[] {
    return resolveRollupDeleteIntents(this.derivationSource?.registry(), this.name, deleted as Record<string, unknown>)
  }

  /**
   * @internal Fire any rollups for which THIS collection is the child `from`, recomputing the
   * affected parent after a child delete/forget. Called from the delete path (return discarded)
   * and from `forgetDerivedFanout` (#638 Task 6), which needs the per-target outcome to fill
   * `ForgetResult.derivedAggregatesRecomputed`/`derivedResidueFrozen`). `wave` (#640): per-target dedup for the sync-apply path; `undefined` on local-delete (byte-identical).
   */
  async dispatchRollupsOnDelete(id: string, deleted: T, wave?: WaveContext): Promise<ReadonlyArray<{ readonly into: string; readonly parentId: string; readonly outcome: RollupOutcome }>> {
    const results: Array<{ into: string; parentId: string; outcome: RollupOutcome }> = []
    for (const intent of this._rollupDeleteIntents(deleted)) {
      const spec = findRollupSpecForIntent(this.derivationSource?.registry(), this.name, intent)
      if (spec) results.push({ into: intent.into, parentId: intent.parentId, outcome: await this.recomputeRollup(spec, intent.parentId, { collection: this.name, id }, wave) })
    }
    return results
  }

  /** @internal #640 — the wave's per-id driver: recompute each sync-apply delete's rollup parent. */
  async _recomputeDeletedRollups(intents: readonly RollupDeleteIntent[], wave: WaveContext): Promise<void> {
    for (const intent of intents) {
      const spec = findRollupSpecForIntent(this.derivationSource?.registry(), this.name, intent)
      if (spec) await this.recomputeRollup(spec, intent.parentId, { collection: this.name, id: '<sync-delete>' }, wave)
    }
  }

  /** @internal `wave` (#638 Task 4) — threaded to `recomputeRollup` for the sync/cutover/restore
   *  dispatch wave's per-target dedup; `undefined` on the local-write path (byte-identical). */
  async dispatchDerivations(id: string, record: T, version: number, wave?: WaveContext): Promise<void> {
    if (this.derivationSource === undefined) return
    // `record` is the stored form here (post-quantize) — decode so
    // derive(source, ctx) sees the canonical money shape.
    const incoming = (this.via ? this.via.canonicalizeStored(record as Record<string, unknown>) : record) as Record<string, unknown>
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

      // Rollup: a write to the child `from` recomputes the
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
        if (parentId !== null) await this.recomputeRollup(spec, parentId, { collection: this.name, id }, wave)
        continue
      }

      // Determine how `this.name` triggers this strategy, and build the list
      // of source records to (re-)derive:
      //   • source     — re-derive the written record itself (same-id).
      //   • sources[]  — re-derive the PRIMARY source at the same id.
      //   • triggerBy  — FK fan-out: re-derive every source record
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
        ({ DerivationExecutor } = (await import('../with-formula/derivations/executor.js')) as { DerivationExecutor: typeof DerivationExecutorType })
      }

      for (const run of runs) {
        const ctx = { vault: this.derivationSource.getReadOnlyFacade() }
        const outCtx = this.#dispatchCtx({ collection: spec.source, id: run.runId })
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
            const { loadFanoutSidecar, saveFanoutSidecar } = await import('../with-formula/derivations/fanout-sidecar.js')
            const prior = await loadFanoutSidecar(this.adapter, this.vault, spec.source, run.runId, key, this.getDEK, this.storeCiphertext)
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
              await putDerivedOutput(outputCollection, entry.key, entry.value, outCtx, { source: 'derived' })
            }

            // Persist the new key set last, for failure-mode symmetry.
            await saveFanoutSidecar(this.adapter, this.vault, {
              source: spec.source,
              sourceId: run.runId,
              outputKey: key,
              outputCollection: outSpec.collection,
              keys: newKeysList,
            }, this.getDEK, this.storeCiphertext)
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

          // ── Self-write reverse-denorm ───────────────────────────
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
            await putDerivedOutput(outputCollection, run.runId, patched, outCtx, { source: 'derived' })
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
          await putDerivedOutput(outputCollection, run.runId, out.value, outCtx, { source: 'derived' })
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
    // User write-hooks AND the Track A observe bus both need the
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
    if (this.writeQueue) await this.writeQueue.track(() => this._deleteInternal(id))
    else await this._deleteInternal(id)
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
      if (!env || isTombstone(env, this.storeCiphertext) || isDeleteMarker(env)) continue
      const decoded = await this.codec.decryptRecord(env, { skipValidation: true, id })
      if (decoded === null) continue // defensive: shredded between list and get
      const record = decoded as unknown as Record<string, unknown>
      const next = transform(record)
      const nextVersion = (env._v ?? 0) + 1
      // Migration pass: on a `perRecordKeys` collection, a legacy (no-`_cek`)
      // record gets a freshly minted CEK here (legacy → CEK re-encrypt), while
      // an already-CEK record reuses its stable CEK. This is the
      // erasure-completeness pass — once migrated, the record body is keyed
      // off a per-record CEK and a future shred can erase it. Until then it
      // stays directly under the collection DEK. `forget()`/shred reports
      // un-migrated records explicitly rather than claiming erasure.
      const cek = this.perRecordCek ? await this.resolveRecordCek(id) : undefined
      const newEnv = await this.codec.encryptRecord(next as unknown as T, nextVersion, cek, undefined, undefined, this.vdigFields !== null ? { id, prev: env } : undefined, id)
      await this.adapter.put(this.vault, this.name, id, newEnv)
      await this._onRecordMutated(id, 'put', 'cutover') // refresh in-memory cache after the raw write (parity: cache only)
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
  private async _deleteInternal(id: string): Promise<void> {
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
   * Returns `true` when it erased a live record, `false` for delete-of-absent (idempotent
   * contract — both txCtx-aware and txCtx===null callers honour this, short-circuiting before any side-effect).
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
  async _internalDelete(id: string, txCtx: TxContext | null = null): Promise<boolean> {
    // Idempotency contract: short-circuit before any ledger/event
    // side-effect when the target is absent. Both txCtx-aware and
    // txCtx-null callers honour this — `deriveAll` recomputes
    // expense-only allocations that never emitted a receipt without
    // writing spurious v0 ledger entries.
    const prior = await this.adapter.get(this.vault, this.name, id)
    if (prior === null) return false
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
    return true
  }

  private async _doDelete(id: string, internal: boolean): Promise<void> {
    if (!hasWritePermission(this.keyring, this.name)) {
      throw new ReadOnlyError()
    }

    // Gate bus (Track A) — fires for ALL deletes (carrying `internal`), so a
    // gate handler can collect amendment changes on system-internal deletes
    // while branching off `onDelete`/period checks for them. Delete-of-absent
    // does not fire — unless the read is elided (#267, {@link resolveGatePrior}).
    if (this.subsystemBus?.hasGateHandlers('beforeDelete')) {
      const { env: existingEnv, record: existingRecord, elided } = await this.resolveGatePrior('beforeDelete', id)
      if (existingEnv || elided) {
        await this.subsystemBus.dispatchGate('beforeDelete', {
          vault: this.vault, collection: this.name, docId: id,
          existing: this.via ? this.via.canonicalizeStored(existingRecord as Record<string, unknown>) : existingRecord,
          existingVersion: existingEnv?._v ?? 0,
          existingTs: existingEnv?._ts,
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
          const previousRecord = await this.codec.decryptRecord(previousEnvelope, { id })
          // Tombstone (shredded) prior → no record to snapshot on delete.
          if (previousRecord !== null) {
            existing = { record: previousRecord, version: previousEnvelope._v }
          }
        }
      }
    } else {
      // Real values, not cache handles — re-encrypted into a history snapshot.
      existing = await this.resolvePriorValues(id)
    }

    // Save history snapshot before deleting. On a CEK collection the
    // snapshot reuses the record's stable CEK so the displaced version
    // stays in the same key chain as the rest of its history.
    if (existing && this.historyConfig.enabled !== false) {
      const cek = this.perRecordCek ? await this.resolveRecordCek(id) : undefined
      const prevForVdig = this.vdigFields !== null ? await this.adapter.get(this.vault, this.name, id) : null
      const historyEnvelope = await this.codec.encryptRecord(existing.record, existing.version, cek, undefined, undefined, this.vdigFields !== null ? { id, prev: prevForVdig } : undefined, id)
      await this.historyStrategy.saveHistory(this.adapter, this.vault, this.name, id, historyEnvelope)
    }

    // Capture the previous envelope's payloadHash BEFORE delete so we
    // have a stable reference for the ledger entry. The hash is of
    // whatever was last visible to readers — for a `delete` of a
    // never-existed record, we use the empty string (which the
    // ledger entry's `payloadHash` field tolerates).
    const previousEnvelope = await this.adapter.get(this.vault, this.name, id)
    const previousPayloadHash = await this.historyStrategy.envelopePayloadHash(previousEnvelope)

    // #589 (review): the version the marker is minted at (live._v + 1) — captured
    // here so `onDirty` below reports the SAME version, not `existing?.version`
    // (which can be stale/absent in lazy mode with the record uncached and history
    // disabled, desyncing the dirty entry's version from the marker and breaking
    // push's CAS). `live` reuses `previousEnvelope` above — same read, nothing
    // between them writes to the adapter, so no need for a second `adapter.get`.
    let markerVersion: number | undefined
    if (this.onDirty) {
      // #589: under sync, delete leaves a version-ordered marker so the deletion
      // converges on pull (a bare adapter.delete is invisible to other pullers).
      // No-op if there is no live record to delete (already marked / shredded).
      const live = previousEnvelope
      if (!live || isTombstone(live, this.storeCiphertext) || isDeleteMarker(live)) return
      markerVersion = live._v + 1
      await this.adapter.put(this.vault, this.name, id, buildDeleteMarker(markerVersion, this.keyring.userId))
    } else {
      await this.adapter.delete(this.vault, this.name, id)
    }

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

    // #589: under sync the marker rides the push channel as an ordinary CAS put at
    // its own version (live._v + 1); the dirty version must match the marker so
    // push's expectedVersion = marker._v - 1 = live._v matches the remote's live copy.
    // #589 (review): use `markerVersion` (the version the marker was actually minted
    // at above), not `existing?.version` — the fallback below is unreachable in
    // practice (onDirty undefined ⇒ markerVersion undefined ⇒ the `?.` short-circuits
    // before this argument matters) but keeps the expression well-typed.
    await this._onRecordMutated(id, 'delete', 'local-delete', { version: markerVersion ?? (existing?.version ?? 0) + 1 })

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
      // Rollup-on-delete: recompute the parent aggregate now
      // that this child is gone. `existing.record` carries the deleted child's
      // FK; the recompute gathers the REMAINING children (this one already
      // removed from the store/cache above).
      if (existing) await this.dispatchRollupsOnDelete(id, existing.record)
    }
  }

  /**
   * @internal — GDPR crypto-shred a LIVE record to a tombstone.
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
   * rebuild. Returns `null` for a tombstone or unreadable envelope.
   * Skips schema validation — the rebuild only reads the subject field.
   */
  async _decodeEnvelope(envelope: EncryptedEnvelope, id: string): Promise<Record<string, unknown> | null> {
    try {
      const rec = await this.codec.decryptRecord(envelope, { skipValidation: true, id })
      return rec === null ? null : (rec as unknown as Record<string, unknown>)
    } catch {
      return null
    }
  }

  async _writeTombstone(id: string, actor: string): Promise<{ previousVersion: number } | null> {
    const live = await this.adapter.get(this.vault, this.name, id)
    if (!live || isTombstone(live, this.storeCiphertext) || isDeleteMarker(live)) return null

    await this.adapter.put(this.vault, this.name, id, buildTombstone(live._v, actor))

    // Invalidate every in-memory view of this record so subsequent reads see
    // the tombstone (→ null), not a stale decrypted value.
    this.cache.delete(id)
    this.lru?.remove(id)
    this.cekCache?.remove(id)
    // #590: enter the sync dirty log — the shred must propagate on push (pull re-assert in team/sync.ts is the backstop)
    await this.onDirty?.(this.name, id, 'put', live._v)

    return { previousVersion: live._v }
  }

  /**
   * Cascade deletes of array-shape derived rows when a source row is deleted. Reads each
   * registered strategy's fanout sidecar for this source id, deletes every listed derived
   * row, then deletes the sidecar itself. Returns the REAL erased count (#622 review Finding 1).
   *
   * Record-shape derivations are skipped on the ordinary delete path (see _doDelete's comment).
   * `eraseRecordShapeToo` (#638 T6, default `false`) opts a same-id record-shape copy into
   * erasure too — forget()'s fanout, GDPR residue. A delete-of-absent contributes 0 either way.
   * @internal
   */
  async dispatchArrayDerivationsOnDelete(id: string, eraseRecordShapeToo = false): Promise<number> {
    if (this.derivationSource === undefined) return 0
    const registry = this.derivationSource.registry()
    const strategies = registry.strategiesForSource(this.name)
    if (strategies.length === 0) return 0
    // Dynamic-import the sidecar helpers — keeps the derivation chunk out of the
    // floor bundle for consumers that don't use array-shape derivations.
    let helpers: {
      loadFanoutSidecar: typeof LoadFanoutSidecarType
      deleteFanoutSidecar: typeof DeleteFanoutSidecarType
      saveFanoutSidecar: typeof SaveFanoutSidecarType
    } | null = null
    const txCtx = this.derivationSource.getActiveTxContext()
    let erased = 0 // #622 review: rows ACTUALLY deleted, not edges visited
    for (const { spec } of strategies) {
      for (const [outputKey, outSpec] of Object.entries(spec.outputs)) {
        if (outSpec.shape === 'record') {
          // Same-id erasure only for a standard source-triggered strategy into a DIFFERENT
          // collection — never the self-denorm case (would re-delete the record just
          // tombstoned) nor triggerBy/sibling (derived id isn't `id`).
          if (eraseRecordShapeToo && spec.source === this.name && outSpec.collection !== this.name) {
            if (await this.derivationSource.getCollection(outSpec.collection)._internalDelete(id, txCtx)) erased += 1
          }
          continue
        }
        if (helpers === null) {
          helpers = await import('../with-formula/derivations/fanout-sidecar.js')
        }
        const sidecar = await helpers.loadFanoutSidecar(this.adapter, this.vault, spec.source, id, outputKey, this.getDEK, this.storeCiphertext)
        if (!sidecar) continue
        const outputCollection = this.derivationSource.getCollection(outSpec.collection)
        for (const derivedId of sidecar.keys) {
          if (await outputCollection._internalDelete(derivedId, txCtx)) erased += 1
        }
        await helpers.deleteFanoutSidecar(this.adapter, this.vault, spec.source, id, outputKey)
      }
    }
    return erased
  }

  /**
   * Mirror of {@link dispatchMaterializedViews} for the delete/forget path — no `_materializedFrom`
   * skip (record's gone); the `internal` gate at `_doDelete` is the recursion guard. Returns the
   * row count TOMBSTONED across every eager MV sourced here (#638 T6 — `forgetDerivedFanout`'s
   * `derivedRecordsErased`); a lazy MV only flips its stale bit (0 contribution — resolved on read).
   * @internal
   */
  async dispatchMaterializedViewsOnDelete(id: string): Promise<number> {
    if (this.materializedViewSource === undefined) return 0
    const registry = this.materializedViewSource.registry()
    const mvs = registry.mvsForSource(this.name)
    if (mvs.length === 0) return 0
    let executor: typeof MVExecutorType | null = null
    let staleHelpers: typeof MVStaleModule | null = null
    let deleted = 0
    for (const reg of mvs) {
      const mode = reg.spec.refresh
      if (mode === 'eager') {
        if (executor === null) {
          ;({ MaterializedViewExecutor: executor } = await import('../with-formula/materialized-views/executor.js'))
        }
        deleted += (await executor.refresh(reg, {
          getCollection: (name) => this.materializedViewSource!.getCollection(name),
          getActiveTxContext: () => this.materializedViewSource!.getActiveTxContext(),
          getQueryContext: () => this.materializedViewSource!.getQueryContext(),
          dispatchCtx: this.#dispatchCtx({ collection: this.name, id }),
        })).deleted
      } else if (mode === 'lazy') {
        if (staleHelpers === null) {
          staleHelpers = await import('../with-formula/materialized-views/stale.js')
        }
        staleHelpers.markMVStale(registry, reg.spec.name)
      }
      // manual: no-op — `vault.refreshView(name)` is the only path.
    }
    return deleted
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
      const { resolveStaleMVOnRead } = await import('../with-formula/materialized-views/stale.js')
      await resolveStaleMVOnRead(this.materializedViewSource, this.name, this.#dispatchCtx({ collection: this.name, id: 'resolve-on-read' }))
    }
    await this.ensureHydrated()
    const records = [...this.cache.values()].map(e => e.record)
    // Money/computed(virtual) decode must run even with no locale, so list()
    // matches get(). applyLocaleToRecord runs the full Via pipeline present()
    // regardless of locale (#638 Task 7: was money/i18n/dictKey-flag-gated —
    // missed any OTHER binding's `present` hook; `this.via` truthiness is the
    // general no-transform fast-path condition every binding's presence implies).
    if (!this.via) return records
    return Promise.all(records.map(r => this.applyLocaleToRecord(r, locale)))
  }

  /**
   * Scan-mode full-text search over a plain-text `field`. Decrypts the
   * collection in memory and ranks records by BM25 against the tokenized query.
   * **Zero added store leakage** — pure client-side scan; nothing searchable is
   * written to the store. (A store-usable blind index for at-scale search is a
   * separate, gated opt-in.) Eager mode only.
   *
   * `opts.match` (`'any'` default | `'all'`), `opts.prefix` (last query term as
   * a prefix → typeahead), `opts.limit` (top-N). Returns `{ id, score, record }`
   * ranked by descending score. The default tokenizer is word-boundary based —
   * see `src/search/tokenize.ts` for the Thai/CJK caveat.
   */
  search(field: string, query: string, opts: SearchOptions = {}): Promise<SearchResult<T>[]> {
    return this.searchStrategy.search(this.searchContext(), field, query, opts)
  }

  /** Force-persist the lexical index now — gated behind `searchStrategy: withSearch()`. */
  flushIndex(): Promise<void> {
    return this.searchStrategy.flushIndex(this.searchContext())
  }

  /** Pre-build the lexical index — gated behind `searchStrategy: withSearch()`. */
  warmIndex(): Promise<void> {
    return this.searchStrategy.warmIndex(this.searchContext())
  }

  /** Retrieval (lexical | semantic | hybrid) — gated behind `searchStrategy: withSearch()`. */
  retrieve(query: string, opts: RetrieveOptions<T> = {}): Promise<RetrieveHit<T>[]> {
    return this.searchStrategy.retrieve(this.searchContext(), query, opts)
  }

  /** Raw-vector kNN — gated behind `searchStrategy: withSearch()`. */
  similarTo(vector: Float32Array, opts: { k?: number; minScore?: number; includeRecord?: boolean } = {}): Promise<RetrieveHit<T>[]> {
    return this.searchStrategy.similarTo(this.searchContext(), vector, opts)
  }

  /**
   * Bind the {@link SearchContext} the search/retrieval surface needs. The
   * `cache` is the SAME `Map` reference the eager read/write path owns (passed
   * by reference, never copied) so the index always builds over the live set.
   */
  private searchContext(): SearchContext<T> {
    return {
      name: this.name,
      vault: this.vault,
      adapter: this.adapter,
      codec: this.codec,
      cache: this.cache,
      lazy: this.lazy,
      textIndexes: this.textIndexes,
      i18nFields: this.i18nFields,
      dictKeyFields: this.dictKeyFields,
      blobFields: this.blobFields,
      getDictionary: this.getDictionary,
      searchIndexStore: this.searchIndexStore,
      vectorSet: this.vectorSet,
      embeddings: this.embeddings,
      ensureHydrated: () => this.ensureHydrated(),
      blob: (id) => this.blob(id),
    }
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
      result.set(id, (await this.get(id)) as unknown as T | null)
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
  query(): Query<T, S, Q, M>
  query(predicate: (record: T) => boolean): T[]
  query(predicate?: (record: T) => boolean): Query<T, S, Q, M> | T[] {
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
      snapshotEntries: () => [...this.cache.entries()].map(([id, e]) => ({ id, record: e.record })),
      ...(this.via ? { via: this.via } : {}),
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
          // Flow the vault/collection default locale to joins so a
          // joined i18n field resolves like get()/list() when no per-call
          // locale is given; toArray({ locale }) overrides it.
          ...(this.defaultLocale !== undefined ? { defaultLocale: this.defaultLocale } : {}),
          ...(resolver.resolveDictSource
            ? { resolveDictSource: (field: string) => resolver.resolveDictSource!(leftCollection, field) }
            : {}),
        }
      : undefined
    return new Query<T, S, Q, M>(source, undefined, joinContext, this.aggregateStrategy)
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
          cb({ type: 'put', id: event.id, record: (record ?? null) as unknown as T | null })
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
   * variant of this method, which is exactly what streaming joins will need anyway.
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
      // Sync join dressing (#650 Task 6, #626 retirement) — i18n-text + lookup-label, from this collection's own bindings.
      ...(this.presentForJoin !== undefined ? { presentForJoin: this.presentForJoin } : {}),
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
      const record = await this.codec.decryptRecord(env, { skipValidation: true, id })
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
    return this.codec.decryptRecord(envelope, { skipValidation: true, id })
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
        const record = await this.codec.decryptRecord(envelope, { id, sealedAsHandles: true })
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
  scan(opts: { pageSize?: number } = {}): ScanBuilder<T, S, M> {
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
          // Flow the vault/collection default locale to joins so a
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
    return new ScanBuilder<T, S, M>(
      {
        listPage: (listOpts) => this.listPage(listOpts),
      },
      pageSize,
      [],
      [],
      joinContext,
      this.via,
    )
  }

  /** Decrypt a page of envelopes returned by `adapter.listPage`. */
  private async decryptPage(
    items: ListPageResult['items'],
  ): Promise<Array<{ id: string; record: T; version: number }>> {
    const out: Array<{ id: string; record: T; version: number }> = []
    for (const { id, envelope } of items) {
      // Public scan/listPage output (and the opportunistic cache fill in
      // listPage) — sealed fields surface as handles, never plaintext.
      const record = await this.codec.decryptRecord(envelope, { id, sealedAsHandles: true })
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

  /** @internal Satellite fan-out revert cleanup (spec #591): drop the sync dirty entry ('revert' is
   *  onDirty-channel-only) and re-announce the RESTORED state as a plain put/delete — `subscribe()`
   *  only understands those two actions, and the restored record may exist again. */
  async _compensateRevertedWrite(id: string): Promise<void> {
    await this._invalidateCacheEntry(id)
    await this.onDirty?.(this.name, id, 'revert', 0)
    const restored = await this.get(id) // rare revert path — one read buys a semantically-correct event
    this.emitter.emit('change', { vault: this.vault, collection: this.name, id, action: restored !== null ? 'put' : 'delete' })
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
    // Handle-form for the cache (non-residency for sensitive fields).
    const record = await this.codec.decryptRecord(envelope, { id, sealedAsHandles: true })
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
    await this._onRecordMutated(id, action, 'tab-mirror')
  }

  /**
   * Origin-tagged mutation choke point (#623 task 10) — the single dispatch
   * point every put/delete path funnels through, AFTER its own store write,
   * to fire the side-effects that path performs today. Each case below
   * performs EXACTLY the side-effect set the seam-map Part-3 table
   * (`.superpowers/sdd/seam-map-i18n-pipeline.md`) records for `origin` —
   * this is a pure parity extraction of existing tails, not a behavior
   * change. Phase C (#621, #622) plugs the dependency-graph dispatch into
   * this socket, keyed off `origin`, without every call site having to
   * learn the graph.
   *
   * `restore` is never reached: `Vault.load` / `backup.ts#loadVault` drops
   * the whole `collectionCache` instead of dispatching per record — the
   * origin is reserved for phase C.
   *
   * @internal
   */
  async _onRecordMutated(
    id: string,
    action: 'put' | 'delete',
    origin: MutationOrigin,
    ctx?: { readonly record?: T; readonly version?: number },
  ): Promise<void> {
    switch (origin) {
      case 'local-write': {
        const record = ctx!.record!
        const version = ctx!.version!
        await this.onDirty?.(this.name, id, 'put', version)
        this.emitter.emit('change', { vault: this.vault, collection: this.name, id, action: 'put' } satisfies ChangeEvent)
        this.searchIndexStore?.markDirty() // zero-cost for non-search collections
        await this.onAccess?.('put', id)
        await this.dispatchDerivations(id, record, version)
        await this.dispatchMaterializedViews(id, record)
        return
      }
      case 'local-delete': {
        await this.onDirty?.(this.name, id, 'put', ctx!.version!)
        this.emitter.emit('change', { vault: this.vault, collection: this.name, id, action: 'delete' } satisfies ChangeEvent)
        this.searchIndexStore?.markDirty() // zero-cost for non-search collections
        await this.onAccess?.('delete', id)
        return
      }
      case 'tab-mirror':
        await this._invalidateCacheEntry(id)
        this.emitter.emit('change', { vault: this.vault, collection: this.name, id, action })
        this.searchIndexStore?.markDirty() // peer write changed the cache; rebuild on next retrieve
        return
      case 'sync-apply': {
        this._invalidateCekCacheEntry(id)
        const prior = action === 'delete' ? this._peekCached(id) : undefined
        await this._invalidateCacheEntry(id)
        if (prior) this.graphDispatch?.collectDelete(this.name, id, this._rollupDeleteIntents(prior))
        else if (action === 'put') this.graphDispatch?.collect(this.name, id)
        return
      }
      case 'cutover':
        // Parity: cache invalidation only — the migration ledger entry
        // stays at the `_applyCutoverTransform` call site.
        await this._invalidateCacheEntry(id)
        this.graphDispatch?.collect(this.name, id)
        return
      case 'restore':
        // Unreachable today — see doc comment above. Phase C (#638) wires the dispatch call anyway.
        this.graphDispatch?.collect(this.name, id)
        return
    }
  }

  /** @internal — the current in-memory record without a store read (for conflict capture); also the #640 FK-recovery read on a sync-applied delete — misses on a cold or evicted child (lazy LRU eviction OR an un-hydrated eager collection whose first sync op is a delete), not "lazy-mode" only. */
  _peekCached(id: string): T | null {
    const entry = this.lazy && this.lru ? this.lru.get(id) : this.cache.get(id)
    return entry ? entry.record : null
  }

  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) return

    const ids = await this.adapter.list(this.vault, this.name)
    for (const id of ids) {
      const envelope = await this.adapter.get(this.vault, this.name, id)
      if (envelope && !isTombstone(envelope, this.storeCiphertext) && !isDeleteMarker(envelope)) {
        const record = await this.codec.decryptRecord(envelope, { id, sealedAsHandles: true })
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
      if (isTombstone(envelope, this.storeCiphertext) || isDeleteMarker(envelope)) continue
      const record = await this.codec.decryptRecord(envelope, { id, sealedAsHandles: true })
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
    rebuildEagerIndexesFromCacheImpl(this.indexingContext())
  }

  /**
   * Rebuild unique-constraint maps from the current in-memory cache.
   * Called after any bulk hydration alongside `rebuildEagerIndexesFromCache`.
   */
  private rebuildUniqueConstraintsFromCache(): void {
    rebuildUniqueConstraintsFromCacheImpl(this.indexingContext())
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
    return rebuildIndexesImpl(this.indexingContext())
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
    return reconcileIndexImpl(this.indexingContext(), field, opts)
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
      encrypted: this.storeCiphertext,
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
      const prevForVdig = this.vdigFields !== null ? await this.adapter.get(this.vault, this.name, id) : null
      result[id] = await this.codec.encryptRecord(entry.record, entry.version, cek, undefined, undefined, this.vdigFields !== null ? { id, prev: prevForVdig } : undefined, id)
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
   * Returns the record unchanged when no Via pipeline is compiled (#638 Task 7:
   * was money/i18n/dictKey-flag-gated — missed any OTHER binding's `present`
   * hook, e.g. the `computed` via-binding's virtual-mode read-time compute;
   * `this.via` truthiness is the general condition every binding's presence
   * already implies).
   */
  private async applyLocaleToRecord(
    record: T,
    localeOpts?: LocaleReadOptions,
  ): Promise<T> {
    if (!this.via) return record

    const locale = localeOpts?.locale ?? this.defaultLocale
    const layer = localeOpts?._layer ?? 'read'

    let result = record as unknown as Record<string, unknown>

    // Money decode + i18nText/dictKey/computed(virtual) resolution all run through
    // the compiled Via pipeline: money decode is unconditional (virtuals gated on
    // `locale !== 'raw'` inside the money binding); the i18n binding's `present`
    // hook (the i18n via-shape's `runI18nPresent`) applies the SAME locale-active /
    // static-display-hinge / dict-label / densify-marker-strip logic this method
    // used to run inline; `this.via` is already known truthy (the guard above).
    result = await this.via.present(result, { locale, ...(localeOpts?.fallback !== undefined ? { fallback: localeOpts.fallback } : {}), layer })

    return result as T
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
  private maintainPersistedIndexesOnPut(
    id: string,
    newRecord: T,
    previousRecord: T | null,
    version: number,
  ): Promise<void> {
    return maintainPersistedIndexesOnPutImpl(this.indexingContext(), id, newRecord, previousRecord, version)
  }

  /**
   * Tear down `_idx/<field>/<recordId>` side-cars for a deleted record.
   * Mirror state updates regardless of adapter outcome; adapter failures
   * surface on `index:write-partial` the same way put does.
   */
  private maintainPersistedIndexesOnDelete(id: string, previousRecord: T): Promise<void> {
    return maintainPersistedIndexesOnDeleteImpl(this.indexingContext(), id, previousRecord)
  }

  /**
   * @internal — hard-delete this record's persisted `_idx/<field>/<recordId>`
   * side-cars for the erasure path. `forget()` crypto-shreds the body but
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
  _purgePersistedIndexes(id: string): Promise<{ purged: number; residue: string[] }> {
    return purgePersistedIndexesImpl(this.indexingContext(), id)
  }

  /** Drop a record's encrypted _vec sidecar on erasure (a vector is text-invertible).
   *  Called by vault.ts forget() inside a resilient try/catch; residue is reported in ForgetResult. */
  async _purgeVector(id: string): Promise<void> {
    await this.adapter.delete(this.vault, '_vec', id)
    this.vectorSet?.markDirty()
  }

  /** Drop the persisted lexical-index blob (forget/erasure): an opaque
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
        const json = await this.codec.decryptJsonString(envelope)
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
  lazyQuery(): LazyQuery<T, S, Q> {
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
      getRecord: (id: string) => this.get(id) as unknown as Promise<T | null>,
    }
    return new LazyQuery<T, S, Q>(source)
  }

  /**
   * Resolve the stable CEK for a record on the WRITE path — see
   * {@link resolveStableCek}. Thin delegate that supplies the collection's
   * CEK cache, live-envelope reader, and DEK resolver.
   */
  private resolveRecordCek(id: string): Promise<EnclaveKey> {
    return resolveStableCek(
      {
        cache: this.cekCache,
        getLive: (rid) => this.adapter.get(this.vault, this.name, rid),
        getDEK: () => this.getDEK(this.name),
      },
      id,
    )
  }

  /** C-A/R10: persist the classified marker once per classified handle (store I/O in config-drift.ts). */
  private async _ensureClassifiedMarker(): Promise<void> {
    if (this._markerPersisted || this.vdigFields === null) return
    const { persistClassifiedMarkerForFields } = await import('../port/with/classified-marker.js')
    await persistClassifiedMarkerForFields(this.adapter, this.vault, this.name, this.vdigFields, await this.getDEK(this.name))
    this._markerPersisted = true
  }

  /** C-A/R10 drift signal — the marker's declared digest-only set, memoized to one store read per handle (see config-drift.ts). */
  private async _classifiedMarkerDigestOnly(): Promise<readonly string[]> {
    if (this._markerDigestOnlyCache !== undefined) return this._markerDigestOnlyCache
    const { readClassifiedMarkerDigestOnly } = await import('../port/with/classified-marker.js')
    this._markerDigestOnlyCache = await readClassifiedMarkerDigestOnly(this.adapter, this.vault, this.name, await this.getDEK(this.name))
    return this._markerDigestOnlyCache
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
  findByDet(field: string, value: unknown): Promise<T | null> {
    return findByDet(this.detContext(), field, value)
  }

  /**
   * return every record whose deterministic field matches.
   * Same semantics as {@link findByDet} but without the short-circuit.
   */
  queryByDet(field: string, value: unknown): Promise<T[]> {
    return queryByDet(this.detContext(), field, value)
  }

  /** Bind the {@link DeterministicContext} this collection's det lookups need. */
  private detContext(): DeterministicContext<T> {
    return {
      name: this.name,
      vault: this.vault,
      adapter: this.adapter,
      deterministicFields: this.deterministicFields,
      storeCiphertext: this.storeCiphertext,
      getDEK: () => this.getDEK(this.name),
      codec: this.codec,
    }
  }

  // ─── Hierarchical Access ──────────────────────────

  /** tier-aware put — gated behind `tiersStrategy: withTiers()`. */
  putAtTier(id: string, record: T, tier: number, opts?: { elevation?: { reason: string; fromTier: number }; source?: string; sourceTs?: string }): Promise<void> {
    return this.tiersStrategy.putAtTier(this.tiersContext(), id, record, tier, opts)
  }

  /** tier-aware get — gated behind `tiersStrategy: withTiers()`. */
  getAtTier(id: string): Promise<T | GhostRecord | null> {
    return this.tiersStrategy.getAtTier(this.tiersContext(), id)
  }

  /** list ids grouped by the caller's readability — gated behind `withTiers()`. */
  listAtTier(): Promise<Array<{ id: string; tier: number; readable: boolean }>> {
    return this.tiersStrategy.listAtTier(this.tiersContext())
  }

  /** elevate a record to a higher tier — gated behind `withTiers()`. */
  elevate(id: string, toTier: number): Promise<void> {
    return this.tiersStrategy.elevate(this.tiersContext(), id, toTier)
  }

  /** demote a record to a lower tier — gated behind `withTiers()`. */
  demote(id: string, toTier: number): Promise<void> {
    return this.tiersStrategy.demote(this.tiersContext(), id, toTier)
  }

  /**
   * Emit a cross-tier access event. The subscriber sink stays collection-
   * resident (it captures `onCrossTierAccess`); the tiers module reaches it
   * via the {@link TiersContext.emitCrossTierEvent} callback.
   */
  private emitCrossTierEvent(event: CrossTierAccessEvent): void {
    try {
      this.onCrossTierAccess?.(event)
    } catch {
      // notification sink failures must never block a tier operation
    }
  }

  /**
   * Classify a live envelope's `_sealed` slots for crypto-shred completeness
   * (#M-1, 2026-06-30 security review). Kept as a `_`-prefixed method on
   * Collection because `vault.ts` forget() reaches in via this name.
   */
  _classifySealedShred(live: EncryptedEnvelope): Promise<{ readonly slots: readonly SealedShredSlot[] }> {
    return classifySealedShredImpl(this.tiersContext(), live)
  }

  async _onViaErase(id: string, live: EncryptedEnvelope): Promise<ViaEraseReport | undefined> { return this.via ? this.via.eraseSealed({ id, vault: this.vault, live, crypto: await this.codec.eraseCryptoCtx(id, live) }) : undefined } // @internal forget()'s per-ref via-erase fold (#629 T10)
  get _via(): ViaPipeline | undefined { return this.via } // @internal exportRedact()'s typed reach-in accessor (fixes #634)
  /**
   * Bind the {@link TiersContext} the tier ops need. The `cekCache` is passed
   * by reference (the SAME `Lru` the kernel's read/write path owns) so an
   * elevate/demote CEK re-wrap stays synchronous with cache eviction.
   */
  private tiersContext(): TiersContext<T> {
    return {
      name: this.name,
      vault: this.vault,
      adapter: this.adapter,
      keyring: this.keyring,
      codec: this.codec,
      cekCache: this.cekCache,
      provenance: this.provenance,
      tiers: this.tiers,
      tierMode: this.tierMode,
      getDEK: (key: string) => this.getDEK(key),
      emitCrossTierEvent: (event) => this.emitCrossTierEvent(event),
    }
  }

  /**
   * Bind the {@link IndexingContext} the index-maintenance surface needs. The
   * eager `cache` Map and the index / unique-constraint / persisted mirrors are
   * passed by reference (the SAME instances the query path reads, never
   * copied); the `persistedIndexesLoaded` flag and `ensure*` hydration stay
   * collection-resident, reached via callbacks.
   */
  private indexingContext(): IndexingContext<T> {
    return {
      name: this.name,
      vault: this.vault,
      adapter: this.adapter,
      codec: this.codec,
      cache: this.cache,
      lazy: this.lazy,
      emitter: this.emitter,
      indexes: this.indexes,
      uniqueConstraints: this.uniqueConstraints,
      persistedIndexes: this.persistedIndexes,
      ensureHydrated: () => this.ensureHydrated(),
      ensurePersistedIndexesLoaded: () => this.ensurePersistedIndexesLoaded(),
      setPersistedIndexesLoaded: (value) => { this.persistedIndexesLoaded = value },
    }
  }
}
