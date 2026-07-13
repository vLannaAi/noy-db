/**
 * Collection construction config — the PURE half of the `Collection`
 * constructor.
 *
 * `resolveCollectionConfig` takes the raw `CollectionOpts` the Vault threads in
 * and resolves every `?? default`, every normalized/derived field, and runs the
 * pure construction-time validations (embeddings-on-CRDT, money-field paths,
 * deterministic-risk acknowledgement). It holds **no `this`** and performs no
 * external side effect — the only objects it allocates (`Set`s, `VectorSet`,
 * the CEK `Lru`) are the same instances the collection then owns by reference.
 *
 * The `this`-dependent construction (the search-index store whose persisted
 * callback closes over `this.searchContext()`, the `RecordCodec`, and the
 * SyncEngine conflict-resolver registration) stays in the constructor — those
 * genuinely capture the live instance (and the conflict-resolver closures close
 * over `conflictPolicy: ConflictPolicy<T>`, whose invariant-in-T custom-merge
 * signature can't be exposed via a method without breaking `Collection<T>`
 * assignability to `Collection<unknown>`).
 */
import type { NoydbStore, ConflictPolicy, CollectionConflictResolver, HistoryConfig, TierMode, CrossTierAccessEvent, VdigFieldPolicy } from './types.js'
import type { EnclaveKey } from './enclave/index.js'
import type { UnlockedKeyring } from '../with-party/team/keyring.js'
import type { NoydbEventEmitter } from './events.js'
import type { WriteQueueTracker } from './write-queue.js'
import type { WriteHookRegistry } from '../port/with/write-hooks.js'
import type { ServiceBus } from '../port/with/service-bus.js'
import type { SchemaUpdateGate } from '../with-shape/schema-update/gate.js'
import type { SchemaFenceController } from '../with-shape/schema-update/fence-controller.js'
import type { StandardSchemaV1 } from './schema.js'
import type { LedgerStore } from '../with-commit/history/ledger/index.js'
import type { CrdtMode } from '../with-commit/crdt/crdt.js'
// CrdtStrategy imported directly from ./types.js (not with-commit/crdt/strategy.js)
// — #667: collection-config.ts sits in the shared dts chunk with types.ts, so
// routing this through strategy.ts's re-export closed a cycle in the dts rollup
// graph. NO_CRDT (a runtime value, only defined in strategy.ts) still comes from there.
import { NO_CRDT } from '../with-commit/crdt/strategy.js'
import type { CrdtStrategy } from './types.js'
import { NO_HISTORY, type HistoryStrategy } from '../with-commit/history/strategy.js'
import { NO_I18N, type I18nStrategy } from '../port/with/i18n-strategy.js'
import { NO_SYNC, type SyncStrategy } from '../with-party/team/sync-strategy.js'
import { NO_BLOBS, type BlobStrategy } from '../port/with/blob-strategy.js'
import { NO_AGGREGATE, type AggregateStrategy } from '../with-lookup/aggregate/strategy.js'
import { NO_TIERS, type TiersStrategy } from '../with-audit/tiers/strategy.js'
import { NO_SEARCH, type SearchStrategy } from '../with-lookup/search/strategy.js'
import type { ObjectProjection } from '../with-shape/blobs/object-projection.js'
import type { BlobFieldsConfig } from '../with-shape/blobs/blob-compaction.js'
import type { IndexStrategy } from '../with-lookup/indexing/strategy.js'
import type { IndexDef } from '../with-lookup/indexing/eager-indexes.js'
import type { I18nTextDescriptor, DictKeyDescriptor, StaticDictDescriptor, DictionaryHandle } from '../port/with/i18n-strategy.js'
// #650 Task 2 — `LookupDescriptor` type-only, mirroring the i18n descriptor
// imports above; no eager value import needed (lookup()/enumOf()/dict()
// each call `linkLookupVia()` themselves, so `viaBinder('lookup')` is
// already resolvable by the time a `lookupFields` entry exists).
import type { LookupDescriptor, MaterializedBacking } from '../port/with/lookup-strategy.js'
import { buildPresentForJoin } from '../port/with/lookup-strategy.js'
import type { ComputedFields, ComputedFn, ComputedFieldEntry } from '../with-formula/computed/index.js'
import type { RollupDeleteIntent } from './via/dispatch.js'
// #638 Task 7 — the value import (not just `import type`) forces the port module's eager
// `linkComputedVia()` to run whenever this file loads (collection-config.ts is always in the
// dependency graph), so `viaBinder('computed')` is resolvable before `compileViaBindings` needs it.
import '../port/with/computed-strategy.js'
import type { ComputedDescriptor } from '../port/with/computed-strategy.js'
import {
  resolveClassifiedFields, guardClassifiedCompat, NO_CLASSIFIED,
  type ClassifiedEntry, type ResolvedClassified, type ClassifiedGuardCtx, type ClassifiedStrategy, type ClassifiedViaConfig,
} from '../port/with/classified-strategy.js'
import { ClassifiedConfigError, ValidationError } from './errors.js'
import type { FieldRef, Grain } from './via/graph.js'
import type { FieldMeta } from '../with-shape/introspection/field-meta.js'
import type { CollectionMeta } from '../with-shape/introspection/meta.js'
import type { RefDescriptor } from './refs.js'
import type { JoinableSource } from './query/index.js'
import { VectorSet, type EmbeddingDescriptor } from '../with-lookup/embeddings/index.js'
import { Lru } from './cache/index.js'
import type { ReadOnlyVaultFacade } from '../with-audit/guards/types.js'
import type { DerivationRegistry } from '../with-formula/derivations/registry.js'
import type { TxContext } from '../with-commit/tx/transaction.js'
import type { MaterializedViewRegistry } from '../with-formula/materialized-views/registry.js'
import type { MVQueryContext } from '../with-formula/materialized-views/types.js'
import type { Collection, OnDirtyCallback, CacheOptions } from './collection.js'
import type { LazyStrategy } from '../port/with/lazy-strategy.js'
import { ViaPipeline } from './via/pipeline.js'
import { viaBinder, type ViaBinding, type ViaDescriptor } from './via/index.js'
import { mergeViaFields, guardCrossBindingFieldCollisions, type ViaFieldSpec } from './via/compose.js'

