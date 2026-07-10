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
import { NO_CRDT, type CrdtStrategy } from '../with-commit/crdt/strategy.js'
import { NO_HISTORY, type HistoryStrategy } from '../with-commit/history/strategy.js'
import { NO_I18N, type I18nStrategy } from '../shape/via-i18n/strategy.js'
import { NO_SYNC, type SyncStrategy } from '../with-party/team/sync-strategy.js'
import { NO_BLOBS, type BlobStrategy } from '../with-shape/blobs/strategy.js'
import { NO_AGGREGATE, type AggregateStrategy } from '../with-lookup/aggregate/strategy.js'
import { NO_TIERS, type TiersStrategy } from '../with-audit/tiers/strategy.js'
import { NO_SEARCH, type SearchStrategy } from '../with-lookup/search/strategy.js'
import type { ObjectProjection } from '../with-shape/blobs/object-projection.js'
import type { BlobFieldsConfig } from '../with-shape/blobs/blob-compaction.js'
import type { IndexStrategy } from '../with-lookup/indexing/strategy.js'
import type { IndexDef } from '../with-lookup/indexing/eager-indexes.js'
import type { I18nTextDescriptor } from '../shape/via-i18n/core.js'
import type { DictKeyDescriptor, StaticDictDescriptor, DictionaryHandle } from '../shape/via-i18n/dictionary.js'
import type { ComputedFields } from '../with-formula/computed/index.js'
import { resolveClassifiedFields, ClassifiedConfigError, type ClassifiedEntry, type ResolvedClassified } from '../with-shape/classified/resolve.js'
import { guardClassifiedCompat, type ClassifiedGuardCtx } from '../with-shape/classified/guards.js'
import { NO_CLASSIFIED, type ClassifiedStrategy } from '../with-shape/classified/strategy.js'
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
import { ViaPipeline } from './via-pipeline.js'
import { viaBinder, type ViaBinding, type ViaDescriptor } from './via.js'

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
}

/**
 * Compile a collection's declared config into the ordered list of `ViaBinding`s
 * for its `ViaPipeline`. Compile seam only — no production consumers yet.
 */
export function compileViaBindings<T>(opts: CollectionOpts<T>): ViaBinding[] {
  // money (Task 5) then i18n (Task 8) — order pinned for pipeline parity
  const bindings: ViaBinding[] = []
  if (opts.moneyFields) bindings.push(viaBinder('money')(opts.moneyFields))
  return bindings
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

  const resolvedClassified: ResolvedClassified | undefined =
    opts.classifiedFields !== undefined
      ? resolveClassifiedFields(opts.name, opts.classifiedFields)
      : undefined

  // rider companions run first; user `computed` fns may read them.
  // A user `computed` key colliding with a rider companion is a config error.
  let mergedComputed: ComputedFields | undefined = opts.computed
  if (resolvedClassified !== undefined) {
    for (const key of Object.keys(opts.computed ?? {})) {
      if (resolvedClassified.riderComputed[key] !== undefined) {
        throw new ClassifiedConfigError(opts.name, `computed field "${key}" collides with a rider companion`)
      }
    }
    mergedComputed = { ...resolvedClassified.riderComputed, ...(opts.computed ?? {}) }
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

  // Precompute the densify-enabled subset (undefined when none opt in)
  // so the write path skips work for non-densify collections.
  const densifyFields = opts.i18nFields
    ? Object.fromEntries(
        Object.entries(opts.i18nFields).filter(([, d]) => d.options.densifyOnWrite === true),
      )
    : {}
  const i18nDensifyFields =
    Object.keys(densifyFields).length > 0 ? densifyFields : undefined

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
    i18nFields: opts.i18nFields,
    textIndexes: opts.textIndexes,
    i18nDensifyFields,
    embeddings: opts.embeddings,
    vectorSet: opts.embeddings ? new VectorSet() : undefined,
    dictKeyFields: opts.dictKeyFields,
    fieldMeta: opts.fieldMeta,
    meta: opts.meta,
    _refs: opts.declaredRefs ?? {},
    via: ViaPipeline.build(compileViaBindings(opts)),
    moneyFields: opts.moneyFields,
    classified: resolvedClassified,
    classifiedGuardCtx,
    classifiedStrategy: opts.classifiedStrategy ?? NO_CLASSIFIED,
    computed: mergedComputed,
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
