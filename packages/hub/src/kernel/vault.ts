import type { OpenCollectionOptions } from '../port/with/collection-options.js'
import { populateCollectionRegistries } from '../port/with/collection-registries.js'
import { NO_BLOBS } from '../port/with/blob-strategy.js'
import type { StrategyBag } from '../port/with/strategies.js'
import type {
  NoydbStore,
  EncryptedEnvelope,
  HistoryConfig,
  ExportStreamOptions,
  ExportChunk,
  CollectionConflictResolver,
  CrossTierAccessEvent,
  Role,
  VaultUserApi,
  CollectionShape, SensitiveOf, IndexedOf, MoneyOf,
} from './types.js'
import type { Noydb } from './noydb.js'
import type { IssueDelegationOptions, DelegationToken } from '../with-party/team/delegation.js'
import { NOYDB_FORMAT_VERSION } from './types.js'
import { Collection } from './collection.js'
import type { JoinableSource } from './query/index.js'
import type { OnDirtyCallback } from './collection.js'
import type { UnlockedKeyring, BundleRecipient } from '../with-party/team/keyring.js'
import type { MaterializedViewRegistry } from '../with-formula/materialized-views/registry.js'
import type { MaterializedViewStrategy, MVQueryContext } from '../with-formula/materialized-views/types.js'
import type { OverlayedViewRegistry } from '../with-formula/overlay-views/registry.js'
import type { OverlayedViewStrategy } from '../with-formula/overlay-views/types.js'
import { OverlayedCollection } from '../with-formula/overlay-views/virtual-collection.js'
import type { Cover } from '../with-party/directory/cover/types.js'
import { buildRecipientKeyringFile } from '../with-party/team/keyring.js'
import { ensureCollectionDEK, hasAccess } from '../with-party/team/keyring.js'
import { isSecretBearingReservedCollection } from '../with-party/team/reserved-secret-collections.js'
import {
  assertCanExport as assertCanExportCapability,
  assertCanImport as assertCanImportCapability,
  canExport as canExportCapability,
  canImport as canImportCapability,
} from '../port/with/capabilities.js'
import type { ExportFormat, KeyringFile } from './types.js'
import {
  ValidationError,
  AlreadyElevatedError,
  TierNotGrantedError,
} from './errors.js'
import { ElevatedHandle, ELEVATION_AUDIT_COLLECTION } from '../with-commit/tx/elevated-handle.js'
import type { NoydbEventEmitter } from './events.js'
import type { ObjectProjection } from '../with-shape/blobs/object-projection.js'
import type { ArchivePolicy, ArchiveContext, ArchiveResult, ArchiveRunOptions } from '../with-fork/archive/index.js'
import { runArchive, runRestore, runListArchived } from '../with-fork/archive/index.js'
import { type SequenceStore, type SequenceHandle, type FormattedSequenceHandle, type SequenceOptions, resolveSequenceKey, compileSequenceFormat, SEQUENCE_COLLECTION } from '../with-commit/sequence/index.js'
import { DeferredNumberingStore, type Assignment } from '../with-commit/numbering/index.js'
import type { DeferredNumberingConfig } from '../with-commit/numbering/descriptor.js'
import type { TierMoveResult } from '../with-audit/tiers/strategy.js'
import { type CargoStrategy } from '../with-cargo/strategy.js'
import { buildCredentialBrokerHandle, type CredentialBrokerHandle } from '../port/with/broker-strategy.js'
//  — import from leaf modules (NOT from ./history/ledger/index.js
// or store.js) so the LedgerStore class never reaches the floor
// bundle. The leaf files hold pure constants + a tiny hash helper;
// the class lives behind the history strategy seam.
import type { LedgerStore } from '../with-commit/history/ledger/store.js'
import { sha256Hex } from '../with-commit/history/ledger/entry.js'
import type { VaultInstant } from '../with-commit/history/time-machine.js'
import { type ForgetResult } from '../with-audit/forget/strategy.js'
import {
  addSubjectRef, readDottedPath, coerceSubjectId,
  removeSubjectRef,
  lookupSubject,
  rebuildSubjectIndex as rebuildSubjectIndexImpl,
  type SubjectRef,
} from '../with-audit/forget/subject-index.js'
import { ForgetStrategyNotConfiguredError } from './errors.js'
import type { VaultFrame } from '../with-fork/shadow/vault-frame.js'
import type { ConsentContext, ConsentAuditEntry, ConsentAuditFilter, ConsentOp } from '../with-audit/consent/consent.js'
import { VaultPeriods } from '../with-audit/periods/vault-facade.js'
import { VaultLinks } from '../with-shape/links/vault-facade.js'
import {
  RefRegistry,
  type RefDescriptor,
  type RefViolation,
} from './refs.js'
import type { DictionaryHandle, DictionaryOptions, StaticDictDescriptor } from '../port/with/i18n-strategy.js'
import { isDictCollectionName } from '../port/with/i18n-strategy.js'
// #650 Task 1 (via-lookup extraction) — the pure dict-registry helpers now live in
// via/lookup/registry.ts, reached only through this port seam (never via/lookup/*
// directly — Check 14 via-layering). Aliased to avoid colliding with Vault's own same-named
// public delegator methods below. Task 2's resolveLabelFromMap/collectLookupDictCompat is the
// alias-equivalence bridge shared by the i18n + lookup bindings.
import {
  enforceStaticDictOnPut as enforceStaticDictOnPutHelper,
  resolveDictSource as resolveDictSourceHelper,
  updateReferencingRecords,
  resolveLabelFromMap,
  checkLookupMembership, buildLookupAltIndex,
  dictCollectionName, registerLookupRefEdges, // #650 Task 4/5
  buildLookupSnapshotRows, // #650 Task 6
  reservedDictDepsOf, // #653
  type LookupDescriptor,
} from '../port/with/lookup-strategy.js'
import { isLinkCollectionName, type LinkSpec, type LinkSetHandle } from '../with-shape/links/names.js'
import { makeLazyLinkSetHandle, type LazyLinkSetHandle } from '../with-shape/links/lazy-handle.js'
import { getAtPath } from './paths.js'
import type { ComputedFields } from '../with-formula/computed/index.js'
import { type I18nTextDescriptor } from '../port/with/i18n-strategy.js'
import { isViaInstalled } from './via/index.js'
import { mergeViaFields } from './via/compose.js'
import { exportRedact } from './via/pipeline.js'
import { ViaGraph } from './via/graph.js'
import { registerCollectionGraphSources, applyTaintOverlay, reapplyDependentOverlays } from './via/graph-wiring.js'
import { reconcileViaAttach, type ViaReconcileVaultCtx } from './via/reconcile.js'
import { runGraphDispatchWave, putDerivedOutput, ledgerAuditHook, forgetDerivedFanout, touchFor, type GraphBatch, type ForgetFanoutStats, type RollupDeleteIntent } from './via/dispatch.js'
// Type-only imports for the guard + derivation services. The
// runtime classes are loaded on demand via `await import(...)` inside
// `_initGuards` / `_initDerivations` (and the read-only-facade
// accessor below) so consumers that never register a guard or
// derivation strategy don't pay the chunk cost. This seam prevents
// the bundle regression that motivated the lazy-import pattern.
import type { GuardRegistry } from '../with-audit/guards/registry.js'
import type { GuardStrategyAny } from '../with-audit/guards/types.js'
import type { ReadOnlyVaultFacade } from '../with-audit/guards/read-only-facade.js'
import type { DerivationRegistry } from '../with-formula/derivations/registry.js'
import type { DerivationStrategy } from '../with-formula/derivations/types.js'
import { ReservedCollectionNameError, StaticDictReadonlyError, SatelliteConfigError } from './errors.js'
import { declareSatellite } from '../with-shape/satellites/declare.js'
import { makeSatelliteProxy, makeBaseProxy } from '../with-shape/satellites/proxy.js'
import type { SatelliteRegistry } from '../with-shape/satellites/registry.js'
import { makeJoinedHandle } from '../with-shape/satellites/joined.js'
import type { JoinedHandle } from '../with-shape/satellites/types.js'
import { expandRefsWithSatellites } from '../with-shape/satellites/forget.js'
import { migrateSatelliteCek } from '../with-shape/satellites/migrate-cek.js'
import {
  type PeriodRecord,
  type ClosePeriodOptions,
  type OpenPeriodOptions,
  purgeMarkersOn,
} from '../with-audit/periods/index.js'
import { encrypt, openEnvelopeJson, hasPerRecordKey, SEALED_CEK_NS, type SealingContext, type EnclaveKey, buildDeleteMarker, makeReservedEnvelopes } from './enclave/index.js'
import type { RecipientSealer } from '../with-party/team/managed-secret.js'
import {
  createExportBlobsHandle,
  EXPORT_AUDIT_COLLECTION,
  type ExportBlobsOptions,
  type ExportBlobsHandle,
  type ExportBlobsAuditEntry,
} from '../with-shape/blobs/export-blobs.js'
import { runCompaction, type BlobFieldsConfig, type CompactRunOptions, type CompactionResult } from '../with-shape/blobs/blob-compaction.js'
import {
  writeMagicLinkGrant,
  type IssueMagicLinkGrantOptions,
  type MagicLinkGrantRecord,
} from '../with-party/team/magic-link-grant.js'
import { CustodyApi } from '../with-party/custody/index.js'
// #553: gate + controller + fence-doc reader stay static (a REMOTE cutover must fence this client even without local declarations, and schemaFenceState() is a thin live read that UI bindings seed from in one tick); the decision engine + watcher load lazily.
import type { FenceWatcher } from '../with-shape/schema-update/fence-watcher.js'
import { SchemaUpdateGate } from '../with-shape/schema-update/gate.js'
import { SchemaFenceController } from '../with-shape/schema-update/fence-controller.js'
import { loadFence, type FenceDoc } from '../with-shape/schema-update/fence.js'
import type { UpdateDecision, TransformFn } from '../with-shape/schema-update/types.js'
import type { RevocationList } from '@noy-db/attestation'
import { VaultAttestation } from '../with-audit/attestation/vault-facade.js'
import type { DumpSchemaOptions, VaultSchemaSnapshot, SchemaIntrospection } from '../with-shape/introspection/types.js'
import type { VaultIntrospectState } from '../with-shape/introspection/walk.js'
import type { VaultMeta } from '../with-shape/introspection/meta.js'
import { USER_ENVELOPE_COLLECTION } from './constants.js'

/** A vault (tenant namespace) containing collections. */
/**
 * Collection options that `vault.collection()` threads straight through to
 * `CollectionOpts` under the same name, with no transformation (#841).
 *
 * These were 28 hand-written `if (options?.X !== undefined) collOpts.X =
 * options.X` lines. Adding a pass-through option is now one entry here.
 * Options needing any logic — `refs`, `attestation`, `satelliteOf`, the
 * forget-subject `perRecordKeys` override — deliberately stay explicit below.
 */
const COLLECTION_PASSTHROUGH_KEYS = [
  'indexes', 'reconcileOnOpen', 'prefetch', 'cache', 'schema', 'conflictPolicy', 'crdt',
  'deterministicFields', 'acknowledgeDeterministicRisk', 'acknowledgeEquatableRisk',
  'sensitive', 'perRecordKeys', 'provenance', 'ramCiphertext', 'tiers', 'tierMode',
  'blobTierPolicy', 'i18nFields', 'embeddings', 'textIndexes', 'warmIndexOnOpen',
  'textIndexPersist', 'moneyFields', 'viaFields', 'computed', 'classifiedFields',
  'fieldMeta', 'meta',
] as const

/** Copy `keys` from `src` onto `dst`, skipping any that are `undefined`. */
function copyDefined(dst: Record<string, unknown>, src: Record<string, unknown> | undefined, keys: readonly string[]): void {
  if (src === undefined) return
  for (const key of keys) {
    const value = src[key]
    if (value !== undefined) dst[key] = value
  }
}

export class Vault {
  private readonly adapter: NoydbStore
  /** The vault's name as passed to `openVault()`. Stable for the instance lifetime. */
  public readonly name: string
  /** Backreference to the parent `Noydb` — lets vault-scoped services reach the strategy seam
   *  without threading `db` through every API (type-only import keeps the module graph acyclic). */
  public readonly noydb: Noydb
  /** The active in-memory keyring. NOT readonly — `load()` refreshes it after restoring a
   *  different keyring file, or in-memory/on-disk DEKs drift apart and decrypt fails with TamperedError. */
  private keyring: UnlockedKeyring
  private readonly encrypted: boolean
  private readonly emitter: NoydbEventEmitter
  private readonly onDirty: OnDirtyCallback | undefined
  private readonly onRegisterConflictResolver: ((name: string, resolver: CollectionConflictResolver) => void) | undefined
  private readonly syncAdapter: NoydbStore | undefined
  private readonly getPurgeableTargets: () => readonly { store: NoydbStore; role: 'backup' | 'archive'; label?: string }[]
  private readonly historyConfig: HistoryConfig
  /**
   * Every opt-in service, resolved once by `createNoydb` (#838). Shared by
   * reference with the owning `Noydb` and with every `Collection` this vault
   * opens, so all three always agree about which services are enabled.
   */
  private readonly strategies: StrategyBag
  private readonly objectStore: ObjectProjection | undefined

  /** Per-collection record archival policies. Indexed by collection name. */
  private readonly archiveRegistry = new Map<string, ArchivePolicy>()
  private readonly periods: VaultPeriods
  private readonly linksEnforcer: VaultLinks

  /** Cargo (partition extraction) strategy — `NO_CARGO` (throwing) unless `withCargo()` was passed.
   *  Public so the `extractPartition` free function (which takes a `Vault`) routes through it. */
  get cargoStrategy(): CargoStrategy {
    return this.strategies.cargo
  }
  /** Per-vault guard registry; `null` until `_initGuards()` runs (or for vaults that never register
   *  one) — the runtime class is dynamic-imported on demand to keep it out of the floor bundle. */
  private guardRegistry: GuardRegistry | null = null
  /** Per-vault derivation/MV/overlay registries — same lazy-load contract as
   *  `guardRegistry`: each stays `null` until its `_init*()` runs with at
   *  least one strategy/MV/overlay handle. */
  private derivationRegistry: DerivationRegistry | null = null
  private materializedViewRegistry: MaterializedViewRegistry | null = null
  private overlayedViewRegistry: OverlayedViewRegistry | null = null
  /** Per-vault dependency graph (#638) — field postures + derivation/MV/overlay/
   *  computed/via-deps edges. Metadata-only (field names, postures, grains —
   *  never values or key material); always present, unlike the registries above. */
  readonly graph: ViaGraph
  /** #638 Task 4 — open sync/cutover/restore touch collector, or `undefined` between batches. */
  private _graphBatch: GraphBatch | undefined
  /** Cached read-only facades for guard/derivation callbacks — split by
   *  resolution layer (`layer:'guard'` vs `'derivation'`, each field's
   *  `onMissing` policy differs). Allocated eagerly inside `_initGuards()`/
   *  `_initDerivations()` so read accessors stay synchronous; `null` for
   *  vaults without that service. */
  private guardFacade: ReadOnlyVaultFacade | null = null
  private derivationFacade: ReadOnlyVaultFacade | null = null
  private getDEK: (collectionName: string) => Promise<EnclaveKey>

  /**
   * Per-principal user envelope API.
   *
   * - Write-self: `me()`, `updateMe(patch)`, `setMe(payload)` — always
   *   target this vault session's keyringId. There is no method to write
   *   another principal's envelope (own-only write rule, structural).
   * - Read-anyone: `get(keyringId)`, `list()` — read other principals'
   *   envelopes, subject to the `view-team-profiles` policy gate.
   * - Reactive: `subscribe(id, cb)`, `live(id)` — fire on local writes.
   *
   * @see docs/superpowers/specs/2026-05-05-user-envelope-design.md
   */
  public readonly user: VaultUserApi

  /**
   * FR-6 custody API — the sovereign-custody surface, mirroring `vault.user.*`.
   *
   * - `grantCustodian(opts)` / `revokeCustodian(opts)` — owner-only: mint /
   *   remove a `custodian` who operates the vault fully but can never grant /
   *   rotate / sever / extract.
   * - `liberate(opts)` — custodian-only: the audited claim of ownership over a
   *   sealed-owner (Deed) vault (mints a DISTINCT new owner; ledger-audited).
   *
   * @see docs/superpowers/specs/2026-06-17-fr6-deed-custodian-liberate-design.md
   */
  public readonly custody: CustodyApi

  /** Re-derives an UnlockedKeyring from the adapter using the active user's secret; called by
   *  `load()` after the on-disk keyring file has been replaced. Provided by Noydb at openVault()
   *  time; `undefined` in tests that construct Vault directly (load() then skips the refresh). */
  private readonly reloadKeyring: (() => Promise<UnlockedKeyring>) | undefined
  private readonly collectionCache = new Map<string, Collection<unknown>>()
  private satelliteRegistry: SatelliteRegistry | null = null // spec #591, archetype-③
  /** Vault-level schema cutover fence/controller. */
  readonly schemaFence: SchemaFenceController
  /** Per-client heartbeat/watcher; started lazily on cutover registration. */
  #fenceWatcher: FenceWatcher | undefined
  #fenceCoordinationStarted = false
  /** Per-collection registered schema-update strategy names. */
  readonly #schemaUpdateNames = new Map<string, string[]>()

  /**
   * per-collection `blobFields` retention/TTL config.
   * Populated on `collection({ blobFields })` and read by
   * `vault.compact()`. Indexed by collection name.
   */
  private readonly blobFieldsRegistry = new Map<string, BlobFieldsConfig<unknown>>()

  /**
   * Attestation facade (issue/revoke + the per-collection field-schema
   * registry). Built in the constructor.
   */
  private readonly attestation!: VaultAttestation

  /**
   * Per-vault ledger store. Lazy-initialized on first
   * `collection()` call (which passes it through to the Collection)
   * or on first `ledger()` call from user code.
   *
   * One LedgerStore is shared across all collections in a vault
   * because the hash chain is vault-scoped: the chain head is a
   * single "what did this vault do last" identifier, not a
   * per-collection one. Two collections appending concurrently is the
   * single-writer concurrency concern documented in the LedgerStore
   * docstring.
   */
  private ledgerStore: LedgerStore | null = null

  /** Lazily-built atomic-sequence store. See {@link sequence}. */
  private sequenceStore: SequenceStore | null = null
  /** Lazily-built deferred-numbering engine. See {@link runNumberingPass}. */
  private deferredNumbering: DeferredNumberingStore | null = null
  /** Registered deferred-numbering series, keyed by series name. */
  private readonly numberingConfigs: Map<string, DeferredNumberingConfig>

  /**
   * Background writes for persisted-schema envelopes (#schema-dump v0
   * slice 1). One promise per `collection({ persistJsonSchema: true })`
   * registration that actually fired a derive call. Fire-and-forget
   * from the collection factory; tests await
   * {@link _drainPendingSchemaWrites} before asserting on storage.
   * Production code does not need to drain — the writes are
   * idempotent fingerprints, not correctness invariants.
   */
  private _pendingSchemaWrites: Promise<void>[] = []

  /**
   * Per-vault foreign-key reference registry. Collections
   * register their `refs` option here on construction; the
   * vault uses the registry on every put/delete/checkIntegrity
   * call. One instance lives for the compartment's lifetime.
   */
  private readonly refRegistry = new RefRegistry()

  /**
   * Vault-default locale. Set via
   * `openVault(name, { locale })`. Used as the fallback locale
   * when per-call `{ locale }` options are not specified on individual
   * `get()`/`list()` calls.
   */
  private locale: string | undefined

  /**
   * Vault-level descriptive metadata. Set once at construction via
   * `openVault(name, { meta })`. First-wins: re-opening a cached vault
   * with different meta leaves the original untouched.
   */
  private readonly vaultMeta: VaultMeta | undefined

  /**
   * Current consent scope. Set by `withConsent()` and
   * restored in its finally block. When non-null, every collection
   * access inside the scope writes one entry to `_consent_audit`.
   *
   * Single-slot by design — two concurrent withConsent calls on the
   * same Vault stomp each other. Adopters needing per-flight scoping
   * should use separate Vault instances.
   */
  private consentContext: ConsentContext | null = null

  /** dictKeyField registry: collection name → field name → dictionary name — `DictionaryHandle.rename()`'s reference-update source; populated by `collection()` from `dictKeyFields`. */
  private readonly dictKeyFieldRegistry = new Map<string, Record<string, string>>()

  /** Names of `staticDict()`-backed dictionaries (skip rename tracking; `vault.dictionary(name)` refuses mutation on these via `StaticDictReadonlyError`). Populated at `collection()` config time. */
  private readonly staticDictNames = new Set<string>()

  /** Static-dict descriptors by dictionary name — backs the read-path label resolver and the `resolveDictSource` snapshot. Last writer wins across collections (tables match by construction). */
  private readonly staticByName = new Map<string, StaticDictDescriptor>()

  /** Per-collection field name → StaticDictDescriptor, validated by `enforceStaticDictOnPut`. */
  private readonly staticDescriptorByField = new Map<string, Record<string, StaticDictDescriptor>>()