/**
 * Raw options handed to the {@link Collection} constructor by the Vault.
 * One named type shared by the constructor and the pure resolver.
 */
export interface CollectionOpts<T> {
  adapter: NoydbStore
  vault: string
  name: string
  keyring: UnlockedKeyring
  encrypted: boolean
  /**
   * Opt-in: keep the working set encrypted in RAM, decrypting on read (future phase).
   * Default false — the working set is plaintext.
   */
  ramCiphertext?: boolean
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
  subsystemBus?: ServiceBus | undefined
  /** Active transaction id supplier (null outside a transaction). */
  activeTxId?: (() => string | null) | undefined
  getDEK: (collectionName: string) => Promise<EnclaveKey>
  historyConfig?: HistoryConfig | undefined
  /**
   * When `true`, the caller explicitly provided `historyConfig` rather than
   * inheriting the vault-wide default. Used by `getConfig()` to decide
   * whether to surface `history: true` in the schema dump.
   */
  historyConfigExplicit?: boolean | undefined
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
   * Lazy service seam (#267) — supplies the bounded-LRU working-set cache
   * when `prefetch: false`. Omitted → the deprecated IMPLICIT_LAZY
   * back-compat default (identical behavior + one-time warn).
   */
  lazyStrategy?: LazyStrategy | undefined
  /**
   * Optional Standard Schema v1 validator (Zod, Valibot, ArkType,
   * Effect Schema, etc.). When set, every `put()` is validated before
   * encryption and every read is validated after decryption. See the
   * `schema` field docstring for the error semantics.
   */
  schema?: StandardSchemaV1<unknown, T> | undefined
  /** Declares this collection a satellite of `satelliteOf` (spec #591). */
  satelliteOf?: string | undefined
  /** Satellite routing table — the fields owned by this satellite (required with satelliteOf). */
  fields?: readonly string[] | undefined
  /** Registers the full-record joined handle under this name (optional; see vault.joined()). */
  joined?: string | undefined
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
        resolveDictSource?: (leftCollection: string, field: string) => JoinableSource | null
      }
    | undefined
  /** — i18nText field descriptors for locale-aware reads. */
  i18nFields?: Record<string, I18nTextDescriptor> | undefined
  /** — embedding config for write-time vector derivation + semantic retrieval. */
  embeddings?: EmbeddingDescriptor | undefined
  /** — string fields exposed to client-side `retrieve()`. */
  textIndexes?: readonly string[] | undefined
  /** — pre-build the lexical index on open (eager-only). */
  warmIndexOnOpen?: boolean | undefined
  /** — persist the lexical index as an opaque encrypted blob at `_ftindex/<name>`. */
  textIndexPersist?: boolean | undefined
  /** — dictKey field descriptors for label resolution on reads. */
  dictKeyFields?: Record<string, DictKeyDescriptor | StaticDictDescriptor> | undefined
  /** — consumer-neutral per-field descriptors. Read via getFieldMeta(). */
  fieldMeta?: Record<string, FieldMeta> | undefined
  /** — collection-level descriptive metadata. Read via getMeta(). */
  meta?: CollectionMeta | undefined
  moneyFields?: Record<string, ViaDescriptor> | undefined
  /** — declare via() composed fields; grouped by `_viaBrand` and merged with the money/i18n sugar keys above (a field in both throws). */
  viaFields?: Record<string, ViaFieldSpec> | undefined
  /** — outbound ref declarations (snapshot from vault refRegistry). Used by describe(). */
  declaredRefs?: Record<string, RefDescriptor> | undefined
  computed?: ComputedFields | undefined
  /** — declare classified() sensitive-field descriptors (sealed + riders + projections). */
  classifiedFields?: Record<string, ClassifiedEntry> | undefined
  /**
   * The forget-cascade subject key for this collection (from
   * `withForgetCascade({ subjects })`), plumbed by the Vault. Consumed by the
   * classified refusal matrix (R4: a digest-only field cannot be the subject key).
   */
  subjectKeyField?: string | undefined
  /** — tree-shake seam for `collection.reveal()`. Defaults to `NO_CLASSIFIED`. */
  classifiedStrategy?: ClassifiedStrategy | undefined
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
   * Async callback to open a dynamic dictionary handle.
   * Provided by the Vault for dynamic-dict label-map resolution in
   * the search index. Static dicts bypass this.
   */
  getDictionary?: ((name: string) => Promise<DictionaryHandle>) | undefined
  /**
   * synchronous callback that validates i18nText fields
   * on put. Provided by the Vault. Throws MissingTranslationError.
   */
  i18nPutValidator?: ((record: unknown) => void) | undefined
  /** — declare lookup()/enumOf()/dict() fields (#650 Task 2 sugar key, mirrors dictKeyFields), merged with `via(lookup(...))` entries. */
  lookupFields?: Record<string, LookupDescriptor> | undefined
  /**
   * async label resolver for the `'lookup'` binding's `'static'`/`'reserved'`
   * tiers. Provided by the Vault — the SAME closure as `dictLabelResolver`
   * (static table first, else the `vault.dictionary()` handle), so a
   * native `dict()`/`lookup(static)` field resolves through identical
   * label data as its `dictKey()`/`staticDict()` alias.
   */
  lookupLabelResolver?:
    | ((dimension: string, key: string, locale: string, fallback?: string | readonly string[]) => Promise<string | undefined>)
    | undefined
  /** — the matrix (`backing:'collection'`) tier's present-time row accessor, keyed by the full
   *  descriptor so it can resolve by `descriptor.key`, not the backing row's PUT-id (#651 Task 3).
   *  Provided by the Vault. */
  getLookupBacking?: ((descriptor: LookupDescriptor) => (key: string) => Promise<Record<string, unknown> | undefined>) | undefined
  /** — closed-vocabulary write-time membership test (#650 Task 3). Provided by the Vault. */
  membership?: ((field: string, key: string) => boolean | Promise<boolean>) | undefined
  /** — altKeys `ingest` normalization source (#650 Task 3). Provided by the Vault. */
  getAltIndex?: ((desc: LookupDescriptor) => MaterializedBacking | undefined) | undefined
  /**
   * — sync materialized `key -> row` rows for a lookup descriptor (#650
   * Task 6, spec §5's snapshot+locale seam; matrix-tier routing added Task
   * 7). Provided by the Vault; feeds the `'lookup'` binding's
   * `compareForOrder`/`resolveOrderLabel` and this collection's
   * `presentForJoin` hook (`resolveCollectionConfig` builds the latter via
   * `buildPresentForJoin`, below).
   */
  snapshotFor?: ((descriptor: LookupDescriptor) => ReadonlyMap<string, Record<string, unknown>> | undefined) | undefined
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
  onAccess?: (op: 'get' | 'put' | 'delete' | 'reveal' | 'verify' | 'find', id: string) => Promise<void>
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
   * gate for the classified `equatable` knob (R8 double door). Must be `true`
   * when any classified field declares `equatable: true`; otherwise construction
   * throws. One-directional — setting it with zero equatable members is a
   * silent no-op (mirrors `acknowledgeDeterministicRisk`).
   */
  acknowledgeEquatableRisk?: boolean | undefined
  /**
   * Structural group-encryption. Fields listed here are
   * encrypted into their own `_sealed[field]` envelope slot — each under
   * an HKDF-derived per-field key — instead of sitting inside the open
   * `_data` blob. Default-off: with no `sensitive` fields the envelope is
   * byte-identical to today. Read merges them back inline (the
   * `Sealed<V>`/`reveal()` access restriction is a separate follow-up).
   *
   * **Incompatible with `perRecordKeys`/forget-cascade:** sealed
   * field keys derive off the *collection* DEK, not the per-record CEK, so
   * crypto-shredding a record does not erase its sealed fields.
   */
  sensitive?: readonly string[] | undefined
  /**
   * Per-record content-encryption keys. When `true`, every record body
   * (and every history version of it) is encrypted under a fresh
   * per-record CEK, AES-KW-wrapped under the collection DEK and stored
   * on the envelope's `_cek`. Off by default. Foundation for per-record
   * erasure and record-scoped sealing. `_det` slots stay
   * keyed to the collection DEK regardless.
   */
  perRecordKeys?: boolean | undefined
  /**
   * Per-record provenance tracking. When `true`, `put()` calls that
   * supply a `source` option stamp `_source` (opaque source id) and
   * `_sourceTs` (ISO-8601 timestamp) onto the unencrypted envelope
   * metadata. Off by default — zero cost for collections that don't
   * need lineage tracking.
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
   * tree-shake seam — strategy for the collection-level tier operations
   * (`putAtTier`/`getAtTier`/`listAtTier`/`elevate`/`demote`). When omitted,
   * every tier operation throws `TiersNotEnabledError`. Enable by passing
   * `withTiers()` from `@noy-db/hub/tiers` at `createNoydb` time.
   */
  tiersStrategy?: TiersStrategy | undefined
  /**
   * Search / retrieval capability strategy. When omitted, a collection's
   * `search`/`retrieve`/`similarTo`/`warmIndex`/`flushIndex` methods and the
   * embedding write-hook throw `SearchNotEnabledError`. Enable by passing
   * `withSearch()` from `@noy-db/hub` at `createNoydb` time.
   */
  searchStrategy?: SearchStrategy | undefined
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
     * instance the guards service uses for `check(incoming, ctx)`.
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
  /**
   * #638 Task 4 — thin collector hook wired by the Vault (`Vault._collectGraphTouch`). Every
   * `sync-apply`/`cutover`/`restore` mutation origin calls `collect(this.name, id)`; a no-op
   * when no batch is open (`_beginGraphBatch()` wasn't called) or the vault has no graph.
   * `collectDelete` (#640) is the sync-apply delete socket — the resolved rollup-parent intents
   * for a deleted record, captured pre-invalidation.
   */
  graphDispatch?:
    | { collect(collection: string, id: string): void; collectDelete(collection: string, id: string, intents: readonly RollupDeleteIntent[]): void }
    | undefined
}

