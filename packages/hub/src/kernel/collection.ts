import type { StrategyBag } from '../port/with/strategies.js'
import type { NoydbStore, EncryptedEnvelope, ChangeEvent, HistoryConfig, HistoryOptions, HistoryEntry, PruneOptions, ListPageResult, LocaleReadOptions, CollectionConflictResolver, PutManyItemOptions, PutManyOptions, PutManyResult, DeleteManyResult, SealedView, VdigFieldPolicy, ClassifiedVerdict } from './types.js'
import type { PreparedPut, PreparedDelete } from './prepared-write.js'
import type { FieldMeta } from '../with-shape/introspection/field-meta.js'
import type { CollectionMeta } from '../with-shape/introspection/meta.js'
import { resolveClassifiedFields, guardClassifiedCompat, type ClassifiedEntry, type ClassifiedFieldSpec, type ResolvedClassified, type ClassifiedGuardCtx, type ClassifiedVerifyCtx } from '../port/with/classified-strategy.js'
import type { CrdtMode, CrdtState, LwwMapState, RgaState } from '../with-commit/crdt/crdt.js'
import type { I18nTextDescriptor, DictKeyDescriptor, StaticDictDescriptor, DictionaryHandle } from '../port/with/i18n-strategy.js'
import { isStaticDictDescriptor } from '../port/with/i18n-strategy.js'
import type { LookupDescriptor } from '../port/with/lookup-strategy.js'
import { ViaPipeline } from './via/pipeline.js'
import { viaBinder, type ViaDescriptor, type ViaWriteCtx, type ViaEraseReport } from './via/index.js'
import type { MutationOrigin } from './mutation.js'
import { putDerivedOutput, ledgerAuditHook, selfWriteFieldEqual, resolveRollupDeleteIntents, findRollupSpecForIntent, type WaveContext, type RollupOutcome, type RollupDeleteIntent } from './via/dispatch.js'
import type { ComputedFields } from '../with-formula/computed/index.js'
import { type RecordIdentity,
  isTombstone, isDeleteMarker, buildTombstone, buildDeleteMarker,
  resolveStableCek, findByDet, queryByDet, RecordCodec,
  type DeterministicContext, type EnclaveKey, type SealedShredSlot,
} from './enclave/index.js'
import { countLiveEnvelopes } from './lazy-count.js'
import { findMatchingIdsByPairs } from './match-pairs.js'
import { liveRecordIsElevated, assertTierWritable } from './tier-visibility.js'
import { applyCutoverTransform } from './cutover-transform.js'
import {
  classifySealedShred as classifySealedShredImpl, syncDerivedOutputs,
  type TiersContext, type TierMoveResult,
} from '../with-audit/tiers/index.js'
import {
  buildPersistedIndexCallbacks as buildPersistedIndexCallbacksImpl,
  syncTierSearch as syncTierSearchImpl,
  type SearchContext,
} from '../with-lookup/search/collection-facade.js'
import {
  rebuildEagerIndexesFromCache as rebuildEagerIndexesFromCacheImpl, rebuildUniqueConstraintsFromCache as rebuildUniqueConstraintsFromCacheImpl, rebuildIndexes as rebuildIndexesImpl,
  reconcileIndex as reconcileIndexImpl, maintainPersistedIndexesOnPut as maintainPersistedIndexesOnPutImpl, maintainPersistedIndexesOnDelete as maintainPersistedIndexesOnDeleteImpl,
  purgePersistedIndexes as purgePersistedIndexesImpl, syncTierIndexes as syncTierIndexesImpl, type IndexingContext,
} from '../with-lookup/indexing/collection-facade.js'
import { ReadOnlyError, ClassifiedConfigError, ClassifiedRevealError, ClassifiedVerifyError } from './errors.js'
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
import { NO_HISTORY } from '../with-commit/history/strategy.js'
import { Query, ScanBuilder } from './query/index.js'
import type { QuerySource, JoinContext, JoinableSource } from './query/index.js'
import { normalizeIndexDefs, type CollectionIndexes } from '../with-lookup/indexing/eager-indexes.js'
import { decodeIdxId } from '../with-lookup/indexing/persisted-indexes.js'
import type { PersistedCollectionIndex } from '../with-lookup/indexing/persisted-indexes.js'
import { LazyQuery } from '../with-lookup/indexing/lazy-builder.js'
import type { LazyQuerySource } from '../with-lookup/indexing/lazy-builder.js'
import { type IndexState } from '../with-lookup/indexing/strategy.js'
import type { SearchOptions, SearchResult } from '../with-lookup/search/index.js'
import { MemoryIndexStore, type IndexStore } from '../with-lookup/search/index-store.js'
import { PersistedIndexStore } from '../with-lookup/search/persisted-index-store.js'
import type { RetrieveOptions, RetrieveHit } from '../with-lookup/search/retrieve-types.js'
import { encodeVecId, type VectorSet, type EmbeddingDescriptor } from '../with-lookup/embeddings/index.js'
import { buildUniqueConstraintSet, type UniqueConstraintSet } from '../with-lookup/indexing/unique-constraints.js'
import type { RefDescriptor } from './refs.js'
import { buildDescription, deriveZodFields, resolveDescribeFieldIds, type CollectionDescription, type DescribeOptions } from '../with-shape/introspection/describe.js'
import type { CollectionConfig } from '../with-shape/introspection/types.js'
import { estimateRecordBytes, type Lru, type LruStats } from './cache/index.js'
import { generateULID } from '../with-pod/ulid.js'
import type { PresenceHandle, PresenceHandleOpts } from '../with-sync/presence.js'
import type { BlobSet } from '../with-shape/blobs/blob-set.js'
import { NO_BLOBS } from '../port/with/blob-strategy.js'
import type { ObjectProjection } from '../with-shape/blobs/object-projection.js'
import type { BlobFieldsConfig } from '../with-shape/blobs/blob-compaction.js'
import type { ReadOnlyVaultFacade } from '../with-audit/guards/types.js'
import type { DerivationRegistry } from '../with-formula/derivations/registry.js'
import type { TxContext } from '../with-commit/tx/transaction.js'
import { runPutManyAtomic } from './put-many-atomic.js'
// Type-only — runtime class loaded via dynamic import in
// `dispatchDerivations` when an eager-mode strategy fires. Keeps the
// derivation executor chunk out of the floor bundle.
import type {
} from '../with-formula/derivations/fanout-sidecar.js'
import { resolveStaleOnRead } from '../with-formula/derivations/stale.js'
import type { MaterializedViewRegistry } from '../with-formula/materialized-views/registry.js'
import type { MVQueryContext } from '../with-formula/materialized-views/types.js'
import { resolveCollectionConfig, resolveVirtualMoneyFields, type CollectionOpts } from './collection-config.js'
import { loadEvalComputedFields } from '../with-formula/computed/lazy.js'

/**
 * Callback for dirty tracking (sync engine integration). `action: 'revert'`
 * (spec #591) means "un-dirty" — the fan-out wiring in `noydb.ts` routes it
 * to `SyncEngine.removeDirty` instead of `trackChange`; `version` is unused
 * for that action.
 */