  /** i18nText fields: collection name → field name → descriptor. Used by `applyI18nLocale`/`validateI18nTextValue`; populated by `collection()` from `i18nFields`. Private — the #664 `via/reconcile.ts` dispatch reads these through {@link _viaReconcileCtx}'s structural bag, not `this` directly (a plain structural bag, never a `Vault` import — S5 port-layering forbids the kernel spine from reaching a with-* service, and this file's own reconcile-ladder logic moved OUT into that unguarded module). */
  private readonly i18nFieldRegistry = new Map<string, Record<string, I18nTextDescriptor>>()

  /** Cache of DictionaryHandle instances, one per dictionary name. */
  private readonly dictionaryCache = new Map<string, DictionaryHandle>()

  /** #650 Task 4 (#647) — declared reserved-lookup collection name → dimension name, for dimensions
   *  with `backing:'reserved'` (dict()/dictKey()). The explicit sync-pull registry: NOT a blanket
   *  underscore-glob — populated at `collection()`-declare time and at `dictionary()`-call time. */
  private readonly reservedLookupCollections = new Map<string, string>()

  /** Registered link specs, keyed by link name; set by `vault.link()`. */
  private readonly linkRegistry = new Map<string, LinkSpec>()
  /** Cache of link-set handles, one per link name (lazy -- see links()). */
  private readonly linkSetCache = new Map<string, LazyLinkSetHandle>()

  /** — subscribers for cross-tier access events. */
  private readonly crossTierSubs = new Set<(event: CrossTierAccessEvent) => void>()

  /** — currently-active elevation, or null. One per vault. */
  private activeElevation: {
    readonly tier: number
    readonly expiresAt: number
    readonly reason: string
    readonly handle: ElevatedHandle
  } | null = null

  /**
   * Optional translator callback threaded from `Noydb.invokeTranslator`.
   * Present only when `plaintextTranslator` was configured on `createNoydb()`.
   */
  private readonly translateText:
    | ((text: string, from: string, to: string, field: string, collection: string) => Promise<string>)
    | undefined

  constructor(opts: {
    adapter: NoydbStore
    name: string
    noydb: Noydb
    keyring: UnlockedKeyring
    encrypted: boolean
    emitter: NoydbEventEmitter
    onDirty?: OnDirtyCallback | undefined
    historyConfig?: HistoryConfig | undefined
    reloadKeyring?: (() => Promise<UnlockedKeyring>) | undefined
    /** Vault-default locale. */
    locale?: string | undefined
    /** Translator callback from Noydb. */
    plaintextTranslator?:
      | ((text: string, from: string, to: string, field: string, collection: string) => Promise<string>)
      | undefined
    /**
     * callback to register a per-collection envelope-level
     * conflict resolver with the SyncEngine. Present when sync is configured.
     */
    onRegisterConflictResolver?: ((name: string, resolver: CollectionConflictResolver) => void) | undefined
    /** — optional remote/sync adapter for presence broadcasting. */
    syncAdapter?: NoydbStore | undefined
    /** #615 — push-only sync targets (backup/archive) this vault may target-purge. Default: none. */
    getPurgeableTargets?: () => readonly { store: NoydbStore; role: 'backup' | 'archive'; label?: string }[]
    /**
     * tree-shake seam — strategy for optional blob storage.
     * Passed through to every `Collection` built by `vault.collection()`.
     * `undefined` => every `collection.blob(id)` throws with a pointer
     * at `@noy-db/hub/blobs`.
     */
    /**
     * Every opt-in service, already resolved by `createNoydb` (#838). Not
     * optional: a Vault cannot be built without it, which is what makes the
     * partially-populated construction path of #834 unrepresentable.
     */
    strategies: StrategyBag
    objectStore?: ObjectProjection | undefined
    guardStrategies?: ReadonlyArray<GuardStrategyAny> | undefined
    numberingConfigs?: ReadonlyArray<DeferredNumberingConfig> | undefined
    /** Vault-level descriptive metadata — set once at construction (first-wins). */
    meta?: VaultMeta | undefined
  }) {
    this.adapter = opts.adapter
    this.name = opts.name
    this.numberingConfigs = new Map((opts.numberingConfigs ?? []).map((c) => [c.series, c]))
    this.noydb = opts.noydb
    this.keyring = opts.keyring
    this.encrypted = opts.encrypted
    this.schemaFence = new SchemaFenceController({
      coordination: this.noydb.coordination,
      vault: this.name,
      onFlush: () => this.noydb._writeQueueTracker.onFlush(),
      clientId: this.noydb._clientId,
      sessionId: this.noydb._sessionId,
      emit: (e) => this.emitter.emit('schema:fence-changed', { vault: this.name, ...e }),
    })
    this.emitter = opts.emitter
    this.onDirty = opts.onDirty
    this.onRegisterConflictResolver = opts.onRegisterConflictResolver
    this.syncAdapter = opts.syncAdapter
    this.getPurgeableTargets = opts.getPurgeableTargets ?? (() => [])
    // #838 — 20 field assignments, each re-applying a `?? NO_*` default that
    // `createNoydb` had already resolved, are one shared reference.
    this.strategies = opts.strategies
    this.objectStore = opts.objectStore
    this.periods = new VaultPeriods({
      strategy: this.strategies.periods,
      adapter: this.adapter,
      vault: this.name,
      encrypted: this.encrypted,
      userId: () => this.keyring.userId,
      getDEK: (collection) => this.getDEK(collection),
      getLedgerOrNull: () => this.getLedgerOrNull(),
      collection: (name) => this.collection(name),
      purgeDeleteMarkers: (before) => this._purgeDeleteMarkers(before),
      archiveRecords: (before) => this._archiveClosedPeriod(before),
      purgeTargets: (before) => this._purgePeriodTargets(before),
      // #822: push symmetry for the period summaries — see writeReserved.
      onDirty: this.onDirty,
    })
    this.linksEnforcer = new VaultLinks({
      refRegistry: this.refRegistry,
      linkRegistry: this.linkRegistry,
      adapter: this.adapter,
      vault: this.name,
      collection: (name) => this.collection(name),
      links: (name) => this.links(name),
      getCachedCollection: (name) => this.collectionCache.get(name),
      getActiveTxContext: () => this.noydb._activeTxContextOrNull,
      emitter: this.emitter,
    })
    this.graph = new ViaGraph()
    // Guard + derivation registries are initialised lazily via
    // `_initGuards()` / `_initDerivations()` from `Noydb.openVault()`.
    // The classes are dynamic-imported there so vaults that never
    // register a strategy don't pull the service code into the
    // floor bundle. The `opts.guardStrategies` argument is
    // intentionally accepted but unused on the constructor — the sync
    // `vault()` fallback path in `noydb.ts` does NOT call `_initGuards`,
    // matching the existing behaviour for `_initDerivations`.
    void opts.guardStrategies
    this.historyConfig = opts.historyConfig ?? { enabled: true }
    this.reloadKeyring = opts.reloadKeyring
    this.locale = opts.locale
    this.vaultMeta = opts.meta
    this.translateText = opts.plaintextTranslator

    // Build the lazy DEK resolver. Pulled out into a private method
    // so `load()` can rebuild it after a keyring refresh — the
    // closure captures `this.keyring` by reference, so changing the
    // field is enough, but resetting the cached `getDEKFn` ensures
    // ensureCollectionDEK runs again against the freshly-loaded
    // wrapped DEKs.
    this.getDEK = this.makeGetDEK()

    // Attestation facade — always built (holds the per-collection field-schema
    // registry); the capability itself is gated by the injected strategy
    // (NO_ATTESTATION default throws until `attestationStrategy: withAttestation()`).
    this.attestation = new VaultAttestation({
      adapter: this.adapter,
      vault: this.name,
      getDEK: (collection) => this.getDEK(collection),
      role: () => this.keyring.role,
      getRawRecord: async (collection, recId) =>
        (await this.collection(collection).get(recId, { locale: 'raw' })) as Record<string, unknown> | null,
    }, this.strategies.attestation)

    // User envelope API — frozen writerKeyringId, dynamic DEK resolver
    // (so a post-load() keyring refresh transparently rotates the DEK
    // through the rebuilt this.getDEK), and a checkGate callback that
    // delegates to Noydb's policy engine (wires edit-own-profile +
    // view-team-profiles).
    this.user = this.noydb.userApiFactory({
      adapter: this.adapter,
      vaultName: this.name,
      writerKeyringId: this.keyring.userId,
      getDek: () => this.getDEK(USER_ENVELOPE_COLLECTION),
      checkGate: (gate, presented) => this.noydb.checkGate(this.name, gate, presented),
      exportAccessible: (opts) => this.strategies.portability.exportAccessibleData(this, opts),
      unilateralWithdraw: (opts) => this.strategies.portability.withdrawAccessibleData(this, opts),
      requestWithdraw: (opts) => this.strategies.portability.requestWithdrawal(this, opts),
      listWithdrawals: (opts) => this.strategies.portability.listWithdrawalRequests(this, opts),
      approveWithdraw: (requestId, opts) => this.strategies.portability.approveWithdrawal(this, requestId, opts),
      rejectWithdraw: (requestId, opts) => this.strategies.portability.rejectWithdrawal(this, requestId, opts),
    })

    // FR-6 custody API — mirrors the UserApi injection pattern: vault-bound
    // closures over Noydb.grantCustodian/revokeCustodian (owner-only) and the
    // liberate ceremony (custodian-only). All three route through the opt-in
    // custodyStrategy (S4): grant/revoke via the gated Noydb methods, liberate
    // via `noydb.custodyStrategy` (which lazily imports the liberateVault
    // engine). No logic here — CustodyApi is a pure delegation shell.
    this.custody = new CustodyApi(
      (options, factors) => this.noydb.grantCustodian(this.name, options, factors),
      (options, factors) => this.noydb.revokeCustodian(this.name, options, factors),
      (opts) => this.noydb.custodyStrategy.liberate(this, opts),
    )
  }

  /**
   * Construct (or reconstruct) the lazy DEK resolver. Captures the
   * CURRENT value of `this.keyring` and `this.adapter` in a closure,
   * memoizing the inner getDEKFn after first use so subsequent
   * lookups are O(1).
   *
   * `load()` calls this after refreshing `this.keyring` to discard
   * the prior session's cached DEKs.
   */
  private makeGetDEK(): (collectionName: string) => Promise<EnclaveKey> {
    let getDEKFn: ((collectionName: string) => Promise<EnclaveKey>) | null = null
    return async (collectionName: string): Promise<EnclaveKey> => {
      if (!getDEKFn) {
        getDEKFn = await ensureCollectionDEK(this.adapter, this.name, this.keyring)
      }
      return getDEKFn(collectionName)
    }
  }

  /**
   * Open a typed collection within this vault.
   *
   * - `options.indexes` declares secondary indexes for the query DSL.
   *   Indexes are computed in memory after decryption; adapters never
   *   see plaintext index data.
   * - `options.prefetch` (default `true`) controls hydration. Eager mode
   *   loads everything on first access; lazy mode (`prefetch: false`)
   *   loads records on demand and bounds memory via the LRU cache.
   * - `options.cache` configures the LRU bounds. Required in lazy mode.
   *   Accepts `{ maxRecords, maxBytes: '50MB' | 1024 }`.
   * - `options.schema` attaches a Standard Schema v1 validator (Zod,
   *   Valibot, ArkType, Effect Schema, etc.). Every `put()` is validated
   *   before encryption; every read is validated after decryption.
   *   Failing records throw `SchemaValidationError`.
   * - `options.i18nFields` declares per-field `i18nText()` descriptors
   *. Validated on `put()` and locale-resolved on reads.
   * - `options.dictKeyFields` declares per-field `dictKey()` descriptors
   *. `put()` validates keys against the declared set; reads
   *   with `{ locale }` add `<field>Label` virtual fields.
   *
   * Throws `ReservedCollectionNameError` for names starting with `_dict_` or
   * equal to `_sequences`. Use `vault.dictionary(name)` for dict collections
   * and `vault.sequence(name)` for sequence counters.
   *
   * Lazy mode + indexes is rejected at construction time — see the
   * Collection constructor for the rationale.
   */
  /** Assembles {@link ViaReconcileVaultCtx} — the plain structural bag the #664 `via/reconcile.ts`
   *  dispatch reads/writes — from this vault's OWN privates, rather than passing `this` itself. */
  private _viaReconcileCtx(): ViaReconcileVaultCtx {
    return {
      i18nStrategy: this.strategies.i18n, locale: this.locale, translateText: this.translateText,
      i18nFieldRegistry: this.i18nFieldRegistry, dictKeyFieldRegistry: this.dictKeyFieldRegistry,
      staticDescriptorByField: this.staticDescriptorByField, reservedLookupCollections: this.reservedLookupCollections,
      staticByName: this.staticByName, staticDictNames: this.staticDictNames, getOpenCollection: (n) => this._getCollection(n), getCollection: (n) => this.collection<Record<string, unknown>>(n),
      dictionary: (name) => this.dictionary(name),
      enforceI18nOnPut: (collectionName, record) => this.enforceI18nOnPut(collectionName, record),
      enforceStaticDictOnPut: (collectionName, record) => this.enforceStaticDictOnPut(collectionName, record),
    }
  }