/** One normalized `ComputedFields` entry — a plain `ComputedFn` or a `ComputedFieldEntry`
 *  reduced to its parts, `mode` always defaulted (#638 Task 7). Exported so
 *  `via/graph-wiring.ts`'s reconcile-path guard can check `mode` without duplicating
 *  the plain-fn-vs-object-form normalization. */
export interface ComputedEntryParts { readonly fn: ComputedFn; readonly deps?: readonly string[]; readonly mode: 'materialized' | 'virtual' }

export function computedEntryParts(entry: ComputedFn | ComputedFieldEntry): ComputedEntryParts {
  if (typeof entry === 'function') return { fn: entry, mode: 'materialized' }
  return { fn: entry.fn, ...(entry.deps !== undefined ? { deps: entry.deps } : {}), mode: entry.mode ?? 'materialized' }
}

/**
 * #638 Task 7 — union the `computed:` sugar option with `via(computed(...))`-declared
 * entries (`kernel/via/compose.ts#mergeViaFields`'s `computedFields` output) into ONE
 * per-field map. NEVER includes `resolvedClassified.riderComputed` — that sanctioned
 * classified→computed channel (seam map Part 4) stays outside every guard this map feeds
 * (`resolveComputedEdges`'s depsless-on-classified refusal, the rider-name collision check).
 * Both `compileViaBindings` (to find `mode: 'virtual'` fields) and `resolveCollectionConfig`
 * (to split materialized entries into `mergedComputed` + extract graph edges) read this.
 */
function unifyComputedFields<T>(opts: CollectionOpts<T>, viaComputedFields: Record<string, ComputedDescriptor> | undefined): ComputedFields {
  return { ...(opts.computed ?? {}), ...(viaComputedFields ?? {}) }
}

