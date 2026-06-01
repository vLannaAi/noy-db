import type { NoydbStore, EncryptedEnvelope, ChangeEvent, HistoryConfig, HistoryOptions, HistoryEntry, PruneOptions, ListPageResult, LocaleReadOptions, ConflictPolicy, CollectionConflictResolver, PutManyItemOptions, PutManyOptions, PutManyResult, DeleteManyResult } from './types.js'
import { NOYDB_FORMAT_VERSION } from './types.js'
import type { CrdtMode, CrdtState, LwwMapState, RgaState } from './crdt/crdt.js'
import { NO_CRDT, type CrdtStrategy } from './crdt/strategy.js'
import type { I18nTextDescriptor } from './i18n/core.js'
import type { DictKeyDescriptor } from './i18n/dictionary.js'
import { NO_I18N, type I18nStrategy } from './i18n/strategy.js'
import { encrypt, decrypt, encryptDeterministic } from './crypto.js'
import { ConflictError, ReadOnlyError, TranslatorNotConfiguredError, TierDemoteDeniedError } from './errors.js'
import { dekKey, assertTierAccess } from './team/tiers.js'
import type { GhostRecord, TierMode, CrossTierAccessEvent } from './types.js'
import type { UnlockedKeyring } from './team/keyring.js'
import { hasWritePermission } from './team/keyring.js'
import type { NoydbEventEmitter } from './events.js'
import type { WriteQueueTracker } from './write-queue.js'
import type { WriteHookRegistry, WriteEvent } from './write-hooks.js'
import type { SubsystemBus } from './subsystem-bus.js'
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
import { IndexWriteFailureError } from './errors.js'
import type { RefDescriptor } from './refs.js'
import { Lru, parseBytes, estimateRecordBytes, type LruStats } from './cache/index.js'
import { generateULID } from './bundle/ulid.js'
import type { PresenceHandle, PresenceHandleOpts } from './team/presence.js'
import { NO_SYNC, type SyncStrategy } from './team/sync-strategy.js'
import type { BlobSet } from './blobs/blob-set.js'
import { NO_BLOBS, type BlobStrategy } from './blobs/strategy.js'
import { NO_AGGREGATE, type AggregateStrategy } from './aggregate/strategy.js'
import type { GuardRegistry } from './guards/registry.js'
import type { ReadOnlyVaultFacade } from './guards/types.js'
// Type-only — runtime class loaded via dynamic import in the
// frozen-field branch of `put()` / amendment paths. Keeps the guard
// executor chunk out of the floor bundle (#130).
import type { GuardExecutor as GuardExecutorType } from './guards/executor.js'
import type { DerivationRegistry } from './derivations/registry.js'
import type { TxContext, ExecutedOp } from './tx/transaction.js'
import { revertExecuted } from './tx/transaction.js'
// Type-only — runtime class loaded via dynamic import in
// `dispatchDerivations` when an eager-mode strategy fires. Keeps the
// derivation executor chunk out of the floor bundle (#130).
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
   * Map of field name → `DictKeyDescriptor` for fields declared with
   * `dictKey()`. Used by `get()`/`list()` to add `<field>Label` virtual
   * fields when a locale is requested.
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
   * declared deterministic fields. `null` when the feature
   * is inactive for this collection; a frozen `Set` otherwise.
   */
  private readonly deterministicFields: ReadonlySet<string> | null

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
   * accounting-period write guard. Called BEFORE any
   * adapter write with:
   *   - `existing` — the prior envelope's `_ts` and decrypted record
   *     (or `null` if no prior envelope exists)
   *   - `incoming` — the record being written (or `null` for delete)
   *
   * Throws `PeriodClosedError` if either side falls inside a closed
   * period. Installed by Vault; no-op when no period has been closed.
   * Async so the Vault can lazy-load the period list from the
   * adapter on first use.
   */
  private readonly periodGuard:
    | ((
        existing: { ts: string | null; record: Record<string, unknown> | null } | null,
        incoming: Record<string, unknown> | null,
      ) => Promise<void>)
    | undefined

  /**
   * Optional back-reference to the owning vault's guard registry + a
   * read-only vault facade. When present, `Collection.put` and
   * `Collection.delete` consult the registry for guards declared
   * against this collection and run their `check` + `frozenFields`
   * before the adapter write. Absent in unit tests that construct
   * a Collection directly; production code always sets it via
   * `Vault.collection()`.
   *
   * Typed structurally rather than as `Vault` to avoid a circular
   * import (mirrors the `refEnforcer` / `joinResolver` pattern).
   */
  private readonly guardSource:
    | {
        registry(): GuardRegistry
        readOnlyVault(): ReadOnlyVaultFacade
      }
    | undefined

  /**
   * Vault-internal hook for derivation dispatch. When set,
   * `Collection.put` consults the registry after the source-write
   * commits and writes derived outputs through `getCollection(name).put`.
   * Same structural-interface pattern as `guardSource` to avoid a
   * circular Vault import.
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
         * bulk-put source ops (#133).
         */
        createTxContext(): TxContext
        /** Publish a TxContext for the duration of a bulk-atomic loop. */
        setActiveTxContext(ctx: TxContext): void
        /** Drop a previously-published TxContext (defensive no-op if mismatched). */
        clearActiveTxContext(ctx: TxContext): void
      }
    | undefined

  /**
   * Vault-internal hook for materialized-view dispatch (#143/#150).
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
     * Vault-level in-flight write tracker (#227). When present,
     * `put`/`delete` run inside `writeQueue.track()` so `hub.writeQueue`
     * reflects outstanding writes. Optional so direct Collection
     * construction in tests still works untracked.
     */
    writeQueue?: WriteQueueTracker | undefined
    /** #245 — per-collection schema-update gate; `put`/`delete` await it. */
    schemaUpdateGate?: SchemaUpdateGate | undefined
    /** #232 — vault-level fence controller; `put`/`delete` consult it. */
    schemaFence?: SchemaFenceController | undefined
    /** #230 — hub-level write-hook registry; fired around put/delete. */
    writeHooks?: WriteHookRegistry | undefined
    /** Track A — the observe bus, threaded from Noydb. */
    subsystemBus?: SubsystemBus | undefined
    /** #230 — active transaction id supplier (null outside a transaction). */
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
    /** — dictKey field descriptors for label resolution on reads. */
    dictKeyFields?: Record<string, DictKeyDescriptor> | undefined
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
    periodGuard?: (
      existing: { ts: string | null; record: Record<string, unknown> | null } | null,
      incoming: Record<string, unknown> | null,
    ) => Promise<void>
    /**
     * Optional back-reference to the owning vault's guard registry +
     * read-only facade. When present, put/delete consult registered
     * guards for this collection. Same structural-interface pattern
     * as `refEnforcer` to avoid a circular Vault import.
     */
    guardSource?: {
      registry(): GuardRegistry
      readOnlyVault(): ReadOnlyVaultFacade
    } | undefined
    /**
     * Optional back-reference to the owning vault's derivation
     * registry + collection accessor. When present, successful
     * `put()` dispatches registered derivation strategies for the
     * source collection. Same structural-interface pattern as
     * `guardSource` to avoid a circular Vault import.
     */
    derivationSource?: {
      registry(): DerivationRegistry
      getCollection(name: string): Collection<Record<string, unknown>>
      /**
       * Read-only vault facade handed to `derive(source, ctx)` so a
       * derivation can fetch sibling records (#147). Same shape and
       * instance the guards subsystem uses for `check(incoming, ctx)`.
       */
      getReadOnlyFacade(): ReadOnlyVaultFacade
      /**
       * Read access to the owning Noydb's currently-active multi-record
       * transaction context, or `null` when no transaction is running.
       * `dispatchDerivations` consults this so a recursive derived-output
       * write can register its pre-write envelope onto `ctx._executed`
       * and roll back alongside the source op on mid-batch failure (#133).
       */
      getActiveTxContext(): TxContext | null
      /**
       * Construct a transient TxContext bound to the owning Noydb. Used
       * by `Collection.putManyAtomic` to publish an active context for
       * its Phase 2 loop (#133).
       */
      createTxContext(): TxContext
      /** Publish a TxContext for the duration of a bulk-atomic loop. */
      setActiveTxContext(ctx: TxContext): void
      /** Drop a previously-published TxContext. */
      clearActiveTxContext(ctx: TxContext): void
    } | undefined
    /**
     * Vault-internal hook for materialized-view dispatch (#143/#150).
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
    this.dictKeyFields = opts.dictKeyFields
    this.dictLabelResolver = opts.dictLabelResolver
    this.i18nPutValidator = opts.i18nPutValidator
    this.autoTranslateHook = opts.autoTranslateHook
    this.defaultLocale = opts.defaultLocale
    this.crdtMode = opts.crdt
    this.syncAdapter = opts.syncAdapter
    this.onAccess = opts.onAccess
    this.periodGuard = opts.periodGuard
    this.guardSource = opts.guardSource
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

    // register CRDT conflict resolver with SyncEngine
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
        const merged = this.crdtStrategy.mergeCrdtStates(localState, remoteState)
        const mergedVersion = Math.max(local._v, remote._v) + 1
        return this.encryptJsonString(JSON.stringify(merged), mergedVersion)
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

    // Lazy-MV resolve-on-read (#151). When the collection being read
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
    return JSON.parse(json) as CrdtState
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
   * (#227) so `hub.writeQueue.pending` reflects this write.
   *
   * @param id      Record identifier.
   * @param record  The record body (validated by the collection's schema
   *                if one was attached at `vault.collection(...)` time).
   * @param options Optional metadata for audit + import workflows.
   *                `reason` is stamped onto the resulting ledger entry
   *                (see #1) so audit consumers can filter via
   *                `entries.filter(e => e.reason?.startsWith('import:'))`.
   */
  async put(id: string, record: T, options?: { readonly reason?: string }): Promise<void> {
    // #245 — refuse the write if an update strategy rejected the schema
    // change. Awaited OUTSIDE track() so a rejected write never counts
    // toward writeQueue.depth.
    await this.schemaUpdateGate?.assertWritable()
    await this.schemaFence?.assertWritable(this.name) // #232
    // TODO(#232-slice2 / #230-followup): putManyAtomic / tx-execute / CRDT /
    // blob write paths are not yet tracked by writeQueue nor fired through
    // the write hooks.
    let event: WriteEvent | undefined
    if (this.#hooksActive()) {
      const prior = await this.#priorForHook(id)
      event = {
        op: prior.record === null ? 'create' : 'update',
        vault: this.vault, collection: this.name, docId: id, before: prior.record, after: record,
        userId: this.keyring.userId, timestamp: Date.now(), txId: this.#txIdForHook(),
        baseVersion: prior.version, version: prior.version + 1,
      }
      await this.writeHooks!.runBefore(event) // throw → aborts the write
    }
    if (this.writeQueue) await this.writeQueue.track(() => this.putInternal(id, record, options))
    else await this.putInternal(id, record, options)
    if (event) await this.writeHooks!.runAfter(event)
  }

  /** @internal #230 — true when hooks should fire for this write (handlers exist, not re-entrant). */
  #hooksActive(): boolean {
    return this.writeHooks !== undefined && this.writeHooks.hasHandlers && !this.writeHooks.suppressed
  }

  /**
   * @internal #230/#228c — resolve the prior record for a hook's `before` and
   * its version. Critically, this uses the SAME basis `putInternal` writes from
   * (the in-memory cache in eager mode; lru-then-adapter in lazy) — NOT a fresh
   * store read — so `baseVersion`/`version` match the version actually written.
   * A separate store read would diverge once another tab has advanced the shared
   * store past this tab's cache, breaking #228c conflict detection.
   */
  async #priorForHook(id: string): Promise<{ record: unknown; version: number }> {
    if (this.lazy && this.lru) {
      const cached = this.lru.get(id)
      if (cached) return { record: cached.record, version: cached.version }
      const env = await this.adapter.get(this.vault, this.name, id)
      if (!env) return { record: null, version: 0 }
      return { record: (await this.decryptRecord(env, { skipValidation: true })) as unknown, version: env._v }
    }
    await this.ensureHydrated()
    const cached = this.cache.get(id)
    return cached ? { record: cached.record, version: cached.version } : { record: null, version: 0 }
  }

  #txIdForHook(): string {
    return this.activeTxId?.() ?? generateULID()
  }

  /** @internal Untracked put body — call {@link put}, not this. */
  private async putInternal(id: string, record: T, options?: { readonly reason?: string }): Promise<void> {
    if (!hasWritePermission(this.keyring, this.name)) {
      throw new ReadOnlyError()
    }

    // Guard hook (record lock + field freeze). Runs BEFORE the
    // period guard so a guard-blocked write fails before any
    // schema work, i18n translation, history, or ledger churn.
    // Inside an active amendment we skip the synchronous check
    // and frozen-field diff — those run at commit time on the
    // collected change-set instead.
    if (this.guardSource) {
      const registry = this.guardSource.registry()
      const guards = registry.guardsFor(this.name)
      if (guards.length > 0) {
        const existingEnv = await this.adapter.get(this.vault, this.name, id)
        let existingRecord: Record<string, unknown> | null = null
        if (existingEnv) {
          try {
            existingRecord = (await this.decryptRecord(existingEnv, { skipValidation: true })) as unknown as Record<string, unknown>
          } catch {
            existingRecord = null
          }
        }
        const incomingRecord = record as unknown as Record<string, unknown>
        const ctx = {
          existing: existingRecord,
          vault: this.guardSource.readOnlyVault(),
          userId: this.keyring.userId,
          role: this.keyring.role,
        }
        if (registry.isAmendmentActive()) {
          const vBefore = existingEnv?._v ?? 0
          // `put` deterministically bumps version by 1 — see the
          // `version = existing.version + 1` line further down in this
          // method. Computing vAfter here keeps the audit math local
          // to the call site that decides it.
          registry.collectChange(this.name, id, existingRecord, incomingRecord, vBefore, vBefore + 1)
        } else {
          await registry.runChecks(this.name, incomingRecord, ctx)
          // Dynamic-import the executor only when at least one guard
          // is registered AND a non-amendment write fires. Consumers
          // who never call `withGuard()` never reach this branch and
          // never pull `GuardExecutor` into their bundle (#130).
          const { GuardExecutor } = (await import('./guards/executor.js')) as { GuardExecutor: typeof GuardExecutorType }
          for (const g of guards) {
            await GuardExecutor.checkFrozenFields(g, id, existingRecord, incomingRecord)
          }
        }
      }
    }

    // accounting-period guard. Runs BEFORE any other
    // work so a closed-period write fails fast and leaves no partial
    // trace (no schema work, no i18n translation, no history). Reads
    // the existing envelope + decrypts the prior record so
    // business-date comparison against the closed period's
    // `dateField` can use the stored value (late entries don't slip
    // through a write-time check). For first-time inserts the prior
    // is null.
    if (this.periodGuard !== undefined) {
      const existingEnv = await this.adapter.get(this.vault, this.name, id)
      let priorRecord: Record<string, unknown> | null = null
      if (existingEnv) {
        try {
          priorRecord = (await this.decryptRecord(existingEnv, { skipValidation: true })) as unknown as Record<string, unknown>
        } catch {
          priorRecord = null
        }
      }
      await this.periodGuard(
        existingEnv ? { ts: existingEnv._ts, record: priorRecord } : null,
        record as unknown as Record<string, unknown>,
      )
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

    // Auto-translate missing i18nText translations.
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

    // i18nText validation — runs AFTER schema validation so
    // the record shape is trustworthy. Throws MissingTranslationError
    // when required translations are absent.
    if (this.i18nPutValidator !== undefined) {
      this.i18nPutValidator(record)
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
          const prevParsed = JSON.parse(prevJson) as unknown
          if (prevParsed !== null && typeof prevParsed === 'object' && '_crdt' in prevParsed) {
            existingState = prevParsed as LwwMapState
          }
        }
        crdtState = this.crdtStrategy.buildLwwMapState(record as Record<string, unknown>, existingState, now)
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
        crdtState = this.crdtStrategy.buildRgaState(arr, existingState, generateULID)
      } else {
        // yjs: record is the base64 update string (produced by @noy-db/yjs)
        crdtState = { _crdt: 'yjs', update: record as unknown as string }
      }

      const version = existingVersion + 1
      const envelope = await this.encryptJsonString(JSON.stringify(crdtState), version)
      await this.adapter.put(this.vault, this.name, id, envelope)

      // Resolve snapshot for cache and history
      const resolvedRecord = this.crdtStrategy.resolveCrdtSnapshot(crdtState) as T
      const existingResolved = existingEnvelope
        ? { record: await this.decryptRecord(existingEnvelope, { skipValidation: true }), version: existingVersion }
        : undefined

      if (existingResolved && this.historyConfig.enabled !== false) {
        const histEnvelope = await this.encryptRecord(existingResolved.record, existingResolved.version)
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
    }

    await this.onDirty?.(this.name, id, 'put', version)

    this.emitter.emit('change', {
      vault: this.vault,
      collection: this.name,
      id,
      action: 'put',
    } satisfies ChangeEvent)

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
   * no-ops in the foundation (subtask #150) — wired in #151.
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
    // #130 dynamic-import pattern v1 uses for derivations). Lazy mode
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
  private async dispatchDerivations(id: string, record: T, version: number): Promise<void> {
    if (this.derivationSource === undefined) return
    const incoming = record as unknown as Record<string, unknown>
    if (incoming && typeof incoming === 'object' && '_derivedFrom' in incoming) return
    const registry = this.derivationSource.registry()
    const strategies = registry.strategiesForSource(this.name)
    if (strategies.length === 0) return
    // Dynamic-import the executor only on the first eager-mode
    // dispatch. Lazy-mode dispatches use `markStale` (a pure helper)
    // which doesn't reach into the executor at all. Keeps the
    // derivation executor chunk out of the floor bundle for any
    // consumer that doesn't fire an eager derivation (#130).
    let DerivationExecutor: typeof DerivationExecutorType | null = null
    for (const { spec, strategyHash } of strategies) {
      const mode = typeof spec.lifecycle === 'string' ? spec.lifecycle : spec.lifecycle.mode
      if (mode === 'eager') {
        if (DerivationExecutor === null) {
          ({ DerivationExecutor } = (await import('./derivations/executor.js')) as { DerivationExecutor: typeof DerivationExecutorType })
        }
        const sourceWithId = { ...incoming, id } as Record<string, unknown> & { id: string }
        const ctx = { vault: this.derivationSource.getReadOnlyFacade() }
        const result = await DerivationExecutor.run(spec, sourceWithId, version, strategyHash, ctx)
        for (const key of Object.keys(spec.outputs)) {
          const out = result.outputs[key]
          if (!out) continue
          if (out.kind === 'failed') {
            const err = out.error
            if (spec.strict) throw err
            console.warn(`[derivation] output "${key}" for source "${spec.source}" id="${id}" failed:`, err)
            continue
          }
          const outSpec = spec.outputs[key]
          if (!outSpec) continue
          const outputCollection = this.derivationSource.getCollection(outSpec.collection)
          // #133 — if we're inside a multi-record transaction, register
          // derived writes as side-effect ops on the active ctx
          // BEFORE they fire. `revertExecuted` walks `_executed` in
          // reverse on rollback, so capturing the pre-write envelope
          // here lets a later mid-batch failure restore this output's
          // prior state alongside the source op. Outside a transaction
          // the context is null and tracking is skipped.
          const txCtx = this.derivationSource.getActiveTxContext()

          // ── Array-shape branch (#200) ──────────────────────────
          if (out.kind === 'array') {
            // Load the prior key set from the fanout sidecar.
            const { loadFanoutSidecar, saveFanoutSidecar } = await import('./derivations/fanout-sidecar.js')
            const prior = await loadFanoutSidecar(
              this.adapter,
              this.vault,
              spec.source,
              id,
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
              await outputCollection.put(entry.key, entry.value)
            }

            // Persist the new key set (last step — see spec §5.1
            // on failure-mode symmetry).
            await saveFanoutSidecar(this.adapter, this.vault, {
              source: spec.source,
              sourceId: id,
              outputKey: key,
              outputCollection: outSpec.collection,
              keys: newKeysList,
            })
            continue
          }

          // ── Record-shape branch (existing v1 behavior) ─────────
          if (out.skipped === true) {
            // #144: optional output returned null. Delete the
            // previously-emitted output at this id, if any. Routed
            // through `_internalDelete` so a user-registered
            // `onDelete` (#145) on the output collection does NOT
            // fire — this is a system-internal tombstone, not a
            // user-initiated delete. The txCtx hookup captures the
            // prior envelope inside `_internalDelete` for #133-style
            // rollback symmetry; delete-of-absent is a silent no-op.
            await outputCollection._internalDelete(id, txCtx)
            continue
          }
          if (txCtx !== null) {
            const prior = await this.adapter.get(this.vault, outSpec.collection, id)
            txCtx._executed.push({
              op: {
                type: 'put',
                vaultName: this.vault,
                collectionName: outSpec.collection,
                id,
              },
              priorEnvelope: prior,
            })
          }
          await outputCollection.put(id, out.value)
        }
      } else {
        await markStale(registry, spec, id)
      }
    }
  }

  /**
   * Delete a record by ID. Runs inside the hub's write-queue tracker
   * (#227) so `hub.writeQueue.pending` reflects this write.
   */
  async delete(id: string): Promise<void> {
    await this.schemaUpdateGate?.assertWritable() // #245
    await this.schemaFence?.assertWritable(this.name) // #232
    let event: WriteEvent | undefined
    if (this.#hooksActive()) {
      const prior = await this.#priorForHook(id)
      event = {
        op: 'delete', vault: this.vault, collection: this.name, docId: id, before: prior.record, after: null,
        userId: this.keyring.userId, timestamp: Date.now(), txId: this.#txIdForHook(),
        baseVersion: prior.version, version: prior.version + 1,
      }
      await this.writeHooks!.runBefore(event)
    }
    if (this.writeQueue) await this.writeQueue.track(() => this.deleteInternal(id))
    else await this.deleteInternal(id)
    if (event) await this.writeHooks!.runAfter(event)
  }

  /**
   * @internal #232 — bulk-rewrite every record through a cutover transform.
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
      if (!env) continue
      const record = (await this.decryptRecord(env, { skipValidation: true })) as unknown as Record<string, unknown>
      const next = transform(record)
      const nextVersion = (env._v ?? 0) + 1
      const newEnv = await this.encryptRecord(next as unknown as T, nextVersion)
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
   * delete hooks (`onDelete`, accounting-period guard, FK ref
   * enforcer). Used by derivation tombstones (#144) and MV refresh
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
   * the #133 rollback hardening for puts. Callers outside a
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

    // Guard hook for deletes. Symmetric to put(): consult the
    // registry, decrypt the prior record (if any), then either
    // collect the {before, null} change pair into an active
    // amendment or run the guards' `onDelete` callback. Frozen-field
    // diffing is skipped (it's a put concept). Delete-of-absent is
    // a no-op — no guard is consulted because there's nothing to
    // protect, matching the idempotent-delete contract.
    //
    // For `internal === true` (system housekeeping — derivation
    // tombstones, MV refresh): `onDelete` is bypassed, but the
    // amendment change-collection still runs if a window is open.
    // This means an `amendment.invariant` paired with `onDelete` for
    // "TRULY unconditional" rules sees the system delete and can
    // reject it — closing the niwat-review gap where a derivation
    // tombstone fired during an admin amendment would otherwise
    // silently bypass both hooks.
    if (this.guardSource) {
      const registry = this.guardSource.registry()
      const guards = registry.guardsFor(this.name)
      if (guards.length > 0) {
        const existingEnv = await this.adapter.get(this.vault, this.name, id)
        if (existingEnv) {
          let existingRecord: Record<string, unknown> | null = null
          try {
            existingRecord = (await this.decryptRecord(existingEnv, { skipValidation: true })) as unknown as Record<string, unknown>
          } catch {
            existingRecord = null
          }
          if (registry.isAmendmentActive()) {
            // For deletes, the record version is the version that was
            // visible at delete time; we record vBefore = that version
            // and vAfter = same (the ledger entry's `op` discriminator
            // is `delete`, not `put`, so the consumer treats the
            // tombstone shape correctly). Fires for BOTH user and
            // system-internal deletes (#145 follow-up).
            const vBefore = existingEnv._v
            registry.collectChange(
              this.name,
              id,
              existingRecord,
              null as unknown as Record<string, unknown>,
              vBefore,
              vBefore,
            )
          } else if (!internal) {
            // Dedicated delete-time hook (#145). `check` is put-only;
            // `onDelete(existing, ctx)` receives the currently-persisted
            // record and decides whether the deletion is permitted.
            // Skipped for internal deletes — housekeeping must not trip
            // user invariants in normal-mode operation.
            const ctx = {
              existing: existingRecord,
              vault: this.guardSource.readOnlyVault(),
              userId: this.keyring.userId,
              role: this.keyring.role,
            }
            await registry.runOnDelete(
              this.name,
              existingRecord ?? {},
              ctx,
            )
          }
        }
      }
    }

    // accounting-period guard (same contract as put;
    // incoming is null because this is a delete).
    if (!internal && this.periodGuard !== undefined) {
      const existingEnv = await this.adapter.get(this.vault, this.name, id)
      let priorRecord: Record<string, unknown> | null = null
      if (existingEnv) {
        try {
          priorRecord = (await this.decryptRecord(existingEnv, { skipValidation: true })) as unknown as Record<string, unknown>
        } catch {
          priorRecord = null
        }
      }
      await this.periodGuard(
        existingEnv ? { ts: existingEnv._ts, record: priorRecord } : null,
        null,
      )
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
          existing = { record: previousRecord, version: previousEnvelope._v }
        }
      }
    } else {
      existing = this.cache.get(id)
    }

    // Save history snapshot before deleting
    if (existing && this.historyConfig.enabled !== false) {
      const historyEnvelope = await this.encryptRecord(existing.record, existing.version)
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
      }
    }

    await this.onDirty?.(this.name, id, 'delete', existing?.version ?? 0)

    this.emitter.emit('change', {
      vault: this.vault,
      collection: this.name,
      id,
      action: 'delete',
    } satisfies ChangeEvent)

    await this.onAccess?.('delete', id)

    // Symmetric to put (#181): user-initiated deletes must fire MV
    // refresh so `onEmpty: 'delete'` MVs tombstone their now-orphan
    // output rows. Gated on `!internal` to prevent recursion — the
    // MV executor's own tombstoning round-trips through
    // `_internalDelete → _doDelete(_, true)` and must NOT re-fire
    // dispatch (matches put's `_materializedFrom` skip in spirit).
    //
    // Record-shape derivations intentionally NOT dispatched on delete:
    // their derived-output id equals the source id, so the user can
    // delete the output directly with `outputCollection.delete(id)` if
    // they want. Array-shape derivations (#200) DO cascade on delete
    // because their derived ids are opaque (from the `key(out)`
    // extractor) — without cascade the rows become unfindable orphans.
    if (!internal) {
      await this.dispatchMaterializedViewsOnDelete(id)
      await this.dispatchArrayDerivationsOnDelete(id)
    }
  }

  /**
   * Cascade deletes of array-shape derived rows when a source row is
   * deleted (#200). Reads each registered strategy's fanout sidecar
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
   * Mirror of {@link dispatchMaterializedViews} for the delete path
   * (#181). No record content is available (it's gone), so the
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
    // Lazy-MV resolve-on-read (#157 review): if this collection is the
    // output of a registered lazy MV with a pending stale flag, run
    // the executor before returning so callers see fresh data. No-op
    // when nothing is pending — keeps the read path negligible.
    if (this.materializedViewSource !== undefined) {
      const { resolveStaleMVOnRead } = await import('./materialized-views/stale.js')
      await resolveStaleMVOnRead(this.materializedViewSource, this.name)
    }
    await this.ensureHydrated()
    const records = [...this.cache.values()].map(e => e.record)
    if (!locale) return records
    return Promise.all(records.map(r => this.applyLocaleToRecord(r, locale)))
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
    // #133 — when a derivation registry is wired, publish a transient
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
   * **Lazy-MV gap (#157):** `query()` is synchronous and does NOT
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
   * **Lazy-MV gap (#157):** `scan()` is synchronous-build and does
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
      if (previous) this.indexes?.remove(id, previous.record)
      return
    }
    const record = await this.decryptRecord(envelope)
    this.cache.set(id, { record, version: envelope._v })
    this.indexes?.upsert(id, record, previous ? previous.record : null)
  }

  /**
   * #228b — apply a peer tab's committed write to THIS tab's in-memory view:
   * re-read the (already-persisted) envelope from the shared store + refresh
   * cache/indexes, then emit a `change` event so reactive consumers re-render.
   * Never writes to the store and never fires write hooks, so it cannot loop.
   */
  async _applyRemoteChange(id: string, action: 'put' | 'delete'): Promise<void> {
    await this._invalidateCacheEntry(id)
    this.emitter.emit('change', { vault: this.vault, collection: this.name, id, action })
  }

  /** @internal #228c — the current in-memory record without a store read (for conflict capture). */
  _peekCached(id: string): T | null {
    const entry = this.lazy && this.lru ? this.lru.get(id) : this.cache.get(id)
    return entry ? entry.record : null
  }

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
    this.rebuildEagerIndexesFromCache()
  }

  /** Hydrate from a pre-loaded snapshot (used by Vault). */
  async hydrateFromSnapshot(records: Record<string, EncryptedEnvelope>): Promise<void> {
    for (const [id, envelope] of Object.entries(records)) {
      const record = await this.decryptRecord(envelope)
      this.cache.set(id, { record, version: envelope._v })
    }
    this.hydrated = true
    this.rebuildEagerIndexesFromCache()
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
        const body = JSON.parse(await this.decryptJsonString(env)) as { value: unknown }
        sidecar.set(decoded.recordId, body.value)
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
    if (!hasI18n && !hasDict) return record

    const locale = localeOpts?.locale ?? this.defaultLocale
    if (!locale) return record

    let result = record as unknown as Record<string, unknown>

    // 1. i18nText resolution
    if (hasI18n && this.i18nFields) {
      result = this.i18nStrategy.applyI18nLocale(result, this.i18nFields, locale, localeOpts?.fallback)
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
    const base = await this.encryptJsonString(JSON.stringify(record), version)
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
        matches.push(await this.decryptRecord(env))
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
    opts?: { elevation?: { reason: string; fromTier: number } },
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
    const plaintext = await decrypt(envelope._iv, envelope._data, dek)
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

    const plaintext = await decrypt(envelope._iv, envelope._data, fromDek)
    const { iv, data } = await encrypt(plaintext, toDek)
    const now = new Date().toISOString()
    const next: EncryptedEnvelope = {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: envelope._v + 1,
      _ts: now,
      _iv: iv,
      _data: data,
      _by: this.keyring.userId,
      _tier: toTier,
      _elevatedBy: this.keyring.userId,
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

    const plaintext = await decrypt(envelope._iv, envelope._data, fromDek)
    const { iv, data } = await encrypt(plaintext, toDek)
    const now = new Date().toISOString()
    const next: EncryptedEnvelope = {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: envelope._v + 1,
      _ts: now,
      _iv: iv,
      _data: data,
      _by: this.keyring.userId,
      ...(toTier > 0 && { _tier: toTier }),
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
