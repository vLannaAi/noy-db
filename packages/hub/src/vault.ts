import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultBackup,
  VaultSnapshot,
  HistoryConfig,
  ExportStreamOptions,
  ExportChunk,
  CollectionConflictResolver,
  CrossTierAccessEvent,
  TierMode,
} from './types.js'
import type { IssueDelegationOptions, DelegationToken } from './team/delegation.js'
import { NOYDB_BACKUP_VERSION, NOYDB_FORMAT_VERSION } from './types.js'
import { Collection } from './collection.js'
import type { CacheOptions } from './collection.js'
import type { IndexDef } from './query/indexes.js'
import type { JoinableSource } from './query/index.js'
import type { OnDirtyCallback } from './collection.js'
import type { UnlockedKeyring } from './team/keyring.js'
import { ensureCollectionDEK, hasAccess, hasExportCapability } from './team/keyring.js'
import type { ExportFormat } from './types.js'
import { ExportCapabilityError, ValidationError } from './errors.js'
import type { NoydbEventEmitter } from './events.js'
import { BackupLedgerError, BackupCorruptedError } from './errors.js'
import type { StandardSchemaV1 } from './schema.js'
import { LedgerStore, sha256Hex, LEDGER_COLLECTION, LEDGER_DELTAS_COLLECTION } from './history/ledger/index.js'
import { VaultInstant } from './history/time-machine.js'
import { VaultFrame } from './shadow/vault-frame.js'
import type { ConsentContext, ConsentAuditEntry, ConsentAuditFilter, ConsentOp } from './consent/consent.js'
import { writeConsentEntry, loadConsentEntries } from './consent/consent.js'
import {
  RefRegistry,
  RefIntegrityError,
  type RefDescriptor,
  type RefViolation,
} from './refs.js'
import {
  DictionaryHandle,
  isDictCollectionName,
  type DictionaryOptions,
} from './i18n/dictionary.js'
import {
  validateI18nTextValue,
  applyI18nLocale,
  type I18nTextDescriptor,
} from './i18n/core.js'
import type { DictKeyDescriptor } from './i18n/dictionary.js'
import type { LocaleReadOptions, ConflictPolicy } from './types.js'
import type { CrdtMode } from './crdt.js'
import { ReservedCollectionNameError } from './errors.js'
import {
  PERIODS_COLLECTION,
  loadPeriods,
  chainAnchor,
  assertTsWritable,
  validatePeriodName,
  appendPeriodLedgerEntry,
  type PeriodRecord,
  type ClosePeriodOptions,
  type OpenPeriodOptions,
} from './periods/index.js'
import { encrypt, decrypt } from './crypto.js'
import {
  createExportBlobsHandle,
  EXPORT_AUDIT_COLLECTION,
  type ExportBlobsOptions,
  type ExportBlobsHandle,
  type ExportBlobsAuditEntry,
} from './store/export-blobs.js'
import { runCompaction, type BlobFieldsConfig, type CompactRunOptions, type CompactionResult } from './store/blob-compaction.js'
import {
  writeMagicLinkGrant,
  type IssueMagicLinkGrantOptions,
  type MagicLinkGrantRecord,
} from './team/magic-link-grant.js'

/** A vault (tenant namespace) containing collections. */
export class Vault {
  private readonly adapter: NoydbStore
  /** The vault's name as passed to `openVault()`. Stable for the instance lifetime. */
  public readonly name: string
  /**
   * The active in-memory keyring. NOT readonly because `load()`
   * needs to refresh it after restoring a different keyring file —
   * otherwise the in-memory DEKs (from the pre-load session) and
   * the on-disk wrapped DEKs (from the loaded backup) drift apart
   * and every subsequent decrypt fails with TamperedError.
   */
  private keyring: UnlockedKeyring
  private readonly encrypted: boolean
  private readonly emitter: NoydbEventEmitter
  private readonly onDirty: OnDirtyCallback | undefined
  private readonly onRegisterConflictResolver: ((name: string, resolver: CollectionConflictResolver) => void) | undefined
  private readonly syncAdapter: NoydbStore | undefined
  private readonly historyConfig: HistoryConfig
  private getDEK: (collectionName: string) => Promise<CryptoKey>

  /**
   * Optional callback that re-derives an UnlockedKeyring from the
   * adapter using the active user's passphrase. Called by `load()`
   * after the on-disk keyring file has been replaced — refreshes
   * `this.keyring` so the next DEK access uses the loaded wrapped
   * DEKs instead of the stale pre-load ones.
   *
   * Provided by Noydb at openVault() time. Tests that
   * construct Vault directly can pass `undefined`; load()
   * skips the refresh in that case (which is fine for plaintext
   * compartments — there's nothing to re-unwrap).
   */
  private readonly reloadKeyring: (() => Promise<UnlockedKeyring>) | undefined
  private readonly collectionCache = new Map<string, Collection<unknown>>()

  /**
   * v0.21 #263 — per-collection `blobFields` retention/TTL config.
   * Populated on `collection({ blobFields })` and read by
   * `vault.compact()`. Indexed by collection name.
   */
  private readonly blobFieldsRegistry = new Map<string, BlobFieldsConfig<unknown>>()

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

  /**
   * Per-vault foreign-key reference registry. Collections
   * register their `refs` option here on construction; the
   * vault uses the registry on every put/delete/checkIntegrity
   * call. One instance lives for the compartment's lifetime.
   */
  private readonly refRegistry = new RefRegistry()

  /**
   * Set of collection record-ids currently being deleted as part of
   * a cascade. Populated on entry to `enforceRefsOnDelete` and
   * drained on exit. Used to break mutual-cascade cycles: deleting
   * A → cascade to B → cascade back to A would otherwise recurse
   * forever, so we short-circuit when we see an already-in-progress
   * delete on the same (collection, id) pair.
   */
  private readonly cascadeInProgress = new Set<string>()

  /**
   * Vault-default locale (v0.8 #81 #82). Set via
   * `openVault(name, { locale })`. Used as the fallback locale
   * when per-call `{ locale }` options are not specified on individual
   * `get()`/`list()` calls.
   */
  private locale: string | undefined

  /**
   * Current consent scope (v0.16 #218). Set by `withConsent()` and
   * restored in its finally block. When non-null, every collection
   * access inside the scope writes one entry to `_consent_audit`.
   *
   * Single-slot by design — two concurrent withConsent calls on the
   * same Vault stomp each other. Adopters needing per-flight scoping
   * should use separate Vault instances.
   */
  private consentContext: ConsentContext | null = null