/**
 * Compile a collection's declared config into the ordered list of `ViaBinding`s
 * for its `ViaPipeline`.
 *
 * money then i18n then lookup then classified then blob then computed — order
 * pinned for pipeline parity with the hand-wired baseline this replaces: money
 * encode ran before the i18n write stages, and money decode ran before i18n
 * locale/dict-label resolution on read. Lookup compiles right after i18n
 * (#650 Task 2) — a separate binding for native lookup()/enumOf()/dict()
 * fields (`dictKeyFields`/`dictKey()`/`staticDict()` stay on the i18n
 * binding above, unchanged); its `present` hook only adds `<field>Label`,
 * same shape of read-time addition as i18n's own dict-label dressing, and
 * declares no write-pipeline hooks yet (Task 3 adds `ingest`/`enforceWrite`).
 * Classified compiles after those (#629 Task 6): its
 * `encodeAtRest`/`decodeAtRest` hooks make the pipeline's `hasAtRestHooks`
 * true, retiring the codec's inline `sensitiveFields` seal path
 * (record-codec.ts) for any collection that declares `classifiedFields` —
 * `classifiedGuardCtx` is the SAME `ClassifiedGuardCtx`
 * `resolveCollectionConfig` already built for door 1's
 * `guardClassifiedCompat` call, threaded in by its one caller below. Blob
 * compiles next (#629 Task 7) but its position is inert: the blob binding
 * declares NO write/read pipeline hooks (blob content is out-of-band
 * `BlobSet` side-collections — it must never flip `hasAtRestHooks`), only
 * `erase`/`describeFragment`. Computed compiles LAST (#638 Task 7) — its
 * `present` hook must run AFTER money's own `present` so a virtual field's
 * `deps` read the decoded (quantized) amount, not the raw stored form; at
 * present-time i18n/lookup's DRESSING now runs AFTER computed instead (#665
 * `_presentOrder`, `via/pipeline.ts` — compile order here is unchanged).
 * `via/graph-wiring.ts#applyTaintOverlay` appends the `taint`
 * binding after WHATEVER this function returns, so taint's present-time
 * redaction always runs after computed's regardless of this ordering.
 * {@link Collection._applyMoneyFields} PREPENDS money for the same reason
 * on its own (MV-precreation reconcile) path — see its docstring;
 * {@link Collection._applyClassifiedFields} APPENDS classified on that same
 * reconcile path (blobFields/computed have no late-attach reconcile door —
 * `viaFields`, like i18nFields/dictKeyFields, is construction-only).
 *
 * `eraseCfgOut` (#629 Task 10, optional out-param) — this function runs
 * before the owning `Collection` exists (`this.codec` isn't built yet), so
 * the classified binding's `classifySealedShred` closure can't be wired
 * here. When supplied, `eraseCfgOut.classified` is set to the SAME cfg
 * object instance handed to `viaBinder('classified')`, so a caller
 * (`resolveCollectionConfig`) can thread it out to the `Collection`
 * constructor, which mutates `classifySealedShred` in place once
 * `this.codec` exists. Additive — every existing caller omits it and keeps
 * getting a plain `ViaBinding[]`.
 */
export function compileViaBindings<T>(
  opts: CollectionOpts<T>,
  classifiedGuardCtx: ClassifiedGuardCtx,
  eraseCfgOut?: { classified?: ClassifiedViaConfig },
): ViaBinding[] {
  const { moneyFields, i18nFields, dictKeyFields, computedFields, lookupFields } = mergeViaFields(opts)
  const allComputedFields = unifyComputedFields(opts, computedFields)
  guardCrossBindingFieldCollisions({
    moneyFields, i18nFields, dictKeyFields, lookupFields,
    classifiedFields: opts.classifiedFields !== undefined
      ? resolveClassifiedFields(opts.name, opts.classifiedFields).byField
      : undefined,
    blobFields: opts.blobFields,
    computed: allComputedFields,
  })
  const bindings: ViaBinding[] = []
  // #669 — hoisted above the money push (was built at the tail of this function, alongside
  // the `computed` binding push below) so money's own binding config can be told which of
  // ITS fields are ALSO virtual-mode computed (the money+virtual-on-the-same-field
  // MAJOR-UNITS case) — money needs this at construction time; nothing else in this
  // function depends on the hoist.
  const virtualFields = new Map<string, ComputedDescriptor>()
  for (const [field, entry] of Object.entries(allComputedFields)) {
    const parts = computedEntryParts(entry)
    if (parts.mode === 'virtual') {
      virtualFields.set(field, { _viaBrand: 'computed', fn: parts.fn, mode: 'virtual', ...(parts.deps !== undefined ? { deps: parts.deps } : {}) })
    }
  }
  if (moneyFields) {
    const virtualMoney = resolveVirtualMoneyFields(Object.keys(moneyFields), (f) => virtualFields.has(f))
    bindings.push(viaBinder('money')({ moneyFields, ...(virtualMoney.size > 0 ? { virtualMoneyFields: virtualMoney } : {}) }))
  }
  if (i18nFields || dictKeyFields) {
    // Densify-enabled subset (fields opting into `densifyOnWrite: true`) —
    // undefined when none opt in, so the write path skips densify work
    // entirely for ordinary collections.
    const densify = i18nFields
      ? Object.fromEntries(
          Object.entries(i18nFields).filter(([, d]) => d.options.densifyOnWrite === true),
        )
      : {}
    const i18nDensifyFields = Object.keys(densify).length > 0 ? densify : undefined
    bindings.push(viaBinder('i18n')({
      ...(i18nFields !== undefined ? { i18nFields } : {}),
      ...(dictKeyFields !== undefined ? { dictKeyFields } : {}),
      ...(i18nDensifyFields !== undefined ? { i18nDensifyFields } : {}),
      strategy: opts.i18nStrategy ?? NO_I18N,
      ...(opts.defaultLocale !== undefined ? { defaultLocale: opts.defaultLocale } : {}),
      ...(opts.autoTranslateHook !== undefined ? { autoTranslateHook: opts.autoTranslateHook } : {}),
      ...(opts.dictLabelResolver !== undefined ? { dictLabelResolver: opts.dictLabelResolver } : {}),
      ...(opts.i18nPutValidator !== undefined ? { i18nPutValidator: opts.i18nPutValidator } : {}),
      collectionName: opts.name,
    }))
  }
  // #650 Task 2 — native lookup()/enumOf()/dict() fields (the `lookupFields`
  // sugar key, merged with `via(lookup(...))` entries by mergeViaFields). A
  // SEPARATE binding from i18n above — dictKey()/staticDict() stay on the
  // i18n binding (the alias, unchanged); a collection declaring BOTH
  // dictKeyFields and lookupFields compiles both bindings.
  // must move together with via/reconcile.ts's lookup binder-config block (reconcileLookupFields,
  // the `viaBinder('lookup')({...})` call) (#664) — same option-shape contract.
  if (lookupFields !== undefined) {
    bindings.push(viaBinder('lookup')({
      lookupFields,
      ...(opts.lookupLabelResolver !== undefined ? { lookupLabelResolver: opts.lookupLabelResolver } : {}),
      ...(opts.getLookupBacking !== undefined ? { getLookupBacking: opts.getLookupBacking } : {}),
      ...(opts.membership !== undefined ? { membership: opts.membership } : {}),
      ...(opts.getAltIndex !== undefined ? { getAltIndex: opts.getAltIndex } : {}),
      ...(opts.snapshotFor !== undefined ? { snapshotFor: opts.snapshotFor } : {}),
      collectionName: opts.name,
    }))
  }
  if (opts.classifiedFields !== undefined) {
    const classifiedCfg: ClassifiedViaConfig = {
      entries: opts.classifiedFields,
      collectionName: opts.name,
      guardCtx: classifiedGuardCtx,
    }
    if (eraseCfgOut) eraseCfgOut.classified = classifiedCfg
    bindings.push(viaBinder('classified')(classifiedCfg))
  }
  if (opts.blobFields !== undefined) {
    bindings.push(viaBinder('blob')({
      fields: opts.blobFields,
      collectionName: opts.name,
    }))
  }
  if (virtualFields.size > 0) {
    bindings.push(viaBinder('computed')({ virtualFields }))
  }
  return bindings
}