export type OnDirtyCallback = (collection: string, id: string, action: 'put' | 'delete' | 'revert', version: number) => Promise<void>


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
  /** #693: live check — true when multi-tab write-propagation is active; gates the #606 marker-id-set fallback read. */
  private readonly tabCoordinated: (() => boolean) | undefined
  private readonly historyConfig: HistoryConfig
  /** True when the caller explicitly provided a `historyConfig` option (vs. inheriting the vault default). */
  private readonly historyConfigExplicit: boolean

  /**
   * Every opt-in service, resolved once by `createNoydb` (#838) and shared by
   * reference with the owning `Vault` and `Noydb`.
   *
   * Each entry is a tree-shake seam. An un-opted-in service resolves to its
   * `NO_*` stub — a tiny module that throws with an actionable message —
   * so, for example, none of the BlobSet / chunk / MIME-magic machinery
   * reaches the bundle unless the consumer imports `@noy-db/hub/blobs` and
   * passes `blobsStrategy: blobs()` to `createNoydb`.
   */
  private readonly strategies: StrategyBag
  private readonly objectStore: ObjectProjection | undefined
  private readonly blobFields: BlobFieldsConfig | undefined; private readonly blobTierPolicy: 'isolate' | 'dedup' // #724 T2/T3

  // In-memory cache of decrypted records (eager mode only). Lazy mode
  // uses `lru` instead. Both fields exist so a single Collection instance
  // doesn't need a runtime branch on every cache access.
  private readonly cache = new Map<string, { record: T; version: number }>()
  private hydrated = false

  /**
   * #606: ids known to carry a delete marker in the store — lets the #589
   * re-create version-continuity gate in `_putInternal` read the store ONLY
   * for a known marker prior, instead of unconditionally on every insert.
   * Populated on hydration (`ensureHydrated`/`hydrateFromSnapshot`), local
   * delete (`_commitDelete`), and the sync/tab/cutover choke point
   * (`_invalidateCacheEntry`). Accepted drift: `vault._purgeDeleteMarkers`/
   * `_purgeMarkersOn` remove markers directly on the raw store, bypassing
   * Collection, so this set can hold stale ids after a purge on an
   * already-loaded collection — perf-only and self-healing (a stale id just
   * costs one `adapter.get` that returns non-marker/null, and version
   * resolution falls back to 1 correctly). Do not try to wire purge into it.
   */
  private readonly markerIds = new Set<string>()

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
   * `IndexingStrategy` passed through from `createNoydb({ indexingStrategy })`.
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
   * `null` when no `unique:true` indexes are declared on this collection, or when the collection is in lazy mode (which throws at registration).
   */
  private readonly uniqueConstraints: UniqueConstraintSet | null

  private readonly declaredIndexes: ReadonlyArray<{ readonly fields: readonly string[]; readonly unique?: boolean }> // declared index defs, normalized (introspection only)

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
   * Accessor for the persisted-mirror (lazy-mode) index. Returns `null` when indexing is disabled or the collection is in eager mode.
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

  /** Field name → `I18nTextDescriptor` for `i18nText()` fields (`i18nFields` option); write/read runs through the compiled `via` i18n binding — this remains for `describe()` and the search-index build path. Mutable — see {@link _reconcileReadState} (#671 item 2). */
  private i18nFields: Record<string, I18nTextDescriptor> | undefined

  /** The configured string fields exposed to `retrieve()`; `undefined` for ordinary collections (zero-cost). */
  private readonly textIndexes: readonly string[] | undefined

  /** Session-scoped lexical index store; `undefined` (zero-cost) unless `textIndexes` is non-empty. */
  private readonly searchIndexStore: IndexStore | undefined

  /** Embedding config for write-time vector derivation; `undefined` (zero-cost) for ordinary
   *  collections. When set, `put()` encodes the source field(s) and stores an encrypted `_vec` sidecar. */
  private readonly embeddings: EmbeddingDescriptor | undefined

  /** In-memory vector set, populated lazily from `_vec` sidecars; `undefined` when no embedding config is declared. */
  private vectorSet: VectorSet | undefined

  /** Field name → `DictKeyDescriptor` for `dictKey()` fields; used by `get()`/`list()` to add `<field>Label` virtual fields when a locale is requested. Mutable — see {@link _reconcileReadState} (#671 item 2). */
  private dictKeyFields: Record<string, DictKeyDescriptor | StaticDictDescriptor> | undefined

  /** Field name → `LookupDescriptor` for native `lookup()`/`enumOf()`/`dict()` fields (#650 Task 2) — describe()-only in this task. Mutable — see {@link _reconcileReadState} (#671 item 2). */
  private lookupFields: Record<string, LookupDescriptor> | undefined
  /** Sync join-dressing hook (#650 Task 6, #626 retirement) — `querySourceForJoin()`'s `presentForJoin`. Mutable — see {@link _reconcileReadState} (#671 item 3). */
  private presentForJoin: ((record: unknown, locale: string) => unknown) | undefined

  /** Consumer-neutral per-field descriptors declared via `fieldMeta`; read by `getFieldMeta()`, merged by `describe()`. */
  private fieldMeta: Record<string, FieldMeta> | undefined

  /** Collection-level descriptive metadata declared via `meta`; read by `getMeta()`, surfaced in `describe()`. */
  private meta: CollectionMeta | undefined

  /** Outbound ref declarations (snapshot from the vault refRegistry); read by `describe()` and
   *  {@link _txAtomicSafe}. Mutable for {@link _attachDeclaredRefs} (#1141). */
  private _refs: Record<string, RefDescriptor>

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


  /** Async callback provided by the Vault to open a dynamic dictionary handle (for label-map pre-computation in the search index). Only used in `resolveDictLabelMaps()`; static dicts bypass this entirely. Mutable, assign-once — see {@link _reconcileReadState} (#671 item 1). */
  private getDictionary: ((name: string) => Promise<DictionaryHandle>) | undefined

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
  private readonly addSubjectRef: ((id: string, record: unknown) => Promise<void>) | undefined // #766: putAtTier's first-write subject-index registration (wired by the Vault; undefined ⇒ no forget-subject field declared)

  /**
   * Optional reference to the vault-level hash-chained audit log. When present, every successful `put()` and `delete()` appends an entry to the ledger AFTER the adapter write succeeds (so a failed adapter write never produces an orphan ledger entry).
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
        _deleteCascadesPossible(collectionName: string): boolean
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
    this.strategies = cfg.strategies
    this.objectStore = cfg.objectStore
    this.blobFields = cfg.blobFields; this.blobTierPolicy = cfg.blobTierPolicy ?? 'isolate'
    this.reconcileOnOpen = cfg.reconcileOnOpen
    this.getDEK = cfg.getDEK
    this.onDirty = cfg.onDirty
    this.tabCoordinated = cfg.tabCoordinated
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
    this.addSubjectRef = cfg.addSubjectRef
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
      const indexedFields = new Set(normalizeIndexDefs(opts.indexes).flatMap((d) => d.fields))
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
      crdtStrategy: this.strategies.crdt,
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
    // this.strategies.crdt, this.resolveRecordCek) AND close over `conflictPolicy:
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
        const localJson = await this.codec.decryptJsonString({ collection: this.name, id }, local)
        const remoteJson = await this.codec.decryptJsonString({ collection: this.name, id }, remote)
        // Tombstone (shredded) on either side: the live envelope is the
        // authoritative merge result — a shred must win and stay shredded.
        if (localJson === null) return local
        if (remoteJson === null) return remote
        const merged = this.strategies.crdt.mergeCrdtStates(JSON.parse(localJson) as CrdtState, JSON.parse(remoteJson) as CrdtState)
        const mergedVersion = Math.max(local._v, remote._v) + 1
        const cek = this.perRecordCek ? await this.resolveRecordCek(id) : undefined
        return this.codec.encryptJsonString({ collection: this.name, id }, JSON.stringify(merged), mergedVersion, cek)
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
          const localRecord = await this.codec.decryptRecord({ collection: this.name, id }, local, { skipValidation: true, })
          const remoteRecord = await this.codec.decryptRecord({ collection: this.name, id }, remote, { skipValidation: true, })
          // Tombstone on either side wins — a shredded record must not be
          // resurrected by a merge against a still-live peer.
          if (localRecord === null) return local
          if (remoteRecord === null) return remote
          const merged = mergeFn(localRecord, remoteRecord)
          const mergedVersion = Math.max(local._v, remote._v) + 1
          const cek = this.perRecordCek ? await this.resolveRecordCek(id) : undefined
          // R2 refuses digest-only × conflictPolicy; on a vdig collection this path is
          // unreachable and the codec fail-loud guard backstops it.
          return this.codec.encryptRecord({ collection: this.name, id }, merged, mergedVersion, cek)
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
      this.lru = opts.strategies.lazy
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
    const strategy = opts.strategies.indexing
    this.indexState = strategy.createState({
      defs: opts.indexes ?? [],
      lazy: this.lazy,
    })
    this.declaredIndexes = normalizeIndexDefs(opts.indexes ?? [])
    this.indexes?.setCanonicalizer((f, v) => this.via?.canonicalizeIndexKey(f, v)) // #672 review C1: one-time canonicalizer registration; lazy `this.via` read survives late `_setVia` (#666)
    this.persistedIndexes?.setCanonicalizer((f, v) => this.via?.canonicalizeIndexKey(f, v)) // #677: lazy twin of the line above

    // Unique-constraint enforcement (eager mode only; UnsupportedIndexOptionError)
    // — see buildUniqueConstraintSet. The Arc-7 tiers+blobFields refusal (#724)
    // moved to collection.blob(id)'s runtime read gate (Arc 10 Task 1, blob-set.ts).
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

  getDeclaredIndexes(): ReadonlyArray<{ readonly fields: readonly string[]; readonly unique?: boolean }> { return this.declaredIndexes } // declared index defs, normalized; consumed by walk.ts

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
    if (opts) return this.describeAsync(opts)
    return buildDescription({
      collection: this.name,
      fieldMeta: this.fieldMeta,
      moneyFields: this.moneyFields,
      dictKeyFields: this.dictKeyFields,
      ...(this.lookupFields !== undefined ? { lookupFields: this.lookupFields } : {}),
      computed: this.computed,
      refs: this._refs,
      zodFields: undefined, schema: this.schema, // #1253 — sync fieldMeta key-validation
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
      ...(await resolveDescribeFieldIds(this.adapter, this.vault, this.name, this.getDEK)), // #946
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
    return this.strategies.classified.reveal({
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
      ? this.strategies.classified.verify(ctx, id, field, candidate)
      : this.strategies.classified.verifyText(ctx, id, field, candidate)
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
    return this.strategies.classified.matchGroup(ctx, id, answers, opts)
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
    const target = await this.strategies.classified.computeTarget(this._classifiedVerifyCtx(spec), field, candidate)

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
          payloadHash: await this.strategies.history.envelopePayloadHash(scrubbed),
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
   * PREPENDS money rather than appending: {@link compileVias} always
   * compiles money before i18n (money-first pipeline order — see its
   * docstring), and by the time this reconcile runs an i18n binding may
   * already be sitting in `this.via.bindings` (declared at construction).
   * Appending here would yield `[i18n, money]` on this path vs `[money,
   * i18n]` from compile — prepending keeps both paths money-first.
   */
  _applyMoneyFields(moneyFields: Record<string, ViaDescriptor>): void {
    if (this.moneyFields !== undefined) return
    const virtualMoney = resolveVirtualMoneyFields(Object.keys(moneyFields), (f) => this.via?.bindings.find((b) => b.brand === 'computed')?.covers?.(f) ?? false) // #669
    this.via = ViaPipeline.build([viaBinder('money')({ moneyFields, ...(virtualMoney.size > 0 ? { virtualMoneyFields: virtualMoney } : {}) }), ...(this.via?.bindings ?? [])], this.via?.taint) // #671 item 4 — thread taint through the rebuild
    this.moneyFields = moneyFields
    if (this.hydrated) this.rebuildEagerIndexesFromCache() // #686: re-canonicalize buckets built before this money late-attach
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

  /** @internal #1141 — refresh the ref snapshot after a late `refs` declaration. Overwrites rather
   *  than first-wins, deliberately: the argument is the ref registry's own merged view (see
   *  `reconcileViaAttach`), which `RefRegistry.register` has already refused to let conflict. */
  _attachDeclaredRefs(refs: Record<string, RefDescriptor>): void { this._refs = refs }

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
    })], this.via?.taint) // #671 item 4 — thread taint through the rebuild (code-level consistency; masked today by the reconcilePlan applyTaintOverlay re-run)
  }

  get _ramCiphertext(): boolean { return this.ramCiphertext } // @internal — used only in tests; do not read in production code.

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
    const record = await this.#getRaw(id)
    if (record === null) return null
    // The cache/decrypt path already substituted Sealed handles for declared
    // sensitive fields (S); the cast reflects that runtime shape. For
    // collections with no sensitive fields S = never and SealedView<T, never>
    // collapses to T, so this is a no-op widening.
    return this.applyLocaleToRecord(record, locale) as unknown as SealedView<T, S>
  }

  /**
   * Raw fetch: cache/adapter → decrypt → tombstone-null, WITHOUT `present()`.
   * Split out of `get()` (#684) so `lazyQuery()`'s `LazyQuerySource` can hand
   * `LazyQuery`'s post-filter the RAW (stored-form) record a `clause.via`
   * evaluator (e.g. money) needs — `present()`/locale decode is applied only
   * to survivors, via `applyLocaleToRecord` (see `lazyQuery()` below). `get()`
   * itself is unchanged: raw fetch, then `applyLocaleToRecord`, same order
   * as before this split.
   */
  async #getRaw(id: string): Promise<T | null> {
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
        // body / CEK. Reads return null rather than throwing TamperedError. #701: elevated records are invisible — gate BEFORE decrypt, or the warm cekCache serves tier plaintext.
        if (isTombstone(envelope, this.storeCiphertext) || isDeleteMarker(envelope) || (envelope._tier ?? 0) > 0) return null
        record = await this.codec.decryptRecord({ collection: this.name, id }, envelope, { sealedAsHandles: true })
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
    return record
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
    if (!envelope || (envelope._tier ?? 0) > 0) return null
    const json = await this.codec.decryptJsonString({ collection: this.name, id }, envelope)
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
    return this.strategies.sync.buildPresence<P>(presenceOpts)
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
    // BYPASS HAZARD: any refusal or side-effect added to this wrapper must ALSO be covered on the atomic tx path — extend _assertWriteGates or _txAtomicSafe (see commitAtomicBatch in with-commit/tx/transaction.ts); two m44 holes (write-hooks, schema gates) came from exactly this bypass.
    await this.schemaUpdateGate?.assertWritable()
    await this.schemaFence?.assertWritable(this.name)
    // TODO: putManyAtomic / CRDT / blob write paths are not yet tracked by writeQueue nor fired through the write hooks (tx-execute now asserts the schema gates directly — see _assertWriteGates).
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
      if (!env || (env._tier ?? 0) > 0) return undefined // #707: elevated ≡ missing
      const rec = await this.codec.decryptRecord({ collection: this.name, id }, env, { })
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
      if (!env || (env._tier ?? 0) > 0) return { record: null, version: 0 } // #707: elevated ≡ missing
      return { record: (await this.codec.decryptRecord({ collection: this.name, id }, env, { skipValidation: true, })) as unknown ?? null, version: env._v }
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
      if (!env || isTombstone(env, this.storeCiphertext) || (env._tier ?? 0) > 0) return undefined // #707: elevated ≡ missing
      const rec = await this.codec.decryptRecord({ collection: this.name, id }, env, { skipValidation: true, })
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
    if ((env._tier ?? 0) > 0) return { env, record: null, elided: false } // #707: elevated invisible to gate handlers — deterministic, not a swallowed InvalidKeyError
    return { env, record: await this.codec.decryptRecord({ collection: this.name, id }, env, { skipValidation: true, }), elided: false }
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
  /**
   * Decode a prior envelope's CRDT state, or `undefined` when there is no
   * usable prior: no envelope, a shredded body decrypting to `null`, or a
   * payload that is not a CRDT state. The `lww-map` and `rga` branches each
   * carried a copy, byte-identical apart from the cast (#842).
   */
  async #decodePriorCrdtState<S>(id: string, envelope: EncryptedEnvelope | null): Promise<S | undefined> {
    if (!envelope) return undefined

    const prevJson = await this.codec.decryptJsonString({ collection: this.name, id }, envelope)
    if (prevJson === null) return undefined

    const prevParsed = JSON.parse(prevJson) as unknown
    if (prevParsed === null || typeof prevParsed !== 'object' || !('_crdt' in prevParsed)) {
      return undefined
    }
    return prevParsed as S
  }

  /**
   * Record a write on the active transaction so a mid-batch failure rolls it
   * back. Four sites in the derivation/MV dispatch hand-built this literal (#842).
   */
  #trackPut(txCtx: TxContext, collectionName: string, id: string, priorEnvelope: EncryptedEnvelope | null): void {
    txCtx._executed.push({
      op: { type: 'put', vaultName: this.vault, collectionName, id },
      priorEnvelope,
    })
  }

  /**
   * Snapshot the PRIOR version into history, emit, and prune.
   *
   * Deliberately does NOT carry `source` from the current write — a history
   * entry describes the version being replaced, not the one replacing it.
   *
   * Kept OUT of {@link #commitWriteTail} because the two paths call it at
   * different points: the normal path snapshots BEFORE `adapter.put` (so a
   * history failure leaves no write behind), while the CRDT path must merge
   * and persist first to resolve the prior record at all. Folding it into the
   * tail would silently reorder one of them (#842).
   */
  async #savePriorHistory(
    id: string,
    prior: { record: T; version: number },
    cek: EnclaveKey | undefined,
    vdigCtx: { id: string; prev: EncryptedEnvelope | null } | undefined,
  ): Promise<void> {
    if (this.historyConfig.enabled === false) return

    await this.strategies.history.saveHistory(
      this.adapter, this.vault, this.name, id,
      await this.codec.encryptRecord(this.strategies.history.historyIdentity(this.name, id, prior.version), prior.record, prior.version, cek, undefined, undefined, vdigCtx), // sealed against its _history STORAGE identity (#1041)
    )
    this.emitter.emit('history:save', { vault: this.vault, collection: this.name, id, version: prior.version })

    if (this.historyConfig.maxVersions) {
      await this.strategies.history.pruneHistory(this.adapter, this.vault, this.name, id, { keepVersions: this.historyConfig.maxVersions })
    }
  }

  /**
   * Everything both write paths do once the envelope is on the adapter:
   * classified marker, embedding sidecar, ledger append, cache/index
   * maintenance, and the mutation event that drives derivation dispatch.
   *
   * The CRDT branch used to re-implement all of it, and in doing so skipped
   * `_ensureClassifiedMarker`, the unique-constraint upsert and
   * `_toCacheableRecord` (#835). All three were unreachable — each blocked by
   * a config-time refusal on CRDT collections — but only by accident of what
   * that copy happened to omit. One tail makes the divergence unrepresentable
   * rather than merely unreachable; on a CRDT collection the extra steps are
   * provably no-ops (classified/unique + crdt are refused at construction, and
   * a CRDT body never produces a `_sealed` slot, so `_toCacheableRecord` is
   * the identity).
   */
  async #commitWriteTail(args: {
    readonly id: string
    readonly envelope: EncryptedEnvelope
    readonly version: number
    /** The record as it should appear in caches, indexes and the ledger delta. */
    readonly indexed: T
    /** The record reported to `_onRecordMutated` — what derivations observe. */
    readonly event: T
    readonly prior: { record: T; version: number } | undefined
    readonly reason: string | undefined
  }): Promise<void> {
    const { id, envelope, version, indexed, event, prior, reason } = args

    // C-A/R10: persist the x-classified marker on the first classified write
    // (cross-session drift signal). Memoized; no-op for non-classified handles.
    await this._ensureClassifiedMarker()

    // Derive the embedding vector at write (encode → encrypted _vec sidecar).
    // The _vec envelope _v is not OCC-checked. Gated behind
    // `searchStrategy: withSearch()`: a collection declaring `embeddings`
    // but not opting into search hits NO_SEARCH's throw here.
    if (this.embeddings) {
      await this.strategies.search.embedOnWrite(this.searchContext(), id, indexed, version)
    }

    // Ledger append — AFTER the adapter write succeeds so a failed write never
    // orphans an entry. `payloadHash` is taken from the envelope just written,
    // i.e. the exact bytes the adapter holds; the entry records only metadata,
    // never the record, encrypted under the compartment's ledger DEK.
    //
    // `delta` is a REVERSE patch — how to turn the NEW record back into the
    // previous one. That lets `ledger.reconstruct()` walk backward from current
    // state without a forward-walking base snapshot, which would double the
    // scheme's storage cost. Genesis puts carry no `deltaHash`.
    if (this.ledger) {
      const appendInput: Parameters<typeof this.ledger.append>[0] = {
        op: 'put',
        collection: this.name,
        id,
        version,
        actor: this.keyring.userId,
        payloadHash: await this.strategies.history.envelopePayloadHash(envelope),
      }
      if (prior) appendInput.delta = this.strategies.history.computePatch(indexed, prior.record)
      if (reason !== undefined) appendInput.reason = reason
      await this.ledger.append(appendInput)
    }

    // Cache the handle-form (sealed fields → Sealed handles) so plaintext for
    // sensitive fields is never resident in the working set.
    const cacheable = await this._toCacheableRecord(indexed, envelope, id)

    if (this.lazy && this.lru) {
      this.lru.set(id, { record: cacheable, version }, estimateRecordBytes(indexed))
      // Persisted-index side-cars. Lazy mode is the only place
      // `persistedIndexes` is populated; eager mode uses `CollectionIndexes`.
      await this.maintainPersistedIndexesOnPut(id, indexed, prior ? prior.record : null, version)
    } else {
      this.cache.set(id, { record: cacheable, version })
      // Incremental secondary-index update — no-op when none are declared.
      // The previous record cleans up old buckets before the new value lands.
      this.indexes?.upsert(id, indexed, prior ? prior.record : null)
      this.uniqueConstraints?.upsert(id, indexed, prior?.record)
    }

    // Derivation dispatch (inside `_onRecordMutated`) runs AFTER store +
    // ledger + cache commit, so a failed source-write never produces orphan
    // derived outputs. The recursive `put` into output collections re-enters
    // this pipeline intentionally; cycle detection at vault open is the
    // primary defense against infinite recursion.
    // `prior` is already resolved pre-write by `_preparePut`/CRDT-merge (the
    // timing composite-triggerBy union fan-out needs, #1249 spec §2) — thread
    // it straight through rather than re-reading post-write, which would see
    // the record this write just landed.
    const priorForTrigger = prior ? (prior.record as unknown as Record<string, unknown>) : null
    await this._onRecordMutated(id, 'put', 'local-write', { record: event, version, prior: priorForTrigger })
  }

  /**
   * The pre-envelope stages both write paths share (#904): permission + tier
   * refusal, Via ingest, the beforePut gate bus, Via enforceWrite, computed
   * fields, schema validation, Via encodeWrite and ref enforcement. Reads and
   * throws; commits nothing. Returns the record in the shape that gets stored.
   */
  async #prepareWriteRecord(id: string, record: T): Promise<T> {
    if (!hasWritePermission(this.keyring, this.name)) {
      throw new ReadOnlyError()
    }
    // #715: elevated record ⇒ tier-0 API refuses (putAtTier/elevate/demote remedy) — see assertTierWritable's doc.
    await assertTierWritable(this.adapter, this.vault, this.name, id, this.tiers !== null)

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
    // binding order is money-first (see {@link compileVias}).
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

    return record
  }

  private async _putInternal(id: string, record: T, options?: { readonly reason?: string; readonly source?: string; readonly sourceTs?: string }): Promise<void> {
    // ─── CRDT mode ─────────────────────────────────────────
    // In CRDT mode we always read the raw envelope from the adapter to get
    // the existing CRDT state, merge the incoming record into it, then
    // encrypt the merged CRDT state — bypassing the normal version path.
    // Stays inline: merge-then-persist doesn't decompose into prepare/commit,
    // and CRDT collections never take the atomic path (#904).
    if (this.crdtMode) {
      record = await this.#prepareWriteRecord(id, record)
      const existingEnvelope = await this.adapter.get(this.vault, this.name, id)
      const existingVersion = existingEnvelope?._v ?? 0
      const now = new Date().toISOString()

      let crdtState: CrdtState

      if (this.crdtMode === 'lww-map') {
        const existingState = await this.#decodePriorCrdtState<LwwMapState>(id, existingEnvelope)
        crdtState = this.strategies.crdt.buildLwwMapState(record as Record<string, unknown>, existingState, now)
      } else if (this.crdtMode === 'rga') {
        const existingState = await this.#decodePriorCrdtState<RgaState>(id, existingEnvelope)
        crdtState = this.strategies.crdt.buildRgaState(Array.isArray(record) ? record : [record], existingState, generateULID)
      } else {
        // yjs: record is the base64 update string (produced by @noy-db/yjs)
        crdtState = { _crdt: 'yjs', update: record as unknown as string }
      }

      const version = existingVersion + 1
      // Stable per-record CEK shared by the new CRDT body and its history
      // snapshot (undefined on non-CEK collections → legacy path).
      const cek = this.perRecordCek ? await this.resolveRecordCek(id) : undefined
      const envelope = await this.codec.encryptJsonString({ collection: this.name, id }, JSON.stringify(crdtState), version, cek, options?.source, options?.sourceTs)
      await this.adapter.put(this.vault, this.name, id, envelope)

      // Resolve snapshot for cache and history
      const resolvedRecord = this.strategies.crdt.resolveCrdtSnapshot(crdtState) as T
      // A tombstone (shredded) prior envelope yields a null record → treat as
      // "no previous version" so we don't snapshot/diff an erased value.
      const existingResolvedRecord = existingEnvelope
        ? await this.codec.decryptRecord({ collection: this.name, id }, existingEnvelope, { skipValidation: true })
        : null
      const existingResolved = existingResolvedRecord !== null
        ? { record: existingResolvedRecord, version: existingVersion }
        : undefined

      if (existingResolved) {
        await this.#savePriorHistory(id, existingResolved, cek, this.vdigFields !== null ? { id, prev: existingEnvelope } : undefined)
      }

      // Caches and indexes see the resolved snapshot of the merged state;
      // the mutation event reports the record the caller passed.
      await this.#commitWriteTail({
        id, envelope, version,
        indexed: resolvedRecord,
        event: record,
        prior: existingResolved,
        reason: options?.reason,
      })
      return
    }
    // ─── End CRDT mode ──────────────────────────────────────────────────

    await this._commitPut(await this._preparePut(id, record, options))
  }

  /**
   * Prepare half of the ordinary (non-CRDT) write (#893/#904): run every
   * pre-envelope stage, resolve the prior version, and produce the encrypted
   * envelope — with ZERO observable side effects. No store write, no cache or
   * index mutation, no history entry, no ledger append, no event. It may READ
   * the store (gate prior, lazy prior, vdig prior) and it may THROW; refusing
   * a write before anything commits is precisely its job.
   *
   * Pairs with {@link _commitPut}. Split out so a batch can prepare every op,
   * submit ONE `store.tx()`, then finalize each op.
   *
   * @internal
   */
  async _preparePut(id: string, record: T, options?: { readonly reason?: string; readonly source?: string; readonly sourceTs?: string }): Promise<PreparedPut<T>> {
    record = await this.#prepareWriteRecord(id, record)

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
          const previousRecord = await this.codec.decryptRecord({ collection: this.name, id }, priorRaw, { })
          // Tombstone (shredded) prior → treat as no previous version.
          if (previousRecord !== null) {
            existing = { record: previousRecord, version: priorRaw._v }
          }
        }
      }
    } else {
      await this.ensureHydrated()
      // Real values, not cache handles — `_commitPut` re-encrypts the prior
      // record into a history snapshot; a handle would seal `'[sealed]'`.
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
      // #606: only fall back to a store read when this id is a KNOWN marker
      // — markers are filtered out of the eager cache, so `!existing` alone
      // can't distinguish a re-create from a genuinely-new insert, and most
      // inserts are the latter. The lazy branch above may have already read
      // the raw envelope on an LRU miss regardless of `markerIds` (preserved
      // as-is); this only gates the previously-unconditional second read.
      // #693: when the store may be written out-of-band by another tab (write-relay active),
      // markerIds isn't authoritative during the broadcast-latency window — fall back to the
      // pre-#606 unconditional read so a cross-tab marker is never missed.
      if (priorRaw === null && (this.markerIds.has(id) || this.tabCoordinated?.())) {
        priorRaw = await this.adapter.get(this.vault, this.name, id)
      }
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

    const envelope = await this.codec.encryptRecord({ collection: this.name, id }, record, version, cek, options?.source, options?.sourceTs, vdigCtx)

    return { id, envelope, version, indexed: record, event: record, prior: existing, cek, vdigCtx, reason: options?.reason }
  }

  /**
   * Commit half (#893/#904): the only place an ordinary put becomes
   * observable — history snapshot of the prior version, store write, marker
   * clear, then the shared write tail.
   *
   * History still runs BEFORE the store write, so a history failure leaves no
   * write behind. It now runs AFTER `encryptRecord` rather than before it —
   * the split's one sanctioned reorder, which also stops an encrypt failure
   * from leaving an orphan snapshot behind.
   *
   * @internal `persist: false` skips the `adapter.put` — see {@link _finalizePut}.
   */
  async _commitPut(prepared: PreparedPut<T>, persist = true): Promise<void> {
    const { id, envelope, version, indexed, event, prior, cek, vdigCtx, reason } = prepared

    // CRITICAL: the history snapshot is a record of the PRIOR version — it must
    // NOT carry the source from the current write (source belongs to the new write only).
    if (prior) await this.#savePriorHistory(id, prior, cek, vdigCtx)

    if (persist) await this.adapter.put(this.vault, this.name, id, envelope)
    this.markerIds.delete(id) // #606: the live body just overwrote any marker prior — no-op if `id` wasn't one

    await this.#commitWriteTail({ id, envelope, version, indexed, event, prior, reason })
  }

  /**
   * {@link _commitPut} minus the `adapter.put`: the store already holds this
   * envelope because it was written as one leg of a `store.tx()` batch.
   *
   * @internal
   */
  _finalizePut(prepared: PreparedPut<T>): Promise<void> {
    return this._commitPut(prepared, false)
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
    // S4 gate: dynamic import only — see #derivationDeleteCtx (#842).
    const { dispatchMaterializedViews } = await import('../with-formula/materialized-views/dispatch.js')
    return dispatchMaterializedViews(this.#mvDispatchCtx(this.materializedViewSource), id, record as unknown as Record<string, unknown>, wave)
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
        raw = await this.codec.decryptRecord({ collection: this.name, id }, env, { })
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
          raw = await this.codec.decryptRecord({ collection: this.name, id }, env, { })
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
    const record = await this.codec.decryptRecord({ collection: this.name, id }, env, { })
    return record === null ? null : { record, version: env._v }
  }

  /** @internal Ids of records whose top-level `field` equals `value` — delegates to the composite scan. */
  async _findMatchingIds(field: string, value: unknown): Promise<string[]> {
    if (typeof value !== 'string' && typeof value !== 'number') return []
    return this._findMatchingCompositeIds([{ field, value: String(value) }])
  }

  /** @internal — conjunction fan-out for composite triggerBy (#1249). First indexed pair narrows,
   *  filtered by the OTHER pairs only; zero reads when the index alone decides membership. */
  async _findMatchingCompositeIds(pairs: ReadonlyArray<{ field: string; value: string }>): Promise<string[]> {
    if (!this.lazy) await this.ensureHydrated() // unhydrated index's `lookupEqual` would be empty-but-truthy
    const i = pairs.findIndex((p) => this.getIndexes()?.lookupEqual(p.field, p.value))
    const hit = i < 0 ? null : this.getIndexes()!.lookupEqual(pairs[i]!.field, pairs[i]!.value)
    const residual = i < 0 ? pairs : pairs.filter((_, j) => j !== i)
    return findMatchingIdsByPairs(residual, {
      indexCandidates: hit ? [...hit] : null,
      listIds: async () => this.lazy ? this.adapter.list(this.vault, this.name) : [...this.cache.keys()],
      getRecord: async (id) => this.lazy
        ? (await this._getStoredRecord(id)) as Record<string, unknown> | null
        : ((this.cache.get(id)?.record as Record<string, unknown> | undefined) ?? null),
    })
  }

  /** @internal — ctx for `putDerivedOutput`'s frozen-period skip+audit (#638 Task 5). */
  /** What `with-formula/materialized-views/dispatch.ts` needs from this collection (#842). */
  #mvDispatchCtx(materializedViewSource: NonNullable<Collection<T, S, Q, M>['materializedViewSource']>) {
    return {
      materializedViewSource,
      collectionName: this.name,
      dispatchCtx: (source: { readonly collection: string; readonly id: string }) => this.#dispatchCtx(source),
    }
  }

  /**
   * What `with-formula/derivations/dispatch.ts` needs from this collection (#842).
   *
   * The return type is inferred, not annotated: importing `DerivationDeleteCtx`
   * would be a STATIC spine→service import, which `port-layering` rejects even
   * when it is type-only — the guard scans import statements, not their
   * erasure. The dynamic `import()` at the call site still types the argument.
   */
  #derivationDeleteCtx(derivationSource: NonNullable<Collection<T, S, Q, M>['derivationSource']>) {
    return {
      derivationSource,
      collectionName: this.name,
      adapter: this.adapter,
      vault: this.vault,
      getDEK: this.getDEK,
      storeCiphertext: this.storeCiphertext,
    }
  }

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
      this.#trackPut(txCtx, into, parentId, await this.adapter.get(this.vault, into, parentId))
    }
    return putDerivedOutput(intoColl, parentId, patched, this.#dispatchCtx(source))
  }

  /** @internal #640 — this deleted child's rollup PARENT intents (see via/dispatch.ts#resolveRollupDeleteIntents). */
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

  /** Extras added onto {@link #derivationDeleteCtx} — shared by `dispatchDerivations` and `dispatchTriggerDerivationsOnDelete` (#1249). */
  #derivationDispatchCtx() { return { ...this.#derivationDeleteCtx(this.derivationSource!), via: this.via, recomputeRollup: this.recomputeRollup.bind(this), dispatchCtx: this.#dispatchCtx.bind(this), trackPut: this.#trackPut.bind(this) } }

  /** @internal `wave` (#638 Task 4) — threaded to `recomputeRollup` for the sync/cutover/restore
   *  dispatch wave's per-target dedup; `undefined` on the local-write path (byte-identical). */
  async dispatchDerivations(id: string, record: T, version: number, wave?: WaveContext, prior?: Record<string, unknown> | null): Promise<void> {
    if (this.derivationSource === undefined) return
    const { dispatchDerivations } = await import('../with-formula/derivations/dispatch.js')
    return dispatchDerivations(this.#derivationDispatchCtx(), id, record as unknown as Record<string, unknown>, version, wave, prior)
  }

  /** @internal — trigger fan-out for a deleted parent (#1249); see dispatch.ts. */
  async dispatchTriggerDerivationsOnDelete(id: string, deleted: T): Promise<void> {
    if (this.derivationSource === undefined) return
    const { dispatchTriggerDerivationsOnDelete } = await import('../with-formula/derivations/dispatch.js')
    return dispatchTriggerDerivationsOnDelete(this.#derivationDispatchCtx(), id, deleted as unknown as Record<string, unknown>) }

  /**
   * Delete a record by ID. Runs inside the hub's write-queue tracker
   * so `hub.writeQueue.pending` reflects this write.
   */
  async delete(id: string): Promise<void> {
    // BYPASS HAZARD: any refusal or side-effect added to this wrapper must ALSO be covered on the atomic tx path — extend _assertWriteGates or _txAtomicSafe (see commitAtomicBatch in with-commit/tx/transaction.ts); two m44 holes (write-hooks, schema gates) came from exactly this bypass.
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
   * @internal — bulk-rewrite every record through a cutover transform. Body
   * lives in `./cutover-transform.js` (kernel-surface line ceiling); this is
   * a thin context-passing delegator. See {@link applyCutoverTransform} for
   * the full behavior doc.
   */
  async _applyCutoverTransform(
    transform: (doc: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<number> {
    return applyCutoverTransform<T>({
      adapter: this.adapter, vault: this.vault, name: this.name, tiers: this.tiers,
      storeCiphertext: this.storeCiphertext, codec: this.codec, perRecordCek: this.perRecordCek,
      vdigFields: this.vdigFields, ledger: this.ledger, keyring: this.keyring,
      resolveRecordCek: this.resolveRecordCek.bind(this),
      onRecordMutated: this._onRecordMutated.bind(this), envelopePayloadHash: (envelope) => this.strategies.history.envelopePayloadHash(envelope),
      transform,
    })
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
    return await this._doDelete(id, true)
  }

  private async _doDelete(id: string, internal: boolean): Promise<boolean> {
    const prepared = await this._prepareDelete(id, internal)
    return prepared === null ? false : await this._commitDelete(prepared)
  }

  /**
   * Prepare half of the delete (#893/#905): every refusal (write permission,
   * tier, the beforeDelete gate bus, foreign-key refs), the prior-version
   * resolution, the pre-delete payload hash, and the #589 marker DECISION —
   * the marker is minted here but NOT written.
   *
   * Commits nothing of its own: no store write, no history entry, no ledger
   * append, no cache/index mutation, no event, no `markerIds` entry. It READS
   * the store and it may THROW — refusing a delete before anything commits is
   * precisely its job. `null` is the "nothing to delete" answer that the early
   * `return false` paths gave: no live record, an already-shredded tombstone,
   * an existing marker, or the #718 elevated-internal skip.
   *
   * ONE exception to that guarantee: on a collection with `cascade` inbound
   * refs, prepare itself deletes the referencing children (via
   * `enforceRefsOnDelete`, as it always has) — prepare is NOT abortable there.
   * The transaction atomic path must never call this on such a collection; its
   * eligibility gate excludes refs-bearing collections.
   *
   * Pairs with {@link _commitDelete}. A deliberately separate split from the
   * put pair (#842c) — delete differs in hydration, in the history-read gate
   * and in the marker rules.
   *
   * @internal
   */
  async _prepareDelete(id: string, internal: boolean): Promise<PreparedDelete<T> | null> {
    if (!hasWritePermission(this.keyring, this.name)) {
      throw new ReadOnlyError()
    }
    // #716: public deletes only — see assertTierWritable's doc + Step 5 investigation for `internal`.
    await assertTierWritable(this.adapter, this.vault, this.name, id, !internal && this.tiers !== null)
    if (internal && this.tiers !== null && await liveRecordIsElevated(this.adapter, this.vault, this.name, id)) return null // #718: internal cleanup treats an elevated record as nonexistent, same as tier-0 reads — skip, no marker, not counted as erased (#761 item 8)

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
          const previousRecord = await this.codec.decryptRecord({ collection: this.name, id }, previousEnvelope, { })
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

    // Capture the previous envelope's payloadHash BEFORE delete so we
    // have a stable reference for the ledger entry. The hash is of
    // whatever was last visible to readers — for a `delete` of a
    // never-existed record, we use the empty string (which the
    // ledger entry's `payloadHash` field tolerates).
    const previousEnvelope = await this.adapter.get(this.vault, this.name, id)
    const previousPayloadHash = await this.strategies.history.envelopePayloadHash(previousEnvelope)

    // #589 (review): the marker is minted at `live._v + 1` and carried on the
    // prepared delete, so `onDirty` reports the SAME version, not
    // `existing?.version` (which can be stale/absent in lazy mode with the
    // record uncached and history disabled, desyncing the dirty entry's version
    // from the marker and breaking push's CAS). `live` reuses `previousEnvelope`
    // above — same read, nothing between them writes to the adapter.
    let marker: EncryptedEnvelope | undefined
    if (this.onDirty) {
      // #589: under sync, delete leaves a version-ordered marker so the deletion
      // converges on pull (a bare adapter.delete is invisible to other pullers).
      // No-op if there is no live record to delete (already marked / shredded).
      const live = previousEnvelope
      if (!live || isTombstone(live, this.storeCiphertext) || isDeleteMarker(live)) return null
      marker = buildDeleteMarker({ collection: this.name, id }, live._v + 1, this.keyring.userId)
    }

    // History-snapshot key material, resolved HERE off the live envelope —
    // re-resolving it in the commit half would read the already-written marker
    // (see {@link PreparedDelete.cek}). `previousEnvelope` is that same
    // pre-write read, so the vdig context costs no extra `adapter.get`.
    const snapshots = existing !== undefined && this.historyConfig.enabled !== false
    const cek = snapshots && this.perRecordCek ? await this.resolveRecordCek(id) : undefined
    const vdigCtx = snapshots && this.vdigFields !== null ? { id, prev: previousEnvelope } : undefined

    return { id, internal, existing, previousPayloadHash, marker, cek, vdigCtx }
  }

  /**
   * Commit half (#893/#905): the only place a delete becomes observable —
   * history snapshot of the deleted version, the store write (the #589 marker
   * put, or the physical removal when sync is off), then the ledger entry,
   * cache/index teardown, the mutation event, and the user-initiated
   * derivation dispatch.
   *
   * History still runs BEFORE the store write, exactly as today, so a history
   * failure leaves no delete behind.
   *
   * @internal `persist: false` skips the store write — see {@link _finalizeDelete}.
   */
  async _commitDelete(prepared: PreparedDelete<T>, persist = true): Promise<boolean> {
    const { id, internal, existing, previousPayloadHash, marker, cek, vdigCtx } = prepared

    // Save history snapshot before deleting. On a CEK collection the
    // snapshot reuses the record's stable CEK (resolved in prepare, off the
    // live envelope) so the displaced version stays in the same key chain as
    // the rest of its history.
    if (existing && this.historyConfig.enabled !== false) {
      await this.strategies.history.saveHistory(this.adapter, this.vault, this.name, id, await this.codec.encryptRecord(this.strategies.history.historyIdentity(this.name, id, existing.version), existing.record, existing.version, cek, undefined, undefined, vdigCtx))
    }

    if (marker) {
      if (persist) await this.adapter.put(this.vault, this.name, id, marker)
      this.markerIds.add(id) // #606: this id now carries a marker — the #589 continuity gate should consult it on re-create
    } else if (persist) await this.adapter.delete(this.vault, this.name, id)

    // Ledger append — same after-write timing as put(). The recorded
    // version is the version that WAS deleted (existing?.version), not
    // a successor. A delete of a missing record still appends an
    // entry with version 0 so the chain captures the intent.
    if (this.ledger) {
      await this.ledger.append({ op: 'delete', collection: this.name, id, version: existing?.version ?? 0, actor: this.keyring.userId, payloadHash: previousPayloadHash })
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
    // #589 (review): use the marker's own `_v` (the version it was actually minted
    // at), not `existing?.version` — the fallback below is unreachable in
    // practice (onDirty undefined ⇒ no marker ⇒ the `?.` short-circuits
    // before this argument matters) but keeps the expression well-typed.
    await this._onRecordMutated(id, 'delete', 'local-delete', { version: marker?._v ?? (existing?.version ?? 0) + 1 })

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
    // extractor) — without cascade the rows become unfindable orphans. (Deleting a TRIGGER parent
    // is a different event and DOES fan out — see dispatchTriggerDerivationsOnDelete, #1249.)
    if (!internal) {
      await this.dispatchMaterializedViewsOnDelete(id)
      await this.dispatchArrayDerivationsOnDelete(id)
      // Rollup-on-delete: recompute the parent aggregate now
      // that this child is gone. `existing.record` carries the deleted child's
      // FK; the recompute gathers the REMAINING children (this one already
      // removed from the store/cache above).
      if (existing) { await this.dispatchRollupsOnDelete(id, existing.record); await this.dispatchTriggerDerivationsOnDelete(id, existing.record) }
    }
    return true
  }

  /**
   * {@link _commitDelete} minus the store write: the marker (or the removal)
   * already landed as one leg of a `store.tx()` batch.
   *
   * @internal
   */
  _finalizeDelete(prepared: PreparedDelete<T>): Promise<boolean> {
    return this._commitDelete(prepared, false)
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
      const rec = await this.codec.decryptRecord({ collection: this.name, id }, envelope, { skipValidation: true, })
      return rec === null ? null : (rec as unknown as Record<string, unknown>)
    } catch {
      return null
    }
  }

  async _writeTombstone(id: string, actor: string): Promise<{ previousVersion: number } | null> {
    const live = await this.adapter.get(this.vault, this.name, id)
    if (!live || isTombstone(live, this.storeCiphertext) || isDeleteMarker(live)) return null

    await this.adapter.put(this.vault, this.name, id, buildTombstone({ collection: this.name, id }, live._v, actor))

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
    // S4 gate: the spine may not statically import a with-* service, and this
    // keeps the derivation chunk out of the floor bundle (#842).
    const { dispatchArrayDerivationsOnDelete } = await import('../with-formula/derivations/dispatch.js')
    return dispatchArrayDerivationsOnDelete(this.#derivationDeleteCtx(this.derivationSource), id, eraseRecordShapeToo)
  }

  /**
   * Mirror of {@link dispatchMaterializedViews} for the delete/forget path — no `_materializedFrom`
   * skip (record's gone); the `internal` gate at `_doDelete` is the recursion guard. Returns the
   * row count TOMBSTONED across EVERY MV sourced here (#638 T6 — `forgetDerivedFanout`'s
   * `derivedRecordsErased`) — eager AND lazy/manual `invalidateMVAtRest` purges both contribute now
   * (#761 item 1, previously eager-only); lazy persists a stale mark for cold-session recompute;
   * manual serves empty until `refreshView()`. `residueUndecodable`/`residueDeclined` (#776/#785) carry `outputCollection:id` entries whose ownership stamp `invalidateMVAtRest` could not decode, resp. decoded+stamp-matched but declined erasure — surfaced, not erased.
   * @internal
   */
  async dispatchMaterializedViewsOnDelete(id: string): Promise<{ deleted: number; residueUndecodable: string[]; residueDeclined: string[] }> {
    if (this.materializedViewSource === undefined) return { deleted: 0, residueUndecodable: [], residueDeclined: [] }
    // S4 gate: dynamic import only — see #derivationDeleteCtx (#842).
    const { dispatchMaterializedViewsOnDelete } = await import('../with-formula/materialized-views/dispatch.js')
    return dispatchMaterializedViewsOnDelete(this.#mvDispatchCtx(this.materializedViewSource), id)
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
    return this.strategies.search.search(this.searchContext(), field, query, opts)
  }

  /** Force-persist the lexical index now — gated behind `searchStrategy: withSearch()`. */
  flushIndex(): Promise<void> {
    return this.strategies.search.flushIndex(this.searchContext())
  }

  /** Pre-build the lexical index — gated behind `searchStrategy: withSearch()`. */
  warmIndex(): Promise<void> {
    return this.strategies.search.warmIndex(this.searchContext())
  }

  /** Retrieval (lexical | semantic | hybrid) — gated behind `searchStrategy: withSearch()`. */
  retrieve(query: string, opts: RetrieveOptions<T> = {}): Promise<RetrieveHit<T>[]> {
    return this.strategies.search.retrieve(this.searchContext(), query, opts)
  }

  /** Raw-vector kNN — gated behind `searchStrategy: withSearch()`. */
  similarTo(vector: Float32Array, opts: { k?: number; minScore?: number; includeRecord?: boolean } = {}): Promise<RetrieveHit<T>[]> {
    return this.strategies.search.similarTo(this.searchContext(), vector, opts)
  }

  /** Opt-in bulk `_vec` re-derive (#788) — a plain collection has nothing to rebuild; gated behind `searchStrategy: withSearch()` otherwise. */
  rebuildEmbeddings(): Promise<{ rebuilt: number; skipped: number }> {
    if (!this.embeddings) return Promise.resolve({ rebuilt: 0, skipped: 0 })
    return this.strategies.search.rebuildEmbeddings(this.searchContext())
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
   * revert on mid-batch failure. On a store that declares `txAtomic`
   * the whole batch is instead submitted as ONE `store.tx()` call with
   * per-leg CAS (#921) — genuinely all-or-nothing, with history/ledger/
   * change events firing after the batch is durable. Atomic mode throws
   * on failure rather than returning a mixed-results object.
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
   * Atomic-mode implementation of {@link putMany} — both branches live in
   * `kernel/put-many-atomic.ts`: #921 delegates the batch through ONE
   * `store.tx()` on a `txAtomic` store when the single-collection
   * reduction of the #906 gate admits it (store bits + no duplicate ids +
   * `_txAtomicSafe('put')`); anything else keeps the sequential pre-flight
   * → execute → best-effort-revert loop.
   *
   * @internal
   */
  private putManyAtomic(
    entries: ReadonlyArray<readonly [id: string, record: T, opts?: PutManyItemOptions]>,
  ): Promise<PutManyResult> {
    return runPutManyAtomic(
      { host: this, store: this.adapter, vault: this.vault, name: this.name, derivationSource: this.derivationSource },
      entries,
    )
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
      // Binds a keyset cursor to this collection (#1346).
      identity: `${this.vault}/${this.name}`,
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
    return new Query<T, S, Q, M>(source, undefined, joinContext, this.strategies.reduce)
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
    const envelopes = await this.strategies.history.getHistoryEntries(
      this.adapter, this.vault, this.name, id, options,
    )
    if (await liveRecordIsElevated(this.adapter, this.vault, this.name, id)) return [] // #712: elevated ≡ invisible

    const entries: HistoryEntry<T>[] = []
    for (const env of envelopes) {
      if ((env._tier ?? 0) > 0) continue // #712: defensive — a per-version tiered snapshot
      // History reads skip schema validation — see getVersion() docs.
      const record = await this.codec.decryptRecord(this.strategies.history.historyIdentity(this.name, id, env._v), env, { skipValidation: true, }) // #1041: _history identity
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
    const envelope = await this.strategies.history.getVersionEnvelope(
      this.adapter, this.vault, this.name, id, version,
    )
    if (!envelope || (envelope._tier ?? 0) > 0 || await liveRecordIsElevated(this.adapter, this.vault, this.name, id)) return null
    return this.codec.decryptRecord(this.strategies.history.historyIdentity(this.name, id, envelope._v), envelope, { skipValidation: true, }) // #1041: _history storage identity, not the live record's
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
    return this.strategies.history.diff(recordA, versionB === undefined || versionB === 0
      ? (versionB === 0 ? null : await this.resolveCurrentOrVersion(id))
      : await this.resolveVersion(id, versionB))
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
    const pruned = await this.strategies.history.pruneHistory(
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
    return this.strategies.history.clearHistory(this.adapter, this.vault, this.name, id)
  }

  // ─── Core Methods ─────────────────────────────────────────────

  /**
   * Count records in the collection.
   *
   * In eager mode this returns the in-memory cache size (instant). In lazy
   * mode it counts only LIVE tier-0 envelopes via envelope inspection — no
   * record bodies loaded — matching eager's tombstone/tier exclusion (#706).
   */
  async count(): Promise<number> {
    if (this.lazy) {
      return countLiveEnvelopes(this.adapter, this.vault, this.name, this.storeCiphertext)
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
      if (envelope && (envelope._tier ?? 0) === 0) {
        const record = await this.codec.decryptRecord({ collection: this.name, id }, envelope, { sealedAsHandles: true })
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
      // Public scan/listPage output + opportunistic cache fill — sealed fields stay handles; elevated records are invisible (#706: gate BEFORE decrypt or the warm cekCache leaks tier plaintext, audit-free).
      if ((envelope._tier ?? 0) > 0) continue
      const record = await this.codec.decryptRecord({ collection: this.name, id }, envelope, { sealedAsHandles: true })
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
    this.emitter.emit('change', { vault: this.vault, collection: this.name, id, action: (await this.get(id)) !== null ? 'put' : 'delete' }) // rare revert path — one read buys a semantically-correct event
  }

  async _invalidateCacheEntry(id: string): Promise<void> {
    if (this.lazy && this.lru) {
      this.lru.remove(id)
      return
    }
    const envelope = await this.adapter.get(this.vault, this.name, id)
    // #606: this is the single choke point every sync-apply / tab-mirror /
    // cutover write (plus tx/derivation-revert restores) funnels through, so
    // it's also where the marker-id set tracks a remote marker landing or
    // clearing. MUST run before the `!hydrated` gate below — a marker can
    // land while this collection is still mid-hydration, and hydration
    // snapshots its id list at loop start, so it can never recover an id it
    // never listed. Missing this here permanently drops the id from
    // `markerIds` for the session and reintroduces the #589 divergence.
    if (envelope && isDeleteMarker(envelope)) this.markerIds.add(id)
    else this.markerIds.delete(id)
    if (!this.hydrated) return
    const previous = this.cache.get(id)
    if (!envelope) {
      this.cache.delete(id)
      if (previous) {
        this.indexes?.remove(id, previous.record)
        this.uniqueConstraints?.remove(id, previous.record)
      }
      return
    }
    // Handle-form for the cache (non-residency for sensitive fields).
    const record = await this.codec.decryptRecord({ collection: this.name, id }, envelope, { sealedAsHandles: true })
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
    ctx?: { readonly record?: T; readonly version?: number; readonly prior?: Record<string, unknown> | null },
  ): Promise<void> {
    // #606: maintain `markerIds` synchronously, in the SAME continuation as
    // the caller's own `local.put` of this envelope (no `await` between
    // them) — closes the window where a concurrent `put(id)` could read the
    // set before `_invalidateCacheEntry`'s (awaited, below) maintenance
    // catches up. A superset for a moment on a sync-applied tombstone is
    // harmless — `_invalidateCacheEntry`'s read refines it, and a re-create
    // racing ahead of that just does one extra (correct) store read. Gated to
    // eager+synced: lazy mode never consults `markerIds`, and unsynced
    // collections never see markers.
    if (this.onDirty && !this.lazy) {
      if (action === 'delete') this.markerIds.add(id)
      else this.markerIds.delete(id)
    }
    switch (origin) {
      case 'local-write': {
        const record = ctx!.record!
        const version = ctx!.version!
        await this.onDirty?.(this.name, id, 'put', version)
        this.emitter.emit('change', { vault: this.vault, collection: this.name, id, action: 'put' } satisfies ChangeEvent)
        this.searchIndexStore?.markDirty() // zero-cost for non-search collections
        await this.onAccess?.('put', id)
        await this.dispatchDerivations(id, record, version, undefined, ctx!.prior)
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
      if (envelope && !isTombstone(envelope, this.storeCiphertext) && !isDeleteMarker(envelope) && (envelope._tier ?? 0) === 0) {
        const record = await this.codec.decryptRecord({ collection: this.name, id }, envelope, { sealedAsHandles: true })
        if (record === null) continue
        this.cache.set(id, { record, version: envelope._v })
      } else if (envelope && isDeleteMarker(envelope)) {
        this.markerIds.add(id) // #606: seed the marker-id set from disk on cold hydration
      }
    }
    this.hydrated = true
    this.rebuildEagerIndexesFromCache()
    this.rebuildUniqueConstraintsFromCache()
  }

  /** Hydrate from a pre-loaded snapshot (used by Vault). */
  async hydrateFromSnapshot(records: Record<string, EncryptedEnvelope>): Promise<void> {
    for (const [id, envelope] of Object.entries(records)) {
      if (isDeleteMarker(envelope)) { this.markerIds.add(id); continue } // #606: seed from a pre-loaded snapshot too
      if (isTombstone(envelope, this.storeCiphertext) || (envelope._tier ?? 0) > 0) continue
      const record = await this.codec.decryptRecord({ collection: this.name, id }, envelope, { sealedAsHandles: true })
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
    // tree-shake refactor: delegate to `blobsStrategy`. The default
    // is `NO_BLOBS` (throws with a message pointing at the `@noy-db/hub/blobs`
    // subpath). Users who want blob storage pass `blobs()` from that
    // subpath into `createNoydb({ blobsStrategy: blobs() })`, which
    // threads the active strategy through Vault → Collection.
    return this.strategies.blobs.openSlot({
      store: this.adapter,
      vault: this.vault,
      collection: this.name,
      recordId: id,
      getDEK: this.getDEK,
      encrypted: this.storeCiphertext,
      userId: this.keyring.userId,
      erasableBlobs: this.perRecordCek, tiersActive: this.tiers !== null, keyring: this.keyring,
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
      result[id] = await this.codec.encryptRecord({ collection: this.name, id }, entry.record, entry.version, cek, undefined, undefined, this.vdigFields !== null ? { id, prev: prevForVdig } : undefined)
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
    await this.adapter.delete(this.vault, '_vec', encodeVecId(this.name, id))
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
        const json = await this.codec.decryptJsonString({ collection: this.name, id }, envelope)
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
        `\`createNoydb({ indexingStrategy: withIndexing() })\`.`,
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
      canonicalizeIndexKey: (f: string, v: unknown) => this.via?.canonicalizeIndexKey(f, v),
      ensurePersistedIndexesLoaded: () => this.ensurePersistedIndexesLoaded(),
      // #684: raw-fetch seam — post-filter runs against the RAW record;
      // only survivors are decoded via `decodeRecord` below.
      getRawRecord: (id: string) => this.#getRaw(id),
      decodeRecord: (record: unknown) => this.applyLocaleToRecord(record as T, undefined),
      via: () => this.via,
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

  /** tier-aware put — gated behind `tiersStrategy: withTiers()`. `searchResidue: true` = stuck search compensation (#774, mirroring #764's elevate/demote posture); the write itself always completes. */
  putAtTier(id: string, record: T, tier: number, opts?: { elevation?: { reason: string; fromTier: number }; source?: string; sourceTs?: string }): Promise<TierMoveResult> {
    return this.strategies.tiers.putAtTier(this.tiersContext(), id, record, tier, opts)
  }

  /** tier-aware get — gated behind `tiersStrategy: withTiers()`. */
  getAtTier(id: string): Promise<T | GhostRecord | null> {
    return this.strategies.tiers.getAtTier(this.tiersContext(), id)
  }

  /** list ids grouped by the caller's readability — gated behind `withTiers()`. */
  listAtTier(): Promise<Array<{ id: string; tier: number; readable: boolean }>> {
    return this.strategies.tiers.listAtTier(this.tiersContext())
  }

  /** elevate a record to a higher tier — gated behind `withTiers()`. `searchResidue: true` = stuck search compensation (#764); the move itself always completes. */
  elevate(id: string, toTier: number): Promise<TierMoveResult> {
    return this.strategies.tiers.elevate(this.tiersContext(), id, toTier)
  }

  /** demote a record to a lower tier — gated behind `withTiers()`. Same `searchResidue` posture as {@link elevate} (#764). */
  demote(id: string, toTier: number): Promise<TierMoveResult> {
    return this.strategies.tiers.demote(this.tiersContext(), id, toTier)
  }

  /**
   * Emit a cross-tier access event. The subscriber sink stays collection-resident (it captures `onCrossTierAccess`); the tiers module reaches it via the {@link TiersContext.emitCrossTierEvent} callback.
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
  _setVia(pipeline: ViaPipeline | undefined): void { this.via = pipeline; this.codec.setVia(this.via) } // @internal applyTaintOverlay()'s typed writer seam — assigns `via` + resyncs the codec (fixes #666)
  get _viaFieldsSnapshot(): { i18nFields: Record<string, I18nTextDescriptor> | undefined; lookupFields: Record<string, LookupDescriptor> | undefined } { return { i18nFields: this.i18nFields, lookupFields: this.lookupFields } } // @internal reconcile.ts's presentForJoin-rebuild union reader (#671 item 3)
  async _assertWriteGates(): Promise<void> { await this.schemaUpdateGate?.assertWritable(); await this.schemaFence?.assertWritable(this.name) } // @internal #906 — the two refusals `put()`/`delete()` assert BEFORE anything else: the schema-update gate (an opt-in but persistent `reject` decision) and the schema fence (stale generation → MigrationRequiredError; draining/migrating vault or pending per-collection cutover → SchemaFenceError). Neither lives in the prepare halves, and the atomic commit path calls those directly — so it asserts here, per op, mirroring put()/delete() exactly (the fence does a fresh store read per call, so per-op matches today's cost model). Deliberately NOT moved into the prepare halves: that would double-assert on the OCC path.

  /**
   * @internal #931 — the after-write OBSERVERS `put()`/`delete()` fire in
   * their wrappers (user `onAfterWrite` hooks, then the `afterPut`/
   * `afterDelete` observe bus), replayed for one atomic-path leg after its
   * finalize. Neither can refuse a completed write, so since #931 they no
   * longer gate `_txAtomicSafe`; skipping them silently would still be a
   * policy hole (forget's subject index and the cross-tab write relay are
   * both wired this way), so the atomic path calls this per leg. The
   * WriteEvent is built from the prepared carrier — same prior basis the
   * wrappers use — and the same re-entrancy guards apply (`runAfter`
   * suppresses nested hook firing; the bus gate checks `dispatching`).
   */
  async _fireAtomicAfterWrite(opType: 'put' | 'delete', prepared: PreparedPut<T> | PreparedDelete<T>): Promise<void> {
    const hooksActive = this.#hooksActive()
    const busPoint = opType === 'put' ? 'afterPut' as const : 'afterDelete' as const
    const busActive = (this.subsystemBus?.hasHandlers(busPoint) ?? false) && !(this.subsystemBus?.dispatching ?? false)
    if (!hooksActive && !busActive) return
    const base = { vault: this.vault, collection: this.name, userId: this.keyring.userId, timestamp: Date.now(), txId: this.#txIdForHook() }
    const event: WriteEvent = opType === 'put'
      ? { ...base, op: (prepared as PreparedPut<T>).prior ? 'update' : 'create', docId: prepared.id, before: (prepared as PreparedPut<T>).prior?.record ?? null, after: (prepared as PreparedPut<T>).event, baseVersion: (prepared as PreparedPut<T>).prior?.version ?? 0, version: (prepared as PreparedPut<T>).version }
      : { ...base, op: 'delete', docId: prepared.id, before: (prepared as PreparedDelete<T>).existing?.record ?? null, after: null, baseVersion: (prepared as PreparedDelete<T>).existing?.version ?? 0, version: ((prepared as PreparedDelete<T>).existing?.version ?? 0) + 1 }
    if (hooksActive) await this.writeHooks!.runAfter(event)
    if (busActive) await this.subsystemBus!.dispatch(busPoint, event)
  }
  _txAtomicSafe(opType: 'put' | 'delete'): boolean { if ((this.materializedViewSource !== undefined && (this.materializedViewSource.registry().hasPendingPlans() || this.materializedViewSource.registry().mvsForSource(this.name).length > 0)) || (this.derivationSource !== undefined && this.derivationSource.registry().strategiesForSource(this.name).length > 0) || this.crdtMode !== undefined || this.uniqueConstraints !== null || (this.writeHooks !== undefined && this.writeHooks.hasBeforeHandlers && !this.writeHooks.suppressed)) return false; return opType === 'put' ? Object.keys(this._refs).length === 0 : this.refEnforcer === undefined || !this.refEnforcer._deleteCascadesPossible(this.name) } // @internal #893/#906-prep atomic-commit eligibility gate (Task 4) — false on any derivation/MV source (any lifecycle), false while ANY query-form MV plan is still parked (#1139: an unplanned strategy has no `_bySource` entry, so `mvsForSource` cannot see that this collection is one of its sources — and the atomic path skips MV dispatch, which is the very thing that would replan it), CRDT mode, unique constraints, or refs on this write direction. Put uses precise outbound `_refs`; delete (#922) consults the enforcer's `_deleteCascadesPossible(name)` — Vault unions ALL THREE cascade sources `enforceRefsOnDelete` (with-shape/links/vault-facade.ts) fires from (lookup-ref edges, classic inbound refs, managed links); anything narrower (e.g. `getInbound` alone) would admit unsafe atomic deletes, because `_prepareDelete` runs those cascades DURING prepare. #931 narrows #906's hooks blanket: only BEFORE-hooks gate (they can REFUSE a write, which only `put()`/`delete()` honors); after-hooks and the `afterPut`/`afterDelete` observe bus cannot refuse, so the atomic path fires them itself post-finalize via `_fireAtomicAfterWrite` instead of forfeiting the batch (the pre-#931 db-global blanket cost multi-tab write-relay and forget-subject apps the atomic path entirely). See atomic-eligibility.ts.
  _reconcileReadState(patch: { dictKeyFields?: Record<string, DictKeyDescriptor | StaticDictDescriptor>; i18nFields?: Record<string, I18nTextDescriptor>; lookupFields?: Record<string, LookupDescriptor>; getDictionary?: (name: string) => Promise<DictionaryHandle>; presentForJoin?: (record: unknown, locale: string) => unknown }): void { // @internal reconcile.ts's ONE late-attach writer for #671 items 1-3 — descriptor maps merge (construction wins on collision), getDictionary/presentForJoin assign (getDictionary never clobbers a live closure)
    if (patch.dictKeyFields) this.dictKeyFields = { ...patch.dictKeyFields, ...this.dictKeyFields }
    if (patch.i18nFields) this.i18nFields = { ...patch.i18nFields, ...this.i18nFields }
    if (patch.lookupFields) this.lookupFields = { ...patch.lookupFields, ...this.lookupFields }
    if (patch.getDictionary && this.getDictionary === undefined) this.getDictionary = patch.getDictionary
    if (patch.presentForJoin) this.presentForJoin = patch.presentForJoin
  }
  /**
   * Bind the {@link TiersContext} the tier ops need — `cekCache` by reference (same `Lru` the read/write path owns) for a synchronous re-wrap; `syncDerived` closes over `this` for {@link syncDerivedOutputs} (#722).
   */
  private tiersContext(): TiersContext<T> {
    return {
      name: this.name,
      vault: this.vault,
      adapter: this.adapter,
      keyring: this.keyring,
      codec: this.codec,
      cekCache: this.cekCache,
      syncCache: (id: string, e: { record: T; version: number } | null) => { if (e) this.cache.set(id, e); else this.cache.delete(id); this.lru?.remove(id) },
      syncIndexes: (id: string, rec: T | null, version: number, priorEnvelope?: EncryptedEnvelope) => syncTierIndexesImpl(this.indexingContext(), id, rec, version, priorEnvelope),
      syncSearch: (id: string, rec: T | null, version?: number) => syncTierSearchImpl(this.searchContext(), id, rec, version),
      syncHistory: async (id: string, fromDek: EnclaveKey, toDek: EnclaveKey) => this.strategies.history.rewrapHistory(this.adapter, this.vault, this.name, id, fromDek, toDek, await this.getDEK(this.name)),
      saveHistorySnapshot: async (id: string, version: number, seal: (address: RecordIdentity) => Promise<EncryptedEnvelope>) => { // #728: gate folded in here so tiers/index.ts stays simple; review fix — mirror put()'s save→emit→prune parity (maxVersions was unbounded on tier moves)
        if (this.historyConfig.enabled === false) return
        const envelope = await seal(this.strategies.history.historyIdentity(this.name, id, version)) // #1041
        await this.strategies.history.saveHistory(this.adapter, this.vault, this.name, id, envelope)
        this.emitter.emit('history:save', { vault: this.vault, collection: this.name, id, version: envelope._v })
        if (this.historyConfig.maxVersions) await this.strategies.history.pruneHistory(this.adapter, this.vault, this.name, id, { keepVersions: this.historyConfig.maxVersions })
      },
      historyEnabled: this.historyConfig.enabled !== false && this.strategies.history !== NO_HISTORY, // #728/#737: lets putAtTier skip decrypting `existing` when no real history strategy is wired
      syncBlobs: (id: string, fromTier: number, toTier: number) => this.strategies.blobs !== NO_BLOBS ? this.blob(id).syncTierMove(fromTier, toTier, this.blobTierPolicy) : Promise.resolve(), // #724 I1: gate on blob storage enabled (not on declared blobFields) so undeclared-field blobs still rehome; #746: syncTierMove mints/resumes the rehome journal marker; self-no-ops on an empty slot map
      syncLedger: async (id: string) => { await this.ledger?.purgeRecordDeltas(this.name, id) },
      syncDerived: (id: string, record: T | null, elevated: boolean, version?: number) => syncDerivedOutputs(this, id, record, elevated, version),
      hasDerivedOutputs: (this.materializedViewSource !== undefined && this.materializedViewSource.registry().mvsForSource(this.name).length > 0) || (this.derivationSource !== undefined && this.derivationSource.registry().strategiesForSource(this.name).length > 0), // #737: source-grained (was vault-grained) — a derivation-free tiered collection skips the pre-move decode even when other collections in the vault have derivations
      provenance: this.provenance,
      tiers: this.tiers,
      tierMode: this.tierMode,
      getDEK: (key: string) => this.getDEK(key),
      emitCrossTierEvent: (event) => this.emitCrossTierEvent(event),
      addSubjectRef: (id: string, record: T) => this.addSubjectRef?.(id, record) ?? Promise.resolve(),
    }
  }

  /**
   * Bind the {@link IndexingContext} the index-maintenance surface needs. The
   * eager `cache` Map and the index / unique-constraint / persisted mirrors are
   * passed by reference (the SAME instances the query path reads, never
   * copied); the `persistedIndexesLoaded` flag and `ensure*` hydration stay collection-resident, reached via callbacks.
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