  /**
   * Cache of closed/opened accounting periods (v0.17 #201 / #202).
   * Populated on first `closePeriod` / `openPeriod` / `listPeriods` /
   * per-collection write call. Kept in memory as an ordered list (by
   * `closedAt`) so the `periodGuard` hook runs synchronously against
   * each collection's put/delete path.
   *
   * Sentinel `null` means "not yet loaded" — the first consumer
   * triggers a one-time `loadPeriods()` pass. Every subsequent
   * closure/opening pushes into the cache in-place so the next write
   * sees the updated chain without re-reading the adapter.
   */
  private periodCache: PeriodRecord[] | null = null

  /**
   * Registry of dictKey fields declared across all collections in this
   * vault. Keyed by collection name → field name → dictionary name.
   * Used by `DictionaryHandle.rename()` to find and update all records
   * referencing a renamed key.
   *
   * Populated by `collection()` when the `dictKeyFields` option is passed.
   */
  private readonly dictKeyFieldRegistry = new Map<
    string, // collection name
    Record<string, string> // field name → dictionary name
  >()

  /**
   * Registry of i18nText fields declared across all collections. Keyed
   * by collection name → field name → I18nTextDescriptor. Used by
   * `applyI18nLocale` on reads and by `validateI18nTextValue` on puts.
   *
   * Populated by `collection()` when the `i18nFields` option is passed.
   */
  private readonly i18nFieldRegistry = new Map<
    string, // collection name
    Record<string, I18nTextDescriptor>
  >()

  /** Cache of DictionaryHandle instances, one per dictionary name. */
  private readonly dictionaryCache = new Map<string, DictionaryHandle>()