/**
 * The money∩virtual-mode-computed field-name intersection (#669) — shared by
 * `compileViaBindings` above (fresh construction, `isVirtual` closes over the just-built
 * `virtualFields` Map) and {@link Collection._applyMoneyFields} (late-attach, `isVirtual`
 * closes over the already-compiled pipeline's `computed` binding instead — virtual-mode
 * computed fields have no late-attach door of their own (declaring one on a reconcile call
 * throws), so by the time money reconciles onto an existing collection, any virtual field
 * is already sitting in `bindings`, never in `this.computed`: `resolveCollectionConfig`
 * deliberately excludes virtual-mode entries from the map it assigns to `this.computed`,
 * since that field feeds ONLY the write-time `evalComputedFields` path — see
 * `materializedComputed` above). Both callers get the identical intersection semantics from
 * one function, so money's `presentLate` MAJOR-UNITS dressing (`via/money/binding.ts`) can
 * never silently disagree between the fresh and late-attach paths.
 */
export function resolveVirtualMoneyFields(
  moneyFieldNames: Iterable<string>,
  isVirtual: (field: string) => boolean,
): Set<string> {
  const out = new Set<string>()
  for (const field of moneyFieldNames) if (isVirtual(field)) out.add(field)
  return out
}

/** One `ViaGraph.registerDerived` call's worth of edge data — target + sources,
 *  `kind` chosen by the caller (#638 Task 2 edge extraction). `grain` defaults to
 *  `'record'` when absent; `resolveComputedEdges` (#638 Task 7) sets it to `'virtual'`
 *  for a `mode: 'virtual'` computed field's edge. */
export interface GraphEdge { readonly target: FieldRef; readonly sources: readonly FieldRef[]; readonly grain?: Grain }

/**
 * The known-field-name universe builder (#638 Task 2 fix wave 2) — used by
 * {@link resolveCollectionConfig} to validate `resolveViaBindingDepsEdges`'s `deps`
 * entries, and by {@link resolveComputedEdges}'s classified-collection dep-name check
 * (Finding I2ii's "shared, so the two paths cannot silently drift apart" rationale).
 * #638 Task 7 dropped `resolveComputedEdges`'s dep-name check entirely (legalizing a
 * plain-field dep on a non-classified collection); the Task 7 review's CRITICAL finding
 * (a typo'd dep on a CLASSIFIED collection reopens the #636 leak) restored a
 * classified-only slice of it, scoped through this SAME helper rather than a
 * hand-rolled second universe — exported so `via/graph-wiring.ts`'s reconcile path can
 * build its own call-scoped knownFields the identical way the fresh path does.
 */
export function collectKnownFieldNames(parts: {
  readonly moneyFields?: Record<string, unknown> | undefined
  readonly i18nFields?: Record<string, unknown> | undefined
  readonly dictKeyFields?: Record<string, unknown> | undefined
  readonly classifiedFields?: Record<string, unknown> | undefined
  readonly computed?: Record<string, unknown> | undefined
  readonly lookupFields?: Record<string, unknown> | undefined
}): Set<string> {
  return new Set<string>([
    ...Object.keys(parts.moneyFields ?? {}),
    ...Object.keys(parts.i18nFields ?? {}),
    ...Object.keys(parts.dictKeyFields ?? {}),
    ...Object.keys(parts.classifiedFields ?? {}),
    ...Object.keys(parts.computed ?? {}),
    ...Object.keys(parts.lookupFields ?? {}),
  ])
}

/** Default `knownFields` for a `resolveComputedEdges` call that never checks it
 *  (`hasClassifiedFields === false`) — lets existing direct-unit-test call sites
 *  omit the 4th argument. */
const EMPTY_KNOWN_FIELDS: ReadonlySet<string> = new Set()