  /** The registries `populateCollectionRegistries` writes into (#841). */
  #registries() {
    return {
      refRegistry: this.refRegistry,
      i18nFieldRegistry: this.i18nFieldRegistry,
      blobFieldsRegistry: this.blobFieldsRegistry,
      archiveRegistry: this.archiveRegistry,
      attestation: this.attestation,
      dictKeyFieldRegistry: this.dictKeyFieldRegistry,
      staticDictNames: this.staticDictNames,
      staticByName: this.staticByName,
      staticDescriptorByField: this.staticDescriptorByField,
      reservedLookupCollections: this.reservedLookupCollections,
      schemaUpdateNames: this.#schemaUpdateNames,
    }
  }

  collection<T, O extends CollectionShape<T> = Record<never, never>>(
    collectionName: string,
    options?: OpenCollectionOptions<T, SensitiveOf<T, O>, IndexedOf<T, O>, MoneyOf<T, O>>,
  ): Collection<T, SensitiveOf<T, O>, IndexedOf<T, O>, MoneyOf<T, O>> {
    type S = SensitiveOf<T, O>; type Q = IndexedOf<T, O>; type M = MoneyOf<T, O> // #839
    // Overlay intercept. When the requested collection name
    // matches a registered `withOverlayedView`, return the virtual
    // proxy that merges base + overlay on read and routes writes to
    // the overlay collection. The proxy implements the core
    // Collection<T> read/write surface (get, list, put, delete);
    // reactive APIs (live, subscribe) are out of scope.
    const overlayRegistry = this.overlayedViewRegistry
    if (overlayRegistry !== null && overlayRegistry.isOverlay(collectionName)) {
      const spec = overlayRegistry.byName(collectionName)
      if (spec) {
        // Recursive call into the same method — the base + overlay
        // are real collections, so they re-enter this method without
        // hitting the overlay intercept (their names won't match).
        const base = this.collection<T>(spec.base)
        const overlay = this.collection<T>(spec.overlay)
        const baseRowKey = overlayRegistry.resolveBaseRowKey(collectionName, this.materializedViewRegistry)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return new OverlayedCollection<any>(spec, base, overlay, baseRowKey) as unknown as Collection<T, S, Q, M>
      }
    }
    // Guard: reject reserved _dict_* names
    if (isDictCollectionName(collectionName)) throw new ReservedCollectionNameError(collectionName)
    // Guard: reject the internal _sequences collection — use vault.sequence() instead.
    if (collectionName === SEQUENCE_COLLECTION) throw new ReservedCollectionNameError(collectionName)
    // Guard: reject reserved _links_* names — use vault.link()/vault.links() instead.
    if (isLinkCollectionName(collectionName)) throw new ReservedCollectionNameError(collectionName)
    // Guard: reject secret-bearing reserved names (`_sync_credentials`,
    // `_broker`). Their record CONTENTS are directly-usable secrets, so they
    // must never be reachable through the generic public collection handle —
    // they are served only by their dedicated, owner/admin-gated API. Serving
    // them here would decrypt with whatever DEK the caller's keyring holds,
    // bypassing that gate. See reserved-secret-collections.ts.
    if (isSecretBearingReservedCollection(collectionName)) throw new ReservedCollectionNameError(collectionName)

    if (this.satelliteRegistry?.byJoined(collectionName)) { // #591: joined handle — not a directly reachable collection
      throw new SatelliteConfigError(`"${collectionName}" is a joined handle — use vault.joined('${collectionName}'), not vault.collection().`)
    }
    // R-S8 direction (ii): refuse constructing (fresh OR already-cached) either
    // pair member with crdt mode AFTER the pairing already exists.
    if (options?.crdt !== undefined && this.satelliteRegistry?.isPairMember(collectionName)) {
      throw new SatelliteConfigError('R-S8: crdtMode is refused on either member of a satellite pair in v1 (revert cannot compensate a merge).')
    }
    if (options?.satelliteOf !== undefined) { // #591 thin call-site (archetype-③) — wiring lives in with-shape/satellites/declare.ts
      this.satelliteRegistry = declareSatellite({
        adapter: this.adapter, vaultName: this.name, forgetSubjects: this.strategies.forget.subjects, getDEK: this.getDEK,
        getBaseSchema: (base) => this.collectionCache.get(base)?.getSchema(),
        getBaseCrdt: (base) => this.collectionCache.get(base)?.getConfig()?.crdt,
        collectionExists: (name) => this.collectionCache.has(name),
        registerPoisonHook: (hook) => { this.noydb._writeHooks.onBeforeWrite(hook) },
        forEachSyncEngine: (fn) => { this.noydb._forEachSyncEngine(this.name, fn) },
      }, collectionName, { ...options, satelliteOf: options.satelliteOf }, this.satelliteRegistry)
    }

    let coll = this.collectionCache.get(collectionName)
    const effectiveViaFields = mergeViaFields({ moneyFields: options?.moneyFields, i18nFields: options?.i18nFields, dictKeyFields: options?.dictKeyFields, lookupFields: options?.lookupFields, viaFields: options?.viaFields }) // #627: merged view feeds both late-attach reconcile (below) and fresh construct
    // #664 — the whole late-attach reconcile ladder (collision guard, the five pre-existing
    // _apply* reconciles, the two-phase graph-edge/taint commit, and the new i18n/dictKey
    // machinery) now lives behind ONE dispatch call in the unguarded via/reconcile.ts, not
    // inlined here. `Collection._applyX`'s own first-wins semantics are unchanged; this file
    // only threads the field-declaring options + this vault's registries through.
    if (coll) {
      reconcileViaAttach(coll, this.graph, collectionName, this._viaReconcileCtx(), {
        effectiveViaFields,
        ...(options?.computed !== undefined ? { computed: options.computed as ComputedFields } : {}),
        ...(options?.fieldMeta !== undefined ? { fieldMeta: options.fieldMeta } : {}),
        ...(options?.meta !== undefined ? { meta: options.meta } : {}),
        ...(options?.classifiedFields !== undefined ? { classifiedFields: options.classifiedFields } : {}),
        ...(options?.blobFields !== undefined ? { blobFields: options.blobFields } : {}),
      })
    }
    if (!coll) {
      // Fan the declaration out into the vault's ten registries (#841).
      // Runs BEFORE the Collection is constructed so the first put() already
      // sees its refs through vault.enforceRefsOnPut.
      populateCollectionRegistries(this.#registries(), collectionName, options, effectiveViaFields)

      // Schema-update gate. Built only when persistence + strategies
      // are on. Detection runs in the same work pushed to the drain; the
      // gate caches the decision and the write path (put/delete) enforces it.
      let schemaUpdateGate: SchemaUpdateGate | undefined
      if (
        options?.persistJsonSchema === true &&
        options.schema !== undefined &&
        (options.schemaUpdate?.length ?? 0) > 0
      ) {
        const validator: unknown = options.schema
        const strategies = options.schemaUpdate ?? []
        const work = (async (): Promise<UpdateDecision> => {
          const dek = await this.getDEK(collectionName)
          const { persistSchemaIfNeeded } = await import('../with-shape/persisted-schemas/register.js') // lazy (#553)
          const result = await persistSchemaIfNeeded({
            store: this.adapter, vault: this.name, collectionName, validator, dek, strategies,
          })
          const decision = result.decision ?? { action: 'allow' as const }
          if (decision.action === 'cutover') {
            this.schemaFence.registerPendingCutover(collectionName, decision.transform)
            await this._ensureFenceCoordination()
          }
          return decision
        })()
        this._pendingSchemaWrites.push(work.then(() => {}, () => {}))
        schemaUpdateGate = new SchemaUpdateGate(work)
      }

      // Per-collection history/ledger scoping. A per-call
      // `historyConfig` overrides the vault-wide config wholesale for this
      // collection; `ledger: false` excludes it from the tamper chain.
      const effectiveHistoryConfig = options?.historyConfig ?? this.historyConfig

      const collOpts: ConstructorParameters<typeof Collection<T>>[0] = {
        adapter: this.adapter,
        vault: this.name,
        name: collectionName,
        keyring: this.keyring,
        encrypted: this.encrypted,
        emitter: this.emitter,
        writeQueue: this.noydb._writeQueueTracker,
        writeHooks: this.noydb._writeHooks,
        subsystemBus: this.noydb._subsystemBus,
        activeTxId: () => this.noydb._activeTxContextOrNull?.txId ?? null,
        schemaUpdateGate,
        schemaFence: this.schemaFence,
        getDEK: this.getDEK,
        onDirty: this.onDirty,
        tabCoordinated: () => this.noydb._tabCoordinationActive, // #693: re-create gate fallback
        historyConfig: effectiveHistoryConfig,
        historyConfigExplicit: options?.historyConfig !== undefined,
        ...(this.objectStore !== undefined ? { objectStore: this.objectStore } : {}),
        ...(options?.blobFields !== undefined ? { blobFields: options.blobFields as BlobFieldsConfig<unknown> } : {}),
        strategies: this.strategies,
        // Per-collection ledger opt-out: when this collection sets
        // `historyConfig.ledger: false`, withhold the ledger reference so all
        // four `if (this.ledger)` append sites in Collection no-op. The chain
        // stays valid — it simply never receives this collection's entries.
        ledger: effectiveHistoryConfig.ledger === false ? undefined : (this.getLedgerOrNull() ?? undefined),
        refEnforcer: this,
        joinResolver: this,
        defaultLocale: this.locale,
        onRegisterConflictResolver: this.onRegisterConflictResolver,
        onAccess: (op, id) => this._logConsent(op, collectionName, id),
        graphDispatch: { collect: (collection, id) => this._collectGraphTouch(collection, id), collectDelete: (collection, id, intents) => this._collectGraphDelete(collection, id, intents) },
        // Derivation source is only wired when the corresponding registry
        // has been initialised. Guard source was removed in Track A slice 3b
        // — guards now run via the gate bus in Noydb.#registerGuardGate.
        // Vaults without derivations skip this so `Collection.put`'s
        // `if (this.derivationSource)` branch no-ops without touching the
        // derivation service code.
        ...(this.derivationRegistry !== null
          ? {
              derivationSource: {
                registry: () => this.derivationRegistry as DerivationRegistry,
                getCollection: (name: string) =>
                  this.collection(name) as unknown as Collection<Record<string, unknown>>,
                getReadOnlyFacade: () => this._ensureReadOnlyFacade(),
                getActiveTxContext: () => this.noydb._activeTxContextOrNull,
                createTxContext: () => this.noydb._createTxContext(),
                setActiveTxContext: (ctx) => this.noydb._setActiveTxContext(ctx),
                clearActiveTxContext: (ctx) => this.noydb._clearActiveTxContext(ctx),
              },
            }
          : {}),
        ...(this.materializedViewRegistry !== null
          ? {
              materializedViewSource: {
                 
                registry: () => this.materializedViewRegistry!,
                getCollection: (name: string) => this.collection(name),
                getActiveTxContext: () => this.noydb._activeTxContextOrNull,
                getQueryContext: () => this as unknown as MVQueryContext,
              },
            }
          : {}),
      }
      // #841 — 28 pass-through options in one call. Anything needing logic
      // stays explicit; the forget-subject rule below still overrides
      // `perRecordKeys` because it runs after this.
      copyDefined(collOpts as unknown as Record<string, unknown>, options as unknown as Record<string, unknown> | undefined, COLLECTION_PASSTHROUGH_KEYS)
      // A collection declared in `withForget({ subjects })` MUST
      // use per-record CEKs: crypto-shred can only guarantee erasure of a body
      // keyed off a per-record CEK. Force it on (and warn if the caller
      // explicitly set it false — that would silently defeat erasure).
      const subjectKey = this.strategies.forget.subjects[collectionName]
      if (subjectKey !== undefined) {
        if (options?.perRecordKeys === false) {
          console.warn(
            `[noy-db] Collection "${collectionName}" is declared in withForget ` +
            `but opened with perRecordKeys: false. Forcing perRecordKeys: true — ` +
            `GDPR crypto-shred requires per-record CEKs.`,
          )
        }
        collOpts.perRecordKeys = true
        // Classified refusal matrix R4: a digest-only field cannot be the
        // forget-subject key (the subject index would hold the plaintext).
        collOpts.subjectKeyField = subjectKey
        collOpts.addSubjectRef = async (id, record) => { const value = readDottedPath(record as Record<string, unknown>, subjectKey); if (value !== undefined && value !== null) await this._addSubjectRef(coerceSubjectId(value), { collection: collectionName, id }) } // #766: putAtTier's raw write bypasses onAfterWrite — register the first-write subject ref directly
      }
      collOpts.onCrossTierAccess = (event) => this.emitCrossTier(event)
      if (this.syncAdapter !== undefined) collOpts.syncAdapter = this.syncAdapter
      if (effectiveViaFields.dictKeyFields !== undefined || effectiveViaFields.lookupFields !== undefined) {
        // Build the label resolver callback for this collection. A static dict resolves from
        // its in-memory table — no dictionary() lookup, no _dict_* read — while a plain dictKey
        // resolves through the encrypted _dict_* handle as before. Shared verbatim by the lookup
        // binding (#650 Task 2) — native lookup()/dict() reserved/static(+table) dimensions
        // register into the SAME staticByName registry above, so this one resolver serves both.
        collOpts.dictLabelResolver = async (dictName, key, locale, fallback) => {
          const stat = this.staticByName.get(dictName)
          if (stat) {
            const labels = stat.table[key]
            return labels ? resolveLabelFromMap(labels, locale, fallback) : undefined
          }
          const handle = this.dictionary(dictName)
          return handle.resolveLabel(key, locale, fallback)
        }
        // Provide a handle factory for dynamic dicts so the search
        // index can call list() to build the full key→labels map.
        collOpts.getDictionary = async (name: string) => this.dictionary(name)
        collOpts.dictKeyFields = options?.dictKeyFields
      }
      if (effectiveViaFields.lookupFields !== undefined) {
        // membership/getAltIndex (#650 Task 3) are vault-built closures — never a collection handle.
        // must move together with via/reconcile.ts's five lookup closures (#664).
        collOpts.lookupLabelResolver = collOpts.dictLabelResolver
        collOpts.getLookupBacking = (desc: LookupDescriptor) => async (key: string) => // #651: snapshot-first (sole truth for key!=='id'); id-tier alone falls back to a live cold-session .get()
          buildLookupSnapshotRows(desc, (n) => this.reservedLookupCollections.has(dictCollectionName(n)), (n) => this.dictionary(n), (n) => this.collection<Record<string, unknown>>(n))?.get(key) ?? (desc.key === 'id' ? (await this.collection<Record<string, unknown>>(desc.dimension).get(key)) ?? undefined : undefined)
        collOpts.lookupFields = options?.lookupFields
        collOpts.membership = (field, key) => checkLookupMembership(effectiveViaFields.lookupFields![field]!, key, (n) => this.dictionary(n), (n) => this.collection(n))
        collOpts.getAltIndex = (d) => buildLookupAltIndex(d, (n) => this.dictionary(n), (n) => this.collection<Record<string, unknown>>(n))
        collOpts.snapshotFor = (d) => buildLookupSnapshotRows(d, (n) => this.reservedLookupCollections.has(dictCollectionName(n)), (n) => this.dictionary(n), (n) => this.collection<Record<string, unknown>>(n)) // #650 Task 6/7
      }
      // i18n / staticDict validation on put — enforced via the compartment's
      // put hook. staticDict adds put-time code validation.
      if (
        effectiveViaFields.i18nFields !== undefined ||
        effectiveViaFields.dictKeyFields !== undefined
      ) {
        collOpts.i18nPutValidator = (record: unknown) => {
          this.enforceI18nOnPut(collectionName, record)
          this.enforceStaticDictOnPut(collectionName, record)
        }
      }
      // Wire the translator for autoTranslate: true fields
      if (effectiveViaFields.i18nFields !== undefined && this.translateText) {
        collOpts.autoTranslateHook = this.translateText
      }
      // fieldMeta: thread through to the collection. Real key-validation (against
      // schema-derived fields) happens in the async describe() path where the full
      // known-field set is available. The sync path at vault-construction time cannot
      // validate schema fields, so no validate call here.
      // meta: thread through to the collection; surfaced via getMeta() / describe().
      // Pass a snapshot of the outbound refs for describe() (sync, config-only).
      if (options?.refs !== undefined) {
        collOpts.declaredRefs = this.refRegistry.getOutbound(collectionName)
      }
      coll = new Collection<T>(collOpts)
      this.collectionCache.set(collectionName, coll)
      registerCollectionGraphSources(this.graph, collectionName, collOpts)
      registerLookupRefEdges(this.graph, collectionName, effectiveViaFields.lookupFields) // #650 Task 5
      applyTaintOverlay(coll, this.graph, collectionName) // #638 Task 3: seal + gate any freshly-tainted field
      reapplyDependentOverlays(this.graph, collectionName, (n) => this._getCollection(n)) // #642: refresh dependents opened before this source

      // Pre-build the lexical index on open when opted in. Fire-and-forget,
      // eager-only; warmIndex() no-ops when no textIndexes are declared and throws
      // (caught here) in lazy mode, so this stays a single guarded line.
      if (options?.warmIndexOnOpen === true && options.prefetch !== false) {
        void coll.warmIndex().catch(() => {})
      }

      // Fire-and-forget persisted-schema write when opted in. Pushed
      // onto _pendingSchemaWrites so tests can drain before asserting;
      // production code ignores it (the writes are idempotent fingerprints).
      // When schemaUpdate strategies are present, persistence already ran
      // inside the gate's work above — skip the un-gated path here.
      if (
        options?.persistJsonSchema === true &&
        options.schema !== undefined &&
        (options.schemaUpdate?.length ?? 0) === 0
      ) {
        const validator: unknown = options.schema
        const work = (async () => {
          try {
            const dek = await this.getDEK(collectionName)
            await (await import('../with-shape/persisted-schemas/register.js')).persistSchemaIfNeeded({
              store: this.adapter,
              vault: this.name,
              collectionName,
              validator,
              dek,
            })
          } catch (err) {
            // Schema persistence is a fingerprint, not a correctness
            // invariant — log and continue. Production callers can
            // still detect failures via _drainPendingSchemaWrites.
             
            console.warn(
              `[noy-db] persisted-schema write failed for "${collectionName}": `
              + (err instanceof Error ? err.message : String(err)),
            )
          }
        })()
        this._pendingSchemaWrites.push(work)
      }
    }
    if (this.satelliteRegistry) { // #591: existence-authority + R-S6 read/write proxy (with-shape/satellites/proxy.ts)
      const spec = this.satelliteRegistry.bySatellite(collectionName)
      if (spec) return makeSatelliteProxy(coll, spec, this.satelliteRegistry) as Collection<T, S, Q, M>
      const baseSpec = this.satelliteRegistry.satelliteOf(collectionName) // #591 Task 6: base-side delete fan-out
      if (baseSpec) return makeBaseProxy(coll, baseSpec, this.satelliteRegistry, () => this.collection(baseSpec.satellite)) as Collection<T, S, Q, M>
    }
    return coll as unknown as Collection<T, S, Q, M>
  }

  /** Full-record handle for a satellite pair registered with `joined:` (spec #591). Narrow type — not a Collection. */
  joined<T extends Record<string, unknown>>(name: string): JoinedHandle<T> {
    const spec = this.satelliteRegistry?.byJoined(name)
    if (!spec) throw new SatelliteConfigError(`No joined handle "${name}" is registered — declare it via collection(satellite, { joined: '${name}' }).`)
    return makeJoinedHandle<T>(spec, {
      spec, base: () => this.collection(spec.base), satellite: () => this.collection(spec.satellite),
      adapter: this.adapter, vaultName: this.name, registry: this.satelliteRegistry!,
    })
  }

  /**
   * Migrate an existing satellite's records onto per-record CEKs (#599) —
   * unblocks R-S7 when a base gains forget coverage after its satellite was
   * already declared without `perRecordKeys`. Call BEFORE re-declaring with
   * `{ satelliteOf, perRecordKeys: true }` AND before this collection serves
   * writes (unfenced walk — see {@link migrateSatelliteCek}); resumable.
   */
  async migrateSatellitePerRecordKeys(satelliteName: string): Promise<{ migrated: number }> {
    return migrateSatelliteCek(satelliteName, this.collection(satelliteName, { perRecordKeys: true }))
  }

  /**
   * Await all background persisted-schema writes triggered by
   * `collection({ persistJsonSchema: true })` calls on this vault.
   * Used in tests; production code does not need to call this.
   */
  async _drainPendingSchemaWrites(): Promise<void> {
    const pending = this._pendingSchemaWrites
    this._pendingSchemaWrites = []
    await Promise.allSettled(pending)
  }

  /**
   * Run a coordinated schema cutover. Drains pending writes, waits
   * for the active client set to quiesce (the ack-barrier), applies every
   * pending collection transform in bulk, bumps the vault schema generation,
   * and clears the fence. Returns the count of collections migrated.
   * `opts.onPoll` (tests) advances other clients between barrier checks.
   */
  async runSchemaCutover(opts?: { onPoll?: () => Promise<void> }): Promise<{ migrated: number }> {
    return this.schemaFence.runCutover(
      (collectionName, transform) => this.#runCutoverTransform(collectionName, transform),
      opts,
    )
  }

  async #runCutoverTransform(collectionName: string, transform: TransformFn): Promise<void> {
    const coll = this.collectionCache.get(collectionName)
    if (!coll) return
    this._beginGraphBatch() // #638 Task 4 — cutover is a dispatch-wave origin, same as sync-apply
    await coll._applyCutoverTransform(transform)
    await this._flushGraphBatch()
  }

  /**
   * Refresh a loaded collection's view of one document from a peer
   * tab's broadcast. No-op when the collection isn't loaded in this tab
   * (it will read fresh on next open). Mirrors `#runCutoverTransform`'s guard.
   */
  async _applyRemoteWrite(collectionName: string, docId: string, action: 'put' | 'delete'): Promise<void> {
    const coll = this.collectionCache.get(collectionName)
    if (!coll) return
    await coll._applyRemoteChange(docId, action)
  }

  /** @internal #598: refresh cache entries a sync-applied write rewrote underneath us. No-op if not loaded this session.
   *  #650 Task 4 (#647): a reserved-lookup collection has no `Collection` instance — instead, refresh
   *  its already-warmed `LookupHandle._syncCache` (membership/altIndex/snapshot reads never see a
   *  stale verdict for a pulled vocabulary edit) and collect the touch into any open graph batch
   *  (the sync-apply wave-reachability seam Task 5's ref edges will use). No-op if never warmed. */
  async _invalidateSyncApplied(collection: string, id: string, action: 'put' | 'delete'): Promise<void> {
    const coll = this.collectionCache.get(collection)
    if (coll) {
      await coll._onRecordMutated(id, action, 'sync-apply')
      return
    }
    const dimName = this.reservedLookupCollections.get(collection)
    if (dimName === undefined) return
    await this.dictionaryCache.get(dimName)?._refreshSyncCache(id)
    this._collectGraphTouch(collection, id)
  }

  /** @internal #650 Task 4 (#647) — declared reserved-lookup collection names, for `SyncEngine.pull()`'s explicit prefix registry. */
  _reservedLookupCollectionNames(): readonly string[] {
    return [...this.reservedLookupCollections.keys()]
  }

  /** @internal #653 — one-hop reserved-dict deps of `names`, for `SyncEngine`'s partial-sync
   *  filter expansion. Provably complete at one hop: `vault.collection()` refuses `_dict_*`
   *  names, so a dict can never itself declare lookup fields (no dict-of-dict chain). */
  _reservedDictDepsOf(names: readonly string[]): readonly string[] {
    return reservedDictDepsOf(names, this.dictKeyFieldRegistry)
  }

  /** @internal #638 Task 4 — open a graph-dispatch touch batch (sync pull()/push()/cutover). */
  _beginGraphBatch(): void {
    this._graphBatch = new Map()
  }

  /** @internal #638 Task 4 — `Collection._onRecordMutated`'s sync-apply/cutover/restore hook; a
   *  no-op when no batch is open (`_beginGraphBatch()` was never called for this call chain). */
  _collectGraphTouch(collection: string, id: string): void {
    if (!this._graphBatch) return
    touchFor(this._graphBatch, collection).puts.add(id)
  }

  /** @internal #640 — the sync-apply delete socket: `id`'s resolved rollup-parent intents. */
  _collectGraphDelete(collection: string, id: string, intents: readonly RollupDeleteIntent[]): void {
    if (!this._graphBatch) return
    touchFor(this._graphBatch, collection).deletes.set(id, intents)
  }

  /** @internal #638 Task 4 — close the open batch and run ONE dispatch wave over it. */
  async _flushGraphBatch(): Promise<void> {
    const batch = this._graphBatch
    this._graphBatch = undefined
    if (batch && batch.size > 0) await runGraphDispatchWave(this, batch)
  }

  /** @internal #638 Task 4 — cached-collection lookup for `runGraphDispatchWave` (`VaultLike`); never constructs. */
  _getCollection(name: string): Collection<Record<string, unknown>> | undefined {
    return this.collectionCache.get(name) as Collection<Record<string, unknown>> | undefined
  }

  /** @internal #640 (#644 item 3) — `VaultLike._emit`: the wave's structured error surfacing. */
  _emit(event: string, payload: unknown): void { (this.emitter.emit as (ev: string, pl: unknown) => void)(event, payload) }

  /**
   * @internal #589 → #604. Physically remove delete markers with `_ts` strictly
   * older than `before` (ISO timestamp), across `collections` (or all data
   * collections). Returns the count removed.
   *
   * SAFETY: purging a marker RE-OPENS the #589 resurrection window for any peer
   * offline since before the cutoff — never-GC is safe precisely because the marker
   * is always present to win convergence. This is an operator-asserted safe-point
   * ONLY; #604's period-close lifecycle is what earns that assertion. Do not call
   * it on live/unsettled data.
   *
   * Emits no ledger/event itself — its callers (#604's `freezePeriod`, #615's
   * `purgePeriodTargets`) own the audit record. The sweep body is shared via
   * {@link _purgeMarkersOn}, which #615 also aims at push-only sync targets.
   *
   * Purges the local adapter only. Markers already pushed to the vault's
   * push-only (`backup`/`archive`) sync targets are reclaimed by #615's
   * `vault.purgePeriodTargets`; `sync-peer` targets are left untouched (purging
   * them would re-open the resurrection window — the deferred half of #611).
   */
  async _purgeDeleteMarkers(before: string, collections?: string[]): Promise<number> {
    return purgeMarkersOn(this.adapter, this.name, before, collections)
  }

  /**
   * @internal #613. Relocate this closed period's in-window records (those
   * with `_ts < before`) from the hot store to the configured cold tier,
   * via the routeStore's `compact({ before })`. Returns the count moved.
   * Requires a `routeStore` with a cold route (the `coldArchival`
   * capability); throws a clear error otherwise. Non-destructive — reads
   * fall through to cold, so this does NOT re-open the #589 window.
   */
  async _archiveClosedPeriod(before: string): Promise<number> {
    // Inline type-only import() (no `from` clause) is the sanctioned S4 gate
    // escape hatch for the kernel spine to reference a with-* service type
    // without a static import that the port-layering architecture check would flag.
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const store = this.adapter as Partial<import('../with-store/route-store.js').RoutedNoydbStore>
    if (store.capabilities?.coldArchival !== true || typeof store.compact !== 'function') {
      throw new ValidationError('archivePeriod: cold archival requires a routeStore with a cold route.')
    }
    return store.compact(this.name, { before })
  }

  /**
   * @internal #615. Sweep delete markers with `_ts < before` off each of the
   * vault's push-only sync targets, returning a per-target count. Skips
   * `sync-peer` targets by construction (getPurgeableTargets yields only
   * backup/archive). Never touches the local adapter.
   */
  async _purgePeriodTargets(before: string): Promise<readonly { label?: string; role: 'backup' | 'archive'; purgedCount: number }[]> {
    const out: { label?: string; role: 'backup' | 'archive'; purgedCount: number }[] = []
    for (const t of this.getPurgeableTargets()) {
      const purgedCount = await purgeMarkersOn(t.store, this.name, before)
      out.push({ ...(t.label !== undefined ? { label: t.label } : {}), role: t.role, purgedCount })
    }
    return out
  }

  /**
   * For a detected conflict: capture this tab's clobbered record,
   * read the common ancestor from history, converge the cache to the store's
   * authoritative value (the re-read), and return all three for the
   * WriteConflict payload. Returns null when the collection isn't loaded.
   */
  async _captureAndConverge(
    collectionName: string,
    docId: string,
    action: 'put' | 'delete',
    baseV: number,
  ): Promise<{ local: unknown; remote: unknown; base: unknown } | null> {
    const coll = this.collectionCache.get(collectionName)
    if (!coll) return null
    // `local` is the pre-converge cached record (the clobbered write) — peek only, no store read.
    // Consumers must not mutate the returned records: in eager mode they alias live cache entries.
    const local = coll._peekCached(docId)
    let base: unknown = null
    try { base = await coll.getVersion(docId, baseV) } catch { base = null }
    await coll._applyRemoteChange(docId, action)
    // `remote` is the post-converge authoritative value via the universal read path
    // (cache in eager mode; a store read in lazy mode, where the LRU entry was just evicted).
    const remote = await coll.get(docId)
    return { local, remote, base }
  }

  /** Recover a stuck cutover fence — reset to normal without bumping. */
  async abortSchemaCutover(): Promise<void> {
    await this.schemaFence.abort()
  }

  /** Current schema-cutover fence state for this vault. Thin live read. */
  async schemaFenceState(): Promise<FenceDoc> {
    return loadFence(this.adapter, this.name)
  }

  /** @internal Start heartbeat + fence watcher once a cutover is registered. Async since #553: FenceWatcher dynamic-imports on demand. */
  async _ensureFenceCoordination(): Promise<void> {
    if (this.#fenceCoordinationStarted) return
    this.#fenceCoordinationStarted = true
    const { FenceWatcher } = await import('../with-shape/schema-update/fence-watcher.js')
    if (!this.#fenceCoordinationStarted) return // _stop raced the load -- don't resurrect
    this.#fenceWatcher = new FenceWatcher({
      coordination: this.noydb.coordination,
      vault: this.name,
      clientId: this.noydb._clientId,
      sessionId: this.noydb._sessionId,
      onFlush: () => this.noydb._writeQueueTracker.onFlush(),
      emit: (e) => this.emitter.emit('schema:fence-changed', { vault: this.name, ...e }),
    })
    this.#fenceWatcher.start(2_000) // heartbeat + poll; unref'd so it never holds the process open
  }

  /** @internal Stop the heartbeat/watcher (vault lock/close). */
  _stopFenceCoordination(): void {
    this.#fenceWatcher?.stop()
    this.#fenceWatcher = undefined
    this.#fenceCoordinationStarted = false
  }

  /** @internal Best-effort flush of all open collections' persisted
   *  lexical indexes on close(). Called fire-and-forget from noydb.close().
   *  Correctness is backstopped by the fingerprint: a missed flush → rebuild on
   *  next load. Only collections with textIndexPersist have a flush(); others no-op. */
  async _flushSearchIndexes(): Promise<void> {
    for (const coll of this.collectionCache.values()) {
      await coll.flushIndex().catch(() => { /* best-effort */ })
    }
  }

  /** @internal Drive one heartbeat + watch cycle deterministically (tests). */
  async _fenceTick(): Promise<void> {
    await this._ensureFenceCoordination()
    await this.#fenceWatcher!.beat()
    await this.#fenceWatcher!.check()
  }

  /**
   * Validate i18nText fields on a `put()`. Called by Collection just
   * before the adapter write, after schema validation. Throws
   * `MissingTranslationError` when a required translation is absent.
   *
   * Delegates through the Via registry (#623) — a no-op only when i18n was
   * never declared (mirrors the registry check below).
   */
  enforceI18nOnPut(collectionName: string, record: unknown): void {
    if (!isViaInstalled('i18n')) return
    const i18nFields = this.i18nFieldRegistry.get(collectionName)
    if (!i18nFields || Object.keys(i18nFields).length === 0) return
    if (!record || typeof record !== 'object') return

    const obj = record as Record<string, unknown>
    for (const [field, descriptor] of Object.entries(i18nFields)) {
      const values = getAtPath(obj, field)
      for (const value of values) {
        if (value === undefined || value === null) continue
        this.strategies.i18n.validateI18nTextValue(value, field, descriptor)
      }
    }
  }

  /**
   * Validate staticDict codes on a `put()`. For each `staticDict()`
   * field, every stored code must be a declared key of the descriptor's
   * table, else `UnknownDictCodeError`. Opt out per descriptor with
   * `{ validateCodes: false }`.
   *
   * Delegates through the Via registry — see {@link enforceI18nOnPut}. The
   * per-field validation itself lives in `via/lookup/registry.ts`
   * (#650 Task 1 extraction), reached via `port/with/lookup-strategy.ts`.
   */
  enforceStaticDictOnPut(collectionName: string, record: unknown): void {
    if (!isViaInstalled('i18n')) return
    enforceStaticDictOnPutHelper(this.staticDescriptorByField.get(collectionName), record)
  }

  /**
   * Open a dictionary by name. Returns a `DictionaryHandle` for CRUD
   * operations on the `_dict_<name>/` reserved collection.
   *
   * The handle is cached — multiple calls with the same name return the
   * same instance.
   *
   * @param name     The dictionary name (e.g. `'status'` → `_dict_status/`).
   * @param options  Optional ACL overrides (default `writableBy: 'admin'`).
   *
   * @example
   * ```ts
   * await company.dictionary('status').putAll({
   *   draft: { en: 'Draft', th: 'ฉบับร่าง' },
   *   paid:  { en: 'Paid',  th: 'ชำระแล้ว' },
   * })
   * ```
   */
  dictionary<Keys extends string = string>(
    name: string,
    options: DictionaryOptions = {},
  ): DictionaryHandle<Keys> {
    // A staticDict has no _dict_* collection and no mutation surface —
    // its labels are code constants. Refuse the handle so put/putAll/rename/
    // delete can never be attempted against a static name.
    if (this.staticDictNames.has(name)) throw new StaticDictReadonlyError(name)
    this.reservedLookupCollections.set(dictCollectionName(name), name) // #650 Task 4 (#647)
    let handle = this.dictionaryCache.get(name)
    if (!handle) {
      handle = this.strategies.i18n.buildDictionaryHandle<Keys>({
        adapter: this.adapter,
        compartmentName: this.name,
        dictionaryName: name,
        keyring: this.keyring,
        reservedEnvelopes: makeReservedEnvelopes((collection) => this.getDEK(collection), ['_dict_'])('_dict_'),
        encrypted: this.encrypted,
        ledger: this.getLedgerOrNull() ?? undefined,
        options,
        // findAndUpdateReferences: rewrite dictKey fields in all
        // registered collections when rename() is called. Body extracted to
        // via/lookup/registry.ts (#650 Task 1) — reached via the
        // port/with/lookup-strategy.ts seam.
        findAndUpdateReferences: async (dictionaryName, oldKey, newKey) => {
          await updateReferencingRecords(
            this.dictKeyFieldRegistry,
            (collectionName) => this.collection<Record<string, unknown>>(collectionName),
            dictionaryName,
            oldKey,
            newKey,
          )
        },
        emitter: this.emitter,
        buildDeleteMarker, // #647 fix wave 1 — real kernel/enclave builder; LookupHandle can't import it directly
        // #650 Task 4 (#647) — choke-point participation for LOCAL writes: dirty-log tracking + a
        // one-shot graph-dispatch wave (local-write's `graphDispatch.collect`-equivalent; Task 5's ref edges give it dependents).
        onDirty: this.onDirty,
        onRecordMutated: async (collection, id) => { this._beginGraphBatch(); this._collectGraphTouch(collection, id); await this._flushGraphBatch() },
        checkReferencesOnDelete: (key) => this.linksEnforcer.enforceLookupRefsOnDelete(this.graph, name, dictCollectionName(name), key), // #650 Task 5
      })
      this.dictionaryCache.set(name, handle)
    }
    return handle as DictionaryHandle<Keys>
  }

  /**
   * Declare a managed many-to-many link set. Registers a
   * `_links_<name>` junction between two endpoint collections; access its
   * rows via `vault.links(name)`. Idempotent for an identical re-declaration;
   * a conflicting one throws. See {@link links}.
   *
   * ```ts
   * vault.link('saleLineLinks', { a: ref('saleLines'), b: ref('purchaseLines'), onDelete: 'cascade' })
   * ```
   *
   * `a` / `b` accept either a collection name or a `ref(target)` descriptor
   * (only its `target` is used — links manage their own integrity). `onDelete`
   * governs what happens to link rows when an endpoint record is deleted
   * (`'cascade'` default, `'strict'`, `'warn'`).
   */
  link(name: string, spec: { a: string | RefDescriptor; b: string | RefDescriptor; onDelete?: LinkSpec['onDelete'] }): void {
    const a = typeof spec.a === 'string' ? spec.a : spec.a.target
    const b = typeof spec.b === 'string' ? spec.b : spec.b.target
    for (const [slot, target] of [['a', a], ['b', b]] as const) {
      if (!target || target.startsWith('_') || target.includes('/')) {
        throw new ValidationError(
          `vault.link("${name}"): endpoint "${slot}" must be a simple collection name, got "${target}".`,
        )
      }
    }
    const resolved: LinkSpec = { a, b, ...(spec.onDelete ? { onDelete: spec.onDelete } : {}) }
    const existing = this.linkRegistry.get(name)
    if (existing) {
      if (existing.a !== resolved.a || existing.b !== resolved.b || (existing.onDelete ?? 'cascade') !== (resolved.onDelete ?? 'cascade')) {
        throw new ValidationError(`vault.link("${name}"): conflicting re-declaration.`)
      }
      return
    }
    this.linkRegistry.set(name, resolved)
  }

  /**
   * Access a declared link set. Throws if `name` was not first
   * declared via {@link link}. Returns a cached {@link LinkSetHandle}:
   * `connect(a, b, meta?)`, `disconnect(a, b)`, `has(a, b)`, `of(id)`, `list()`.
   */
  links(name: string): LinkSetHandle {
    let handle = this.linkSetCache.get(name)
    if (!handle) {
      const spec = this.linkRegistry.get(name)
      if (!spec) {
        throw new ValidationError(`vault.links("${name}"): not declared. Call vault.link("${name}", { a, b }) first.`)
      }
      // #553: handle surface is all-async, so the LinkSet engine dynamic-imports on first link I/O.
      handle = makeLazyLinkSetHandle({
        adapter: this.adapter, vault: this.name, name, spec, encrypted: this.encrypted,
        getDEK: this.getDEK, actor: this.keyring.userId, emitter: this.emitter,
        endpointExists: async (collection, id) => (await this.collection(collection).get(id)) !== null,
      })
      this.linkSetCache.set(name, handle)
    }
    return handle
  }

  /**
   * Build a `JoinableSource` for a dictKey field, for use in dict joins.
   * Returns a source whose snapshot contains `{ key, labels, ...labels }`
   * records — one per dictionary entry — keyed by the stable key. Returns
   * `null` when `field` is not a dictKey in `leftCollection`.
   *
   * Body extracted to `via/lookup/registry.ts` (#650 Task 1) —
   * reached via the `port/with/lookup-strategy.ts` seam. See that
   * function's doc comment for the static-vs-dynamic-dict split and the
   * cache-warming caveat.
   */
  resolveDictSource(leftCollection: string, field: string): JoinableSource | null {
    return resolveDictSourceHelper(
      leftCollection,
      field,
      this.staticDescriptorByField,
      this.dictKeyFieldRegistry,
      (name) => this.dictionary(name),
    )
  }

  /**
   * Set or update the vault-default locale at runtime.
   * Useful when the user switches their preferred language after opening
   * the vault.
   */
  setLocale(locale: string | undefined): void {
    this.locale = locale
  }

  /** Return the current vault-default locale. */
  getLocale(): string | undefined {
    return this.locale
  }

  /** Return the vault-level descriptive metadata (set-once at construction). */
  getMeta(): VaultMeta | undefined {
    return this.vaultMeta
  }

  /**
   * The user id of the keyring backing this vault session. Useful for
   * UI affordances ("you are alice"), audit trails, and orchestration
   * composables that need to stamp records with the current actor.
   */
  get userId(): string {
    return this.keyring.userId
  }

  /**
   * The role of the keyring backing this vault session — one of
   * `owner | admin | operator | viewer | client`. Useful for UI
   * affordance gates and approval workflows that need to confirm
   * the caller can perform a given action before attempting it.
   */
  get role(): Role {
    return this.keyring.role
  }

  /**
   * Build keyring files for bundle recipients without persisting them
   * to the source vault. Used by `writePod()` when the bundle
   * is re-keyed for distinct recipients.
   *
   * Each recipient becomes its own `KeyringFile` sealed with that
   * recipient's secret. The DEKs wrapped into each slot are
   * exactly those the recipient's role + permissions justify, and
   * never wider than the source keyring's own DEK set
   * (privilege-escalation check).
   *
   * Returns a `Record<userId, KeyringFile>` ready to substitute for
   * the `keyrings` field of a `vault.dump()` JSON. Adapter is never
   * touched; the produced files exist only in the bundle bytes.
   *
   * @public
   */
  async buildBundleRecipientKeyrings(
    recipients: readonly BundleRecipient[],
  ): Promise<Record<string, KeyringFile>> {
    const result: Record<string, KeyringFile> = {}
    for (const recipient of recipients) {
      if (recipient.id in result) {
        throw new Error(`buildBundleRecipientKeyrings: duplicate recipient id "${recipient.id}"`)
      }
      result[recipient.id] = await buildRecipientKeyringFile(this.keyring, recipient)
    }
    return result
  }

  /**
   * Authorize an `@noy-db/as-*` export against the current keyring's
   * `exportCapability`. Throws `ExportCapabilityError` if
   * the invoking keyring is not authorised.
   *
   * `as-*` packages MUST call this before invoking the underlying
   * export primitive (`exportStream()` / `writePod()` / …).
   *
   * - `assertCanExport('plaintext', 'xlsx')` — check plaintext tier
   *   for a specific format. Defaults to empty for every role; owner
   *   must positively grant.
   * - `assertCanExport('bundle')` — check encrypted-bundle tier.
   *   Defaults to on for owner/admin, off for others.
   *
   * See `docs/patterns/as-exports.md` for the full policy.
   */
  assertCanExport(tier: 'plaintext', format: ExportFormat): void
  assertCanExport(tier: 'bundle'): void
  assertCanExport(tier: 'plaintext' | 'bundle', format?: ExportFormat): void {
    assertCanExportCapability(this.keyring, tier, format)
  }

  /**
   * Authorize an `@noy-db/as-*` import against the current keyring's
   * `importCapability` (issue ). Throws `ImportCapabilityError` if
   * the invoking keyring is not authorised.
   *
   * `as-*` reader entry-points (`fromString` / `fromBytes`) MUST call
   * this before parsing or building an `ImportPlan`.
   *
   * - `assertCanImport('plaintext', 'csv')` — check plaintext-tier
   *   import for a specific format. Default-closed for every role.
   * - `assertCanImport('bundle')` — check `.noydb` bundle-import gate.
   *   Default-closed for every role, including owner — import is more
   *   dangerous than export (corrupts vs leaks).
   *
   * Owner who wants to import re-grants own keyring with
   * `importCapability` set explicitly.
   */
  assertCanImport(tier: 'plaintext', format: ExportFormat): void
  assertCanImport(tier: 'bundle'): void
  assertCanImport(tier: 'plaintext' | 'bundle', format?: ExportFormat): void {
    assertCanImportCapability(this.keyring, tier, format)
  }

  /**
   * Bulk blob extraction primitive.
   *
   * Returns an async-iterable handle over every blob attached to
   * records in the vault. Single capability check (`plaintext/blob`)
   * at handle creation; single audit entry to `_export_audit` before
   * the first yield. Per-blob decryption happens lazily as the
   * consumer pulls tuples.
   *
   * ```ts
   * const handle = vault.exportBlobs({
   *   collections: ['invoiceScans'],
   *   where: (rec) => (rec as { clientId?: string }).clientId === 'c-123',
   * })
   * for await (const { bytes, meta, recordRef } of handle) {
   *   await uploadToColdStorage(bytes, recordRef)
   * }
   * ```
   *
   * @see `@noy-db/hub/store/export-blobs` for the full option surface.
   */
  /**
   * Evict blob slots per the per-collection `blobFields` retention
   * policy.
   *
   * Iterates every collection declared with `{ blobFields: {...} }`.
   * For each record, checks every configured slot against its
   * policy — `retainDays` (age-based TTL) and/or `evictWhen(record)`
   * (predicate) — and evicts matching slots. Every eviction writes
   * one entry to `_blob_eviction_audit` (actor + eTag + reason +
   * timestamp, no plaintext). Consumer-scheduled; noy-db never runs
   * this on its own.
   *
   * ```ts
   * await vault.compact()                                   // run full pass
   * await vault.compact({ dryRun: true })                   // preview counts
   * await vault.compact({ maxEvictions: 1000 })             // cap batch
   * ```
   */
  /**
   * Atomic, gap-free numbering. `vault.sequence('invoice-2026').next()`
   * returns 1, 2, 3, … with no gaps or duplicates under concurrency, via
   * an optimistic-CAS counter at `_sequences/<name>`. Each name is an
   * independent sequence.
   *
   * **Online-only:** `next()` throws `SequenceOfflineError` unless the
   * store advertises `capabilities.casAtomic` — gap-free numbering cannot
   * be serialized by an offline / non-CAS writer.
   *
   * ```ts
   * const n = await vault.sequence('invoice-2026').next()   // 1, then 2, …
   * const cur = await vault.sequence('invoice-2026').peek()  // current value, no allocation
   * ```
   *
   * Pass a `format` to emit a serial string instead of a bare
   * integer — `next()` then returns `{ serial, formatted }`. Per-partition
   * reset is inherent (a new partition tuple starts at 1):
   *
   * ```ts
   * const seq = vault.sequence('fatture', { partition: [2026], format: '{partition.0}/{seq:04}' })
   * await seq.next()   // { serial: 1, formatted: '2026/0001' }
   * ```
   */
  sequence(series: string, opts: SequenceOptions & { format: string }): FormattedSequenceHandle
  sequence(series: string, opts?: SequenceOptions): SequenceHandle
  sequence(series: string, opts?: SequenceOptions): SequenceHandle | FormattedSequenceHandle {
    // A null byte is the structural partition separator in
    // resolveSequenceKey; a series name carrying one could forge a
    // partitioned key, so reject it.
    if (series.includes('\x00')) {
      throw new ValidationError(`sequence("${series}"): series name must not contain a null byte (\\x00).`)
    }
    // Deferred-numbering series route to the pass-based engine; `next({ for })`
    // resolves at `runNumberingPass`. They are keyed by series only and have
    // no CAS counter, so seedTo (CAS-only) is unavailable. All other names
    // use the CAS counter.
    if (this.numberingConfigs.has(series)) {
      if (opts?.format !== undefined) {
        // Deferred numbering stamps an auto-assigned serial onto a record
        // field at seal time; a render template there is a separate change
        // (it would alter the stamped field's type). Not supported here.
        throw new ValidationError(
          `sequence("${series}") is a deferred-numbering series; the format option applies to CAS sequences only.`,
        )
      }
      const eng = this.deferred()
      return {
        next: async (nextOpts) => {
          if (!nextOpts?.for) {
            throw new ValidationError(`sequence("${series}") is a deferred-numbering series; call next({ for: recordId }).`)
          }
          return (await eng.enqueue(series, nextOpts.for)).assigned
        },
        peek: () => eng.peek(series),
        seedTo: () => {
          throw new ValidationError(`sequence("${series}") is a deferred-numbering series; seedTo is CAS-only.`)
        },
      }
    }
    if (!this.sequenceStore) {
      // Opt-in gate (S4): NO_SEQUENCE.createStore throws SequenceNotEnabledError
      // unless `sequenceStrategy: withSequence()` was passed to createNoydb.
      this.sequenceStore = this.strategies.sequence.createStore({
        adapter: this.adapter,
        vault: this.name,
        encrypted: this.encrypted,
        getDEK: this.getDEK,
        actor: this.keyring.userId,
      })
    }
    const handle = this.sequenceStore.handle(resolveSequenceKey(series, opts))
    if (opts?.format === undefined) return handle
    // Formatted variant: validate the template now (throws on a bad
    // token), then wrap next() to also return the rendered serial string.
    // peek/seedTo operate on the underlying integer counter, unchanged.
    const render = compileSequenceFormat(opts.format, series, opts.partition)
    return {
      next: async (nextOpts) => {
        const serial = await handle.next(nextOpts)
        return { serial, formatted: render(serial) }
      },
      peek: () => handle.peek(),
      seedTo: (n) => handle.seedTo(n),
    }
  }

  /** @internal — lazily build the deferred-numbering engine with a cache-coherent stamp. */
  private deferred(): DeferredNumberingStore {
    if (!this.deferredNumbering) {
      this.deferredNumbering = new DeferredNumberingStore({
        adapter: this.adapter,
        vault: this.name,
        encrypted: this.encrypted,
        getDEK: this.getDEK,
        actor: this.keyring.userId,
        configs: this.numberingConfigs,
        // Stamp THROUGH the Collection layer so cache/indexes/MVs stay coherent —
        // `this.collection(name)` returns the shared cached instance, so a
        // subsequent user `collection.get(id)` sees the assigned serial.
        stamp: async (collection, recordId, field, serial) => {
          const coll = this.collection<Record<string, unknown>>(collection)
          const rec = await coll.get(recordId)
          if (!rec) return false
          await coll.put(recordId, { ...rec, [field]: serial })
          return true
        },
      })
    }
    return this.deferredNumbering
  }

  /**
   * Run a deferred-numbering pass for `series`: assign gap-free serials to all
   * records whose store-commit-time interval has settled, in store-time order.
   * Returns the assignments made. See {@link sequence} / `withDeferredNumbering`.
   */
  async runNumberingPass(series: string): Promise<Assignment[]> {
    return this.deferred().runPass(series)
  }

  async compact(options: CompactRunOptions = {}): Promise<CompactionResult> {
    return runCompaction({
      adapter: this.adapter,
      vault: this.name,
      actor: this.keyring.userId,
      encrypted: this.encrypted,
      getDEK: this.getDEK,
      getBlobFields: <T>(name: string): BlobFieldsConfig<T> | null =>
        (this.blobFieldsRegistry.get(name) as BlobFieldsConfig<T> | undefined) ?? null,
      listCollections: () => this.collections(),
      listRecords: (name: string) => this.adapter.list(this.name, name),
      getRecord: async <T>(name: string, id: string) => {
        const coll = this.collection<T>(name)
        return coll.get(id) as unknown as T | null
      },
      listSlots: async (name: string, id: string) => {
        const coll = this.collection(name)
        return coll.blob(id).list()
      },
      deleteSlot: async (name: string, id: string, slotName: string) => {
        const coll = this.collection(name)
        await coll.blob(id).delete(slotName)
      },
      dropLocalCache: async (name: string, id: string, slotName: string) => this.collection(name).blob(id).dropLocalCache(slotName), // #808: budget pass drops device-local external cache copies
    }, options)
  }

  /**
   * Sweep records eligible by their collection's `archive` policy into the
   * cold archive store. Relocation is envelope-level (no re-encryption) and
   * bypasses guards + materialized-view dispatch, so issued/immutable
   * records over a sealed period can be archived without recomputing
   * finalized aggregates. A `legalHold` predicate blocks archival.
   * Requires `archiveStrategy: withArchive({ store })` in `createNoydb`.
   */
  async archive(options: ArchiveRunOptions = {}): Promise<ArchiveResult> {
    return runArchive(this._archiveContext(), options)
  }

  /** Relocate one archived record back to the primary store. Returns false if it was not archived. */
  async restore(collection: string, id: string): Promise<boolean> {
    return runRestore(this._archiveContext(), collection, id)
  }

  /** List archived record ids for a collection (or all collections with an archive policy). */
  async listArchived(collection?: string): Promise<Array<{ collection: string; id: string }>> {
    return runListArchived(this._archiveContext(), collection)
  }

  private _archiveContext(): ArchiveContext {
    const strategy = this.strategies.archive
    if (!strategy) {
      throw new Error(
        'vault.archive/restore/listArchived require `archiveStrategy: withArchive({ store })` in createNoydb',
      )
    }
    const archiveStore = strategy.store
    return {
      vaultId: this.name,
      archiveStore,
      collectionsWithPolicy: () => [...this.archiveRegistry.keys()],
      getPolicy: (c) => this.archiveRegistry.get(c) ?? null,
      listRecordIds: (c) => this.adapter.list(this.name, c),
      getRecord: async (c, id) =>
        (await this.collection(c).get(id, { locale: 'raw' })) as Record<string, unknown> | null,
      getEnvelope: (c, id) => this.adapter.get(this.name, c, id),
      removeFromPrimary: async (c, id) => { await this.collection(c)._internalDelete(id) },
      restoreToPrimary: async (c, id, env) => {
        await this.adapter.put(this.name, c, id, env)
        await this.collection(c)._invalidateCacheEntry(id)
      },
    }
  }

  exportBlobs(options: ExportBlobsOptions = {}): ExportBlobsHandle {
    this.assertCanExport('plaintext', 'blob')
    return createExportBlobsHandle(
      this.keyring.userId,
      () => this.collections(),
      (name) => this.collection(name),
      (entry) => this.writeExportAudit(entry),
      options,
    )
  }

  issueAttestation(collectionName: string, id: string): Promise<{ docId: string; qr: string; keyId: string; publicKeyB64: string }> {
    return this.attestation.issue(collectionName, id)
  }

  getDocumentSigningPublicKey(): Promise<{ keyId: string; publicKeyB64: string }> {
    return this.attestation.getDocumentSigningPublicKey()
  }

  revokeAttestation(docId: string): Promise<void> {
    return this.attestation.revoke(docId)
  }

  unrevokeAttestation(docId: string): Promise<void> {
    return this.attestation.unrevoke(docId)
  }

  getRevokedDocIds(): Promise<string[]> {
    return this.attestation.getRevokedDocIds()
  }

  publishRevocationList(): Promise<RevocationList> {
    return this.attestation.publishRevocationList()
  }

  /**
   * @internal #943 — read-only access to this vault's persisted document
   * signer, for pod export signing. Never mints and does NOT require the
   * `withAttestation()` opt-in (role-agnostic, pure read): if no signer has
   * ever been minted, resolves to `null` (unsigned pod) rather than throwing
   * or minting one. Dynamic-imports `signer.js` (the S4 gate escape hatch —
   * see `_ensureFenceCoordination` above) since it is a with-* service path.
   */
  async _loadPodSigner(): Promise<import('../with-audit/attestation/signer.js').DocSigner | null> {
    const { loadSigner } = await import('../with-audit/attestation/signer.js')
    return loadSigner(this.adapter, this.name, this.getDEK)
  }

  private async writeExportAudit(entry: ExportBlobsAuditEntry): Promise<void> {
    const json = JSON.stringify(entry)
    const envelope: EncryptedEnvelope = this.encrypted
      ? await (async () => {
          const dek = await this.getDEK(EXPORT_AUDIT_COLLECTION)
          const { iv, data } = await encrypt(json, dek)
          return { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: entry.startedAt, _iv: iv, _data: data, _by: entry.actor }
        })()
      : { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: entry.startedAt, _iv: '', _data: json, _by: entry.actor }
    await this.adapter.put(this.name, EXPORT_AUDIT_COLLECTION, entry.id, envelope)
  }

  /**
   * Read-only accessor for the invoking keyring's export capability,
   * with role-based defaults resolved. Useful for UI affordances
   * (grey out the export button if no capability) without throwing.
   */
  canExport(tier: 'plaintext', format: ExportFormat): boolean
  canExport(tier: 'bundle'): boolean
  canExport(tier: 'plaintext' | 'bundle', format?: ExportFormat): boolean {
    return canExportCapability(this.keyring, tier, format)
  }

  /**
   * Decrypt a single envelope using the per-collection DEK, returning
   * the parsed plaintext record. Internal helper for bundle-pipeline
   * plaintext filters — keeps DEK access encapsulated
   * inside Vault so callers don't reach into private state.
   *
   * @internal
   */
  async _decryptEnvelopeForBundleFilter(
    env: EncryptedEnvelope,
    collectionName: string,
  ): Promise<unknown> {
    if (!this.encrypted) {
      return JSON.parse(env._data)
    }
    const dek = await this.getDEK(collectionName)
    const json = await openEnvelopeJson(env, dek)
    return JSON.parse(json)
  }

  /**
   * Read-only accessor for the invoking keyring's import capability
   * (issue ). UI affordance — returns false in every default-closed
   * case (every role with no explicit `importCapability` grant).
   */
  canImport(tier: 'plaintext', format: ExportFormat): boolean
  canImport(tier: 'bundle'): boolean
  canImport(tier: 'plaintext' | 'bundle', format?: ExportFormat): boolean {
    return canImportCapability(this.keyring, tier, format)
  }

  /**
   * Enforce strict outbound refs on a `put()`. Called by Collection
   * just before it writes to the adapter. For every strict ref
   * declared on the collection, check that the target id exists in
   * the target collection; throw `RefIntegrityError` if not.
   *
   * `warn` and `cascade` modes don't affect put semantics — they're
   * enforced at delete time or via `checkIntegrity()`.
   */
  async enforceRefsOnPut(collectionName: string, record: unknown): Promise<void> {
    return this.linksEnforcer.enforceRefsOnPut(collectionName, record)
  }

  /**
   * Enforce inbound ref modes on a `delete()`. Called by Collection
   * just before it deletes from the adapter. Walks every inbound
   * ref that targets this (collection, id) and applies its mode
   * (`strict` throws, `cascade` deletes referencing records, `warn`
   * no-ops). Managed-link `onDelete` policy is applied in the same
   * cascade guard. See `with-shape/links/vault-facade.ts`.
   */
  async enforceRefsOnDelete(collectionName: string, id: string): Promise<void> {
    return this.linksEnforcer.enforceRefsOnDelete(this.graph, collectionName, id)
  }

  /**
   * #922 — can a delete on `collectionName` trigger ANY cross-record work in
   * `enforceRefsOnDelete` above? Unions ALL THREE of its cascade sources —
   * lookup-ref edges (`graph.referencingEdgesOf`), classic inbound refs
   * (`refRegistry.getInbound`), and managed link sets whose either endpoint
   * is this collection. `Collection._txAtomicSafe('delete')` consults this
   * instead of the pre-#922 blanket enforcer-presence check: `_prepareDelete`
   * runs those cascades DURING prepare (not abortable), so a delete may take
   * the atomic tx path only when all three sources are provably absent.
   * Registry state only — no store reads, safe to call at commit time.
   *
   * @internal
   */
  _deleteCascadesPossible(collectionName: string): boolean {
    if (this.graph.referencingEdgesOf(collectionName).length > 0) return true
    if (this.refRegistry.getInbound(collectionName).length > 0) return true
    for (const spec of this.linkRegistry.values()) {
      if (spec.a === collectionName || spec.b === collectionName) return true
    }
    return false
  }

  // ─── Join resolver) ────────────────────

  /**
   * Look up the `RefDescriptor` the left collection declared for a
   * given field name. Returns `null` when the field has no ref
   * declaration. Implements the `joinResolver.resolveRef` half of the
   * structural interface that `Collection.query()` consumes.
   */
  resolveRef(leftCollection: string, field: string): RefDescriptor | null {
    return this.linksEnforcer.resolveRef(leftCollection, field)
  }

  /**
   * Resolve a right-side join source by target collection name.
   * Returns `null` for unknown collections. Implements the
   * `joinResolver.resolveSource` half of the structural interface.
   * Only same-vault targets are resolvable — cross-vault joins are
   * explicitly forbidden by the architecture.
   */
  resolveSource(collectionName: string): JoinableSource | null {
    return this.linksEnforcer.resolveSource(collectionName)
  }

  /**
   * Walk every collection that has declared refs, load its records,
   * and report any reference whose target id is missing (modes
   * reported alongside each violation). Returns `{ violations: [...] }`
   * instead of throwing — the point is to surface a list for display
   * or repair, not to fail noisily.
   */
  async checkIntegrity(): Promise<{ violations: RefViolation[] }> {
    return this.linksEnforcer.checkIntegrity()
  }

  /**
   * Return this compartment's hash-chained audit log.
   *
   * The ledger is lazy-initialized on first access and cached for the
   * lifetime of the Vault instance. Every LedgerStore instance
   * shares the same adapter and DEK resolver, so `vault.ledger()`
   * can be called repeatedly without performance cost.
   *
   * The LedgerStore itself is the public API: consumers call
   * `.append()` (via Collection internals), `.head()`, `.verify()`,
   * and `.entries({ from, to })`. See the LedgerStore docstring for
   * the full surface and the concurrency caveats.
   */
  ledger(): LedgerStore {
    const store = this.getLedgerOrNull()
    if (!store) {
      throw new Error(
        'vault.ledger() requires the history strategy. Import ' +
        '`{ withHistory }` from "@noy-db/hub/history" and pass it to ' +
        '`createNoydb({ historyStrategy: withHistory() })`.',
      )
    }
    return store
  }

  /**
   * Internal accessor — returns the LedgerStore if the history
   * strategy is opted in, or `null` otherwise. Used by dump/restore/
   * verifyBackupIntegrity and by Collection write paths that already
   * gate on `if (this.ledger)`. The public `ledger()` accessor above
   * throws on null; this one stays silent so the off-path no-ops.
   */
  private getLedgerOrNull(): LedgerStore | null {
    if (!this.ledgerStore) {
      this.ledgerStore = this.strategies.history.buildLedger({
        adapter: this.adapter,
        vault: this.name,
        encrypted: this.encrypted,
        getDEK: this.getDEK,
        actor: this.keyring.userId,
      })
    }
    return this.ledgerStore
  }

  // ─── GDPR right-to-erasure ────────────────────────────────────────

  /** @internal — add a subject→record ref to the encrypted subject index. */
  async _addSubjectRef(subjectId: string, ref: SubjectRef): Promise<void> {
    await addSubjectRef(this.adapter, this.name, this.getDEK, this.encrypted, subjectId, ref)
  }

  /** @internal — drop a subject→record ref from the encrypted subject index. */
  async _removeSubjectRef(subjectId: string, ref: SubjectRef): Promise<void> {
    await removeSubjectRef(this.adapter, this.name, this.getDEK, this.encrypted, subjectId, ref)
  }

  /**
   * Rebuild the encrypted subject index from canonical records. The recovery
   * path for the documented read-modify-write race (RISK #3). Returns the
   * number of distinct subjects re-indexed.
   */
  async rebuildSubjectIndex(): Promise<number> {
    if (Object.keys(this.strategies.forget.subjects).length === 0) {
      throw new ForgetStrategyNotConfiguredError()
    }
    return rebuildSubjectIndexImpl(
      this.adapter,
      this.name,
      this.getDEK,
      this.encrypted,
      this.strategies.forget.subjects,
      async (collectionName, id, env) => {
        const coll = this.collection<Record<string, unknown>>(collectionName)
        return coll._decodeEnvelope(env, id)
      },
    )
  }

  /**
   * GDPR crypto-shred of a data subject. Consults the encrypted subject index and, per matching
   * record: rewrites the LIVE envelope to a tombstone (drops `_iv`/`_data`/`_cek`/`_det`), tombstones
   * every `_history` version, and fans out to derived residue via the graph (#622) — record-grain
   * artifacts (MV rows, derivation copies) ERASED, aggregate-grain rollups RECOMPUTED without the
   * forgotten contribution (skip+audit in a frozen period). The body/history become permanently
   * undecryptable while the collection DEK and every OTHER record stay intact. Then appends ONE
   * `op:'forget'` ledger entry whose `payloadHash` is `sha256Hex(subjectId)` — the chain still
   * `verify()`s, PROVING the subject existed and was erased without retaining any plaintext.
   *
   * Reports — but does not silently swallow — two completeness gaps: `unmigratedRecords` (a record
   * whose body was NOT yet migrated to a per-record CEK — still tombstoned, but pre-shred backups
   * stay decryptable; migrate, then re-forget) and `blobResidueCollections` (blob attachments, keyed
   * off a separate `_blob` DEK, out of scope here).
   *
   * @throws ForgetStrategyNotConfiguredError when no `withForget` was set.
   */
  async forget(subjectId: string): Promise<ForgetResult> {
    if (Object.keys(this.strategies.forget.subjects).length === 0) {
      throw new ForgetStrategyNotConfiguredError()
    }

    // #734: resolve the ledger BEFORE any shred — the loop purges each record's
    // plaintext deltas and the summary entry appends after, so a missing history
    // strategy must abort with NOTHING erased (was: shred-then-throw).
    const ledger = this.getLedgerOrNull(); if (!ledger) throw new Error('vault.forget() requires the history strategy for the erasure-proof ledger entry. Pass `historyStrategy: withHistory()` from "@noy-db/hub/history" to createNoydb().')
    const refs = await lookupSubject(this.adapter, this.name, this.getDEK, this.encrypted, subjectId)
    // Satellite fan-out (#591, with-shape/satellites/forget.ts) — a satellite
    // is never itself in the subject index, so synthesize its ref or it survives.
    const allRefs = expandRefsWithSatellites(refs, this.satelliteRegistry)

    let recordsShredded = 0; let historyVersionsShredded = 0
    const collections = new Set<string>(); const unmigratedRecords: string[] = []
    const blobResidueCollections = new Set<string>()
    let blobsShredded = 0; let blobsRetainedShared = 0; let indexPostingsPurged = 0
    let sealedFieldsShredded = 0; let sealedCekEnvelopesPurged = 0; let ledgerDeltasPurged = 0
    const sealedCekResidue: string[] = []; const sealedResidue: string[] = []; const indexResidue: string[] = []; const ledgerDeltaResidue: string[] = []
    // #838 — "is the blob service opted in?" is now a stub-identity check.
    // It used to be `blobsStrategy !== undefined`; with every key resolved,
    // absence is NO_BLOBS rather than `undefined`, and reading it as
    // always-enabled would drive forget() into NO_BLOBS.openSlot()'s throw.
    const blobsEnabled = this.strategies.blobs !== NO_BLOBS
    const actor = this.keyring.userId
    const fanoutStats: ForgetFanoutStats = { recordsErased: 0, aggregatesRecomputed: 0, residueFrozen: [], lookupReferencesCascaded: 0, lookupReferencesNullified: 0, lookupReferencesResidue: [], derivedResidueUndecodable: [], derivedResidueDeclined: [] }
    // #633 — scoped-purge per-collection skip accumulators (empty under the unconditional default); lazy (S4 gate: kernel spine → with-* service via dynamic import()).
    const { partitionSealedCekKeys, shouldSkipBlobScan, bumpResidueCount, residueNoticesFromMap } = await import('../with-audit/forget/purge-scope.js')
    const scopedPurge = this.strategies.forget.scopedPurge === true
    const sealedCekScopedSkipped = new Map<string, number>(); const blobScopedSkipped = new Map<string, number>()

    for (const ref of allRefs) {
      const coll = this.collection<Record<string, unknown>>(ref.collection)
      const satelliteOf = (ref as { satelliteOf?: string }).satelliteOf
      const perRecordKeys = this.strategies.forget.subjects[satelliteOf ?? ref.collection] !== undefined // #591 classification inheritance
      const lookupCompareKeys = await this.linksEnforcer.checkLookupRefsRestrict(this.graph, ref.collection, ref.collection, ref.id) // #650 (#648) — restrict BEFORE any shred; ALSO live-resolves every ref edge's compare-key (#650 review, Important fix — no post-shred decode needed by forgetDerivedFanout)

      // Detect an un-migrated record BEFORE shredding: a perRecordKeys
      // collection whose live envelope still carries a body but no `_cek`
      // means the body is keyed off the shared collection DEK (legacy /
      // not-yet-migrated), so a shred cannot guarantee erasure of pre-shred
      // ciphertext. We still tombstone it, but report the gap.
      const live = await this.adapter.get(this.name, ref.collection, ref.id)
      if (perRecordKeys && live && live._data && !hasPerRecordKey(live)) {
        unmigratedRecords.push(`${ref.collection}:${ref.id}`)
      }
      // Classify each `_sealed`/`_vdig` slot BEFORE tombstoning (#M-1, security
      // review): CEK-keyed → shreddable (tombstone erases it); collection-DEK-
      // keyed → NOT (retained → synced/backup copies stay decryptable); the
      // `_bidx` case is both (dual accounting). #629 Task 10: a compiled-in
      // classified via binding owns this via `_onViaErase`'s sealed-posture
      // fold (metadata-driven); bare-`sensitive` collections fall back below.
      if (live?._sealed !== undefined) {
        try {
          const viaReport = await coll._onViaErase(ref.id, live)
          if (viaReport) {
            sealedFieldsShredded += viaReport.shredded
            for (const entry of viaReport.residue as readonly { readonly kind?: string; readonly field?: string }[]) {
              if (entry.kind === 'classified-sealed-dek-residue' && entry.field !== undefined) sealedResidue.push(`${ref.collection}:${ref.id}:${entry.field}`)
            }
          } else {
            const cls = await coll._classifySealedShred(live)
            for (const slot of cls.slots) {
              if (slot.class === 'shreddable' || slot.class === 'live-shreddable+dekResidue-in-backups') sealedFieldsShredded += 1
              if (slot.class === 'dekResidue' || slot.class === 'live-shreddable+dekResidue-in-backups') sealedResidue.push(`${ref.collection}:${ref.id}:${slot.field}`)
            }
          }
        } catch {
          // Classification unwraps `_cek`; if that fails (corrupt/unreadable
          // envelope) do NOT abort the whole erasure mid-loop. Report every
          // sealed field as residue (conservatively un-shredded) and continue
          // tombstoning — mirrors the H-1 block's defensive posture below.
          for (const field of Object.keys(live._sealed)) sealedResidue.push(`${ref.collection}:${ref.id}:${field}`)
        }
      }

      // Purge the record's sealed-CEK delivery envelopes (#H-1, security
      // review). sealRecordToHost persisted the raw CEK sealed to at-* hosts at
      // `_sealed_cek/<collection>/<id>/<pid>`; crypto-shred must destroy them
      // too, or a granted host + a synced pre-forget body recovers an "erased"
      // record. Mirrors rotateRecordCek's prefix-delete.
      const cekPrefix = `${ref.collection}/${ref.id}/`
      try {
        const cekKeys = await this.adapter.list(this.name, SEALED_CEK_NS)
        const { toPurge, skippedCount } = partitionSealedCekKeys(cekKeys, cekPrefix, scopedPurge, coll._via?.hasAtRestHooks === true) // #633
        for (const key of toPurge) {
          await this.adapter.delete(this.name, SEALED_CEK_NS, key)
          sealedCekEnvelopesPurged++
        }
        bumpResidueCount(sealedCekScopedSkipped, ref.collection, skippedCount)
      } catch {
        sealedCekResidue.push(`${ref.collection}:${ref.id}`)
      }
      if (blobsEnabled && !shouldSkipBlobScan(scopedPurge, this.blobFieldsRegistry.has(ref.collection))) { try { await coll.blob(ref.id).mintShredIntent(live?._tier ?? 0) } catch { blobResidueCollections.add(ref.collection) } } // #753 C5 marker PRE-tombstone: crash-safety ENHANCEMENT, not an erasure precondition — mint failure degrades to residue, never blocks the shred below (whole-branch review)
      let shred: { previousVersion: number } | null
      try {
        shred = await coll._writeTombstone(ref.id, actor)
      } catch (cause) {
        if (satelliteOf === undefined) throw cause // base ref: pre-existing (unwrapped) fail-loud behavior
        throw new SatelliteConfigError( // R-S4: abort the whole forget rather than leave the heavy side un-erased
          `R-S4: forget could not fan out to satellite "${ref.collection}" — aborting rather than leaving the heavy side`,
          { cause },
        )
      }
      if (shred !== null) {
        recordsShredded++
        collections.add(ref.collection)
        await forgetDerivedFanout(this, { collection: ref.collection, id: ref.id }, live, fanoutStats, lookupCompareKeys)
      }

      // Tombstone every history version (idempotent — already-shredded skip).
      historyVersionsShredded += await this.strategies.history.tombstoneHistory(
        this.adapter, this.name, ref.collection, ref.id, actor, this.encrypted,
      )

      // #734: purge the record's plaintext `_ledger_deltas` rows — the erasure twin
      // of #729's elevate purge. Chain-safe: verify() never re-reads delta rows; the
      // summary `forget` entry appended below is the retained proof of erasure.
      try { ledgerDeltasPurged += await ledger.purgeRecordDeltas(ref.collection, ref.id) } catch { ledgerDeltaResidue.push(`${ref.collection}:${ref.id}`) }
      // Purge the record's persisted `_idx` side-cars: they live under
      // the retained collection DEK, so crypto-shred alone leaves the indexed
      // field VALUES readable. Content-free delete; failures → indexResidue.
      const idxPurge = await coll._purgePersistedIndexes(ref.id)
      indexPostingsPurged += idxPurge.purged
      for (const field of idxPurge.residue) indexResidue.push(`${ref.collection}:${ref.id}:${field}`)

      // Purge the record's encrypted _vec sidecar: a vector embedding
      // is text-invertible, so it must not survive crypto-shred of the source record.
      try {
        await coll._purgeVector(ref.id)
      } catch {
        indexResidue.push(`${ref.collection}:${ref.id}:_vec`)
      }

      // Blob attachments: crypto-shred the record's erasable blobs.
      // An erasable blob's chunks are under a per-blob content CEK whose only
      // copy is the BlobObject's wrapped `_cek`; deleting it at refCount 0
      // shreds the content. Legacy blobs (no `_cek`) or a session without the
      // blob service cannot be shredded → reported as residue.
      if (blobsEnabled && shouldSkipBlobScan(scopedPurge, this.blobFieldsRegistry.has(ref.collection))) {
        bumpResidueCount(blobScopedSkipped, ref.collection, 1) // #633 — perf win: no per-collection list() scan
      } else if (blobsEnabled) {
        const r = await this.collection<Record<string, unknown>>(ref.collection)
          .blob(ref.id)
          .shredAllForRecord(live?._tier ?? 0) // #724 C3: pre-tombstone tier — the tombstone this loop already wrote drops `_tier`
        blobsShredded += r.shredded.length
        blobsRetainedShared += r.retainedShared.length
        if (r.residue.length > 0) blobResidueCollections.add(ref.collection)
      } else {
        try {
          const [slotIds, verKeys] = await Promise.all([this.adapter.list(this.name, `_blob_slots_${ref.collection}`), this.adapter.list(this.name, `_blob_versions_${ref.collection}`)]) // #750: version rows are residue too when the blob service is off
          if (slotIds.includes(ref.id) || verKeys.some((k) => k.startsWith(`${ref.id}::`))) blobResidueCollections.add(ref.collection)
        } catch {
          // No blob-slots collection for this collection — nothing to report.
        }
      }

      // Drop the (now-shredded) ref from the subject index.
      await this._removeSubjectRef(subjectId, ref)
    }

    // Purge the persisted lexical-index blob for each affected collection:
    // an opaque all-records index must not survive crypto-shred.
    // Failures (transient/permission) must NOT abort forget — an unpurgeable
    // blob is erasure residue surfaced in the returned ForgetResult.
    for (const collName of collections) {
      try {
        await this.collection(collName)._purgeSearchIndex()
      } catch {
        indexResidue.push(`${collName}:_ftindex`)
      }
    }

    // ONE summary ledger entry for the whole subject. payloadHash =
    // sha256Hex(subjectId) so the ledger proves erasure without the subject.
    const subjectHash = await sha256Hex(subjectId)
    const ledgerEntry = await ledger.append({
      op: 'forget',
      collection: '',
      id: '',
      version: 0,
      actor,
      payloadHash: subjectHash,
      reason: JSON.stringify({
        recordsShredded,
        historyVersionsShredded,
        collections: [...collections],
        unmigratedCount: unmigratedRecords.length,
        blobsShredded,
        blobsRetainedShared,
        blobResidueCollections: [...blobResidueCollections],
        indexPostingsPurged,
        indexResidueCount: indexResidue.length,
        sealedFieldsShredded,
        sealedCekEnvelopesPurged,
        sealedCekResidueCount: sealedCekResidue.length,
        sealedResidueCount: sealedResidue.length, ledgerDeltasPurged, ledgerDeltaResidueCount: ledgerDeltaResidue.length,
      }),
    })

    const scopedPurgeResidue = [...residueNoticesFromMap(sealedCekScopedSkipped, 'skipped-undeclared-sealed-cek'), ...residueNoticesFromMap(blobScopedSkipped, 'skipped-undeclared-blob-scan')] // #633
    return {
      subject: subjectId,
      recordsShredded,
      historyVersionsShredded,
      collections: [...collections],
      unmigratedRecords,
      blobsShredded,
      blobsRetainedShared,
      blobResidueCollections: [...blobResidueCollections],
      indexPostingsPurged,
      indexResidue,
      sealedFieldsShredded,
      sealedCekEnvelopesPurged,
      sealedCekResidue,
      sealedResidue,
      ledgerEntry,
      derivedRecordsErased: fanoutStats.recordsErased,
      derivedAggregatesRecomputed: fanoutStats.aggregatesRecomputed,
      derivedResidueFrozen: fanoutStats.residueFrozen,
      lookupReferencesCascaded: fanoutStats.lookupReferencesCascaded, lookupReferencesNullified: fanoutStats.lookupReferencesNullified, lookupReferencesResidue: fanoutStats.lookupReferencesResidue, scopedPurgeResidue, ledgerDeltasPurged, ledgerDeltaResidue, // #650 Task 5 (+ review Important fix: residue) + #633 + #734
      derivedResidueUndecodable: fanoutStats.derivedResidueUndecodable, derivedResidueDeclined: fanoutStats.derivedResidueDeclined, // #776/#785
    }
  }

  // ─── Record-scoped CEK sealing ─────────────────────────────────────

  /**
   * Seal ONE record's content-encryption key (CEK) to an `at-*` host so that
   * host — and only that host — can decrypt exactly that record, with no
   * access to the vault DEK and no ability to read any other record.
   *
   * The grantor (this caller, who holds the collection DEK) reads the record's
   * live `_cek`, unwraps it under the collection DEK, exports the raw CEK
   * bytes, builds a {@link SealedCekBinding} `{collection, id, cek, expiresAt}`,
   * seals that binding for the recipient host via the host's published hint,
   * and persists a thin {@link SealedCekDeliveryEnvelope} at
   * `_sealed_cek/<collection>/<id>/<pid>`. The binding (not the delivery
   * envelope) is the security boundary: the host re-verifies `{collection, id}`
   * and `expiresAt` from inside the sealed payload.
   *
   * Only works on a `perRecordKeys` record — a legacy record has no `_cek` to
   * seal (its body is under the shared collection DEK, which is never exposed
   * by sealing) → {@link RecordCekNotFoundError}.
   *
   * @param collection Collection holding the record.
   * @param id         Record id.
   * @param hostSealer The recipient host's {@link RecipientSealer}.
   * @param opts.expiresAt REQUIRED authoritative expiry (ISO 8601), sealed into
   *   the binding the host verifies.
   * @returns `{ pid, envelopeKey }` — the host provider id and the
   *   `<collection>/<id>/<pid>` key the delivery envelope was written under.
   */
  async sealRecordToHost(
    collection: string,
    id: string,
    hostSealer: RecipientSealer,
    opts: { expiresAt: string },
  ): Promise<{ pid: string; envelopeKey: string }> {
    return this.strategies.sealedRecord.sealRecordToHost(this._sealingContext(), collection, id, hostSealer, opts)
  }

  /**
   * Revoke a sealed-CEK grant. **Default is SOFT**: deletes the `pid` delivery
   * envelope, but a host that already fetched it KEEPS decrypt capability (stops
   * new fetches, not a cryptographic cutoff). Pass **`{ hard: true }`** to rotate
   * the record CEK ({@link rotateRecordCek}) so any prior sealed CEK can no
   * longer open the record. See `revokeSealedRecord` in `record-keys/sealing.ts`.
   */
  async revokeSealedRecord(collection: string, id: string, pid: string, opts?: { hard?: boolean }): Promise<void> {
    return this.strategies.sealedRecord.revokeSealedRecord(this._sealingContext(), collection, id, pid, opts)
  }

  /**
   * HARD-rotate a record's CEK: decrypt the live body under the old CEK,
   * re-encrypt it under a freshly-minted CEK, write the new live envelope, evict
   * the in-memory caches, and delete EVERY sealed-CEK delivery envelope for the
   * record. After this, any host holding a previously-sealed CEK can still
   * decrypt PRE-rotation history versions (they keep their old `_cek`) but NOT
   * the rotated live record (its body is under the new CEK → the old CEK fails
   * the AES-GCM auth tag → `TamperedError`). That asymmetry IS the revocation:
   * old grants lose the live record.
   *
   * Administrative path — bypasses `Collection.put` deliberately (no guards, no
   * history snapshot, no materialized-view refresh): rotation is a key-rotation
   * operation, not a business write, and must not version-bump history (which
   * would re-encrypt the prior version under the NEW CEK and defeat the point).
   *
   * @throws {@link RecordCekNotFoundError} if the record is missing or has no `_cek`.
   */
  async rotateRecordCek(collection: string, id: string): Promise<void> {
    return this.strategies.sealedRecord.rotateRecordCek(this._sealingContext(), collection, id)
  }

  /**
   * Build the {@link SealingContext} the record-keys grantor functions need:
   * the vault-bound adapter, DEK resolver, actor, and the dual-cache eviction
   * `rotateRecordCek` performs (per-record CEK cache + decrypted-record cache).
   */
  private _sealingContext(): SealingContext {
    return {
      adapter: this.adapter,
      vault: this.name,
      getDEK: (collection) => this.getDEK(collection),
      actor: this.keyring.userId,
      invalidateRecordCaches: async (collection, id) => {
        const coll = this.collection<Record<string, unknown>>(collection)
        coll._invalidateCekCacheEntry(id)
        await coll._invalidateCacheEntry(id)
      },
    }
  }

  /**
   * @internal — called by `Noydb.openVault` after construction.
   * Dynamic-imports `GuardRegistry` + `ReadOnlyVaultFacade` and seeds
   * the registry with the supplied strategy handles. No-op when the
   * handles array is empty — keeps the guard service out of the
   * floor bundle for consumers that don't use guards.
   *
   * The read-only facade is eagerly instantiated here so the sync
   * accessor `_getReadOnlyFacade()` (called from the tx amendment
   * runner) stays synchronous.
   */
  async _initGuards(handles: ReadonlyArray<GuardStrategyAny>): Promise<void> {
    if (handles.length === 0) return
    const [{ GuardRegistry }, { ReadOnlyVaultFacade }] = await Promise.all([
      import('../with-audit/guards/registry.js'),
      import('../with-audit/guards/read-only-facade.js'),
    ])
    const registry = new GuardRegistry()
    for (const h of handles) registry.register(h.spec)
    this.guardRegistry = registry
    this.guardFacade = new ReadOnlyVaultFacade(this, 'guard')
  }

  /**
   * @internal — The gate handler in Noydb.#registerGuardGate calls into
   * this. Returns `null` for vaults that never registered any guard
   * strategy. Callers MUST gate on null.
   */
  _getGuardRegistry(): GuardRegistry | null {
    return this.guardRegistry
  }

  /**
   * @internal — called by `Noydb.openVault` after construction.
   * Dynamic-imports `DerivationRegistry` and registers the supplied
   * derivation strategies (async because `strategyHash` computation
   * goes through `crypto.subtle.digest`). No-op when the handles
   * array is empty — keeps the derivation service out of the floor
   * bundle for consumers that don't use derivations. Throws
   * `DerivationCycleError` if a cycle is detected after registration.
   */
  async _initDerivations(handles: ReadonlyArray<DerivationStrategy>): Promise<void> {
    if (handles.length === 0) return
    const [{ DerivationRegistry }, { ReadOnlyVaultFacade }] = await Promise.all([
      import('../with-formula/derivations/registry.js'),
      import('../with-audit/guards/read-only-facade.js'),
    ])
    const registry = new DerivationRegistry()
    for (const h of handles) {
      await registry.register(h.spec)
    }
    for (const edge of registry.edges()) this.graph.registerDerived(edge.target, edge.sources, edge.kind, edge.grain)
    registry.validate(this.graph)
    this.derivationRegistry = registry
    // Derivation reads resolve at `layer:'derivation'` — a distinct
    // facade from the guard one, so `derive(source, ctx)` gets the
    // derivation `onMissing` policy (e.g. `'null'` → branch explicitly)
    // rather than the lenient guard default.
    if (this.derivationFacade === null) {
      this.derivationFacade = new ReadOnlyVaultFacade(this, 'derivation')
    }
  }

  /**
   * @internal — consumed by `Collection.put` at write-time. Returns
   * `null` for vaults that never registered any derivation strategy.
   */
  _getDerivationRegistry(): DerivationRegistry | null {
    return this.derivationRegistry
  }

  /**
   * @internal — called by `Noydb.openVault` after collections are
   * wired. Dynamic-imports `MaterializedViewRegistry`, registers each
   * MV spec (which invokes its `query()` once for dependency
   * analysis), then runs the unified cycle detection across the MV +
   * derivation graphs. No-op when the handles array is empty — keeps
   * the MV service out of the floor bundle (mirrors the derivation lazy-import pattern).
   * Throws `MaterializedViewCycleError` if a cycle is detected.
   */
  async _initMaterializedViews(
     
    handles: ReadonlyArray<MaterializedViewStrategy>,
  ): Promise<void> {
    if (handles.length === 0) return
    const { MaterializedViewRegistry } = await import('../with-formula/materialized-views/registry.js')
    const registry = new MaterializedViewRegistry()
    // Phase 1: publish the (empty) registry on `this` BEFORE
    // registering any spec. The user's `query(db)` callback runs at
    // registration time and may construct source Collections via
    // `db.collection(name)` — those Collections are cached in the
    // vault and their `materializedViewSource` is populated from
    // `this.materializedViewRegistry` AT CONSTRUCTION TIME. If we
    // assigned `this.materializedViewRegistry` only after the
    // register() loop, the source Collections would cache with an
    // unset source and never dispatch MV refreshes on later writes.
    this.materializedViewRegistry = registry
    // Pass `this` Vault as the MVQueryContext — its `collection<T>()`
    // method is what the user's `query(db)` callback consumes.
     
    const db = this as unknown as MVQueryContext
    for (const h of handles) {
      await registry.register(h.spec, db)
    }
    // Phase 2: unified cycle detection — `this.graph` already carries
    // `_initDerivations`'s edges (#638); add this registry's own, then
    // re-validate. Throws `MaterializedViewCycleError` on the first cycle.
    for (const edge of registry.edges()) this.graph.registerDerived(edge.target, edge.sources, edge.kind, edge.grain)
    registry.validate(this.graph)
  }

  /**
   * @internal — consumed by `Collection.put` at write-time. Returns
   * `null` for vaults that never registered any MV strategy.
   */
  _getMaterializedViewRegistry(): MaterializedViewRegistry | null {
    return this.materializedViewRegistry
  }

  /**
   * @internal — called by `Noydb.openVault` after MVs are wired.
   * Dynamic-imports `OverlayedViewRegistry`, registers each spec,
   * validates against the MV registry for name/base/overlay collisions.
   * Throws on validation failure.
   */
  async _initOverlayedViews(
    handles: ReadonlyArray<OverlayedViewStrategy>,
  ): Promise<void> {
    if (handles.length === 0) return
    const { OverlayedViewRegistry } = await import('../with-formula/overlay-views/registry.js')
    const registry = new OverlayedViewRegistry()
    const mvRegistry = this.materializedViewRegistry
    // Build the predicate set for registration validation:
    //  - isOverlayName: an already-registered overlay's virtual name
    //  - isMVOutput: a collection name owned by an MV
    const overlayNames = new Set<string>()
    for (const h of handles) overlayNames.add(h.spec.name)
    const isMVOutput = (name: string): boolean => {
      if (!mvRegistry) return false
      for (const reg of mvRegistry.all()) {
        if (reg.outputCollection === name) return true
      }
      return false
    }
    for (const h of handles) {
      registry.register(h.spec, {
        isOverlayName: (n) => overlayNames.has(n) && n !== h.spec.name,
        isMVOutput,
      })
      // #638 Task 2 — '*' matches the derivation/MV whole-record marker.
      this.graph.registerDerived({ collection: h.spec.name, field: '*' }, [{ collection: h.spec.base, field: '*' }], 'overlay', 'record')
    }
    this.overlayedViewRegistry = registry
  }

  /**
   * @internal — consumed by `Vault.collection()`. Returns `null` for
   * vaults with no overlays registered.
   */
  _getOverlayedViewRegistry(): OverlayedViewRegistry | null {
    return this.overlayedViewRegistry
  }

  /** @internal — ctx for `putDerivedOutput`'s frozen-period skip+audit (#638 Task 5). */
  private _dispatchCtx(source: { readonly collection: string; readonly id: string }) {
    return { emit: (e: string, p: unknown) => (this.emitter.emit as (ev: string, pl: unknown) => void)(e, p), source, audit: ledgerAuditHook(this.getLedgerOrNull() ?? undefined, this.keyring.userId) }
  }

  /**
   * Manual re-materialize for a single registered MV (`refresh: 'manual'` consumers,
   * stale-bit recovery on vault reopen, bulk-recompute escape hatch after a strategy
   * change). Returns `{ written, deleted, failed, residueUndecodable, residueDeclined }` (`deleted`
   * always 0 without tombstoning; #785 splits the #782 leftovers — undecodable vs #718-declined). Throws if not registered.
   */
  async refreshView(name: string): Promise<{ written: number; deleted: number; failed: number; residueUndecodable: string[]; residueDeclined: string[] }> {
    const registry = this.materializedViewRegistry
    if (registry === null) {
      return { written: 0, deleted: 0, failed: 0, residueUndecodable: [], residueDeclined: [] }
    }
    const reg = registry.byName(name)
    if (!reg) {
      throw new Error(`refreshView: no MV registered with name "${name}"`)
    }
    const { MaterializedViewExecutor } = await import('../with-formula/materialized-views/executor.js')
    const result = await MaterializedViewExecutor.refresh(reg, {
      getCollection: (n) => this.collection(n),
      getActiveTxContext: () => this.noydb._activeTxContextOrNull,
      getQueryContext: () => this as unknown as MVQueryContext,
      dispatchCtx: this._dispatchCtx({ collection: name, id: 'refreshView' }),
    })
    // Manual refresh clears any pending stale bit (+ persisted marker, #736) —
    // the post-refresh state matches the registered strategy.
    const { clearMVStaleFully } = await import('../with-formula/materialized-views/stale.js')
    await clearMVStaleFully(this.adapter, this.name, registry, name)
    return result
  }

  /**
   * Re-derive every record in the named source collection (useful after a strategy
   * change to bring previously-derived records up-to-date). Sequential in v1.
   */
  async deriveAll(sourceCollection: string): Promise<{ derived: number; failed: number; skippedFrozen: number }> {
    const registry = this._getDerivationRegistry()
    if (registry === null) return { derived: 0, failed: 0, skippedFrozen: 0 }
    const strategies = registry.strategiesForSource(sourceCollection)
    if (strategies.length === 0) return { derived: 0, failed: 0, skippedFrozen: 0 }

    const { DerivationExecutor } = await import('../with-formula/derivations/executor.js')

    const sourceColl = this.collection<Record<string, unknown>>(sourceCollection)
    const records = await sourceColl.list()
    // `_initDerivations` populates `derivationFacade` — assert non-null
    // for the closure-captured ctx. Falls back to a fresh `derivation`-layer
    // facade on the sync-fallback path (Noydb.vault() without await) for the
    // same defensive reason `_ensureReadOnlyFacade` exists.
    const ctx = { vault: this.derivationFacade ?? new (await import('../with-audit/guards/read-only-facade.js')).ReadOnlyVaultFacade(this, 'derivation') }
    let derived = 0
    let failed = 0
    let skippedFrozen = 0
    for (const record of records) {
      if (typeof record !== 'object' || record === null) continue
      const id = (record as { id?: unknown }).id
      if (typeof id !== 'string') continue
      const dispatchCtx = this._dispatchCtx({ collection: sourceCollection, id })
      for (const { spec, strategyHash } of strategies) {
        const sourceWithId = { ...record, id }
        const result = await DerivationExecutor.run(spec, sourceWithId, 0, strategyHash, ctx)
        let anyFailed = false, anyFrozenSkip = false
        for (const key of Object.keys(spec.outputs)) {
          const out = result.outputs[key]
          if (!out) continue
          if (out.kind === 'failed') { anyFailed = true; continue }
          const outSpec = spec.outputs[key]
          if (!outSpec) continue
          const outputColl = this.collection(outSpec.collection)

          // Array-shape branch — diff against the fanout sidecar.
          if (out.kind === 'array') {
            const { loadFanoutSidecar, saveFanoutSidecar } =
              await import('../with-formula/derivations/fanout-sidecar.js')
            const prior = await loadFanoutSidecar(this.adapter, this.name, spec.source, id, key, this.getDEK, this.encrypted)
            const prevKeys = new Set<string>(prior?.keys ?? [])
            const newKeysList = out.entries.map(e => e.key)
            const newKeysSet = new Set<string>(newKeysList)
            for (const k of prevKeys) {
              if (newKeysSet.has(k)) continue
              await outputColl._internalDelete(k)
            }
            for (const entry of out.entries) {
              if (await putDerivedOutput(outputColl, entry.key, entry.value, dispatchCtx) === 'skipped-frozen') anyFrozenSkip = true
            }
            await saveFanoutSidecar(this.adapter, this.name, {
              source: spec.source,
              sourceId: id,
              outputKey: key,
              outputCollection: outSpec.collection,
              keys: newKeysList,
            }, this.getDEK, this.encrypted)
            continue
          }

          if (out.skipped === true) {
            // Optional output skipped — delete any prior emission.
            // No txCtx hookup needed: `deriveAll` runs outside the
            // multi-record transaction window by design. Routed
            // through `_internalDelete` so the bulk recompute does not
            // trip user `onDelete` on the output collection.
            await outputColl._internalDelete(id)
            continue
          }
          if (await putDerivedOutput(outputColl, id, out.value, dispatchCtx) === 'skipped-frozen') anyFrozenSkip = true
        }
        if (anyFailed) failed++; else if (anyFrozenSkip) skippedFrozen++; else derived++
      }
    }
    return { derived, failed, skippedFrozen }
  }

  /**
   * @internal — exposed for `runTransaction({ amendment: true })` so
   * the amendment invariant runner can pass the SAME read-only vault
   * facade that the gate handler in Noydb.#registerGuardGate uses.
   * Eagerly instantiated by `_initGuards()` so this accessor stays
   * synchronous; returns `null` for vaults that never registered any
   * guard (amendments require at least one guard, so the caller should
   * never see null).
   */
  _getReadOnlyFacade(): ReadOnlyVaultFacade | null {
    return this.guardFacade
  }

  /**
   * Internal lazy-allocator for the derivation read-only facade
   * (`layer:'derivation'`). Used as a defensive fallback; in practice
   * `_initDerivations()` eagerly instantiates this, so the lazy path is
   * a no-op.
   */
  private _ensureReadOnlyFacade(): ReadOnlyVaultFacade {
    if (this.derivationFacade !== null) return this.derivationFacade
    // Synchronous fall-back: dynamic import isn't available here,
    // but `_initDerivations` always sets the facade before any
    // derivation can fire. Reaching this branch means a Vault was
    // constructed without `_initDerivations` being awaited — e.g. via
    // the sync `Noydb.vault()` fallback path. Throw with a
    // pointer rather than silently building an invalid context.
    throw new Error(
      'Vault: derivation hook fired before _initDerivations() completed. ' +
      'This typically means the vault was opened via the sync ' +
      'fallback path (Noydb.vault(name)) without first calling ' +
      'await db.openVault(name). See issue #132.',
    )
  }

  /**
   * @internal — exposed for `runTransaction({ amendment: true })`
   * to append the structured `op: 'amendment'` audit entry without
   * dragging this private accessor onto the public surface or
   * forcing the tx executor to depend on the history-strategy
   * shape directly. Returns `null` when no history strategy is
   * configured, in which case the amendment commits silently
   * (the records still write through; only the multi-record
   * audit summary is skipped).
   */
  _getLedgerOrNull(): LedgerStore | null {
    return this.getLedgerOrNull()
  }

  /**
   * Return a read-only view of this vault as it existed at
   * `timestamp`. Time-machine queries are reconstructed from the
   * per-version history snapshots persisted by every `put()`, then
   * cross-checked against the ledger for deletes that happened
   * between the snapshot and the target timestamp.
   *
   * ```ts
   * const q1End = vault.at('2026-03-31T23:59:59Z')
   * const invoice = await q1End.collection<Invoice>('invoices').get('inv-001')
   * // → the record as it stood at the close of Q1 2026
   * ```
   *
   * `timestamp` accepts an ISO-8601 string or a `Date`. Time-machine
   * views are read-only — writes throw {@link ReadOnlyAtInstantError}.
   * Accuracy bounded by history retention: if `historyConfig.maxVersions`
   * pruned earlier versions, queries before the oldest retained
   * snapshot return null even for records that existed.
   *
   *.
   */
  at(timestamp: string | Date): VaultInstant {
    const iso = timestamp instanceof Date ? timestamp.toISOString() : timestamp
    return this.strategies.history.buildVaultInstant(
      {
        adapter: this.adapter,
        name: this.name,
        encrypted: this.encrypted,
        getDEK: this.getDEK,
        getLedger: () => (this.historyConfig.enabled === false ? null : this.getLedgerOrNull()),
      },
      iso,
    )
  }

  /**
   * Return a read-only "shadow" view of this vault. Every read method
   * on the returned {@link VaultFrame} delegates to the underlying
   * live collection; every write method throws
   * {@link ReadOnlyFrameError}.
   *
   * ```ts
   * const presentation = vault.frame()
   * const invoices = await presentation.collection<Invoice>('invoices').list()
   * ```
   *
   * Use for screen-sharing a live vault, demo mode, or compliance
   * review where the reviewer should not be able to edit. Writes are
   * blocked at the JavaScript layer — the keyring DEKs are unchanged,
   * so this is **not** a cryptographic security boundary against a
   * hostile caller in the same process. See {@link VaultFrame} for
   * the full caveat.
   *
   *.
   */
  frame(): VaultFrame {
    return this.strategies.shadow.buildFrame(this)
  }

  /** Credential-broker handle (#479); `NO_BROKER` throws unless `brokerStrategy: withBroker(config)` was passed to createNoydb(). */
  broker(): CredentialBrokerHandle {
    return buildCredentialBrokerHandle(this.strategies.broker, this.adapter, this.name, () => this.keyring)
  }

  /**
   * Run `fn` under a consent scope. Every `get` / `put` / `delete`
   * that happens inside `fn` writes one entry to `_consent_audit`
   * with the supplied `purpose` and `consentHash`. Outside a scope,
   * no entries are written — consent logging is opt-in by design.
   *
   * ```ts
   * await vault.withConsent(
   *   { purpose: 'quarterly-review', consentHash: '7f3a...' },
   *   async () => {
   *     const invoices = await vault.collection<Invoice>('invoices').list()
   *     return invoices
   *   },
   * )
   * ```
   *
   * The scope is a single slot on this Vault instance — two
   * concurrent `withConsent` calls stomp each other. Use separate
   * Vault instances (or an external `AsyncLocalStorage` shim) for
   * per-flight scoping.
   *
   *.
   */
  async withConsent<T>(ctx: ConsentContext, fn: () => Promise<T>): Promise<T> {
    const prior = this.consentContext
    this.consentContext = ctx
    try {
      return await fn()
    } finally {
      this.consentContext = prior
    }
  }

  /**
   * Query the consent-audit log. Returns every entry matching the
   * filter, newest-first isn't enforced — entries carry ULID ids so
   * sorting by id is insertion-order stable. Caller may sort further.
   *
   *.
   */
  async consentAudit(filter: ConsentAuditFilter = {}): Promise<ConsentAuditEntry[]> {
    return this.strategies.consent.read(this.adapter, this.name, this.encrypted, this.getDEK, filter)
  }

  /**
   * Called by Collection after every access when a consent scope is
   * active. Internal — not part of the public API.
   *
   * @internal
   */
  async _logConsent(op: ConsentOp, collection: string, recordId: string): Promise<void> {
    const ctx = this.consentContext
    if (!ctx) return
    await this.strategies.consent.write(
      this.adapter,
      this.name,
      this.encrypted,
      {
        actor: this.keyring.userId,
        purpose: ctx.purpose,
        consentHash: ctx.consentHash,
        op,
        collection,
        recordId,
      },
      this.getDEK,
    )
  }

  // ─── Hierarchical access ─────────────────────────

  /**
   * Subscribe to cross-tier access events. The callback fires every
   * time a record at a tier above the caller's inherent clearance is
   * read, written, elevated, or demoted successfully via this vault.
   * Returns an unsubscribe function.
   */
  onCrossTierAccess(listener: (event: CrossTierAccessEvent) => void): () => void {
    this.crossTierSubs.add(listener)
    return () => this.crossTierSubs.delete(listener)
  }

  private emitCrossTier(event: CrossTierAccessEvent): void {
    for (const sub of this.crossTierSubs) {
      try {
        sub(event)
      } catch {
        // subscriber failures are swallowed — audit sinks must be best-effort
      }
    }
  }

  /**
   * issue a time-boxed cross-tier delegation. Writes an
   * encrypted envelope to the reserved `_delegations` collection that
   * the target user's runtime will pick up next time they open the
   * vault.
   *
   * Caller must hold the tier DEK for the requested tier and
   * collection.
   */
  async delegate(opts: IssueDelegationOptions): Promise<DelegationToken> {
    const { issueDelegation, DELEGATIONS_COLLECTION } = await import('../with-party/team/delegation.js')
    // The target user's KEK is derived from THEIR keyring — we read
    // the keyring file to pick up the wrapped DEKs and their KEK salt,
    // but we cannot derive their KEK from our side (we don't have
    // their secret). For the delegation wraps against the
    // grantor's own KEK as a simpler first cut; swapping to a proper
    // per-target KEK exchange (via `on-magic-link` or OIDC) is a
    // follow-up tracked in the design doc.
    if (!this.keyring.kek) {
      throw new ValidationError(
        'issueDelegation: keyring.kek is null — issuing a delegation requires ' +
          'a tier-1 unlock. Re-authenticate at tier 1 (secret) first.',
      )
    }
    const targetKek = this.keyring.kek
    const delegationsDek = await this.getDEK(DELEGATIONS_COLLECTION)
    return issueDelegation(
      this.adapter,
      this.name,
      this.keyring,
      targetKek,
      delegationsDek,
      opts,
    )
  }

  /**
   * revoke an issued delegation by id. Safe to call even
   * if the id does not exist.
   */
  async revokeDelegation(id: string): Promise<void> {
    const { revokeDelegation, DELEGATIONS_COLLECTION } = await import('../with-party/team/delegation.js')
    await revokeDelegation(this.adapter, this.name, id)
    // Trigger store to note the delete.
    void DELEGATIONS_COLLECTION
  }

  // ─── Scoped tier elevation ───────────────────────────

  /**
   * Briefly elevate this vault to a higher tier and return a scoped
   * handle whose writes land at that tier. Reads on the original
   * vault continue at the caller's inherent tier; only the returned
   * handle is privileged. Auto-reverts when `release()` is called or
   * `ttlMs` elapses, whichever comes first.
   *
   * Capability semantics:
   *   - The keyring must already carry a wrap for the target tier on
   *     at least one collection (or be `owner` / `admin`, who can
   *     auto-mint). Otherwise throws {@link TierNotGrantedError}.
   *   - Per-collection capability gates (`canExportPlaintext`,
   *     `canExportBundle`) are NOT bypassed — elevation is a tier
   *     projection, not a privilege escalation path.
   *   - Only one elevation can be active per vault at a time.
   *     Calling `elevate(...)` while another is live throws
   *     {@link AlreadyElevatedError}.
   *
   * Audit:
   *   - One `_elevation_audit` envelope is written at start with
   *     `{ id, actor, tier, reason, ttlMs, startedAt, expiresAt }`.
   *   - Each write through the elevated handle additionally fires a
   *     {@link CrossTierAccessEvent} with `authorization: 'elevation'`,
   *     stamped with `reason` and `elevatedFrom`.
   */
  async elevate(tier: number, options: { ttlMs: number; reason: string }): Promise<ElevatedHandle> {
    if (!Number.isInteger(tier) || tier <= 0) {
      throw new ValidationError(`elevate: tier must be a positive integer, got ${tier}`)
    }
    if (!options || typeof options.reason !== 'string' || options.reason.length === 0) {
      throw new ValidationError('elevate: reason is required (non-empty string)')
    }
    if (typeof options.ttlMs !== 'number' || options.ttlMs <= 0) {
      throw new ValidationError('elevate: ttlMs must be a positive number')
    }
    if (this.activeElevation) {
      throw new AlreadyElevatedError(this.activeElevation.tier)
    }
    // Construction-time tier-reach check: scan keyring for any
    // `*#${tier}` DEK. Owners and admins skip — they auto-mint at
    // write time per the existing `assertTierAccess` rules. FR-6:
    // custodian is admin-rank operationally and auto-mints tier DEKs
    // too (kept in lockstep with assertTierAccess in team/tiers.ts).
    if (
      this.keyring.role !== 'owner' &&
      this.keyring.role !== 'admin' &&
      this.keyring.role !== 'custodian'
    ) {
      const suffix = `#${tier}`
      let found = false
      for (const k of this.keyring.deks.keys()) {
        if (k.endsWith(suffix)) { found = true; break }
      }
      if (!found) {
        // Match the existing error class so adopters with one catch()
        // for tier-related failures don't need a second branch.
        throw new TierNotGrantedError('(any collection)', tier)
      }
    }

    const startedAt = new Date()
    const expiresAt = startedAt.getTime() + options.ttlMs
    const reason = options.reason

    const handle = new ElevatedHandle({
      vault: this,
      tier,
      reason,
      expiresAt,
      onRelease: () => {
        if (this.activeElevation && this.activeElevation.handle === handle) {
          this.activeElevation = null
        }
      },
    })

    this.activeElevation = { tier, expiresAt, reason, handle }
    await this.writeElevationAudit({
      actor: this.keyring.userId,
      tier,
      reason,
      ttlMs: options.ttlMs,
      startedAt: startedAt.toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    })
    return handle
  }

  /**
   * Internal — invoked by an `ElevatedHandle.collection().put()` call.
   * Routes through the existing `Collection.putAtTier` code path with
   * the elevation context attached so the cross-tier event reflects
   * the right authorization class. Returns `putAtTier`'s `TierMoveResult` (#779).
   */
  async _elevatedPut<T>(
    collectionName: string,
    id: string,
    record: T,
    tier: number,
    reason: string,
  ): Promise<TierMoveResult> {
    const coll = this.collection<T>(collectionName)
    return coll.putAtTier(id, record, tier, {
      elevation: { reason, fromTier: 0 },
    })
  }

  private async writeElevationAudit(entry: {
    actor: string
    tier: number
    reason: string
    ttlMs: number
    startedAt: string
    expiresAt: string
  }): Promise<void> {
    const id = `elev-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`
    const json = JSON.stringify({ id, ...entry })
    const envelope: EncryptedEnvelope = this.encrypted
      ? await (async () => {
          const dek = await this.getDEK(ELEVATION_AUDIT_COLLECTION)
          const { iv, data } = await encrypt(json, dek)
          return {
            _noydb: NOYDB_FORMAT_VERSION,
            _v: 1,
            _ts: entry.startedAt,
            _iv: iv,
            _data: data,
            _by: entry.actor,
          }
        })()
      : {
          _noydb: NOYDB_FORMAT_VERSION,
          _v: 1,
          _ts: entry.startedAt,
          _iv: '',
          _data: json,
          _by: entry.actor,
        }
    await this.adapter.put(this.name, ELEVATION_AUDIT_COLLECTION, id, envelope)
  }

  /**
   * low-level escape hatch used by `@noy-db/on-magic-link`
   * to persist a magic-link-bound grant after the auth package has
   * derived the content key + KEK from `(serverSecret, token, vault)`.
   *
   * Callers outside of `@noy-db/on-magic-link` should use
   * `issueMagicLinkDelegation()` from that package instead — it handles
   * the HKDF derivation, record-id composition, and batch logic so the
   * grantor doesn't touch this method directly.
   */
  async writeMagicLinkGrant(
    contentKey: EnclaveKey,
    grantKek: EnclaveKey,
    recordId: string,
    opts: IssueMagicLinkGrantOptions,
  ): Promise<MagicLinkGrantRecord> {
    return writeMagicLinkGrant(
      this.adapter,
      this.name,
      this.keyring,
      contentKey,
      grantKek,
      recordId,
      opts,
    )
  }

  // ─── Accounting periods ────────────────────────

  /**
   * Close an accounting period. After this call every record whose
   * envelope `_ts` is at or before `endDate` is write-locked: further
   * `put` or `delete` calls against such records throw
   * {@link PeriodClosedError}. New records (with fresh timestamps)
   * remain freely writable, and records last written AFTER `endDate`
   * are unaffected.
   *
   * Each closure writes a `PeriodRecord` to the reserved `_periods`
   * collection. The record carries the hash of the prior period's
   * record, so a tamper with any closure breaks the chain visible to
   * {@link listPeriods} + `vault.ledger().verify()`.
   *
   * Correctness is tied to the `_ts` field the hub assigns on every
   * write. Backdating records by editing the envelope directly is
   * outside the threat model — see SPEC § zero-knowledge envelopes.
   *
   *.
   */
  async closePeriod(options: ClosePeriodOptions): Promise<PeriodRecord> {
    return this.periods.closePeriod(options)
  }

  /**
   * Open a new period that carries forward from a prior closed one
   *. The `carryForward` callback receives a read-only
   * {@link VaultInstant} view anchored at the prior period's
   * `endDate` — use it to compute opening balances, closing-trial
   * snapshots, or any aggregate the new period should inherit. The
   * returned `{ [collection]: { [id]: record } }` map is written
   * before the new `PeriodRecord` lands, so the opening entries
   * materialise with fresh `_ts` values that fall outside every
   * closed period (the guard lets them through).
   *
   * The new period is stored with `kind: 'opened'` and hash-chained
   * to the same chain the close calls build — `listPeriods()` sees
   * both closed and opened entries in `closedAt` order.
   */
  async openPeriod<TCollections extends Record<string, Record<string, unknown>>>(
    options: OpenPeriodOptions<TCollections>,
  ): Promise<PeriodRecord> {
    return this.periods.openPeriod(options)
  }

  /** Return every closed / opened period in `closedAt` order. */
  async listPeriods(): Promise<readonly PeriodRecord[]> {
    return this.periods.listPeriods()
  }

  /** Look up a single period by name. Returns `null` if not found. */
  async getPeriod(name: string): Promise<PeriodRecord | null> {
    return this.periods.getPeriod(name)
  }

  /**
   * Freeze a closed period (#604): purges in-window delete markers and
   * records a `_period_freezes` companion, never mutating the chained
   * `_periods` record. Idempotent. Purges the LOCAL adapter only — a
   * synced target's markers survive there and re-import on pull (benign),
   * and purging re-opens the #589 resurrection window for a peer offline
   * since before the cutoff (see periods.ts's "Freeze" section).
   */
  async freezePeriod(name: string): Promise<PeriodRecord> {
    return this.periods.freezePeriod(name)
  }

  /**
   * Archive a closed period (#613): relocates its in-window records from the
   * hot store to the configured cold tier (via the routeStore's cold route),
   * recording a `_period_archives` companion + ledger entry, never mutating
   * the chained `_periods` record. Non-destructive (reads fall through to
   * cold) and idempotent. Requires a routeStore with a cold route.
   */
  async archivePeriod(name: string): Promise<PeriodRecord> {
    return this.periods.archivePeriod(name)
  }

  /**
   * Target-purge a closed+frozen period (#615): sweeps delete markers off the
   * vault's push-only sync targets (`backup`/`archive`), recording a
   * `_period_target_purges` companion + ledger entry, never mutating the chained
   * `_periods` record. `sync-peer` targets are skipped. Requires the period be
   * frozen first. Idempotent; a vault with no push-only targets writes no
   * companion and is re-runnable.
   */
  async purgePeriodTargets(name: string): Promise<PeriodRecord> {
    return this.periods.purgePeriodTargets(name)
  }

  /** @internal — called by the gate bus before put/delete. */
  async _assertTsWritable(
    existing: { ts: string | null; record: Record<string, unknown> | null } | null,
    incoming: Record<string, unknown> | null,
  ): Promise<void> {
    return this.periods.assertTsWritable(existing, incoming)
  }

  /** List all collection names in this vault. */
  async collections(): Promise<string[]> {
    const snapshot = await this.adapter.loadAll(this.name)
    return Object.keys(snapshot)
  }

  /**
   * Emit a structured introspection snapshot of this vault — vault name,
   * service opt-in matrix, collections + their fields, materialized
   * views, overlay views, derivations. With `withStats: true`, walks
   * every collection's envelopes to compute record counts, byte totals,
   * and oldest/newest timestamps.
   *
   * Consumed by the `noydb describe` CLI to produce human-readable
   * audit YAML/JSON from a `.noydb` bundle.
   *
   * Field provenance:
   *   - `persisted`: read from `_schemas/<col>` envelope (Route B opt-in)
   *   - `live-validator`: derived in-process from a Zod schema attached
   *     to the live `Collection`
   *   - `sampled`: inferred from decrypted records (deferred to a follow-up)
   *   - `unknown`: no schema info available
   *
   * @see docs/superpowers/specs/2026-05-22-schema-dump-design.md
   */
  async dumpSchema(opts: DumpSchemaOptions = {}): Promise<VaultSchemaSnapshot> {
    const { dumpVaultSchema } = await import('../with-shape/introspection/walk.js') // lazy (#553)
    return dumpVaultSchema(this, opts)
  }

  /**
   * Lightweight read of the vault's registered schema: collections
   * (+ doc counts), guards, materialized views, schema-update strategies,
   * and the unlocked user's grants. Cheap — one `adapter.list` per
   * collection, no decryption. For a full snapshot + stats use dumpSchema().
   * Post-unlock by construction (a Vault only exists with an unlocked keyring).
   */
  async introspect(): Promise<SchemaIntrospection> {
    const byCol = (a: { collection: string }, b: { collection: string }) =>
      a.collection.localeCompare(b.collection)

    // Union of collections registered this session (collectionCache) and
    // collections with persisted records (collections()), so registered-but-
    // empty collections are reported too.
    const names = [...new Set([...this.collectionCache.keys(), ...(await this.collections())])]
      .filter((n) => !n.startsWith('_'))
      .sort((a, b) => a.localeCompare(b))
    const collections: { name: string; docCount: number }[] = []
    for (const name of names) {
      const ids = await this.adapter.list(this.name, name)
      collections.push({ name, docCount: ids.length })
    }

    const guards = (this._getGuardRegistry()?.summary() ?? []).slice().sort(byCol)

    const materializedViews = (this._getMaterializedViewRegistry()?.all() ?? [])
      .map((mv) => ({ name: mv.spec.name, sourceCollections: [...mv.dependencies].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name))

    const schemaUpdate = [...this.#schemaUpdateNames.entries()]
      .map(([collection, strategies]) => ({ collection, strategies }))
      .sort(byCol)

    // Grants reflect what the unlocked user can actually access: the
    // collections they hold a DEK for, with the level from `permissions`
    // (absent ⇒ implicit full access for owner/admin → 'rw').
    const grants = [...this.keyring.deks.keys()]
      .filter((collection) => !collection.startsWith('_'))
      .map((collection) => ({ collection, permission: this.keyring.permissions[collection] ?? 'rw' as const }))
      .sort(byCol)

    return { collections, guards, materializedViews, schemaUpdate, grants }
  }

  /**
   * Internal accessor for {@link dumpVaultSchema}. Exposes the structural
   * state the walker needs (collection cache, registries, ref registry,
   * adapter) without widening the public Vault surface.
   *
   * @internal
   */
  _introspectState(): VaultIntrospectState {
    return {
      name: this.name,
      adapter: this.adapter,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      collectionCache: this.collectionCache as Map<string, any>,
      refRegistry: this.refRegistry,
      getDEK: this.getDEK,
      keyring: this.keyring,
      subsystems: {
        guards: this.guardRegistry !== null,
        derivations: this.derivationRegistry !== null,
        materializedViews: this.materializedViewRegistry !== null,
        overlayViews: this.overlayedViewRegistry !== null,
      },
      ...(this.vaultMeta !== undefined ? { vaultMeta: this.vaultMeta } : {}),
      mvRegistry: this.materializedViewRegistry,
      overlayRegistry: this.overlayedViewRegistry,
      derivationRegistry: this.derivationRegistry,
      // Thread vault-level per-collection registries into the walker so
      // walk.ts can project archive/schemaUpdate into CollectionDescriptor.config
      // without coupling the walker to Vault internals.
      getCollectionSchemaUpdateNames: (col) => {
        const names = this.#schemaUpdateNames.get(col)
        return names !== undefined && names.length > 0 ? names : undefined
      },
      hasCollectionArchive: (col) => this.archiveRegistry.has(col),
    }
  }

  /**
   * Return the stable opaque bundle handle for this vault,
   * generating and persisting a fresh ULID on first call.
   *
   * used by `writePod()` to identify the
   * vault in the unencrypted bundle header without
   * exposing the vault name. The handle is persisted in
   * the reserved `_meta` internal collection so subsequent
   * exports of the same vault produce the same handle —
   * bundle adapters (Drive, Dropbox, iCloud) will use it
   * as their primary key.
   *
   * **Storage path:** the handle is written via the adapter
   * directly with collection name `_meta` and id `handle`. The
   * envelope's `_data` field contains a plain JSON
   * `{ handle: '...' }` payload — the handle is opaque, doesn't
   * need encryption, and the bundle header exposes the same
   * value anyway. This mirrors the storage approach `_keyring`
   * uses for its plain-JSON wrapped-DEK envelopes (also bypasses
   * the AES-GCM layer; the `_iv` field is left empty).
   *
   * **Cross-process stability:** the handle survives process
   * restarts because it's persisted on the adapter, not just
   * cached in memory. A new Vault instance opened on the
   * same adapter sees the same `_meta/handle` envelope and
   * returns the same ULID.
   *
   * **Round-trip after restore:** the receiving vault of a
   * `load()` call generates its OWN handle on first export. The
   * dump body does not include `_meta`, because handle stability
   * is per-vault-instance, not per-vault-content. Two
   * separate restorations of the same backup produce two
   * distinct handles, which is the right behavior — they're
   * separate vault instances now.
   */
  async getBundleHandle(): Promise<string> {
    const existing = await this.adapter.get(this.name, '_meta', 'handle')
    if (existing) {
      try {
        const parsed = JSON.parse(existing._data) as unknown
        if (parsed !== null && typeof parsed === 'object' && 'handle' in parsed) {
          const handle = (parsed as { handle: unknown }).handle
          if (typeof handle === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(handle)) {
            return handle
          }
        }
      } catch {
        // Fall through to regenerate — corrupted handle envelope
        // is treated as missing, not as an error. The new handle
        // overwrites the bad one.
      }
    }
    // Lazy import to avoid a top-of-file circular dependency:
    // bundle/bundle.ts imports from vault.ts (the
    // Vault type), and vault.ts can't statically
    // import from bundle/* without forming a cycle. The dynamic
    // import is invoked once per fresh handle generation, which
    // is rare enough that the cost doesn't matter.
    const { generateULID } = await import('../with-pod/ulid.js')
    const handle = generateULID()
    const envelope: EncryptedEnvelope = {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: 1,
      _ts: new Date().toISOString(),
      _iv: '',
      _data: JSON.stringify({ handle }),
    }
    await this.adapter.put(this.name, '_meta', 'handle', envelope)
    return handle
  }

  /**
   * Read the owner-curated cover for this vault (or `undefined` if
   * none is persisted). The cover lives in `_meta/public-envelope`
   * (the frozen wire name) as plaintext — readable without any KEK
   * — so `getBundleHandle`-style callers can label a vault before
   * unlock.
   *
   * Mirrors `Noydb.getCover(vault, opts)` but scoped to a
   * single, already-opened `Vault` instance so the
   * bundle writer can snapshot it without holding a `Noydb` reference.
   *
   * @see https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/public-envelope.md
   */
  async getCover(opts: { readonly locale?: string } = {}): Promise<Cover | undefined> {
    const { readCover } = await import('../with-party/directory/cover/index.js')
    return readCover(this.adapter, this.name, opts)
  }

  /**
   * Dump vault as a verifiable encrypted JSON backup string.
   *
   * backups embed the current ledger head and the full
   * `_ledger` + `_ledger_deltas` internal collections so the
   * receiver can run `verifyBackupIntegrity()` after `load()` and
   * detect any tampering between dump and restore. Backups produced
   * without a ledger (older formats or hub instances built without
   * the history strategy) skip the integrity check with a warning —
   * both modes round-trip cleanly.
   */
  async dump(): Promise<string> {
    const { dumpVault } = await import('../with-pod/backup.js')
    return dumpVault(this.backupContext())
  }

  /**
   * Build the `BackupContext` the extracted backup module (`with-pod/backup.ts`)
   * binds to: the read paths + the post-load mutation seams (`reloadKeyring`,
   * collection-cache clear, ledger-store reset) that `load()` performs on this
   * Vault's private state.
   */
  private backupContext() {
    return {
      adapter: this.adapter,
      vault: this.name,
      userId: () => this.keyring.userId,
      getLedgerOrNull: () => this.getLedgerOrNull(),
      envelopePayloadHash: (envelope: EncryptedEnvelope) => this.strategies.history.envelopePayloadHash(envelope),
      reloadKeyringAndRebuildDEK: async () => {
        if (this.reloadKeyring) {
          this.keyring = await this.reloadKeyring()
          // Rebuild the DEK resolver against the refreshed keyring so
          // the next ensureCollectionDEK call sees the loaded wrapped
          // DEKs, not the cached pre-load ones.
          this.getDEK = this.makeGetDEK()
        }
      },
      clearCollectionCache: () => this.collectionCache.clear(),
      resetLedgerStore: () => { this.ledgerStore = null },
      exportStream: (opts: ExportStreamOptions) => this.exportStream(opts),
    }
  }

  /**
   * Restore a vault from a verifiable backup.
   *
   * After loading, runs `verifyBackupIntegrity()` to confirm:
   *   1. The hash chain is intact (no `prevHash` mismatches)
   *   2. The chain head matches the embedded `ledgerHead.hash`
   *      from the backup
   *   3. Every data envelope's `payloadHash` matches the
   *      corresponding ledger entry — i.e. nobody swapped
   *      ciphertext between dump and restore
   *
   * On any failure, throws `BackupLedgerError` (chain or head
   * mismatch) or `BackupCorruptedError` (data envelope mismatch).
   * The vault state on the adapter has already been written
   * by the time we throw, so the caller is responsible for either
   * accepting the suspect state or wiping it and trying a different
   * backup.
   *
   * Legacy backups (no `ledgerHead` field, no `_internal`) load
   * with a console warning and skip the integrity check entirely
   * — there's no chain to verify against.
   */
  async load(backupJson: string): Promise<void> {
    const { loadVault } = await import('../with-pod/backup.js')
    return loadVault(this.backupContext(), backupJson)
  }

  /**
   * End-to-end backup integrity check. Runs both:
   *
   *   1. `ledger.verify()` — walks the hash chain and confirms
   *      every `prevHash` matches the recomputed hash of its
   *      predecessor.
   *
   *   2. **Data envelope cross-check** — for every (collection, id)
   *      that has a current value, find the most recent ledger
   *      entry recording a `put` for that pair, recompute the
   *      sha256 of the stored envelope's `_data`, and compare to
   *      the entry's `payloadHash`. Any mismatch means an
   *      out-of-band write modified the data without updating the
   *      ledger.
   *
   * Returns a discriminated union so callers can handle the two
   * failure modes differently:
   *   - `{ ok: true, head, length }` — chain verified and all
   *     data matches; safe to use.
   *   - `{ ok: false, kind: 'chain', divergedAt, message }` — the
   *     chain itself is broken at the given index.
   *   - `{ ok: false, kind: 'data', collection, id, message }` —
   *     a specific data envelope doesn't match its ledger entry.
   *
   * This method is exposed so users can call it any time, not just
   * during `load()`. A scheduled background check is the simplest
   * way to detect tampering of an in-place vault.
   */
  async verifyBackupIntegrity() {
    const { verifyBackupIntegrity } = await import('../with-pod/backup.js')
    return verifyBackupIntegrity(this.backupContext())
  }

  /**
   * Stream every collection in this vault as decrypted, ACL-scoped
   * chunks.
   *
   * ⚠ **This method decrypts your records.** noy-db's threat model assumes
   * that records on disk are encrypted; the values yielded here are
   * plaintext. The consumer is responsible for ensuring the yielded data
   * is handled in a way that matches the data's sensitivity. If your goal
   * is encrypted backup or transport between noy-db instances, use
   * `dump()` instead — it produces a tamper-evident encrypted envelope and
   * never exposes plaintext.
   *
   * ## Behavior
   *
   * - **ACL-scoped.** Collections the calling principal cannot read are
   *   silently skipped (same rule as `Collection.list()`). An operator
   *   with `{ invoices: 'rw', clients: 'ro' }` permissions on a
   *   five-collection vault exports only `invoices` and `clients`,
   *   with no error on the others.
   * - **Streaming.** Returns an `AsyncIterableIterator` so consumers can
   *   process chunks as they arrive without holding the full export in
   *   memory. Note: the underlying adapter call (`loadAll`) is still a
   *   single bulk read — the streaming benefit is on the *output* side.
   *   True per-record adapter streaming arrives with the query DSL.
   * - **Schema + refs surfaced** as metadata on every chunk so downstream
   *   serializers (`@noy-db/as-csv`, `@noy-db/as-xlsx`, custom
   *   exporters) can produce schema-aware output without reaching into
   *   collection internals.
   * - **Internal collections filtered.** `_ledger`, `_keyring`, etc. are
   *   never yielded — they're noy-db's own bookkeeping and have no value
   *   in a plaintext export. Use `dump()` for full backup including
   *   internal collections.
   *
   * ## Composition
   *
   * Once cross-vault queries land, fanning this out across
   * every vault the caller can unlock is `queryAcross(ids, c =>
   * c.exportStream())` — no new primitive needed. That's part of why this
   * method belongs in core: it's the single decrypt+ACL+metadata path
   * that every export-format package will build on, and pushing it into
   * a `@noy-db/as-*` package would force every format to re-solve
   * the same problems independently.
   *
   * @example
   * ```ts
   * for await (const chunk of company.exportStream()) {
   *   // chunk.collection: 'invoices'
   *   // chunk.schema: ZodObject | null
   *   // chunk.refs: { clientId: { target: 'clients', mode: 'strict' } }
   *   // chunk.records: Invoice[]
   * }
   * ```
   *
   * @example
   * ```ts
   * // Per-record streaming for arbitrarily large collections.
   * for await (const chunk of company.exportStream({ granularity: 'record' })) {
   *   // chunk.records is always length 1
   *   await writer.write(serialize(chunk.records[0]))
   * }
   * ```
   */
  async *exportStream(opts: ExportStreamOptions = {}): AsyncIterableIterator<ExportChunk> {
    const granularity = opts.granularity ?? 'collection'
    // Export layer: when an export locale is set, read each record at that
    // locale through the `export` layer (`resolvePolicy(onMissing, 'export')`) —
    // collapsing i18nText fields to the locale string and resolving dictKey/
    // staticDict `<field>Label`s — so the export is single-locale and the raw
    // dictionary snapshot is redundant (omitted). Unset → raw `{locale}` maps +
    // the dictionaries snapshot (a full, all-locale backup).
    const exportLocale = opts.resolveLabels
    const localeOpts = exportLocale !== undefined ? { locale: exportLocale, _layer: 'export' as const } : undefined

    // One bulk read to enumerate collections. `loadAll` filters out
    // underscore-prefixed internal collections, which is exactly what we
    // want — internal bookkeeping has no place in a plaintext export.
    const snapshot = await this.adapter.loadAll(this.name)
    const collectionNames = Object.keys(snapshot).sort()

    // Resolve the ledger head once if requested. The head is identical
    // across every yielded chunk (one ledger per vault) — we copy
    // it onto each chunk so consumers doing per-record streaming don't
    // have to thread state across yields, and so the chunk shape stays
    // forward-compatible with future per-partition ledgers where the
    // head genuinely will differ per chunk.
    const ledgerHead = opts.withLedgerHead
      ? await (async () => {
          const ledger = this.getLedgerOrNull()
          if (!ledger) return undefined
          const head = await ledger.head()
          return head
            ? { hash: head.hash, index: head.entry.index, ts: head.entry.ts }
            : undefined
        })()
      : undefined

    // Capture ALL dictionary snapshots upfront before the first yield.
    // Building all snapshots eagerly before yielding anything ensures that
    // concurrent mutations during streaming do not affect the snapshot — any
    // dictionary.put() that happens after the first yield sees the pre-yield
    // state here. Keyed by collection name.
    const dictSnapshotCache = new Map<
      string, // collection name
      Record<string, Record<string, Record<string, string>>> // field → key → locale → label
    >()
    // Skip the snapshot entirely when exporting at a locale — records carry
    // resolved `<field>Label`s, so the raw dictionary is redundant.
    if (exportLocale === undefined) {
      for (const collectionName of collectionNames) {
        const dictFields = this.dictKeyFieldRegistry.get(collectionName)
        if (dictFields && Object.keys(dictFields).length > 0) {
          const snap: Record<string, Record<string, Record<string, string>>> = {}
          for (const [fieldName, dictName] of Object.entries(dictFields)) {
            const entries = await this.dictionary(dictName).list()
            const keyMap: Record<string, Record<string, string>> = {}
            for (const entry of entries) {
              keyMap[entry.key] = entry.labels
            }
            snap[fieldName] = keyMap
          }
          dictSnapshotCache.set(collectionName, snap)
        }
      }
    }

    for (const collectionName of collectionNames) {
      // ACL gate. The same `hasAccess` check that `Collection.list()`
      // honors — silent skip, no error, matches the "operator can read
      // some but not all" pattern.
      if (!hasAccess(this.keyring, collectionName)) continue

      const coll = this.collection(collectionName)
      const schema = coll.getSchema() ?? null
      const refs = this.refRegistry.getOutbound(collectionName)
      const ids = Object.keys(snapshot[collectionName] ?? {})

      const dictionaries = dictSnapshotCache.get(collectionName)

      if (granularity === 'collection') {
        // Decrypt every record in the collection, then yield once.
        // Using `coll.get(id)` rather than the loadAll envelope directly
        // because `get()` is the canonical decrypt+schema-validate path
        // and any future cache/index plumbing rides through it.
        const records: unknown[] = []
        for (const id of ids) {
          const record = await coll.get(id, localeOpts)
          if (record !== null) records.push(exportRedact(coll, record))
        }
        const chunk: ExportChunk = {
          collection: collectionName,
          schema,
          refs,
          records,
          ...(dictionaries !== undefined ? { dictionaries } : {}),
          ...(ledgerHead ? { ledgerHead } : {}),
        }
        yield chunk
      } else {
        // Per-record yield. Memory profile: O(1 record) at a time.
        // The schema/refs metadata is repeated on every chunk so
        // consumers don't have to thread state across yields.
        for (const id of ids) {
          const record = await coll.get(id, localeOpts)
          if (record === null) continue
          const chunk: ExportChunk = {
            collection: collectionName,
            schema,
            refs,
            records: [exportRedact(coll, record)],
            ...(dictionaries !== undefined ? { dictionaries } : {}),
            ...(ledgerHead ? { ledgerHead } : {}),
          }
          yield chunk
        }
      }
    }
  }

  /**
   * Convenience wrapper that consumes `exportStream()` and serializes the
   * result to a single JSON string.
   *
   * ⚠ **`exportJSON()` decrypts your records and produces plaintext.**
   *
   * noy-db's threat model assumes that records on disk are encrypted.
   * This function deliberately violates that assumption: it produces a
   * JSON string in plaintext, which the consumer is then responsible for
   * protecting (filesystem permissions, full-disk encryption, secure
   * transfer, secure deletion).
   *
   * Use this function only when:
   * - You are the authorized owner of the data, **and**
   * - You have a legitimate downstream tool that requires plaintext
   *   JSON, **and**
   * - You have a documented plan for how the resulting plaintext will be
   *   protected and eventually destroyed.
   *
   * If your goal is encrypted backup or transport between noy-db
   * instances, use `dump()` instead — it produces a tamper-evident
   * encrypted envelope, never plaintext.
   *
   * ## Why `Promise<string>` instead of writing to a file path
   *
   * Core has zero `node:` imports — it runs unchanged in browsers, Node,
   * Bun, Deno, and edge runtimes. Accepting a file path would force a
   * `node:fs` import (breaks browsers) or a runtime dynamic import
   * (doesn't tree-shake, inflates bundles). Returning a string lets the
   * consumer choose any sink and forces the destination decision to be
   * explicit at the call site — which is also better for the security
   * warning.
   *
   * @example
   * ```ts
   * // Node: write to a file
   * import { writeFile } from 'node:fs/promises'
   * await writeFile('./backup.json', await company.exportJSON())
   * ```
   *
   * @example
   * ```ts
   * // Browser: download as a file
   * const json = await company.exportJSON()
   * const blob = new Blob([json], { type: 'application/json' })
   * const url = URL.createObjectURL(blob)
   * // ... attach to an <a download> and click
   * ```
   *
   * @example
   * ```ts
   * // Stream upload to a server
   * await fetch('/upload', {
   *   method: 'POST',
   *   body: await company.exportJSON(),
   * })
   * ```
   *
   * ## On-disk shape
   *
   * ```json
   * {
   *   "_noydb_export": 1,
   *   "_compartment": "acme",
   *   "_exported_at": "2026-04-07T12:00:00.000Z",
   *   "_exported_by": "alice@acme.example",
   *   "collections": {
   *     "invoices": {
   *       "schema": null,
   *       "refs": { "clientId": { "target": "clients", "mode": "strict" } },
   *       "records": [ ... ]
   *     }
   *   },
   *   "ledgerHead": { "hash": "...", "index": 42, "ts": "..." }
   * }
   * ```
   *
   * `schema` is included for forward compatibility but is currently
   * always `null` because Standard Schema validators are not JSON-
   * serializable. Format-package serializers that need the schema
   * should use `exportStream()` directly and read `chunk.schema` (which
   * is the live validator object, not a serialization of it).
   */
  async exportJSON(opts: ExportStreamOptions = {}): Promise<string> {
    const { exportVaultJSON } = await import('../with-pod/backup.js')
    return exportVaultJSON(this.backupContext(), opts)
  }
}