  /** v0.18 #210 — subscribers for cross-tier access events. */
  private readonly crossTierSubs = new Set<(event: CrossTierAccessEvent) => void>()

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
    keyring: UnlockedKeyring
    encrypted: boolean
    emitter: NoydbEventEmitter
    onDirty?: OnDirtyCallback | undefined
    historyConfig?: HistoryConfig | undefined
    reloadKeyring?: (() => Promise<UnlockedKeyring>) | undefined
    /** Vault-default locale (v0.8 #81 #82). */
    locale?: string | undefined
    /** Translator callback from Noydb (v0.8 #83). */
    plaintextTranslator?:
      | ((text: string, from: string, to: string, field: string, collection: string) => Promise<string>)
      | undefined
    /**
     * v0.9 #131 — callback to register a per-collection envelope-level
     * conflict resolver with the SyncEngine. Present when sync is configured.
     */
    onRegisterConflictResolver?: ((name: string, resolver: CollectionConflictResolver) => void) | undefined
    /** v0.9 #134 — optional remote/sync adapter for presence broadcasting. */
    syncAdapter?: NoydbStore | undefined
  }) {
    this.adapter = opts.adapter
    this.name = opts.name
    this.keyring = opts.keyring
    this.encrypted = opts.encrypted
    this.emitter = opts.emitter
    this.onDirty = opts.onDirty
    this.onRegisterConflictResolver = opts.onRegisterConflictResolver
    this.syncAdapter = opts.syncAdapter
    this.historyConfig = opts.historyConfig ?? { enabled: true }
    this.reloadKeyring = opts.reloadKeyring
    this.locale = opts.locale
    this.translateText = opts.plaintextTranslator

    // Build the lazy DEK resolver. Pulled out into a private method
    // so `load()` can rebuild it after a keyring refresh — the
    // closure captures `this.keyring` by reference, so changing the
    // field is enough, but resetting the cached `getDEKFn` ensures
    // ensureCollectionDEK runs again against the freshly-loaded
    // wrapped DEKs.
    this.getDEK = this.makeGetDEK()
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
  private makeGetDEK(): (collectionName: string) => Promise<CryptoKey> {
    let getDEKFn: ((collectionName: string) => Promise<CryptoKey>) | null = null
    return async (collectionName: string): Promise<CryptoKey> => {
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
   *   (v0.8 #82). Validated on `put()` and locale-resolved on reads.
   * - `options.dictKeyFields` declares per-field `dictKey()` descriptors
   *   (v0.8 #81). `put()` validates keys against the declared set; reads
   *   with `{ locale }` add `<field>Label` virtual fields.
   *
   * Throws `ReservedCollectionNameError` for names starting with `_dict_`.
   * Use `vault.dictionary(name)` to access dictionary collections.
   *
   * Lazy mode + indexes is rejected at construction time — see the
   * Collection constructor for the rationale.
   */
  collection<T>(collectionName: string, options?: {
    indexes?: IndexDef[]
    /** v0.23 #278 — auto-reconcile policy for persisted-index drift. */
    reconcileOnOpen?: 'off' | 'dry-run' | 'auto'
    prefetch?: boolean
    cache?: CacheOptions
    schema?: StandardSchemaV1<unknown, T>
    refs?: Record<string, RefDescriptor>
    /** v0.8 #82 — declare i18nText fields for locale-aware reads. */
    i18nFields?: Record<string, I18nTextDescriptor>
    /** v0.8 #81 — declare dictKey fields for label resolution on reads. */
    dictKeyFields?: Record<string, DictKeyDescriptor>
    /** v0.9 #131 — per-collection conflict resolution policy. */
    conflictPolicy?: ConflictPolicy<T>
    /** v0.9 #132 — CRDT mode for collaborative editing without conflicts. */
    crdt?: CrdtMode
    /**
     * v0.19 #219 — declare deterministic-encryption fields for blind
     * equality search. See `Collection` constructor docs for the full
     * trade-off. Requires `acknowledgeDeterministicRisk: true`.
     */
    deterministicFields?: readonly string[]
    /** v0.19 #219 — explicit ack that deterministic encryption leaks equality. */
    acknowledgeDeterministicRisk?: boolean
    /**
     * v0.21 #263 — declarative blob retention / TTL policy per slot
     * name. Values are `{ retainDays?, evictWhen? }`. Evaluated only
     * when `vault.compact()` runs.
     */
    blobFields?: BlobFieldsConfig<T>
    /** v0.18 #205 — declared tiers for this collection. */
    tiers?: readonly number[]
    /** v0.18 #207 #208 — how lower-tier reads see above-tier records. */
    tierMode?: TierMode
  }): Collection<T> {
    // Guard: reject reserved _dict_* names
    if (isDictCollectionName(collectionName)) {
      throw new ReservedCollectionNameError(collectionName)
    }

    let coll = this.collectionCache.get(collectionName)
    if (!coll) {
      // Register ref declarations (if any) with the vault-level
      // registry BEFORE constructing the Collection. This way the
      // first put() on the new collection already sees its refs via
      // vault.enforceRefsOnPut.
      if (options?.refs) {
        this.refRegistry.register(collectionName, options.refs)
      }

      // Register i18nText fields
      if (options?.i18nFields) {
        this.i18nFieldRegistry.set(collectionName, options.i18nFields)
      }

      // v0.21 #263 — register blobFields retention/TTL policy
      if (options?.blobFields) {
        this.blobFieldsRegistry.set(collectionName, options.blobFields as BlobFieldsConfig<unknown>)
      }

      // Register dictKey fields: store field → dictionary name mapping
      if (options?.dictKeyFields) {
        const dictFieldMap: Record<string, string> = {}
        for (const [field, desc] of Object.entries(options.dictKeyFields)) {
          dictFieldMap[field] = desc.name
        }
        this.dictKeyFieldRegistry.set(collectionName, dictFieldMap)
      }

      const collOpts: ConstructorParameters<typeof Collection<T>>[0] = {
        adapter: this.adapter,
        vault: this.name,
        name: collectionName,
        keyring: this.keyring,
        encrypted: this.encrypted,
        emitter: this.emitter,
        getDEK: this.getDEK,
        onDirty: this.onDirty,
        historyConfig: this.historyConfig,
        ledger: this.ledger(),
        refEnforcer: this,
        joinResolver: this,
        defaultLocale: this.locale,
        onRegisterConflictResolver: this.onRegisterConflictResolver,
        onAccess: (op, id) => this._logConsent(op, collectionName, id),
        periodGuard: (existing, incoming) => this._assertTsWritable(existing, incoming),
      }
      if (options?.indexes !== undefined) collOpts.indexes = options.indexes
      if (options?.reconcileOnOpen !== undefined) collOpts.reconcileOnOpen = options.reconcileOnOpen
      if (options?.prefetch !== undefined) collOpts.prefetch = options.prefetch
      if (options?.cache !== undefined) collOpts.cache = options.cache
      if (options?.schema !== undefined) collOpts.schema = options.schema
      if (options?.conflictPolicy !== undefined) collOpts.conflictPolicy = options.conflictPolicy
      if (options?.crdt !== undefined) collOpts.crdt = options.crdt
      if (options?.deterministicFields !== undefined) {
        collOpts.deterministicFields = options.deterministicFields
      }
      if (options?.acknowledgeDeterministicRisk !== undefined) {
        collOpts.acknowledgeDeterministicRisk = options.acknowledgeDeterministicRisk
      }
      if (options?.tiers !== undefined) collOpts.tiers = options.tiers
      if (options?.tierMode !== undefined) collOpts.tierMode = options.tierMode
      collOpts.onCrossTierAccess = (event) => this.emitCrossTier(event)
      if (this.syncAdapter !== undefined) collOpts.syncAdapter = this.syncAdapter
      if (options?.i18nFields !== undefined) collOpts.i18nFields = options.i18nFields
      if (options?.dictKeyFields !== undefined) {
        // Build the label resolver callback for this collection
        collOpts.dictLabelResolver = async (dictName, key, locale, fallback) => {
          const handle = this.dictionary(dictName)
          return handle.resolveLabel(key, locale, fallback)
        }
        collOpts.dictKeyFields = options.dictKeyFields
      }
      // i18n validation on put — enforced via the compartment's put hook
      if (options?.i18nFields !== undefined || options?.dictKeyFields !== undefined) {
        collOpts.i18nPutValidator = (record: unknown) => {
          this.enforceI18nOnPut(collectionName, record)
        }
      }
      // Wire the translator for autoTranslate: true fields (v0.8 #83)
      if (options?.i18nFields !== undefined && this.translateText) {
        collOpts.autoTranslateHook = this.translateText
      }
      coll = new Collection<T>(collOpts)
      this.collectionCache.set(collectionName, coll)
    }
    return coll as Collection<T>
  }

  /**
   * Validate i18nText fields on a `put()`. Called by Collection just
   * before the adapter write, after schema validation. Throws
   * `MissingTranslationError` when a required translation is absent.
   */
  enforceI18nOnPut(collectionName: string, record: unknown): void {
    const i18nFields = this.i18nFieldRegistry.get(collectionName)
    if (!i18nFields || Object.keys(i18nFields).length === 0) return
    if (!record || typeof record !== 'object') return

    const obj = record as Record<string, unknown>
    for (const [field, descriptor] of Object.entries(i18nFields)) {
      const value = obj[field]
      if (value === undefined || value === null) continue
      validateI18nTextValue(value, field, descriptor)
    }
  }

  /**
   * Apply locale resolution to a record for the given collection.
   *
   * Called by Collection after decryption when locale options are present.
   * Returns a new object (never mutates the cached record).
   */
  async applyLocale(
    collectionName: string,
    record: Record<string, unknown>,
    localeOpts: LocaleReadOptions,
  ): Promise<Record<string, unknown>> {
    const locale = localeOpts.locale ?? this.locale
    if (!locale) return record

    let result = record

    // 1. i18nText resolution
    const i18nFields = this.i18nFieldRegistry.get(collectionName)
    if (i18nFields && Object.keys(i18nFields).length > 0) {
      result = applyI18nLocale(result, i18nFields, locale, localeOpts.fallback)
    }

    // 2. dictKey label resolution — add <field>Label virtual fields
    const dictFields = this.dictKeyFieldRegistry.get(collectionName)
    if (dictFields && Object.keys(dictFields).length > 0 && locale !== 'raw') {
      const withLabels = { ...result }
      for (const [field, dictName] of Object.entries(dictFields)) {
        const key = result[field]
        if (typeof key !== 'string') continue
        const handle = this.dictionary(dictName)
        const label = await handle.resolveLabel(key, locale, localeOpts.fallback)
        if (label !== undefined) {
          withLabels[`${field}Label`] = label
        }
      }
      result = withLabels
    }

    return result
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
    let handle = this.dictionaryCache.get(name)
    if (!handle) {
      handle = new DictionaryHandle<Keys>(
        this.adapter,
        this.name,
        name,
        this.keyring,
        this.getDEK,
        this.encrypted,
        this.ledger(),
        options,
        // findAndUpdateReferences: rewrite dictKey fields in all
        // registered collections when rename() is called
        async (dictionaryName, oldKey, newKey) => {
          for (const [collectionName, dictFields] of this.dictKeyFieldRegistry) {
            // Find fields that point at this dictionary
            const fields = Object.entries(dictFields)
              .filter(([, dn]) => dn === dictionaryName)
              .map(([field]) => field)
            if (fields.length === 0) continue

            const coll = this.collection<Record<string, unknown>>(collectionName)
            const records = await coll.list()
            for (const record of records) {
              let changed = false
              const updated = { ...record }
              for (const field of fields) {
                if (updated[field] === oldKey) {
                  updated[field] = newKey
                  changed = true
                }
              }
              if (changed) {
                const id = (record['id'] as string | undefined)
                if (id !== undefined) {
                  await coll.put(id, updated)
                }
              }
            }
          }
        },
        this.emitter,
      )
      this.dictionaryCache.set(name, handle)
    }
    return handle as DictionaryHandle<Keys>
  }

  /**
   * Build a `JoinableSource` for a dictKey field, for use in dict joins
   * (v0.8 #85). Returns a source whose snapshot contains `{ key, ...labels }`
   * records — one per dictionary entry — keyed by the stable key.
   *
   * Returns `null` when `field` is not a dictKey in `leftCollection`.
   *
   * The snapshot is built synchronously from whatever the dictionary
   * handle has in its cached state. For empty dictionaries this returns
   * an empty snapshot rather than `null`.
   */
  /**
   * Build a `JoinableSource` for a dictKey field, for use in dict joins
   * (v0.8 #85). Returns a source whose snapshot contains
   * `{ key, labels, ...labels }` records — one per dictionary entry —
   * keyed by the stable key.
   *
   * The snapshot is built synchronously from the DictionaryHandle's
   * write-through cache, which is populated on every `put()`, `rename()`,
   * `delete()`, and `list()` call. For pre-existing data not yet touched
   * this session, call `await vault.dictionary(name).list()` first
   * to warm the cache.
   *
   * Returns `null` when `field` is not a dictKey in `leftCollection`.
   */
  resolveDictSource(leftCollection: string, field: string): JoinableSource | null {
    const dictFields = this.dictKeyFieldRegistry.get(leftCollection)
    if (!dictFields || !(field in dictFields)) return null
    const dictName = dictFields[field]
    if (!dictName) return null
    const handle = this.dictionary(dictName)
    return {
      snapshot(): readonly unknown[] {
        return handle.snapshotEntries()
      },
      lookupById(id: string): unknown {
        const entries = handle.snapshotEntries()
        return entries.find((e) => e['key'] === id)
      },
    }
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

  /**
   * Authorize an `@noy-db/as-*` export against the current keyring's
   * `exportCapability` (RFC #249). Throws `ExportCapabilityError` if
   * the invoking keyring is not authorised.
   *
   * `as-*` packages MUST call this before invoking the underlying
   * export primitive (`exportStream()` / `writeNoydbBundle()` / …).
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
    if (tier === 'plaintext') {
      if (format === undefined) {
        throw new Error('vault.assertCanExport: plaintext tier requires a format')
      }
      if (!hasExportCapability(this.keyring, 'plaintext', format)) {
        throw new ExportCapabilityError({
          tier: 'plaintext',
          userId: this.keyring.userId,
          format,
        })
      }
      return
    }
    if (!hasExportCapability(this.keyring, 'bundle')) {
      throw new ExportCapabilityError({
        tier: 'bundle',
        userId: this.keyring.userId,
      })
    }
  }

  /**
   * **v0.21 #262** — bulk blob extraction primitive.
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
   * **v0.21 #263** — evict blob slots per the per-collection
   * `blobFields` retention policy.
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
        return coll.get(id)
      },
      listSlots: async (name: string, id: string) => {
        const coll = this.collection(name)
        return coll.blob(id).list()
      },
      deleteSlot: async (name: string, id: string, slotName: string) => {
        const coll = this.collection(name)
        await coll.blob(id).delete(slotName)
      },
    }, options)
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
    if (tier === 'plaintext') {
      if (format === undefined) return false
      return hasExportCapability(this.keyring, 'plaintext', format)
    }
    return hasExportCapability(this.keyring, 'bundle')
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
    const outbound = this.refRegistry.getOutbound(collectionName)
    if (Object.keys(outbound).length === 0) return
    if (!record || typeof record !== 'object') return
    const obj = record as Record<string, unknown>

    for (const [field, descriptor] of Object.entries(outbound)) {
      if (descriptor.mode !== 'strict') continue
      const rawId = obj[field]
      // Nullish ref values are allowed — treat them as "no reference".
      // Users who want "always required" should express it in their
      // Standard Schema validator via a non-optional field.
      if (rawId === null || rawId === undefined) continue
      // Refs must be strings or numbers — anything else (object,
      // array, boolean) is a programming error and should fail
      // loudly rather than serialize as "[object Object]".
      if (typeof rawId !== 'string' && typeof rawId !== 'number') {
        throw new RefIntegrityError({
          collection: collectionName,
          id: (obj['id'] as string | undefined) ?? '<unknown>',
          field,
          refTo: descriptor.target,
          refId: null,
          message:
            `Ref field "${collectionName}.${field}" must be a string or number, got ${typeof rawId}.`,
        })
      }
      const refId = String(rawId)
      const target = this.collection<Record<string, unknown>>(descriptor.target)
      const exists = await target.get(refId)
      if (!exists) {
        throw new RefIntegrityError({
          collection: collectionName,
          id: (obj['id'] as string | undefined) ?? '<unknown>',
          field,
          refTo: descriptor.target,
          refId,
          message:
            `Strict ref "${collectionName}.${field}" → "${descriptor.target}" ` +
            `cannot be satisfied: target id "${refId}" not found in "${descriptor.target}".`,
        })
      }
    }
  }

  /**
   * Enforce inbound ref modes on a `delete()`. Called by Collection
   * just before it deletes from the adapter. Walks every inbound
   * ref that targets this (collection, id) and:
   *
   *   - `strict`: throws if any referencing records exist
   *   - `cascade`: deletes every referencing record
   *   - `warn`:    no-op (checkIntegrity picks it up)
   *
   * Cascade cycles are broken via `cascadeInProgress` — re-entering
   * for the same (collection, id) returns immediately so two
   * mutually-cascading collections don't recurse forever.
   */
  async enforceRefsOnDelete(collectionName: string, id: string): Promise<void> {
    const key = `${collectionName}/${id}`
    if (this.cascadeInProgress.has(key)) return
    this.cascadeInProgress.add(key)

    try {
      const inbound = this.refRegistry.getInbound(collectionName)
      for (const rule of inbound) {
        const fromCollection = this.collection<Record<string, unknown>>(rule.collection)
        // Scan the referencing collection for records whose ref
        // field matches this id. For eager-mode collections this
        // is an in-memory filter; for lazy-mode it requires a scan.
        const allRecords = await fromCollection.list()
        const matches = allRecords.filter((rec) => {
          const raw = rec[rule.field]
          // Same string/number-only restriction as enforceRefsOnPut.
          // Anything else can't have been a valid ref to begin with,
          // so it can't match.
          if (typeof raw !== 'string' && typeof raw !== 'number') return false
          return String(raw) === id
        })
        if (matches.length === 0) continue

        if (rule.mode === 'strict') {
          const first = matches[0]
          throw new RefIntegrityError({
            collection: rule.collection,
            id: (first?.['id'] as string | undefined) ?? '<unknown>',
            field: rule.field,
            refTo: collectionName,
            refId: id,
            message:
              `Cannot delete "${collectionName}"/"${id}": ` +
              `${matches.length} record(s) in "${rule.collection}" still reference it via strict ref "${rule.field}".`,
          })
        }
        if (rule.mode === 'cascade') {
          for (const match of matches) {
            const matchId = (match['id'] as string | undefined) ?? null
            if (matchId === null) continue
            // Recursive delete — the cycle breaker above catches
            // infinite loops.
            await fromCollection.delete(matchId)
          }
        }
        // warn: no-op
      }
    } finally {
      this.cascadeInProgress.delete(key)
    }
  }

  // ─── Join resolver (v0.6 #73 — eager .join()) ────────────────────

  /**
   * Look up the `RefDescriptor` the left collection declared for a
   * given field name. Returns `null` when the field has no ref
   * declaration — the Query builder turns that into an actionable
   * error at plan time (before any records are touched).
   *
   * Implements the `joinResolver.resolveRef` half of the structural
   * interface that `Collection.query()` consumes. See
   * `query/join.ts` for the full design.
   */
  resolveRef(leftCollection: string, field: string): RefDescriptor | null {
    const outbound = this.refRegistry.getOutbound(leftCollection)
    return outbound[field] ?? null
  }

  /**
   * Resolve a right-side join source by target collection name.
   * Returns `null` for unknown collections so the Query executor can
   * surface an actionable error naming the missing target.
   *
   * Implements the `joinResolver.resolveSource` half of the
   * structural interface. The returned JoinableSource is a thin
   * wrapper that reads the target collection's in-memory cache via
   * `list()` / `get()` synchronously — the cache is populated by an
   * earlier `ensureHydrated()` call through the target's query/list
   * path. If the target has not been opened yet in this session the
   * join will see an empty snapshot; consumers who hit this can
   * open the target collection explicitly before running the query.
   *
   * Only same-vault targets are resolvable — cross-vault
   * joins are explicitly forbidden by the architecture (v0.5 #63
   * `queryAcross` is the sanctioned path for cross-vault
   * correlation, not `.join()`).
   */
  resolveSource(collectionName: string): JoinableSource | null {
    // Reject internal / reserved collection names — joins against
    // `_ledger/`, `_keyring/`, `_deltas/`, etc. are never legitimate.
    if (collectionName.startsWith('_')) return null
    const coll = this.collectionCache.get(collectionName)
    if (!coll) return null
    // Collection exposes a structural `querySourceForJoin()` method
    // that returns a lightweight snapshot/lookupById view backed by
    // its in-memory cache. Typed as unknown here because
    // Collection<T> is covariant on T — the join executor only
    // reads fields by name and doesn't care about the concrete type.
    return (coll as unknown as {
      querySourceForJoin(): JoinableSource
    }).querySourceForJoin()
  }

  /**
   * Walk every collection that has declared refs, load its records,
   * and report any reference whose target id is missing. Modes are
   * reported alongside each violation so the caller can distinguish
   * "this is a warning the user asked for" from "this should never
   * have happened" (strict violations produced by out-of-band
   * writes).
   *
   * Returns `{ violations: [...] }` instead of throwing — the whole
   * point of `checkIntegrity()` is to surface a list for display
   * or repair, not to fail noisily.
   */
  async checkIntegrity(): Promise<{ violations: RefViolation[] }> {
    const violations: RefViolation[] = []
    for (const [collectionName, refs] of this.refRegistry.entries()) {
      const coll = this.collection<Record<string, unknown>>(collectionName)
      const records = await coll.list()
      for (const record of records) {
        const recId = (record['id'] as string | undefined) ?? '<unknown>'
        for (const [field, descriptor] of Object.entries(refs)) {
          const rawId = record[field]
          if (rawId === null || rawId === undefined) continue
          // Non-scalar ref values are flagged as a violation rather
          // than thrown — `checkIntegrity` is a "report what's wrong"
          // tool, not a "block on first failure" tool. The thrown
          // version lives in `enforceRefsOnPut`.
          if (typeof rawId !== 'string' && typeof rawId !== 'number') {
            violations.push({
              collection: collectionName,
              id: recId,
              field,
              refTo: descriptor.target,
              refId: rawId,
              mode: descriptor.mode,
            })
            continue
          }
          const refId = String(rawId)
          const target = this.collection<Record<string, unknown>>(descriptor.target)
          const exists = await target.get(refId)
          if (!exists) {
            violations.push({
              collection: collectionName,
              id: recId,
              field,
              refTo: descriptor.target,
              refId: rawId,
              mode: descriptor.mode,
            })
          }
        }
      }
    }
    return { violations }
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
    if (!this.ledgerStore) {
      this.ledgerStore = new LedgerStore({
        adapter: this.adapter,
        vault: this.name,
        encrypted: this.encrypted,
        getDEK: this.getDEK,
        actor: this.keyring.userId,
      })
    }
    return this.ledgerStore
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
   * v0.16 #215.
   */
  at(timestamp: string | Date): VaultInstant {
    const iso = timestamp instanceof Date ? timestamp.toISOString() : timestamp
    return new VaultInstant(
      {
        adapter: this.adapter,
        name: this.name,
        encrypted: this.encrypted,
        getDEK: this.getDEK,
        getLedger: () => (this.historyConfig.enabled === false ? null : this.ledger()),
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
   * v0.16 #217.
   */
  frame(): VaultFrame {
    return new VaultFrame(this)
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
   * v0.16 #218.
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
   * v0.16 #218.
   */
  async consentAudit(filter: ConsentAuditFilter = {}): Promise<ConsentAuditEntry[]> {
    return loadConsentEntries(this.adapter, this.name, this.encrypted, this.getDEK, filter)
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
    await writeConsentEntry(
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

  // ─── Hierarchical access (v0.18 #205–#210) ─────────────────────────

  /**
   * Subscribe to cross-tier access events. The callback fires every
   * time a record at a tier above the caller's inherent clearance is
   * read, written, elevated, or demoted successfully via this vault.
   * Returns an unsubscribe function.
   */
  onCrossTierAccess(
    listener: (event: CrossTierAccessEvent) => void,
  ): () => void {
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
   * v0.18 #209 — issue a time-boxed cross-tier delegation. Writes an
   * encrypted envelope to the reserved `_delegations` collection that
   * the target user's runtime will pick up next time they open the
   * vault.
   *
   * Caller must hold the tier DEK for the requested tier and
   * collection.
   */
  async delegate(opts: IssueDelegationOptions): Promise<DelegationToken> {
    const { issueDelegation, DELEGATIONS_COLLECTION } = await import('./team/delegation.js')
    // The target user's KEK is derived from THEIR keyring — we read
    // the keyring file to pick up the wrapped DEKs and their KEK salt,
    // but we cannot derive their KEK from our side (we don't have
    // their passphrase). For v0.18 the delegation wraps against the
    // grantor's own KEK as a simpler first cut; swapping to a proper
    // per-target KEK exchange (via `on-magic-link` or OIDC) is a
    // v0.18.1 follow-up tracked in the design doc.
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
   * v0.18 #209 — revoke an issued delegation by id. Safe to call even
   * if the id does not exist.
   */
  async revokeDelegation(id: string): Promise<void> {
    const { revokeDelegation, DELEGATIONS_COLLECTION } = await import('./team/delegation.js')
    await revokeDelegation(this.adapter, this.name, id)
    // Trigger store to note the delete.
    void DELEGATIONS_COLLECTION
  }

  /**
   * v0.21 #257 — low-level escape hatch used by `@noy-db/on-magic-link`
   * to persist a magic-link-bound grant after the auth package has
   * derived the content key + KEK from `(serverSecret, token, vault)`.
   *
   * Callers outside of `@noy-db/on-magic-link` should use
   * `issueMagicLinkDelegation()` from that package instead — it handles
   * the HKDF derivation, record-id composition, and batch logic so the
   * grantor doesn't touch this method directly.
   */
  async writeMagicLinkGrant(
    contentKey: CryptoKey,
    grantKek: CryptoKey,
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

  // ─── Accounting periods (v0.17 #201 / #202) ────────────────────────

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
   * v0.17 #201.
   */
  async closePeriod(options: ClosePeriodOptions): Promise<PeriodRecord> {
    const existing = await this._loadPeriodsCache()
    validatePeriodName(options.name, existing)
    if (typeof options.endDate !== 'string' || options.endDate.length === 0) {
      throw new ValidationError('closePeriod: endDate must be a non-empty ISO string.')
    }
    const anchor = await chainAnchor(existing)
    const record: PeriodRecord = {
      name: options.name,
      kind: 'closed',
      endDate: options.endDate,
      closedAt: new Date().toISOString(),
      closedBy: this.keyring.userId,
      priorPeriodHash: anchor.priorPeriodHash,
      ...(anchor.priorPeriodName !== undefined && { priorPeriodName: anchor.priorPeriodName }),
      ...(options.dateField !== undefined && { dateField: options.dateField }),
    }
    const envelope = await this._writePeriodRecord(record)
    await appendPeriodLedgerEntry(this.ledger(), this.keyring.userId, envelope, record.name)
    existing.push(record)
    this.periodCache = existing
    return record
  }

  /**
   * Open a new period that carries forward from a prior closed one
   * (v0.17 #202). The `carryForward` callback receives a read-only
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
    const existing = await this._loadPeriodsCache()
    validatePeriodName(options.name, existing)
    const prior = existing.find((p) => p.name === options.fromPeriod)
    if (!prior) {
      throw new ValidationError(
        `openPeriod: fromPeriod "${options.fromPeriod}" does not exist in this vault.`,
      )
    }
    if (prior.kind !== 'closed') {
      throw new ValidationError(
        `openPeriod: fromPeriod "${options.fromPeriod}" is of kind "${prior.kind}" — only closed periods can be carried forward.`,
      )
    }

    // Build a read-only facade over CURRENT state + the prior
    // period's endDate; after close, records dated <= endDate are
    // frozen so current state equals closing state. The caller
    // filters by business date via their own query against this
    // facade.
    const ctx = {
      priorEndDate: prior.endDate,
      collection: <T = unknown>(name: string) => {
        const c = this.collection<T>(name)
        return {
          get: (id: string) => c.get(id),
          list: () => c.list(),
        }
      },
    }
    const openings = await options.carryForward(ctx)

    // Write opening entries via the normal Collection path so they
    // get encryption, ledger entries, and change events. Each record
    // is timestamped NOW (outside every closed period) — that's why
    // the guard permits them.
    const openingCollections: string[] = []
    for (const [collName, records] of Object.entries(openings)) {
      if (!records || typeof records !== 'object') continue
      const recordEntries = Object.entries(records)
      if (recordEntries.length === 0) continue
      const coll = this.collection(collName)
      for (const [id, record] of recordEntries) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await coll.put(id, record as any)
      }
      openingCollections.push(collName)
    }

    const anchor = await chainAnchor(existing)
    const record: PeriodRecord = {
      name: options.name,
      kind: 'opened',
      startDate: options.startDate,
      endDate: prior.endDate, // sealing boundary inherited from prior close
      closedAt: new Date().toISOString(),
      closedBy: this.keyring.userId,
      priorPeriodHash: anchor.priorPeriodHash,
      priorPeriodName: anchor.priorPeriodName ?? prior.name,
      ...(openingCollections.length > 0 && { openingCollections }),
    }
    const envelope = await this._writePeriodRecord(record)
    await appendPeriodLedgerEntry(this.ledger(), this.keyring.userId, envelope, record.name)
    existing.push(record)
    this.periodCache = existing
    return record
  }

  /** Return every closed / opened period in `closedAt` order. */
  async listPeriods(): Promise<readonly PeriodRecord[]> {
    return [...(await this._loadPeriodsCache())]
  }

  /** Look up a single period by name. Returns `null` if not found. */
  async getPeriod(name: string): Promise<PeriodRecord | null> {
    const all = await this._loadPeriodsCache()
    return all.find((p) => p.name === name) ?? null
  }

  /** @internal — periodGuard callback installed on every Collection. */
  async _assertTsWritable(
    existing: { ts: string | null; record: Record<string, unknown> | null } | null,
    incoming: Record<string, unknown> | null,
  ): Promise<void> {
    // Fast path: nothing to check, and no periods ever touched this
    // vault — avoid a full adapter scan for every put.
    if (existing === null && incoming === null) return
    if (this.periodCache === null) {
      this.periodCache = await loadPeriods(
        this.adapter,
        this.name,
        (env) => this._decryptPeriodRecord(env),
      )
    }
    if (this.periodCache.length === 0) return
    assertTsWritable(existing, incoming, this.periodCache)
  }

  private async _loadPeriodsCache(): Promise<PeriodRecord[]> {
    if (this.periodCache !== null) return this.periodCache
    this.periodCache = await loadPeriods(
      this.adapter,
      this.name,
      (env) => this._decryptPeriodRecord(env),
    )
    return this.periodCache
  }

  private async _writePeriodRecord(record: PeriodRecord): Promise<EncryptedEnvelope> {
    const json = JSON.stringify(record)
    let envelope: EncryptedEnvelope
    if (this.encrypted) {
      const dek = await this.getDEK(PERIODS_COLLECTION)
      const { iv, data } = await encrypt(json, dek)
      envelope = {
        _noydb: NOYDB_FORMAT_VERSION,
        _v: 1,
        _ts: new Date().toISOString(),
        _iv: iv,
        _data: data,
        _by: this.keyring.userId,
      }
    } else {
      envelope = {
        _noydb: NOYDB_FORMAT_VERSION,
        _v: 1,
        _ts: new Date().toISOString(),
        _iv: '',
        _data: json,
        _by: this.keyring.userId,
      }
    }
    await this.adapter.put(this.name, PERIODS_COLLECTION, record.name, envelope)
    return envelope
  }

  private async _decryptPeriodRecord(envelope: EncryptedEnvelope): Promise<PeriodRecord> {
    let json: string
    if (this.encrypted) {
      const dek = await this.getDEK(PERIODS_COLLECTION)
      json = await decrypt(envelope._iv, envelope._data, dek)
    } else {
      json = envelope._data
    }
    return JSON.parse(json) as PeriodRecord
  }

  /** List all collection names in this vault. */
  async collections(): Promise<string[]> {
    const snapshot = await this.adapter.loadAll(this.name)
    return Object.keys(snapshot)
  }

  /**
   * Return the stable opaque bundle handle for this vault,
   * generating and persisting a fresh ULID on first call.
   *
   * v0.6 #100 — used by `writeNoydbBundle()` to identify the
   * vault in the unencrypted bundle header without
   * exposing the vault name. The handle is persisted in
   * the reserved `_meta` internal collection so subsequent
   * exports of the same vault produce the same handle —
   * v0.11 bundle adapters (Drive, Dropbox, iCloud) will use it
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
    const { generateULID } = await import('./bundle/ulid.js')
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
   * Dump vault as a verifiable encrypted JSON backup string.
   *
   * v0.4 backups embed the current ledger head and the full
   * `_ledger` + `_ledger_deltas` internal collections so the
   * receiver can run `verifyBackupIntegrity()` after `load()` and
   * detect any tampering between dump and restore. Pre-v0.4 callers
   * who didn't have a ledger get a backup without these fields, and
   * the corresponding `load()` skips the integrity check with a
   * warning — both modes round-trip cleanly.
   */
  async dump(): Promise<string> {
    const snapshot = await this.adapter.loadAll(this.name)

    // Load keyrings (separate path because loadAll filters them out
    // along with all other underscore-prefixed internal collections).
    const keyringIds = await this.adapter.list(this.name, '_keyring')
    const keyrings: Record<string, unknown> = {}
    for (const keyringId of keyringIds) {
      const envelope = await this.adapter.get(this.name, '_keyring', keyringId)
      if (envelope) {
        keyrings[keyringId] = JSON.parse(envelope._data)
      }
    }

    // Load the ledger entries + deltas so the receiver can replay
    // the chain after restore. Without this, `load()` would have an
    // empty ledger and `verifyBackupIntegrity()` would have nothing
    // to compare against.
    const internalSnapshot: VaultSnapshot = {}
    for (const internalName of [LEDGER_COLLECTION, LEDGER_DELTAS_COLLECTION]) {
      const ids = await this.adapter.list(this.name, internalName)
      if (ids.length === 0) continue
      const records: Record<string, EncryptedEnvelope> = {}
      for (const id of ids) {
        const envelope = await this.adapter.get(this.name, internalName, id)
        if (envelope) records[id] = envelope
      }
      internalSnapshot[internalName] = records
    }

    // Embed the ledger head if there's a chain. An empty ledger
    // (fresh vault) leaves `ledgerHead` undefined, which
    // load() treats the same as a legacy backup (no integrity
    // check, console warning).
    const head = await this.ledger().head()
    const backup: VaultBackup = {
      _noydb_backup: NOYDB_BACKUP_VERSION,
      _compartment: this.name,
      _exported_at: new Date().toISOString(),
      _exported_by: this.keyring.userId,
      keyrings: keyrings as VaultBackup['keyrings'],
      collections: snapshot,
      ...(Object.keys(internalSnapshot).length > 0
        ? { _internal: internalSnapshot }
        : {}),
      ...(head
        ? {
            ledgerHead: {
              hash: head.hash,
              index: head.entry.index,
              ts: head.entry.ts,
            },
          }
        : {}),
    }

    return JSON.stringify(backup)
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
   * Pre-v0.4 backups (no `ledgerHead` field, no `_internal`) load
   * with a console warning and skip the integrity check entirely
   * — there's no chain to verify against.
   */
  async load(backupJson: string): Promise<void> {
    const backup = JSON.parse(backupJson) as VaultBackup

    // 1. Restore data collections.
    await this.adapter.saveAll(this.name, backup.collections)

    // 2. Restore keyrings (same as v0.3).
    for (const [userId, keyringFile] of Object.entries(backup.keyrings)) {
      const envelope = {
        _noydb: 1 as const,
        _v: 1,
        _ts: new Date().toISOString(),
        _iv: '',
        _data: JSON.stringify(keyringFile),
      }
      await this.adapter.put(this.name, '_keyring', userId, envelope)
    }

    // 3. Restore internal collections (`_ledger`, `_ledger_deltas`).
    //    Required so verifyBackupIntegrity has the chain to walk.
    if (backup._internal) {
      for (const [internalName, records] of Object.entries(backup._internal)) {
        for (const [id, envelope] of Object.entries(records)) {
          await this.adapter.put(this.name, internalName, id, envelope)
        }
      }
    }

    // 4. Refresh the in-memory keyring from the freshly-loaded
    //    keyring file. Without this, the Vault's getDEK
    //    closure still holds the OLD session's DEKs, and every
    //    decrypt of a loaded ledger entry / data envelope fails
    //    with TamperedError because the DEK doesn't match the
    //    ciphertext that was encrypted with the SOURCE user's DEK.
    //    Skipped for plaintext vaults and for tests that
    //    construct Vault without a reloadKeyring callback.
    if (this.reloadKeyring) {
      this.keyring = await this.reloadKeyring()
      // Rebuild the DEK resolver against the refreshed keyring so
      // the next ensureCollectionDEK call sees the loaded wrapped
      // DEKs, not the cached pre-load ones.
      this.getDEK = this.makeGetDEK()
    }

    // 5. Clear collection cache + reset the ledger store so the
    //    next ledger() call rebuilds its head cache from the
    //    freshly-loaded entries.
    this.collectionCache.clear()
    this.ledgerStore = null

    // 5. Run the verification gate. Pre-v0.4 backups skip this with
    //    a one-line warning so existing consumers can still read
    //    them while migrating.
    if (!backup.ledgerHead) {
      console.warn(
        `[noy-db] Loaded a legacy backup with no ledgerHead — ` +
        `verifiable-backup integrity check skipped. ` +
        `Re-export with v0.4+ to get tamper detection.`,
      )
      return
    }

    const result = await this.verifyBackupIntegrity()
    if (!result.ok) {
      // Surface the most specific error class we can. The result
      // shape carries enough info for callers to inspect.
      if (result.kind === 'data') {
        throw new BackupCorruptedError(
          result.collection,
          result.id,
          result.message,
        )
      }
      throw new BackupLedgerError(result.message, result.divergedAt)
    }

    // 6. Cross-check: the freshly-verified head must match the
    //    value embedded at dump time. A mismatch means someone
    //    truncated or extended the chain after dump.
    if (result.head !== backup.ledgerHead.hash) {
      throw new BackupLedgerError(
        `Backup ledger head mismatch: embedded "${backup.ledgerHead.hash}" ` +
        `but reconstructed "${result.head}".`,
      )
    }
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
  async verifyBackupIntegrity(): Promise<
    | { readonly ok: true; readonly head: string; readonly length: number }
    | {
        readonly ok: false
        readonly kind: 'chain'
        readonly divergedAt: number
        readonly message: string
      }
    | {
        readonly ok: false
        readonly kind: 'data'
        readonly collection: string
        readonly id: string
        readonly message: string
      }
  > {
    // Step 1: chain verification.
    const chainResult = await this.ledger().verify()
    if (!chainResult.ok) {
      return {
        ok: false,
        kind: 'chain',
        divergedAt: chainResult.divergedAt,
        message:
          `Ledger chain diverged at index ${chainResult.divergedAt}: ` +
          `expected prevHash "${chainResult.expected}" but found "${chainResult.actual}".`,
      }
    }

    // Step 2: data envelope cross-check. Walk every entry in the
    // ledger and, for the LATEST `put` per (collection, id), recompute
    // the data envelope's payloadHash and compare. Earlier puts of the
    // same id are skipped because the data collection only holds the
    // current version — historical envelopes live in the deltas
    // collection (which is itself protected by the chain).
    const ledger = this.ledger()
    const allEntries = await ledger.loadAllEntries()

    // Find the latest non-delete entry per (collection, id). Walk
    // the entries in reverse so we hit the latest first; mark each
    // (collection, id) as seen and skip subsequent entries.
    const seen = new Set<string>()
    const latest = new Map<
      string,
      { collection: string; id: string; expectedHash: string }
    >()
    for (let i = allEntries.length - 1; i >= 0; i--) {
      const entry = allEntries[i]
      if (!entry) continue
      const key = `${entry.collection}/${entry.id}`
      if (seen.has(key)) continue
      seen.add(key)
      // For deletes the data collection should NOT have the record,
      // so we skip — there's nothing to cross-check.
      if (entry.op === 'delete') continue
      latest.set(key, {
        collection: entry.collection,
        id: entry.id,
        expectedHash: entry.payloadHash,
      })
    }

    for (const { collection, id, expectedHash } of latest.values()) {
      const envelope = await this.adapter.get(this.name, collection, id)
      if (!envelope) {
        return {
          ok: false,
          kind: 'data',
          collection,
          id,
          message:
            `Ledger expects data record "${collection}/${id}" to exist, ` +
            `but the adapter has no envelope for it.`,
        }
      }
      const actualHash = await sha256Hex(envelope._data)
      if (actualHash !== expectedHash) {
        return {
          ok: false,
          kind: 'data',
          collection,
          id,
          message:
            `Data envelope "${collection}/${id}" has been tampered with: ` +
            `expected payloadHash "${expectedHash}", got "${actualHash}".`,
        }
      }
    }

    return {
      ok: true,
      head: chainResult.head,
      length: chainResult.length,
    }
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
   *   True per-record adapter streaming arrives with the v0.6 query DSL.
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
   * Once cross-vault queries land (#63), fanning this out across
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
          const head = await this.ledger().head()
          return head
            ? { hash: head.hash, index: head.entry.index, ts: head.entry.ts }
            : undefined
        })()
      : undefined

    // Capture ALL dictionary snapshots upfront before the first yield (v0.8 #84).
    // Building all snapshots eagerly before yielding anything ensures that
    // concurrent mutations during streaming do not affect the snapshot — any
    // dictionary.put() that happens after the first yield sees the pre-yield
    // state here. Keyed by collection name.
    const dictSnapshotCache = new Map<
      string, // collection name
      Record<string, Record<string, Record<string, string>>> // field → key → locale → label
    >()
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
          const record = await coll.get(id)
          if (record !== null) records.push(record)
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
          const record = await coll.get(id)
          if (record === null) continue
          const chunk: ExportChunk = {
            collection: collectionName,
            schema,
            refs,
            records: [record],
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
    // Force per-collection granularity regardless of caller setting:
    // record-by-record output doesn't make sense in a single string.
    const collections: Record<
      string,
      {
        schema: null
        refs: Record<string, { target: string; mode: 'strict' | 'warn' | 'cascade' }>
        records: unknown[]
      }
    > = {}
    let ledgerHead: ExportChunk['ledgerHead'] | undefined
    // Merged dictionary snapshot across all collections (v0.8 #84).
    // Only populated when `resolveLabels` is not set.
    const allDictionaries: Record<
      string, // collection name
      Record<string, Record<string, Record<string, string>>>
    > = {}

    for await (const chunk of this.exportStream({
      granularity: 'collection',
      withLedgerHead: opts.withLedgerHead === true,
    })) {
      collections[chunk.collection] = {
        schema: null, // Standard Schema validators are not JSON-serializable
        refs: chunk.refs,
        records: chunk.records,
      }
      if (chunk.ledgerHead) ledgerHead = chunk.ledgerHead
      // Collect dictionary snapshots unless resolveLabels is set
      if (!opts.resolveLabels && chunk.dictionaries) {
        allDictionaries[chunk.collection] = chunk.dictionaries
      }
    }

    const hasDictionaries = Object.keys(allDictionaries).length > 0
    return JSON.stringify({
      _noydb_export: 1,
      _compartment: this.name,
      _exported_at: new Date().toISOString(),
      _exported_by: this.keyring.userId,
      collections,
      ...(hasDictionaries ? { _dictionaries: allDictionaries } : {}),
      ...(ledgerHead ? { ledgerHead } : {}),
    })
  }
}