/**
 * Validate each `computed` entry's `deps` well-formedness and resolve them into graph
 * edges (#638 Task 2; #638 Task 7 folded the formerly-separate `computedDeps` sibling
 * option into each entry's own `{ fn, deps?, mode? }` shape — see
 * `with-formula/computed/index.ts#ComputedFieldEntry`). `computed` is the RAW
 * user-declared map — `unifyComputedFields`'s union of the `computed:` sugar option and
 * `via(computed(...))` entries, NEVER `mergedComputed`: a classified preset's
 * `riderComputed` companions are a sanctioned, already-vetted classified→computed channel
 * and are deliberately NOT subject to this guard. A depsless entry is fine UNLESS the
 * collection also declares classified fields (`hasClassifiedFields`), in which case an
 * opaque computed function could silently copy a classified field's plaintext into an
 * ordinary, unredacted field (the #636 leak) — refused at declare time, regardless of
 * `mode` (a virtual field's read-time redaction, `via/taint-binding.ts`, only fires for a
 * field the graph actually taints — a depsless one never is).
 *
 * A `deps` entry may name ANY field — including a PLAIN field with no via feature
 * declared on it at all (#638 Task 7; Task 2's original design only ever validated a
 * `deps` entry against `moneyFields`/`i18nFields`/`dictKeyFields`/`classifiedFields`/
 * `computed`'s own declared names — `collection-config.ts` has no schema-introspection
 * API to check a `deps` entry against the record's FULL field set, since
 * `StandardSchemaV1` — Zod/Valibot/ArkType/Effect, deliberately schema-library-agnostic —
 * exposes no "list of field names" capability). This is safe on a NON-classified
 * collection: a dep with no registered `ViaGraph` node contributes `DEFAULT_POSTURE`
 * when folded (`ViaGraph._contribution`'s `?? DEFAULT_POSTURE` fallback) — i.e. nothing,
 * exactly like any other untainted source.
 *
 * Task 7 review CRITICAL fix (empirically confirmed leak reopening): on a collection
 * that DOES declare classified fields, an UNKNOWN `deps` entry (a typo — e.g.
 * `deps: ['sssn']` instead of `['ssn']`) used to fold to `DEFAULT_POSTURE` exactly like
 * the "harmless plain field" case above, silently reopening the #636 leak — construction
 * didn't throw, and the derived field was written/read UNSEALED even though its `fn`
 * actually read a classified field. `knownFields` (built by {@link collectKnownFieldNames}
 * the SAME way at every call site — never a hand-rolled second universe, the exact drift
 * that caused a Task 2 bug) restores the "every dep must name a known field" check, but
 * ONLY when `hasClassifiedFields` — a non-classified collection keeps the Task 7 freedom
 * (any string is a legal dep, per the paragraph above) since an untainted fold there is
 * always safe regardless of typos.
 *
 * KNOWN LIMIT (pre-existing since Task 2, phase-E territory — pinned by
 * `via/taint.test.ts`'s "KNOWN LIMIT" test): this only checks that a `deps` entry names
 * SOME known field, not that it names the RIGHT one. A `deps` entry naming a real,
 * declared-but-WRONG field (e.g. `fn` reads classified field `ssn` but `deps: ['amount']`
 * — a genuine, known, non-classified field) still passes this check and still leaks:
 * the graph edge folds from `amount`'s posture, not `ssn`'s, so the derived field is
 * folded/sealed as if it read `amount`, while its actual output is `ssn`'s plaintext.
 * There is no schema-introspection capability (see above) to verify a `deps` entry
 * actually corresponds to what `fn` reads — closing this fully would need runtime
 * read-tracking or a schema-aware capability, out of this fix's scope.
 */
export function resolveComputedEdges(
  collectionName: string,
  computed: ComputedFields | undefined,
  hasClassifiedFields: boolean,
  knownFields: ReadonlySet<string> = EMPTY_KNOWN_FIELDS,
): readonly GraphEdge[] {
  if (!computed) return []
  const edges: GraphEdge[] = []
  for (const [field, entry] of Object.entries(computed)) {
    const parts = computedEntryParts(entry)
    const deps = parts.deps
    if (deps === undefined) {
      if (hasClassifiedFields) {
        throw new ValidationError(
          `Collection "${collectionName}": computed field "${field}" has no declared \`deps\` and the ` +
          `collection declares classified fields — an opaque computed function could silently copy a ` +
          `classified field's plaintext into an ordinary, unredacted field. Declare \`deps\` naming the ` +
          `source fields it reads, e.g. computed: { ${field}: { fn, deps: [...] } } or ` +
          `via(computed(fn, { deps: [...] })).`,
        )
      }
      continue
    }
    if (deps.length === 0) {
      throw new ValidationError(`Collection "${collectionName}": computed field "${field}"'s \`deps\` must be non-empty.`)
    }
    for (const dep of deps) {
      if (typeof dep !== 'string' || dep.length === 0) {
        throw new ValidationError(`Collection "${collectionName}": computed field "${field}"'s \`deps\` entries must be non-empty strings.`)
      }
      if (hasClassifiedFields && !knownFields.has(dep)) {
        throw new ValidationError(
          `Collection "${collectionName}": computed field "${field}"'s \`deps\` entry "${dep}" does not name a ` +
          `declared field, and the collection declares classified fields — an opaque computed function could ` +
          `silently copy a classified field's plaintext into an ordinary, unredacted field via a mistyped/unknown ` +
          `dep name. Declare \`deps\` naming only known fields (money/i18n/dictKey/classified/computed) — check ` +
          `"${dep}" for a typo.`,
        )
      }
    }
    edges.push({
      target: { collection: collectionName, field },
      sources: deps.map((d) => ({ collection: collectionName, field: d })),
      grain: parts.mode === 'virtual' ? 'virtual' : 'record',
    })
  }
  return edges
}

/**
 * Extract graph edges from `ViaBinding.deps` (#638 Task 2 — `deps` goes from
 * inert to validated). For any compiled binding declaring `deps`, every field
 * it `covers()` (tested against `knownFields`) becomes a derived target whose
 * sources are `deps`; an unknown source field throws declare-time
 * `ValidationError`. No shipped binding declares `deps` today (money/i18n/
 * classified/blob don't) — this is the general path a future derive-bearing
 * binding (phase C Task 7's `computed` via-binding) plugs into.
 */
export function resolveViaBindingDepsEdges(
  collectionName: string,
  bindings: readonly ViaBinding[],
  knownFields: ReadonlySet<string>,
): readonly GraphEdge[] {
  const edges: GraphEdge[] = []
  for (const binding of bindings) {
    if (!binding.deps || binding.deps.length === 0) continue
    for (const dep of binding.deps) {
      if (!knownFields.has(dep)) {
        throw new ValidationError(
          `Collection "${collectionName}": via binding "${binding.brand}" deps references undeclared field "${dep}".`,
        )
      }
    }
    const sources = binding.deps.map((d) => ({ collection: collectionName, field: d }))
    for (const field of knownFields) {
      if (binding.covers?.(field)) edges.push({ target: { collection: collectionName, field }, sources })
    }
  }
  return edges
}

/**
 * Resolve the raw {@link CollectionOpts} into the concrete field values the
 * {@link Collection} constructor assigns — every `?? default`, every derived
 * `Set`/subset, plus the three pure construction-time validations. Pure: no
 * `this`, no external side effect. The allocated `Set`/`VectorSet`/`Lru`
 * instances become the collection's own by reference.
 */
export function resolveCollectionConfig<T>(opts: CollectionOpts<T>) {
  // Guard: CRDT collections cannot use embeddings (the embedding-derive
  // block is unreachable after the CRDT early-return in _putInternal; full
  // CRDT-derivation is out of scope).
  if (opts.embeddings && opts.crdt) {
    throw new Error(
      `Collection "${opts.name}": embeddings are not supported on CRDT collections (L2). Use a non-CRDT collection for semantic search.`,
    )
  }

  // via() / sugar-key merge (#623 Task 9) — throws on a field declared in both.
  const effectiveViaFields = mergeViaFields(opts)

  const resolvedClassified: ResolvedClassified | undefined =
    opts.classifiedFields !== undefined
      ? resolveClassifiedFields(opts.name, opts.classifiedFields)
      : undefined

  // #638 Task 7 — union the `computed:` sugar option with `via(computed(...))` entries,
  // then split by mode: materialized (default) folds into `mergedComputed` exactly like
  // today's sugar map; virtual NEVER does (it's never stored — `evalComputedFields` must
  // not see it) and instead feeds the computed via-binding's config (`compileViaBindings`,
  // above, does the identical split independently — both are pure/cheap, mirrors
  // `resolveCollectionConfig` already re-deriving `effectiveViaFields`).
  const allComputed = unifyComputedFields(opts, effectiveViaFields.computedFields)
  const materializedComputed: ComputedFields = {}
  for (const [field, entry] of Object.entries(allComputed)) {
    if (computedEntryParts(entry).mode !== 'virtual') materializedComputed[field] = entry
  }

  // rider companions run first; user `computed` fns may read them.
  // A user `computed` key colliding with a rider companion is a config error
  // (checked against BOTH modes' field names — a virtual field can collide too).
  let mergedComputed: ComputedFields | undefined =
    Object.keys(materializedComputed).length > 0 ? materializedComputed : undefined
  if (resolvedClassified !== undefined) {
    for (const key of Object.keys(allComputed)) {
      if (resolvedClassified.riderComputed[key] !== undefined) {
        throw new ClassifiedConfigError(opts.name, `computed field "${key}" collides with a rider companion`)
      }
    }
    mergedComputed = { ...resolvedClassified.riderComputed, ...materializedComputed }
  }

  // deterministic-encryption wiring
  let deterministicFields: ReadonlySet<string> | null
  if (opts.deterministicFields && opts.deterministicFields.length > 0) {
    if (opts.acknowledgeDeterministicRisk !== true) {
      throw new Error(
        `Collection "${opts.name}": deterministicFields requires \`acknowledgeDeterministicRisk: true\`. ` +
        `Deterministic encryption leaks equality between records — two records with the same field value ` +
        `produce identical ciphertexts visible to anyone with store access. If that trade-off is acceptable ` +
        `for your threat model, set \`acknowledgeDeterministicRisk: true\` to enable.`,
      )
    }
    deterministicFields = Object.freeze(new Set(opts.deterministicFields))
  } else {
    deterministicFields = null
  }

  // Refusal matrix (R1-R5) — door 1. The SAME guard + ctx runs again at door 2
  // (`_applyClassifiedFields`, the reconcile seam), because crdt/conflictPolicy/
  // perRecordKeys are construction-only while classifiedFields can attach later
  // (C5's lesson). The ctx is always built (and returned) so door 2 has it even
  // when this construction declared no classified fields.
  const guardIndexedFields = new Set<string>()
  for (const ix of opts.indexes ?? []) {
    if (typeof ix === 'string') guardIndexedFields.add(ix)
    else if (Array.isArray(ix)) for (const f of ix) guardIndexedFields.add(f)
    else for (const f of (ix as { readonly fields: readonly string[] }).fields) guardIndexedFields.add(f)
  }
  const embeddingSources = opts.embeddings === undefined ? []
    : typeof opts.embeddings.source === 'string' ? [opts.embeddings.source] : [...opts.embeddings.source]
  const classifiedGuardCtx: ClassifiedGuardCtx = {
    perRecordKeys: opts.perRecordKeys === true,
    crdt: opts.crdt !== undefined,
    hasConflictPolicy: opts.conflictPolicy !== undefined,
    storeCiphertext: opts.encrypted,
    deterministicFields,
    indexedFields: guardIndexedFields,
    textIndexFields: new Set(opts.textIndexes ?? []),
    vectorSourceFields: new Set(embeddingSources),
    subjectKeyField: opts.subjectKeyField,
    bareSensitiveFields: new Set(opts.sensitive ?? []),
    acknowledgeEquatableRisk: opts.acknowledgeEquatableRisk === true,
  }
  if (resolvedClassified !== undefined) {
    guardClassifiedCompat(opts.name, resolvedClassified.byField, classifiedGuardCtx) // door 1
  }

  // structural group-encryption wiring: the set of fields sealed
  // into `_sealed` per-field slots. Empty when the option is absent.
  // Recoverable classified fields are unioned in — they seal via the same
  // mechanism with zero new crypto code.
  const classifiedSensitive = resolvedClassified === undefined ? [] :
    Object.entries(resolvedClassified.byField)
      .filter(([, s]) => s.storage === 'recoverable')
      .map(([f]) => f)
  const sensitiveList = [...(opts.sensitive ?? []), ...classifiedSensitive]
  const sensitiveFields: ReadonlySet<string> = sensitiveList.length > 0
    ? Object.freeze(new Set(sensitiveList))
    : Object.freeze(new Set<string>())

  // Digest-only classified fields → the enclave-consumable policy map
  // (stage 2). Both the codec write path and the verify engine key off it.
  const vdigEntries: Array<readonly [string, VdigFieldPolicy]> =
    resolvedClassified === undefined ? [] :
      Object.entries(resolvedClassified.byField)
        .filter(([, s]) => s.storage === 'digest-only')
        .map(([f, s]) => [f, {
          normalize: s.verifyNormalize ?? 'password',
          notLastN: s.notLastN ?? 0,
          equatable: s.equatable === true,
          ...(s.rotateDays !== undefined ? { rotateDays: s.rotateDays } : {}),
        }] as const)
  const vdigFields: ReadonlyMap<string, VdigFieldPolicy> | null =
    vdigEntries.length > 0 ? new Map(vdigEntries) : null

  // per-record CEK wiring. The cache is bounded by record count; CEKs
  // are tiny CryptoKey handles, so a generous entry budget is cheap.
  const perRecordCek = opts.perRecordKeys === true
  const cekCache = perRecordCek ? new Lru<string, EnclaveKey>({ maxRecords: 4096 }) : null

  // #629 Task 10 — captures the classified binding's cfg (see compileViaBindings's doc comment) for the constructor's post-codec wiring.
  const viaEraseCfgOut: { classified?: ClassifiedViaConfig } = {}
  const via = ViaPipeline.build(compileViaBindings(opts, classifiedGuardCtx, viaEraseCfgOut))

  // #638 Task 2 — the field-name universe `resolveViaBindingDepsEdges` validates `deps`
  // entries against ("references undeclared field" otherwise) — still true for the general
  // `ViaBinding.deps` path. `resolveComputedEdges` (#638 Task 7) only consults this when
  // `hasClassifiedFields` (the Task 7 review's CRITICAL fix — see its own doc comment): a
  // computed `deps` entry may still name a plain field with no via feature at all on a
  // NON-classified collection.
  const knownFields = collectKnownFieldNames({
    moneyFields: effectiveViaFields.moneyFields,
    i18nFields: effectiveViaFields.i18nFields,
    dictKeyFields: effectiveViaFields.dictKeyFields,
    classifiedFields: resolvedClassified?.byField,
    computed: allComputed,
    lookupFields: effectiveViaFields.lookupFields,
  })
  const computedEdges = resolveComputedEdges(opts.name, allComputed, resolvedClassified !== undefined, knownFields)
  const viaDepsEdges = resolveViaBindingDepsEdges(opts.name, via?.bindings ?? [], knownFields)

  return {
    adapter: opts.adapter,
    vault: opts.vault,
    name: opts.name,
    keyring: opts.keyring,
    storeCiphertext: opts.encrypted,
    ramCiphertext: opts.ramCiphertext ?? false,
    emitter: opts.emitter,
    writeQueue: opts.writeQueue,
    schemaUpdateGate: opts.schemaUpdateGate,
    schemaFence: opts.schemaFence,
    writeHooks: opts.writeHooks,
    subsystemBus: opts.subsystemBus,
    activeTxId: opts.activeTxId,
    blobStrategy: opts.blobStrategy ?? NO_BLOBS,
    objectStore: opts.objectStore,
    blobFields: opts.blobFields,
    aggregateStrategy: opts.aggregateStrategy ?? NO_AGGREGATE,
    crdtStrategy: opts.crdtStrategy ?? NO_CRDT,
    historyStrategy: opts.historyStrategy ?? NO_HISTORY,
    i18nStrategy: opts.i18nStrategy ?? NO_I18N,
    syncStrategy: opts.syncStrategy ?? NO_SYNC,
    reconcileOnOpen: opts.reconcileOnOpen ?? 'off',
    getDEK: opts.getDEK,
    onDirty: opts.onDirty,
    historyConfig: opts.historyConfig ?? { enabled: true },
    historyConfigExplicit: opts.historyConfigExplicit ?? false,
    schema: opts.schema,
    ledger: opts.ledger,
    refEnforcer: opts.refEnforcer,
    joinResolver: opts.joinResolver,
    i18nFields: effectiveViaFields.i18nFields,
    textIndexes: opts.textIndexes,
    embeddings: opts.embeddings,
    vectorSet: opts.embeddings ? new VectorSet() : undefined,
    dictKeyFields: effectiveViaFields.dictKeyFields,
    lookupFields: effectiveViaFields.lookupFields,
    // #650 Task 6 — the sync join-dressing hook (#626 retirement, spec §5);
    // `undefined` when this collection declares neither i18nText nor lookup
    // fields, matching today's `i18nFields`-absent JoinableSource shape.
    presentForJoin: buildPresentForJoin(effectiveViaFields.i18nFields, effectiveViaFields.lookupFields, opts.snapshotFor),
    fieldMeta: opts.fieldMeta,
    meta: opts.meta,
    _refs: opts.declaredRefs ?? {},
    via,
    classifiedEraseCfg: viaEraseCfgOut.classified,
    moneyFields: effectiveViaFields.moneyFields,
    classified: resolvedClassified,
    classifiedGuardCtx,
    classifiedStrategy: opts.classifiedStrategy ?? NO_CLASSIFIED,
    computed: mergedComputed,
    computedEdges,
    viaDepsEdges,
    // #638 Task 7 — every declared computed field name (both modes, both surfaces); the
    // reconcile path's cross-call depsless-computed leak-guard memory
    // (`via/graph-wiring.ts#registerCollectionGraphSources`) reads this instead of
    // `Object.keys(opts.computed ?? {})` alone, so a via(computed(...))-declared field
    // participates in that guard identically to a sugar-declared one.
    computedFieldNames: Object.keys(allComputed),
    dictLabelResolver: opts.dictLabelResolver,
    getDictionary: opts.getDictionary,
    i18nPutValidator: opts.i18nPutValidator,
    autoTranslateHook: opts.autoTranslateHook,
    defaultLocale: opts.defaultLocale,
    crdtMode: opts.crdt,
    syncAdapter: opts.syncAdapter,
    onAccess: opts.onAccess,
    derivationSource: opts.derivationSource,
    materializedViewSource: opts.materializedViewSource,
    graphDispatch: opts.graphDispatch,
    tiers: opts.tiers && opts.tiers.length > 0 ? new Set(opts.tiers) : null,
    tiersStrategy: opts.tiersStrategy ?? NO_TIERS,
    searchStrategy: opts.searchStrategy ?? NO_SEARCH,
    tierMode: opts.tierMode ?? 'invisibility',
    onCrossTierAccess: opts.onCrossTierAccess,
    deterministicFields,
    sensitiveFields,
    vdigFields,
    perRecordCek,
    cekCache,
    provenance: opts.provenance === true,
  }
}
