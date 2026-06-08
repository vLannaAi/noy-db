import type {
  NoydbOptions,
  NoydbEventMap,
  GrantOptions,
  RevokeOptions,
  UpdateUserOptions,
  UserInfo,
  PushResult,
  PullResult,
  PushOptions,
  PullOptions,
  SyncStatus,
  SyncTarget,
  NoydbStore,
  Role,
  AccessibleVault,
  ListAccessibleVaultsOptions,
  QueryAcrossOptions,
  QueryAcrossResult,
  ReAuthOperation,
  TranslatorAuditEntry,
  WriteConflict,
} from './types.js'
import { ValidationError, NoAccessError, InvalidKeyError, KeyringCorruptError, StoreCapabilityError, PermissionDeniedError, VaultTemplateNotFoundError } from './errors.js'
import {
  readDirectoryConfig,
  persistDirectoryConfig,
} from './directory/storage.js'
import type { PassphrasePolicy } from './validation.js'
import {
  rotatePassphrase as keyringRotatePassphrase,
  recoverPassphrase as keyringRecoverPassphrase,
  type RotatePassphraseInput,
  type RecoverPassphraseInput,
  type RecoverPassphraseResult,
  type RotateRecoveryOptions,
  type RotateRecoveryResult,
  type EnrollRecoveryResult,
  type RecoveryEnrollmentInput,
  type RecoveryProof,
} from './team/rotate-recover.js'
import {
  recoverUser as keyringRecoverUser,
  type RecoverUserOptions,
} from './team/peer-recover.js'
import {
  loadPaperRecoveryEntries,
  savePaperRecoveryEntries,
  hasRecoveryEnrolled,
  hasStrongRecoveryEnrolled,
  mintPaperRecoveryEntry,
  type PaperRecoveryEntry,
  loadShamirRecoveryEntries,
  saveShamirRecoveryEntries,
  mintShamirRecoveryEntry,
  type ShamirRecoveryEntry,
} from './team/recovery.js'
import { resolveManagedSecret, saveSealedPassphrase } from './team/managed-passphrase.js'
import type { ShamirRecoveryProvider } from './team/shamir-recovery-provider.js'
import { generateULID } from './bundle/ulid.js'
import { RecoveryNotEnrolledError, RecoveryProfileNotImplementedError, ManagedRecoveryNotEnrolledError, PolicyDeniedError } from './policy/errors.js'
import {
  describeAuthConfig as fnDescribeAuthConfig,
  diagramAuthConfig as fnDiagramAuthConfig,
  describeUserAuth as fnDescribeUserAuth,
  describeAllUsersAuth as fnDescribeAllUsersAuth,
} from './auth-introspection/index.js'
import {
  loadPublicEnvelope,
  savePublicEnvelope,
  readPublicEnvelope as fnReadPublicEnvelope,
  resolveSchema as resolvePublicEnvelopeSchema,
  validatePublicEnvelopeInput,
  type PublicEnvelope,
  type SetPublicEnvelopeInput,
  type ResolvedPublicEnvelopeSchema,
} from './meta/public-envelope/index.js'
import { Vault } from './vault.js'
import { NoydbEventEmitter } from './events.js'
import { WriteQueueTracker, type WriteQueue } from './write-queue.js'
import { WriteHookRegistry, type WriteHook, type Unsubscribe } from './write-hooks.js'
import { SubsystemBus } from './subsystem-bus.js'
import { TabCoordinator, defaultLockManager, defaultChannel, type TabCoordinationOptions, type TabRole, type TabPresence } from './tab-coordination.js'
import { CrossTabWriteRelay } from './tab-write-relay.js'
import {
  loadKeyring,
  createOwnerKeyring,
  assertKeyringOpenAllowed,
  grant as keyringGrant,
  revoke as keyringRevoke,
  rotateKeys as keyringRotate,
  changeSecret as keyringChangeSecret,
  listUsers as keyringListUsers,
  updateKeyringIdentity,
} from './team/keyring.js'
import type { UnlockedKeyring } from './team/keyring.js'
import {
  enrollAuthenticator as keyringEnrollAuthenticator,
  removeAuthenticator as keyringRemoveAuthenticator,
  updateAuthenticator as keyringUpdateAuthenticator,
  findAuthenticator,
  type EnrollAuthenticatorOptions,
  type UpdateAuthenticatorOptions,
} from './team/authenticators.js'
import { QuickUnlockStore, type QuickUnlockState } from './session/unlock-state.js'
import type { KeyringAuthenticator } from './types.js'
import type { SyncEngine } from './team/sync.js'
import type { SyncTransaction } from './team/sync-transaction.js'
import { NO_SYNC, type SyncStrategy } from './team/sync-strategy.js'
import { NO_SNAPSHOTS, type SnapshotStrategy, type SnapshotMeta } from './snapshots/strategy.js'
import { SnapshotScheduler } from './snapshots/scheduler.js'
import type { AmendmentTxOptions } from './tx/transaction.js'
import { TxContext } from './tx/transaction.js'
import type { DryRunResult } from './tx/dry-run.js'
import { NO_TX, type TxStrategy } from './tx/strategy.js'
import { INDEXED_STORE_POLICY } from './store/sync-policy.js'
import type { PolicyEnforcer } from './session/session-policy.js'
import { NO_SESSION, type SessionStrategy } from './session/strategy.js'
import {
  checkGate as policyCheckGate,
  loadVaultPolicy,
  saveVaultPolicy,
  PERSONAL_POLICY,
  mergePolicy,
  type ActiveTier,
  type FactorProofBundle,
  type GateName,
  type VaultPolicy,
} from './policy/index.js'
import type { VaultGroup } from './federation/vault-group.js'
import type { VaultTemplate, VaultGroupOptions } from './federation/types.js'

/**
 * Privilege rank used by `listAccessibleVaults({ minRole })` to
 * filter the result. Higher number = more privileged. Owner is at the
 * top; client is at the bottom. Viewer outranks client because viewer
 * has read-all access while client has only explicit-collection read
 * — the ordering reflects "how much can this principal see," not
 * "how much can this principal modify."
 */
const ROLE_RANK: Record<Role, number> = {
  client: 1,
  viewer: 2,
  operator: 3,
  admin: 4,
  owner: 5,
}

/** Dummy keyring for unencrypted mode. */
function createPlaintextKeyring(userId: string): UnlockedKeyring {
  return {
    userId,
    displayName: userId,
    role: 'owner',
    permissions: {},
    deks: new Map(),
    kek: null,
    salt: new Uint8Array(0),
    authenticators: [],
  }
}

/** The top-level NOYDB instance. */
export class Noydb {
  private readonly options: NoydbOptions
  private readonly emitter = new NoydbEventEmitter()
  private readonly writeQueueTracker = new WriteQueueTracker()
  private readonly writeHooks = new WriteHookRegistry()
  private readonly subsystemBus = new SubsystemBus()
  private readonly clientId = generateULID()
  private readonly vaultCache = new Map<string, Vault>()
  private readonly keyringCache = new Map<string, UnlockedKeyring>()
  private readonly syncEngines = new Map<string, SyncEngine>()
  /**
   * Per-vault active session tier — defaults to `1` after a passphrase
   * unlock; tier-2 / tier-3 unlocks downgrade it. Used by
   * {@link checkGate} to evaluate `gate.minTier`.
   */
  private readonly activeTier = new Map<string, ActiveTier>()
  /**
   * Per-vault loaded policy. Cached after the first
   * `_meta/policy` load; replaced by `db.updatePolicy()`.
   */
  private readonly policyCache = new Map<string, VaultPolicy>()
  /**
   * One-shot bypass for the managed-mode strong-recovery check.
   * Set true by {@link openVaultAndEnrollRecovery} for the duration of
   * the bootstrap window so the keyring can be created before the
   * strong recovery is enrolled. Always cleared (try/finally).
   * @internal
   */
  private _skipNextManagedRecoveryCheck = false
  /** Per-vault tier-3 (PIN / quick-resume) state. */
  private readonly quickUnlock = new QuickUnlockStore()
  /**
   * Resolved public-envelope schema. Lazily computed once from
   * `NoydbOptions.publicEnvelope`; `undefined` when the developer
   * didn't opt in.
   */
  private readonly publicEnvelopeSchema: ResolvedPublicEnvelopeSchema | undefined
  private closed = false
  private sessionTimer: ReturnType<typeof setTimeout> | null = null
  /** Same-device multi-tab coordinator; created on `enableTabCoordination()`. */
  private tabCoordinator: TabCoordinator | undefined
  /** Cross-tab write relay; created on `enableTabCoordination()`. */
  private writeRelay: CrossTabWriteRelay | undefined
  /** Per-vault policy enforcers. */
  private readonly policyEnforcers = new Map<string, PolicyEnforcer>()
  private readonly vaultTemplates = new Map<string, VaultTemplate>()
  private readonly txStrategy: TxStrategy
  private readonly sessionStrategy: SessionStrategy
  private readonly syncStrategy: SyncStrategy
  private readonly snapshotStrategy: SnapshotStrategy
  private snapshotScheduler: SnapshotScheduler | null = null
  private readonly dirtySnapshotVaults = new Set<string>()
  /**
   * Currently-running multi-record transaction, set by
   * `runTransaction` at the start of Phase 2 (commit) and cleared in
   * the same function's `finally` block. Side-effect writes triggered
   * during a staged op's `Collection.put` (today: eager derivation
   * outputs) register their pre-write envelope on `_executed` here so
   * a mid-batch failure rolls them back alongside the main staged ops.
   * `null` outside of Phase 2.
   * @internal
   */
  private _activeTxContext: TxContext | null = null

  // ─── plaintextTranslator state ─────────────────────────
  /**
   * In-process translation cache. Key is `"${field}\x00${collection}\x00${from}\x00${to}\x00${text}"`.
   * Cleared on `close()` alongside the KEK and DEKs.
   */
  private readonly translatorCache = new Map<string, string>()
  /** Audit log for all translator invocations in this session. Cleared on `close()`. */
  private readonly _translatorAuditLog: TranslatorAuditEntry[] = []

  constructor(options: NoydbOptions) {
    this.options = options
    this.txStrategy = options.txStrategy ?? NO_TX
    this.sessionStrategy = options.sessionStrategy ?? NO_SESSION
    this.syncStrategy = options.syncStrategy ?? NO_SYNC
    this.snapshotStrategy = options.snapshotStrategy ?? NO_SNAPSHOTS
    this.initSnapshotCadence()
    this.publicEnvelopeSchema = resolvePublicEnvelopeSchema(options.publicEnvelope)
    // Validate sessionPolicy at construction time (developer error if invalid).
    // The strategy's stub throws with a pointer at the subpath if the
    // consumer set a policy without opting in.
    if (options.sessionPolicy) {
      this.sessionStrategy.validateSessionPolicy(options.sessionPolicy)
    }
    this.#registerGuardGate()
    this.#registerPeriodGate()
    this.resetSessionTimer()
  }

  // Track A — guards migration. Registers record-lock / field-freeze / onDelete
  // / amendment-collect as gate-bus handlers (only when guards are opted in, so
  // the write path is zero-cost otherwise). Resolves the live vault's
  // GuardRegistry per dispatch. Registered BEFORE the period gate so guard
  // checks run first. The amendment branch is a side-effect (collectChange),
  // NOT a throw — and runs even for internal deletes (an amendment invariant
  // must see system housekeeping tombstones); onDelete/checks run only for
  // user (non-internal) operations.
  #registerGuardGate(): void {
    if (this.options.guardStrategies === undefined) return
    this.subsystemBus.registerGate('beforePut', async (e) => {
      const v = this.vaultCache.get(e.vault)
      if (!v) return
      const registry = v._getGuardRegistry()
      if (!registry) return
      const guards = registry.guardsFor(e.collection)
      if (guards.length === 0) return
      const existing = (e.existing ?? null) as Record<string, unknown> | null
      const incoming = e.incoming as Record<string, unknown>
      if (registry.isAmendmentActive()) {
        registry.collectChange(e.collection, e.docId, existing, incoming, e.existingVersion, e.existingVersion + 1)
        return
      }
      const facade = v._getReadOnlyFacade()
      if (!facade) return
      const ctx = { existing, vault: facade, userId: e.userId, role: e.role }
      await registry.runChecks(e.collection, incoming, ctx)
      const { GuardExecutor } = await import('./guards/executor.js')
      for (const g of guards) {
        await GuardExecutor.checkFrozenFields(g, e.docId, existing, incoming, e.computedFieldNames)
      }
    })
    this.subsystemBus.registerGate('beforeDelete', async (e) => {
      const v = this.vaultCache.get(e.vault)
      if (!v) return
      const registry = v._getGuardRegistry()
      if (!registry) return
      const guards = registry.guardsFor(e.collection)
      if (guards.length === 0) return
      const existing = (e.existing ?? null) as Record<string, unknown> | null
      if (registry.isAmendmentActive()) {
        registry.collectChange(e.collection, e.docId, existing, null as unknown as Record<string, unknown>, e.existingVersion, e.existingVersion)
        return
      }
      if (e.internal) return
      const facade = v._getReadOnlyFacade()
      if (!facade) return
      const ctx = { existing, vault: facade, userId: e.userId, role: e.role }
      await registry.runOnDelete(e.collection, existing ?? {}, ctx)
    })
  }

  /**
   * Register closed-period write guards on the subsystem bus when a
   * periodsStrategy is configured.  Handlers resolve the live Vault from
   * vaultCache so they always use the up-to-date period cache.
   */
  // Track A — periods migration. Registers the closed-period write guard as a
  // gate-bus handler (only when periods is opted in, so the write path is
  // zero-cost otherwise). Each handler resolves the LIVE vault from the cache
  // per dispatch and delegates to its `_assertTsWritable`, which owns all
  // period logic. Resolving the live vault makes eviction/re-creation
  // transparent. Semantics note: if a write reaches the gate through a retained
  // collection handle whose vault has been evicted from `vaultCache` (e.g. a
  // post-revocation write on a stale handle), the period check is skipped — the
  // guard binds to the live vault, not a captured instance. Periods is a
  // write-integrity guard, not a security boundary, and a re-open reloads the
  // period cache; the trade-off is intentional.
  #registerPeriodGate(): void {
    if (this.options.periodsStrategy === undefined) return
    this.subsystemBus.registerGate('beforePut', async (e) => {
      const v = this.vaultCache.get(e.vault)
      if (!v) return
      const existing = e.op === 'create'
        ? null
        : { ts: e.existingTs ?? null, record: (e.existing ?? null) as Record<string, unknown> | null }
      await v._assertTsWritable(existing, e.incoming as Record<string, unknown>)
    })
    this.subsystemBus.registerGate('beforeDelete', async (e) => {
      if (e.internal) return
      const v = this.vaultCache.get(e.vault)
      if (!v) return
      await v._assertTsWritable(
        { ts: e.existingTs ?? null, record: (e.existing ?? null) as Record<string, unknown> | null },
        null,
      )
    })
  }

  private resetSessionTimer(): void {
    if (this.sessionTimer) clearTimeout(this.sessionTimer)
    // Honor the new sessionPolicy.idleTimeoutMs if present, fall back to
    // the legacy sessionTimeout for backwards compatibility.
    const idleMs = this.options.sessionPolicy?.idleTimeoutMs ?? this.options.sessionTimeout
    if (idleMs && idleMs > 0) {
      this.sessionTimer = setTimeout(() => {
        this.close()
      }, idleMs)
    }
  }

  /**
   * Attach a policy enforcer for a vault.
   * Called internally when a session is started for a vault; the
   * enforcer handles idle/absolute timeouts and background-lock behavior.
   */
  private attachPolicyEnforcer(vault: string, sessionId: string): void {
    const policy = this.options.sessionPolicy
    if (!policy) return

    // Tear down any previous enforcer for this vault
    this.policyEnforcers.get(vault)?.destroy()

    const enforcer = this.sessionStrategy.createEnforcer({
      policy,
      sessionId,
      onRevoke: (_reason) => {
        this.keyringCache.delete(vault)
        this.vaultCache.delete(vault)
        this.policyEnforcers.delete(vault)
      },
    })
    this.policyEnforcers.set(vault, enforcer)
  }

  /**
   * Touch the policy enforcer for a vault (records activity, resets
   * idle timer). Also touches the legacy session timer. No-op if no enforcer.
   */
  private touchPolicy(vault?: string): void {
    this.resetSessionTimer()
    if (vault) {
      this.policyEnforcers.get(vault)?.touch()
    }
  }

  /**
   * Check that a policy-guarded operation is permitted.
   * Throws `SessionPolicyError` if re-auth is required.
   */
  private checkPolicyOperation(vault: string, op: ReAuthOperation): void {
    this.policyEnforcers.get(vault)?.checkOperation(op)
  }

  /**
   * Open a vault by name.
   *
   * @param name    Vault identifier.
   * @param opts    Optional settings for this session.
   * @param opts.locale  Default locale for i18n/dictKey field resolution
   *. Set here to avoid passing `{ locale }`
   *                     on every individual `get()`/`list()` call.
   */
  async openVault(
    name: string,
    opts?: { locale?: string; create?: boolean },
  ): Promise<Vault> {
    if (this.closed) throw new ValidationError('Instance is closed')
    this.touchPolicy(name)

    let comp = this.vaultCache.get(name)
    if (comp) {
      // Update locale on existing cached vault if specified
      if (opts?.locale !== undefined) {
        comp.setLocale(opts.locale)
      }
      return comp
    }

    const keyring = await this.getKeyringInternal(name, { create: opts?.create !== false })
    // Tier-1 unlock — passphrase / getKeyring callbacks both yield the
    // most-privileged tier. Tier-2 / tier-3 unlocks install
    // a lower tier here when they land.
    if (!this.activeTier.has(name)) {
      this.activeTier.set(name, 1)
    }
    // Load + persist the policy document. First call: persist the
    // developer-supplied policy (or default preset). Later calls: read
    // whatever's on disk and merge any developer override on top.
    if (this.options.encrypt !== false && !this.policyCache.has(name)) {
      await this.bootstrapPolicy(name)
    }

    // Set up sync engine(s) — handles bare NoydbStore, SyncTarget, or SyncTarget[]
    let syncEngine: SyncEngine | undefined
    const targets = normalizeSyncTargets(this.options.sync)
    if (targets.length > 0) {
      // Primary sync engine is the first sync-peer (or first target if none)
      const primary = targets.find(t => t.role === 'sync-peer') ?? targets[0]!
      const effectivePolicy = this.options.syncPolicy ?? primary.policy ?? INDEXED_STORE_POLICY
      syncEngine = this.syncStrategy.buildSyncEngine({
        local: this.options.store,
        remote: primary.store,
        vault: name,
        strategy: this.options.conflict ?? 'version',
        emitter: this.emitter,
        syncPolicy: effectivePolicy,
        role: primary.role,
        ...(primary.label !== undefined ? { label: primary.label } : {}),
      })
      this.syncEngines.set(name, syncEngine)

      // Additional targets get their own engines (backup/archive are push-only)
      for (const target of targets) {
        if (target === primary) continue
        const targetPolicy = target.policy ?? this.options.syncPolicy ?? INDEXED_STORE_POLICY
        const engine = this.syncStrategy.buildSyncEngine({
          local: this.options.store,
          remote: target.store,
          vault: name,
          strategy: this.options.conflict ?? 'version',
          emitter: this.emitter,
          syncPolicy: targetPolicy,
          role: target.role,
          ...(target.label !== undefined ? { label: target.label } : {}),
        })
        const key = `${name}::${target.label ?? target.role}`
        this.syncEngines.set(key, engine)
      }
    }

    comp = new Vault({
      adapter: this.options.store,
      name,
      noydb: this,
      keyring,
      encrypted: this.options.encrypt !== false,
      emitter: this.emitter,
      onDirty: targets.length > 0
        ? async (coll, id, action, version) => {
            // Fan out dirty tracking to all sync engines for this vault
            for (const [key, engine] of this.syncEngines) {
              if (key === name || key.startsWith(`${name}::`)) {
                void engine.trackChange(coll, id, action, version)
              }
            }
          }
        : undefined,
      onRegisterConflictResolver: syncEngine
        ? (resolverName, resolver) => syncEngine.registerConflictResolver(resolverName, resolver)
        : undefined,
      syncAdapter: targets.length > 0 ? targets[0]!.store : undefined,
      historyConfig: this.options.history,
      ...(this.options.blobStrategy !== undefined ? { blobStrategy: this.options.blobStrategy } : {}),
      ...(this.options.archiveStrategy !== undefined ? { archiveStrategy: this.options.archiveStrategy } : {}),
      ...(this.options.indexStrategy !== undefined ? { indexStrategy: this.options.indexStrategy } : {}),
      ...(this.options.aggregateStrategy !== undefined ? { aggregateStrategy: this.options.aggregateStrategy } : {}),
      ...(this.options.crdtStrategy !== undefined ? { crdtStrategy: this.options.crdtStrategy } : {}),
      ...(this.options.consentStrategy !== undefined ? { consentStrategy: this.options.consentStrategy } : {}),
      ...(this.options.periodsStrategy !== undefined ? { periodsStrategy: this.options.periodsStrategy } : {}),
      ...(this.options.shadowStrategy !== undefined ? { shadowStrategy: this.options.shadowStrategy } : {}),
      ...(this.options.historyStrategy !== undefined ? { historyStrategy: this.options.historyStrategy } : {}),
      ...(this.options.i18nStrategy !== undefined ? { i18nStrategy: this.options.i18nStrategy } : {}),
      ...(this.options.syncStrategy !== undefined ? { syncStrategy: this.options.syncStrategy } : {}),
      ...(this.options.guardStrategies !== undefined ? { guardStrategies: this.options.guardStrategies } : {}),
      ...(this.options.numbering !== undefined ? { numberingConfigs: this.options.numbering } : {}),
      locale: opts?.locale,
      // Thread the translator hook so Collection.put() can invoke it
      plaintextTranslator: this.options.plaintextTranslator
        ? (text, from, to, field, collection) =>
            this.invokeTranslator(text, from, to, field, collection)
        : undefined,
      // Refresh callback used by Vault.load() to re-derive
      // the in-memory keyring from a freshly-loaded keyring file.
      // Encrypted compartments need this so post-load decrypts work
      // against the loaded session's wrapped DEKs; plaintext
      // compartments leave it null and load() skips the refresh.
      reloadKeyring:
        this.options.encrypt !== false && this.options.secret
          ? async () => {
              // Drop the cached keyring so the next loadKeyring
              // call reads fresh from the adapter, then update the
              // cache so subsequent openVault calls see the
              // refreshed keyring too.
              this.keyringCache.delete(name)
              const refreshed = await loadKeyring(
                this.options.store,
                name,
                this.options.user,
                this.options.secret as string,
              )
              this.keyringCache.set(name, refreshed)
              return refreshed
            }
          : undefined,
    })
    // Initialise the optional guard + derivation registries via
    // dynamic-import. Both calls are no-ops when the corresponding
    // strategies array is empty / unset, leaving the subsystem code
    // out of the floor bundle for consumers that don't use it.
    await comp._initGuards(this.options.guardStrategies ?? [])
    await comp._initDerivations(this.options.derivationStrategies ?? [])
    await comp._initMaterializedViews(this.options.materializedViewStrategies ?? [])
    await comp._initOverlayedViews(this.options.overlayedViewStrategies ?? [])
    // Snapshot the schema-fence generation once per opened vault.
    await comp.schemaFence.init()
    this.vaultCache.set(name, comp)
    return comp
  }

  /** Synchronous vault access (must call openVault first, or auto-opens). */
  vault(name: string): Vault {
    const cached = this.vaultCache.get(name)
    if (cached) return cached

    // For backwards compat: if not opened yet, create with cached keyring or plaintext
    if (this.options.encrypt === false) {
      const keyring = createPlaintextKeyring(this.options.user)
      const comp = new Vault({
        adapter: this.options.store,
        name,
        noydb: this,
        keyring,
        encrypted: false,
        emitter: this.emitter,
        historyConfig: this.options.history,
      ...(this.options.blobStrategy !== undefined ? { blobStrategy: this.options.blobStrategy } : {}),
      ...(this.options.archiveStrategy !== undefined ? { archiveStrategy: this.options.archiveStrategy } : {}),
      ...(this.options.indexStrategy !== undefined ? { indexStrategy: this.options.indexStrategy } : {}),
      ...(this.options.aggregateStrategy !== undefined ? { aggregateStrategy: this.options.aggregateStrategy } : {}),
      ...(this.options.crdtStrategy !== undefined ? { crdtStrategy: this.options.crdtStrategy } : {}),
      ...(this.options.consentStrategy !== undefined ? { consentStrategy: this.options.consentStrategy } : {}),
      ...(this.options.periodsStrategy !== undefined ? { periodsStrategy: this.options.periodsStrategy } : {}),
      ...(this.options.shadowStrategy !== undefined ? { shadowStrategy: this.options.shadowStrategy } : {}),
      ...(this.options.historyStrategy !== undefined ? { historyStrategy: this.options.historyStrategy } : {}),
      ...(this.options.i18nStrategy !== undefined ? { i18nStrategy: this.options.i18nStrategy } : {}),
      ...(this.options.syncStrategy !== undefined ? { syncStrategy: this.options.syncStrategy } : {}),
      ...(this.options.guardStrategies !== undefined ? { guardStrategies: this.options.guardStrategies } : {}),
      ...(this.options.numbering !== undefined ? { numberingConfigs: this.options.numbering } : {}),
      })
      this.vaultCache.set(name, comp)
      return comp
    }

    const keyring = this.keyringCache.get(name)
    if (!keyring) {
      throw new ValidationError(
        `Vault "${name}" not opened. Use await db.openVault("${name}") first.`,
      )
    }

    const comp = new Vault({
      adapter: this.options.store,
      name,
      noydb: this,
      keyring,
      encrypted: true,
      historyConfig: this.options.history,
      ...(this.options.blobStrategy !== undefined ? { blobStrategy: this.options.blobStrategy } : {}),
      ...(this.options.archiveStrategy !== undefined ? { archiveStrategy: this.options.archiveStrategy } : {}),
      ...(this.options.indexStrategy !== undefined ? { indexStrategy: this.options.indexStrategy } : {}),
      ...(this.options.aggregateStrategy !== undefined ? { aggregateStrategy: this.options.aggregateStrategy } : {}),
      ...(this.options.crdtStrategy !== undefined ? { crdtStrategy: this.options.crdtStrategy } : {}),
      ...(this.options.consentStrategy !== undefined ? { consentStrategy: this.options.consentStrategy } : {}),
      ...(this.options.periodsStrategy !== undefined ? { periodsStrategy: this.options.periodsStrategy } : {}),
      ...(this.options.shadowStrategy !== undefined ? { shadowStrategy: this.options.shadowStrategy } : {}),
      ...(this.options.historyStrategy !== undefined ? { historyStrategy: this.options.historyStrategy } : {}),
      ...(this.options.i18nStrategy !== undefined ? { i18nStrategy: this.options.i18nStrategy } : {}),
      ...(this.options.syncStrategy !== undefined ? { syncStrategy: this.options.syncStrategy } : {}),
      ...(this.options.guardStrategies !== undefined ? { guardStrategies: this.options.guardStrategies } : {}),
      ...(this.options.numbering !== undefined ? { numberingConfigs: this.options.numbering } : {}),
      emitter: this.emitter,
    })
    this.vaultCache.set(name, comp)
    return comp
  }

  /**
   * Grant access to a user for a vault.
   *
   * Gated by `enroll-user`. `STRICT_POLICY` requires a TOTP / email-OTP
   * factor proof so the operator affirmatively re-asserts identity at
   * the moment of grant; `PERSONAL_POLICY` accepts a tier-1 unlock alone.
   *
   * The legacy `requireReAuthFor: ['grant']` session-policy check still
   * fires on top — both are independent opt-ins.
   */
  async grant(
    vault: string,
    options: GrantOptions,
    factors?: FactorProofBundle,
  ): Promise<void> {
    this.checkPolicyOperation(vault, 'grant')
    await this.checkGate(vault, 'enroll-user', factors)
    const keyring = await this.getKeyringInternal(vault)
    await keyringGrant(this.options.store, vault, keyring, options)
  }

  /**
   * Revoke a user's access to a vault.
   *
   * Gated by `revoke-user`. `STRICT_POLICY` requires a TOTP / email-OTP
   * factor proof; `PERSONAL_POLICY` accepts a tier-1 unlock alone.
   *
   * The legacy `requireReAuthFor: ['revoke']` session-policy check still
   * fires on top — both are independent opt-ins.
   */
  async revoke(
    vault: string,
    options: RevokeOptions,
    factors?: FactorProofBundle,
  ): Promise<void> {
    this.checkPolicyOperation(vault, 'revoke')
    await this.checkGate(vault, 'revoke-user', factors)
    const keyring = await this.getKeyringInternal(vault)
    await keyringRevoke(this.options.store, vault, keyring, options)
  }

  /**
   * Mutate post-grant identity fields on an existing keyring — `role`,
   * `displayName`, and/or `permissions`. Pure plaintext-header rewrite:
   * no DEK rewrap, no KEK required, no authenticator slots touched.
   * Tier-2 enrollments and recovery codes survive.
   *
   * Different from `db.revoke + db.grant`:
   *
   *   - Same `userId`, same DEK wrappings, same `granted_by`, same
   *     `_users/<keyringId>` envelope. Only the specified header
   *     fields move. Last-write-wins via the standard keyring put.
   *   - No cascade on role demotion (admins demoted to operator keep
   *     the keyrings they previously granted; the cascade rules are
   *     a `db.revoke` concern, not `db.updateUser`).
   *   - Tier-2 slots NOT dropped — the wrapping is unaffected.
   *
   * Role-elevation guard: BOTH the old and new role must satisfy
   * `db.grant`'s hierarchy. Owner can do anything; admin manages
   * admin/operator/viewer/client laterally; admin cannot promote to
   * owner OR demote from owner. The guard runs regardless of the
   * `update-user` policy gate's settings — gates can only be more
   * permissive than the structural floor, never less.
   *
   * Gated by `update-user`. `STRICT_POLICY` requires a TOTP/email-OTP
   * factor proof so the operator affirmatively re-asserts identity at
   * the moment of mutation; `PERSONAL_POLICY` accepts a tier-1 unlock
   * alone.
   *
   * ```ts
   * await db.updateUser('acme', {
   *   userId: 'bob',
   *   role: 'operator',                 // promote
   *   permissions: { invoices: 'rw' },
   * }, { factors: [{ kind: 'totp' }] })
   * ```
   *
   * @throws `NoAccessError` when no keyring exists for the target.
   * @throws `PermissionDeniedError` when the role hierarchy rejects.
   * @throws `ValidationError` when no field is provided.
   */
  async updateUser(
    vault: string,
    options: UpdateUserOptions,
    factors?: FactorProofBundle,
  ): Promise<void> {
    await this.checkGate(vault, 'update-user', factors)
    const keyring = await this.getKeyringInternal(vault)
    await updateKeyringIdentity(this.options.store, vault, keyring, options)
    // If the caller updated their own role / permissions, the cached
    // unlocked keyring is stale — drop it so the next access reloads
    // with the new header fields. (DEKs unchanged, so the cached
    // unlock still works; only the role-gated checks would diverge.)
    if (options.userId === this.options.user) {
      this.keyringCache.delete(vault)
    }
  }

  /**
   * Rotate the DEKs for the given collections in a vault.
   *
   * Generates fresh DEKs, re-encrypts every record in each collection,
   * and re-wraps the new DEKs into every remaining user's keyring. The
   * old DEKs become unreachable — useful as a defense-in-depth measure
   * after a suspected key leak, or as the scheduled half of a
   * key-rotation policy.
   *
   * Unlike `revoke({ rotateKeys: true })`, this call does NOT remove
   * any users — every current member keeps access, but with fresh
   * keys. This is the "just rotate" path; the "revoke and rotate"
   * path still lives in `revoke()`.
   *
   * Exposed on Noydb (rather than only on the lower-level keyring
   * module) so CLI and admin tooling can trigger rotation without
   * reaching into internals. See `noy-db rotate` for the CLI wrapper.
   */
  async rotate(vault: string, collections: string[]): Promise<void> {
    this.checkPolicyOperation(vault, 'rotate')
    const keyring = await this.getKeyringInternal(vault)
    await keyringRotate(this.options.store, vault, keyring, collections)
    // Refresh the cached keyring so subsequent operations see the
    // freshly-rotated DEKs. Without this, `ensureCollectionDEK` on
    // the next Collection access would still hold the old ones.
    this.keyringCache.set(vault, keyring)
  }

  /** List all users with access to a vault. */
  async listUsers(vault: string): Promise<UserInfo[]> {
    return keyringListUsers(this.options.store, vault)
  }

  // ─── Cross-vault queries ──────────────────────

  /**
   * Enumerate every vault the calling principal can unwrap,
   * optionally filtered by minimum role.
   *
   * The walk is a two-step pipeline: first ask the adapter for the
   * universe of compartments it stores, then for each one attempt to
   * load the calling user's keyring with the in-memory passphrase.
   * Compartments where the user has no keyring file (`NoAccessError`)
   * or where the passphrase doesn't unwrap (`InvalidKeyError`) are
   * silently dropped from the result — the existence of those
   * compartments is **not** confirmed in the return value.
   *
   * Requires the optional `NoydbStore.listVaults()` capability.
   * Throws `StoreCapabilityError` against stores that don't
   * implement it (today: store-aws-dynamo, store-aws-s3, store-browser-local, store-browser-idb). For those backends the
   * consumer should either pass an explicit candidate list to
   * `queryAcross()` directly, or maintain a vault index out of
   * band.
   *
   * **Privacy note.** This method's return value never reveals the
   * existence of a vault the caller cannot unwrap. The adapter
   * sees the enumeration call (it has to — it owns the storage), but
   * downstream consumers of `listAccessibleVaults()` only see
   * the filtered list. That's the boundary the existence-leak
   * guarantee draws.
   *
   * **Known edge case.** A vault whose keyring file
   * happens to have an empty wrapped-DEKs map (because the owner
   * granted access before any collection was created) will pass the
   * `loadKeyring` probe with *any* passphrase — there are no DEKs to
   * unwrap, so the integrity-checked unwrap that normally rejects
   * wrong passphrases never runs. The result is that an unrelated
   * principal who happens to know the user-id and the vault
   * name can show up in `listAccessibleVaults()` as having
   * access to that empty vault. They cannot read any actual
   * data (their DEK set is empty), so this is a metadata leak
   * (vault name + user-id), not a content leak. Hardening this
   * via a passphrase canary in the keyring file is a deferred
   * follow-up.
   *
   * **Cost.** O(compartments × keyring-load) — one `loadKeyring`
   * attempt per vault in the universe. Each attempt does one
   * adapter `get` + one PBKDF2 derivation + N AES-KW unwraps. For
   * dozens of compartments this is fine; for thousands the consumer
   * should cache the result and refresh on grant/revoke events. A
   * future optimization could batch the keyring reads via
   * `loadAll('_keyring')` if such a thing existed at the adapter
   * layer, but the contract doesn't expose that.
   *
   * @example
   * ```ts
   * // All compartments I can unwrap
   * const all = await db.listAccessibleVaults()
   *
   * // Only compartments where I'm at least admin
   * const admin = await db.listAccessibleVaults({ minRole: 'admin' })
   *
   * // Only compartments I own
   * const owned = await db.listAccessibleVaults({ minRole: 'owner' })
   * ```
   */
  async listAccessibleVaults(
    options: ListAccessibleVaultsOptions = {},
  ): Promise<AccessibleVault[]> {
    if (this.closed) throw new ValidationError('Instance is closed')
    this.resetSessionTimer()

    const adapter = this.options.store
    if (typeof adapter.listVaults !== 'function') {
      throw new StoreCapabilityError(
        'listVaults',
        'Noydb.listAccessibleVaults()',
        adapter.name,
      )
    }

    if (this.options.encrypt === false) {
      // Plaintext mode: no keyrings exist; every vault the
      // adapter knows about is "accessible" trivially as owner.
      const all = await adapter.listVaults()
      return all.map((id) => ({ id, role: 'owner' as Role }))
    }

    if (!this.options.secret) {
      throw new ValidationError(
        'Noydb.listAccessibleVaults(): a secret (passphrase) is required ' +
          'when encryption is enabled.',
      )
    }

    const minRank = ROLE_RANK[options.minRole ?? 'client']
    const universe = await adapter.listVaults()
    const accessible: AccessibleVault[] = []

    for (const vault of universe) {
      // Probe with loadKeyring directly (NOT getKeyring, which would
      // auto-create a fresh owner keyring on miss — that would
      // silently grant access to every empty vault in the
      // universe and is exactly the wrong shape for an enumeration
      // API). The two expected failure modes — no keyring file, or
      // wrong passphrase — are caught and silently dropped so the
      // return value never leaks existence.
      let keyring: UnlockedKeyring
      try {
        keyring = await loadKeyring(
          adapter,
          vault,
          this.options.user,
          this.options.secret,
        )
      } catch (err) {
        if (
          err instanceof NoAccessError ||
          err instanceof InvalidKeyError ||
          err instanceof KeyringCorruptError
        ) {
          // No accessible key material for this vault. KeyringCorruptError
          // is included so a single partially-corrupted vault does NOT
          // poison the enumeration of every other healthy vault — the
          // caller can probe a corrupted vault directly via openVault()
          // / loadKeyring() if they want to act on it.
          continue
        }
        throw err // unexpected error — surface it
      }

      if (ROLE_RANK[keyring.role] < minRank) continue
      accessible.push({ id: vault, role: keyring.role })

      // Opportunistically prime the keyring cache so a subsequent
      // openVault() doesn't have to re-derive the KEK. The cost
      // is one Map.set per vault we already paid to unwrap.
      this.keyringCache.set(vault, keyring)
    }

    return accessible
  }

  /**
   * Run a per-vault callback against a list of compartments and
   * collect the results.
   *
   * Pure orchestration — there is no new crypto, no new sync, no new
   * authorization layer. Each vault is opened via the existing
   * `openVault()` path (which honors the cache primed by
   * `listAccessibleVaults`), the callback runs against the
   * resulting `Vault` instance, and the result (or thrown
   * error) is captured into the per-vault slot.
   *
   * **Per-vault errors do not abort the fan-out.** If one
   * vault's callback throws, that vault's slot carries
   * the error and the remaining compartments still run. The caller
   * decides how to handle the partition between success and failure.
   * This is the right shape for cross-tenant reports where one
   * tenant's outage shouldn't hide the other tenants' data.
   *
   * **Concurrency** is opt-in via `options.concurrency`. The default
   * is `1` (sequential) — conservative because per-vault
   * callbacks typically do their own I/O and an unbounded fan-out
   * can exhaust adapter connections (DynamoDB throughput, S3 socket
   * limits, browser fetch concurrency). Bump to 4-8 for cloud-backed
   * adapters where parallelism is the whole point.
   *
   * @example
   * ```ts
   * // Cross-tenant invoice totals as a flat list
   * const accessible = await db.listAccessibleVaults({ minRole: 'admin' })
   * const results = await db.queryAcross(
   *   accessible.map((c) => c.id),
   *   async (comp) => {
   *     return comp.collection<Invoice>('invoices').query()
   *       .where('month', '==', '2026-03')
   *       .toArray()
   *   },
   *   { concurrency: 4 },
   * )
   * // results: Array<{ vault, result?: Invoice[], error?: Error }>
   *
   * // Compose with exportStream() — cross-vault plaintext export
   * const exports = await db.queryAcross(accessible.map((c) => c.id), async (comp) => {
   *   const out: unknown[] = []
   *   for await (const chunk of comp.exportStream()) out.push(chunk)
   *   return out
   * })
   * ```
   */
  async queryAcross<T>(
    vaultIds: string[],
    fn: (vault: Vault) => Promise<T>,
    options: QueryAcrossOptions = {},
  ): Promise<QueryAcrossResult<T>[]> {
    if (this.closed) throw new ValidationError('Instance is closed')
    this.resetSessionTimer()

    const concurrency = Math.max(1, options.concurrency ?? 1)
    const results: QueryAcrossResult<T>[] = new Array(vaultIds.length)

    // Tiny inline p-limit. Maintains a sliding window of `concurrency`
    // in-flight promises and schedules the next vault as each
    // one settles. No external dep. Index-keyed result array so the
    // output preserves caller-supplied order even when concurrency
    // > 1 lets later compartments finish before earlier ones.
    let nextIndex = 0
    const inFlight: Set<Promise<void>> = new Set()

    const launch = (): Promise<void> | null => {
      if (nextIndex >= vaultIds.length) return null
      const idx = nextIndex++
      const vaultId = vaultIds[idx]!
      const task = (async () => {
        try {
          const comp = await this.openVault(vaultId, { create: options.create !== false })
          const result = await fn(comp)
          results[idx] = { vault: vaultId, result }
        } catch (err) {
          results[idx] = {
            vault: vaultId,
            error: err instanceof Error ? err : new Error(String(err)),
          }
        }
      })()
      inFlight.add(task)
      // Fire-and-forget cleanup. The task itself never rejects (the
      // try/catch above swallows everything into the result slot), so
      // there's no rejection to handle here — `void` tells the linter
      // we know what we're doing.
      void task.finally(() => inFlight.delete(task))
      return task
    }

    // Prime the window.
    for (let i = 0; i < concurrency; i++) {
      if (launch() === null) break
    }

    // Drain. As each task settles, kick off the next one until the
    // input is exhausted. `Promise.race` against the live set is the
    // simplest way to "wake up on whichever finishes first" without
    // pulling in p-limit / async-pool / etc.
    while (inFlight.size > 0) {
      await Promise.race(inFlight)
      while (inFlight.size < concurrency && nextIndex < vaultIds.length) {
        if (launch() === null) break
      }
    }

    return results
  }

  /**
   * Register a shard schema blueprint. `createShard` / `openVaultGroup`
   * stamp shards from the named template. See the MVF design spec.
   */
  withVaultTemplate(name: string, template: VaultTemplate): void {
    this.vaultTemplates.set(name, template)
  }

  /**
   * Open a VaultGroup — transparent routing over per-partition shard
   * vaults, with shard discovery backed by the supplied `vault-registry`
   * collection.
   */
  async openVaultGroup<T>(name: string, opts: VaultGroupOptions<T>): Promise<VaultGroup<T>> {
    if (this.closed) throw new ValidationError('Instance is closed')
    const template = this.vaultTemplates.get(opts.sharding.vaultTemplate)
    if (!template) throw new VaultTemplateNotFoundError(opts.sharding.vaultTemplate)
    // Lazy-load so the federation module is a separate chunk, not part
    // of the always-loaded core graph (keeps the core bundle ceiling).
    const { VaultGroup } = await import('./federation/vault-group.js')
    return new VaultGroup<T>(this, name, opts.registry, opts.sharding, template)
  }

  /**
   * @internal — true when an encrypted shard vault is provisioned
   * (its keyring exists in the store).
   */
  async _shardVaultProvisioned(vaultId: string): Promise<boolean> {
    return (await this.options.store.list(vaultId, '_keyring')).length > 0
  }

  /**
   * Change the current user's passphrase for a vault.
   *
   * Validates the new passphrase against the strength rules. Pass
   * `{ allowWeakPassphrase: true }` to skip — typically only useful for
   * fixtures and migrations. Pass a `PassphrasePolicy` to override the
   * default rules (e.g. consumer-tunable `pattern` / `customValidator`).
   */
  async changeSecret(
    vault: string,
    newPassphrase: string,
    options?: PassphrasePolicy & { allowWeakPassphrase?: boolean },
  ): Promise<void> {
    this.checkPolicyOperation(vault, 'changeSecret')
    const keyring = await this.getKeyringInternal(vault)
    const updated = await keyringChangeSecret(
      this.options.store,
      vault,
      keyring,
      newPassphrase,
      options,
    )
    this.keyringCache.set(vault, updated)
  }

  // ─── Sync ──────────────────────────────────────────────────────

  /** Push local changes to remote for a vault. */
  async push(vault: string, options?: PushOptions): Promise<PushResult> {
    const engine = this.getSyncEngine(vault)
    return engine.push(options)
  }

  /** Pull remote changes to local for a vault. */
  async pull(vault: string, options?: PullOptions): Promise<PullResult> {
    const engine = this.getSyncEngine(vault)
    return engine.pull(options)
  }

  /**
   * Bidirectional sync: pull then push for all targets.
   * `sync-peer` targets do pull+push; `backup`/`archive` targets do push-only.
   */
  async sync(vault: string, options?: { push?: PushOptions; pull?: PullOptions }): Promise<{ pull: PullResult; push: PushResult }> {
    const primary = this.getSyncEngine(vault)
    const result = await primary.sync(options)

    // Fan out push to backup/archive targets (fire-and-mark-dirty)
    for (const [key, engine] of this.syncEngines) {
      if (key === vault) continue
      if (!key.startsWith(`${vault}::`)) continue
      if (engine.role === 'sync-peer') {
        await engine.sync(options).catch((err: Error) => {
          this.emitter.emit('sync:backup-error', {
            vault,
            target: engine.label ?? engine.role,
            error: err,
          })
        })
      } else {
        // backup/archive: push-only
        await engine.push(options?.push).catch((err: Error) => {
          this.emitter.emit('sync:backup-error', {
            vault,
            target: engine.label ?? engine.role,
            error: err,
          })
        })
      }
    }

    return result
  }

  /**
   * Multi-record atomic transaction.
   *
   * The callback stages writes across any number of vaults /
   * collections; on return the hub pre-flights version checks, then
   * commits every staged op. If the body throws, nothing is
   * persisted. If any staged op fails its `expectedVersion` check,
   * the batch throws `ConflictError` with zero writes performed. If a
   * mid-commit failure occurs after one or more ops have already
   * written, each executed op is reverted best-effort (see
   * `runTransaction` for the crash-window caveat).
   *
   * Distinct from `transaction(vault: string) → SyncTransaction`
   * which batches push/pull across sync peers.
   */
  transaction<T>(fn: (tx: TxContext) => Promise<T> | T): Promise<T>
  /**
   * Open an amendment-mode transaction. Requires `admin` or `owner`
   * role on every vault touched by the body; throws
   * `AmendmentForbiddenError` on first non-privileged `tx.vault(name)`
   * call. Guard `check` callbacks are SKIPPED inside an amendment —
   * the staged change-set is fed to each guard's `amendment.invariant`
   * after the body returns, and the multi-record summary is appended
   * to the vault's ledger as `op: 'amendment'`.
   */
  transaction<T>(
    options: AmendmentTxOptions,
    fn: (tx: TxContext) => Promise<T> | T,
  ): Promise<T>
  /**
   * Dry-run a transaction: run the body to stage ops, then return
   * the directly-affected diff + collected guard violations WITHOUT
   * committing (no adapter writes, no write hooks). MV/derivation cascade
   * is not simulated. Requires `withTransactions()`.
   */
  transaction(
    options: { readonly dryRun: true },
    fn: (tx: TxContext) => unknown,
  ): Promise<DryRunResult>
  /**
   * Create a sync transaction for the given vault.
   * The vault must already be open via `openVault()`.
   * Call `tx.put()` / `tx.delete()` to stage changes, then `tx.commit()`
   * to write all locally and push atomically to remote.
   */
  transaction(vault: string): SyncTransaction
  transaction<T>(
    arg: string | AmendmentTxOptions | { readonly dryRun: true } | ((tx: TxContext) => Promise<T> | T),
    maybeFn?: (tx: TxContext) => Promise<T> | T,
  ): SyncTransaction | Promise<T> | Promise<DryRunResult> {
    if (typeof arg === 'function') {
      return this.txStrategy.runTransaction(this, arg)
    }
    if (typeof arg === 'object' && arg !== null && (arg as { dryRun?: boolean }).dryRun === true) {
      // Dry-run form: stage + diff, no commit.
      if (typeof maybeFn !== 'function') {
        throw new ValidationError(
          'db.transaction({ dryRun: true }, fn) requires the callback as the second argument.',
        )
      }
      return this.txStrategy.runDryRun(this, maybeFn)
    }
    if (typeof arg === 'object' && arg !== null && (arg as { amendment?: boolean }).amendment === true) {
      // Two-arg amendment form. We forward `arg` as the options bag —
      // the executor handles reason validation + per-vault role check.
      if (typeof maybeFn !== 'function') {
        throw new ValidationError(
          'db.transaction({ amendment: true }, fn) requires the callback as the second argument.',
        )
      }
      return this.txStrategy.runTransaction(this, maybeFn, arg as AmendmentTxOptions)
    }
    const vault = arg as string
    const comp = this.vaultCache.get(vault)
    if (!comp) {
      throw new ValidationError(
        `Vault "${vault}" is not open. Call openVault() first.`,
      )
    }
    const engine = this.getSyncEngine(vault)
    return this.syncStrategy.buildSyncTransaction(comp, engine)
  }

  /**
   * Internal accessor for the primary store — used by the tx
   * executor to perform raw adapter reads for pre-flight CAS and
   * raw writes for rollback. Not part of the public API.
   *
   * @internal
   */
  get _store(): NoydbStore {
    return this.options.store
  }

  /**
   * Currently-running multi-record transaction, or `null` outside
   * Phase 2. `Collection.dispatchDerivations` consults this so a
   * recursive derived-output write inside `Collection.put` can register
   * its envelope onto `ctx._executed` and roll back with the main
   * staged ops on mid-batch failure.
   *
   * @internal
   */
  get _activeTxContextOrNull(): TxContext | null {
    return this._activeTxContext
  }

  /**
   * Called by `runTransaction` at Phase 2 start, and by
   * `Collection.putManyAtomic` (via `derivationSource.setActiveTxContext`)
   * for its own Phase 2 loop. Nested or concurrent (non-nested)
   * transactions on the same Noydb instance are NOT supported —
   * overwriting an active context means another transaction is still
   * running and its `_executed` list would be cross-contaminated by
   * the nested writes. We tolerate the overwrite (best-effort, no
   * throw) to keep the rare interleaving from breaking consumers who
   * currently get lucky with timing, but applications should ensure
   * their multi-record commits are serialised on a single Noydb.
   *
   * @internal
   */
  _setActiveTxContext(ctx: TxContext): void {
    this._activeTxContext = ctx
  }

  /**
   * Factory for a transient `TxContext` bound to this Noydb. Used by
   * `Collection.putManyAtomic` (via `derivationSource.createTxContext`)
   * to publish an active context for the duration of its bulk-atomic
   * Phase 2 loop, so recursive derivation-output writes register on
   * `ctx._executed` and roll back together with the source ops.
   *
   * @internal
   */
  _createTxContext(): TxContext {
    return new TxContext(this)
  }

  /**
   * Called by `runTransaction` in its `finally`. Only clears when the
   * passed ctx matches the active one — a defensive no-op if some
   * other code path already cleared it.
   *
   * @internal
   */
  _clearActiveTxContext(ctx: TxContext): void {
    if (this._activeTxContext === ctx) {
      this._activeTxContext = null
    }
  }

  /** Get sync status for a vault. */
  syncStatus(vault: string): SyncStatus {
    const engine = this.syncEngines.get(vault)
    if (!engine) {
      return { dirty: 0, lastPush: null, lastPull: null, online: true }
    }
    return engine.status()
  }

  private requireShamirProvider(): ShamirRecoveryProvider {
    const p = this.options.shamirRecovery
    if (!p) {
      throw new Error(
        "shamir recovery requires a ShamirRecoveryProvider — pass "
        + "shamirRecovery: shamirRecoveryProvider() from '@noy-db/on-shamir' to createNoydb()",
      )
    }
    return p
  }

  private getSyncEngine(vault: string): SyncEngine {
    const engine = this.syncEngines.get(vault)
    if (!engine) {
      throw new ValidationError('No sync adapter configured. Pass a `sync` adapter to createNoydb().')
    }
    return engine
  }

  // ─── Events ────────────────────────────────────────────────────

  on<K extends keyof NoydbEventMap>(event: K, handler: (data: NoydbEventMap[K]) => void): void {
    this.emitter.on(event, handler)
  }

  off<K extends keyof NoydbEventMap>(event: K, handler: (data: NoydbEventMap[K]) => void): void {
    this.emitter.off(event, handler)
  }

  /**
   * Observable write-queue for this hub instance. Reflects outstanding
   * in-flight writes across all collections. See {@link WriteQueue}.
   *
   * @example
   * window.addEventListener('beforeunload', (e) => {
   *   if (db.writeQueue.pending) { e.preventDefault(); e.returnValue = '' }
   * })
   */
  get writeQueue(): WriteQueue {
    return this.writeQueueTracker
  }

  /**
   * @internal Mutable tracker behind {@link writeQueue}. Threaded into
   * each Collection (via Vault) so `put`/`delete` can `track()` writes.
   * Not part of the public surface — consumers use `writeQueue`.
   */
  get _writeQueueTracker(): WriteQueueTracker {
    return this.writeQueueTracker
  }

  /**
   * Register a hook that runs before each write. Awaited; a throw
   * aborts the write. Returns an unsubscribe function.
   */
  onBeforeWrite(handler: WriteHook): Unsubscribe {
    return this.writeHooks.onBeforeWrite(handler)
  }

  /**
   * Register a hook that runs after each committed write. Awaited;
   * a handler error is warned, never rolled back. Returns an unsubscribe fn.
   */
  onAfterWrite(handler: WriteHook): Unsubscribe {
    return this.writeHooks.onAfterWrite(handler)
  }

  /** Subscribe to cross-tab write conflicts. Returns an unsubscribe. */
  onWriteConflict(fn: (c: WriteConflict) => void): Unsubscribe {
    this.on('write:conflict', fn)
    return () => this.off('write:conflict', fn)
  }

  /**
   * Enable same-device multi-tab coordination: primary/secondary
   * election + presence. Browser-only — a graceful no-op (role 'unknown')
   * when Web Locks / BroadcastChannel are unavailable and nothing is
   * injected. Idempotent; returns a disposer.
   */
  enableTabCoordination(opts: TabCoordinationOptions = {}): { dispose: () => void } {
    if (this.tabCoordinator) return { dispose: () => this.disableTabCoordination() }
    const lockManager = opts.lockManager ?? defaultLockManager()
    const channel = opts.channel ?? defaultChannel()
    const c = new TabCoordinator({
      ...opts,
      ...(lockManager ? { lockManager } : {}),
      ...(channel ? { channel } : {}),
      // We own the channel only when we created the default; never close a caller-injected one.
      closeChannelOnDispose: opts.channel === undefined && channel !== undefined,
    })
    this.tabCoordinator = c
    c.start()
    if (opts.propagateWrites !== false) {
      const writeChannel = opts.writeChannel ?? defaultChannel('noydb:tab-writes')
      if (writeChannel) {
        const relay = new CrossTabWriteRelay({
          channel: writeChannel,
          writerId: c.tabId,
          subscribeAfterWrite: (h) => this.onAfterWrite(h),
          applyRemoteWrite: (vault, collection, docId, action) => this.#applyRemoteWrite(vault, collection, docId, action),
          reportConflict: (vault, collection, docId, action, baseV, v, ownV) => this.#reportWriteConflict(vault, collection, docId, action, baseV, v, ownV),
          // Own the channel only when we created the default (mirrors the presence channel).
          closeChannelOnDispose: opts.writeChannel === undefined && writeChannel !== undefined,
        })
        this.writeRelay = relay
        relay.start()
      }
    }
    return { dispose: () => this.disableTabCoordination() }
  }

  #applyRemoteWrite(vaultName: string, collectionName: string, docId: string, action: 'put' | 'delete'): Promise<void> {
    const v = this.vaultCache.get(vaultName)
    if (!v) return Promise.resolve()
    return v._applyRemoteWrite(collectionName, docId, action)
  }

  async #reportWriteConflict(vaultName: string, collectionName: string, docId: string, action: 'put' | 'delete', baseV: number, v: number, ownV: number): Promise<void> {
    const vault = this.vaultCache.get(vaultName)
    if (!vault) return
    const cap = await vault._captureAndConverge(collectionName, docId, action, baseV)
    if (!cap) return
    const conflict: WriteConflict = {
      vault: vaultName, collection: collectionName, docId,
      local: cap.local, remote: cap.remote, base: cap.base,
      localVersion: ownV, remoteVersion: v, baseVersion: baseV,
    }
    this.emitter.emit('write:conflict', conflict)
  }

  private disableTabCoordination(): void {
    this.tabCoordinator?.dispose()
    this.tabCoordinator = undefined
    this.writeRelay?.dispose()
    this.writeRelay = undefined
  }

  get tabRole(): TabRole { return this.tabCoordinator?.role ?? 'unknown' }
  activeTabs(): TabPresence[] { return this.tabCoordinator?.activeTabs() ?? [] }
  onTabRoleChange(fn: (r: TabRole) => void): Unsubscribe { return this.tabCoordinator?.onTabRoleChange(fn) ?? (() => {}) }
  onActiveTabsChange(fn: (t: TabPresence[]) => void): Unsubscribe { return this.tabCoordinator?.onActiveTabsChange(fn) ?? (() => {}) }

  /** @internal The write-hook registry, threaded into each Collection. */
  get _writeHooks(): WriteHookRegistry {
    return this.writeHooks
  }

  /** @internal The observe bus, threaded into every Collection. */
  get _subsystemBus(): SubsystemBus {
    return this.subsystemBus
  }

  /** @internal Stable per-instance id for schema-cutover coordination. */
  get _clientId(): string {
    return this.clientId
  }

  /**
   * Soft-lock a single vault: clear its in-memory keyring, DEKs, vault
   * instance, sync engine, policy enforcer, and active-tier entry —
   * WITHOUT destroying the `Noydb` instance.
   *
   * Designed for "lock screen" UX: the user taps **Lock** and DEKs are
   * scrubbed from memory immediately, but the same `Noydb` instance can
   * be re-unlocked via {@link unlockViaAuthenticator} (tier 2) or
   * {@link unlockViaPin} (tier 3) without re-running `createNoydb`.
   *
   * **QuickUnlock state is preserved.** That's the whole point — the
   * user can still resume via PIN without a full credential re-prompt.
   * The on-disk `_meta/policy` document is also kept in cache (it
   * survives lock; nothing about it changes when DEKs are scrubbed).
   *
   * No-op when `vault` is not currently in cache (idempotent).
   */
  lockVault(vault: string): void {
    // Sync engine: stop autosync + drop the engine so the next openVault
    // builds a fresh one against the freshly-loaded keyring.
    this.syncEngines.get(vault)?.stopAutoSync()
    this.syncEngines.delete(vault)
    // Policy enforcer: cancels its idle timer and any visibility listener.
    this.policyEnforcers.get(vault)?.destroy()
    this.policyEnforcers.delete(vault)
    // Live caches: scrub DEKs, vault instance, active tier.
    this.vaultCache.get(vault)?._stopFenceCoordination() // stop heartbeat/watcher timers
    this.keyringCache.delete(vault)
    this.vaultCache.delete(vault)
    this.activeTier.delete(vault)
    // Intentionally NOT cleared:
    //   - this.quickUnlock — preserves PIN resume.
    //   - this.policyCache — vault policy is on-disk data, survives lock.
    //   - this.sessionStrategy — no per-vault revoke; close() handles bulk.
  }

  close(): void {
    this.closed = true
    this.snapshotScheduler?.stop()
    this.snapshotScheduler = null
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer)
      this.sessionTimer = null
    }
    // Destroy all policy enforcers (cancels timers + visibility listeners)
    for (const enforcer of this.policyEnforcers.values()) {
      enforcer.destroy()
    }
    this.policyEnforcers.clear()
    // Revoke all in-memory session keys
    this.sessionStrategy.revokeAllSessions()
    // Stop all sync engines
    for (const engine of this.syncEngines.values()) {
      engine.stopAutoSync()
    }
    this.syncEngines.clear()
    for (const v of this.vaultCache.values()) v._stopFenceCoordination() // stop heartbeat/watcher timers
    this.disableTabCoordination() // stop tab lock/heartbeat timers
    this.keyringCache.clear()
    this.vaultCache.clear()
    this.activeTier.clear()
    this.policyCache.clear()
    this.quickUnlock.clear()
    this.emitter.removeAllListeners()
    // Clear translator state — same lifetime as KEK/DEKs
    this.translatorCache.clear()
    this._translatorAuditLog.length = 0
  }

  /**
   * Returns a snapshot of all translator invocations since the last
   * `close()`. Useful for testing and compliance auditing. The log is
   * in-memory only — it is cleared when `db.close()` is called.
   *
   * Entries deliberately omit content hashes. See `TranslatorAuditEntry`
   * and issue  for the rationale.
   */
  translatorAuditLog(): readonly TranslatorAuditEntry[] {
    return [...this._translatorAuditLog]
  }

  /**
   * Invoke the configured `plaintextTranslator` (or serve from cache).
   * Records one `TranslatorAuditEntry` per call regardless of cache hit.
   * Called by `Vault` during `put()` for `autoTranslate: true` fields.
   *
   * @internal — not part of the public API surface
   */
  async invokeTranslator(
    text: string,
    from: string,
    to: string,
    field: string,
    collection: string,
  ): Promise<string> {
    const cacheKey = `${field}\x00${collection}\x00${from}\x00${to}\x00${text}`
    const translatorName = this.options.plaintextTranslatorName ?? 'anonymous'

    const cached = this.translatorCache.get(cacheKey)
    if (cached !== undefined) {
      this._translatorAuditLog.push({
        type: 'translator-invocation',
        field,
        collection,
        fromLocale: from,
        toLocale: to,
        translatorName,
        timestamp: new Date().toISOString(),
        cached: true,
      })
      return cached
    }

    const result = await this.options.plaintextTranslator!({ text, from, to, field, collection })
    this.translatorCache.set(cacheKey, result)
    this._translatorAuditLog.push({
      type: 'translator-invocation',
      field,
      collection,
      fromLocale: from,
      toLocale: to,
      translatorName,
      timestamp: new Date().toISOString(),
    })
    return result
  }

  // ─── Policy gates (issue #9) ──────────────────────────────────
  /**
   * Read the active policy for a vault. Loads from `_meta/policy` on
   * first call; subsequent calls hit the in-memory cache. Throws
   * `ValidationError` if the vault has not been opened.
   */
  async getPolicy(vault: string): Promise<VaultPolicy> {
    if (this.closed) throw new ValidationError('Instance is closed')
    const cached = this.policyCache.get(vault)
    if (cached) return cached
    await this.bootstrapPolicy(vault)
    return this.policyCache.get(vault) ?? PERSONAL_POLICY
  }

  /**
   * Replace the policy document at `_meta/policy` and update the
   * in-memory cache. Gated by the `enroll-user` policy (a policy
   * change is fundamentally a privilege-management action).
   */
  async updatePolicy(vault: string, override: Partial<VaultPolicy>): Promise<VaultPolicy> {
    if (this.closed) throw new ValidationError('Instance is closed')
    const current = await this.getPolicy(vault)
    const merged = mergePolicy(current, override)
    if (this.options.encrypt !== false) {
      await saveVaultPolicy(this.options.store, vault, merged)
    }
    this.policyCache.set(vault, merged)
    return merged
  }

  /**
   * Read the current vault-level user-directory toggle. Returns
   * the default-on shape (`{ enabled: true }`) when no `_meta/directory`
   * document has been persisted yet.
   *
   * No role gate — anyone who can open the vault can read the toggle.
   */
  async getDirectoryEnabled(vault: string): Promise<boolean> {
    if (this.closed) throw new ValidationError('Instance is closed')
    const persisted = await readDirectoryConfig(this.options.store, vault)
    return persisted?.enabled ?? true
  }

  /**
   * Toggle the vault's user-directory listing on or off.
   * Owner-only. When disabled, `listUsersWithEnvelopes()` throws
   * {@link import('./errors.js').DirectoryDisabledError} for callers
   * whose role is neither `owner` nor `admin`.
   *
   * Honest caveat: this is a UX flag, not a privacy guarantee. The
   * keyring file at `_keyring/<userId>` and the envelope ciphertext at
   * `_users/<keyringId>` remain observable to anyone with direct store
   * read access — only the hub-level enumeration is gated. See
   * `docs/subsystems/user-envelope.md` → "Directory visibility".
   */
  async setDirectoryEnabled(vault: string, enabled: boolean): Promise<void> {
    if (this.closed) throw new ValidationError('Instance is closed')
    const keyring = await this.getKeyringInternal(vault)
    if (keyring.role !== 'owner') {
      throw new PermissionDeniedError(
        `setDirectoryEnabled requires owner role; caller has role "${keyring.role}"`,
      )
    }
    await persistDirectoryConfig(this.options.store, vault, { enabled })
  }

  /**
   * Evaluate a policy gate against the active session tier and the
   * presented factor proofs. Throws {@link PolicyDeniedError} on
   * denial; resolves with `void` on success.
   *
   * @param vault    The vault whose policy applies.
   * @param gate     Gate name — built-in (e.g. `'rotate-passphrase'`)
   *                 or app-defined (`app:*`).
   * @param presented Caller-supplied factor proofs.
   */
  async checkGate(
    vault: string,
    gate: GateName,
    factors?: FactorProofBundle,
  ): Promise<void> {
    const policy = await this.getPolicy(vault)
    const tier = this.activeTier.get(vault) ?? 1
    await policyCheckGate(policy, gate, {
      activeTier: tier,
      ...(factors?.factors !== undefined ? { factors: factors.factors } : {}),
      ...(factors?.sharedDevice !== undefined
        ? { sharedDevice: factors.sharedDevice }
        : {}),
    })
  }

  /** Read or persist the vault policy at `_meta/policy` on first open. */
  private async bootstrapPolicy(
    vault: string,
    opts?: { skipManagedCheck?: boolean },
  ): Promise<void> {
    const onDisk = await loadVaultPolicy(this.options.store, vault)
    if (onDisk) {
      // Honour the on-disk document; developer overrides cannot
      // weaken what the vault committed to at creation time.
      this.policyCache.set(vault, onDisk)
      await this.assertRecoveryEnrolled(vault, onDisk, opts)
      return
    }
    // First time — persist the developer's policy (or default preset).
    const initial = this.options.policy
      ? mergePolicy(PERSONAL_POLICY, this.options.policy)
      : PERSONAL_POLICY
    await saveVaultPolicy(this.options.store, vault, initial)
    this.policyCache.set(vault, initial)
    await this.assertRecoveryEnrolled(vault, initial, opts)
  }

  /**
   * Throw {@link RecoveryNotEnrolledError} or
   * {@link ManagedRecoveryNotEnrolledError} when recovery enrollment
   * is missing.
   *
   * Two enforcement modes:
   *
   * 1. **Managed-mode mandatory strong-recovery.** When
   *    `passphraseMode === 'managed'`, the vault MUST have at least
   *    one **strong** recovery profile (Shamir today). Paper alone is
   *    rejected because under managed mode the user has no memorized
   *    passphrase, so losing the paper sheet = losing every record.
   *    This check is unconditional — independent of `requireRecovery`
   *    and the `recover-passphrase` gate.
   *
   * 2. **Opt-in strict mandatory-recovery.** When
   *    `requireRecovery: true` is set on createNoydb (and the gate is
   *    not explicitly disabled), require ANY recovery profile (paper
   *    or shamir). This is the v0.x default-off behavior; v1.0 may
   *    flip it default-on.
   *
   * The managed-mode check fires from {@link bootstrapPolicy} unless
   * the `skipManagedCheck` flag is set (used by
   * {@link openVaultAndEnrollRecovery} to allow atomic create-and-enroll).
   */
  private async assertRecoveryEnrolled(
    vault: string,
    policy: VaultPolicy,
    opts?: { skipManagedCheck?: boolean },
  ): Promise<void> {
    const skipManaged = (opts?.skipManagedCheck ?? false) || this._skipNextManagedRecoveryCheck
    if (this.options.passphraseMode === 'managed' && !skipManaged) {
      const enrolled = await hasStrongRecoveryEnrolled(this.options.store, vault)
      if (!enrolled) {
        throw new ManagedRecoveryNotEnrolledError(vault)
      }
    }
    if (this.options.requireRecovery !== true) return
    const gate = policy.gates['recover-passphrase']
    if (gate?.enabled === false) return
    const enrolled = await hasRecoveryEnrolled(this.options.store, vault)
    if (enrolled) return
    throw new RecoveryNotEnrolledError()
  }

  /**
   * Internal accessor used by tier-2/tier-3 unlock paths
   * to mark the active session tier.
   * @internal
   */
  _setActiveTier(vault: string, tier: ActiveTier): void {
    this.activeTier.set(vault, tier)
  }

  // ─── Tier-2 enroll / remove ─────────────────────────────────────
  /**
   * Add a tier-2 authenticator slot to the calling user's keyring.
   * Each slot independently wraps the SAME KEK under a method-specific
   * key — adding a slot is a constant-time keyring write.
   *
   * The wrapping ciphertext is produced by the corresponding
   * `@noy-db/on-*` package (e.g. `enrollPasswordAuthenticator` from
   * `@noy-db/on-password`); the hub persists the result.
   *
   * Gated by `enroll-authenticator`; `presented` carries any factor
   * proofs the active policy demands.
   */
  async enrollAuthenticator(
    vault: string,
    options: EnrollAuthenticatorOptions,
    factors?: FactorProofBundle,
  ): Promise<void> {
    await this.checkGate(vault, 'enroll-authenticator', factors)
    const keyring = await this.getKeyringInternal(vault)
    const next = await keyringEnrollAuthenticator(this.options.store, vault, keyring, options)
    this.keyringCache.set(vault, next)
  }

  /**
   * Remove a tier-2 authenticator slot. Idempotent — removing a
   * non-existent slot is a successful no-op. Gated by
   * `remove-authenticator`.
   */
  async removeAuthenticator(
    vault: string,
    slotId: string,
    factors?: FactorProofBundle,
  ): Promise<void> {
    await this.checkGate(vault, 'remove-authenticator', factors)
    const keyring = await this.getKeyringInternal(vault)
    const next = await keyringRemoveAuthenticator(this.options.store, vault, keyring, slotId)
    this.keyringCache.set(vault, next)
  }

  /** Read the slot list for a vault. Internal — `describeAuthConfig` consumes this. */
  async listAuthenticators(vault: string): Promise<ReadonlyArray<KeyringAuthenticator>> {
    const keyring = await this.getKeyringInternal(vault)
    return keyring.authenticators
  }

  /**
   * Mutate the `meta` blob on an existing authenticator slot — slot
   * rename, label change, attachment of UI hints. The slot's `id`,
   * `method`, and wrap material (`wrapped_kek` / `wrapped_deks` + `iv`)
   * are immutable through this method. Anti-slot-swap is structural,
   * not gate-driven.
   *
   * `meta` patch semantics (top-level merge):
   *   - Top-level merge — absent keys preserved
   *   - `null` value — delete that meta key
   *   - Other values — replace verbatim
   *
   * Use case: per-slot nickname for "iPhone Touch ID" vs "MacBook
   * Touch ID" disambiguation in admin UIs. The slot id (auto-derived
   * from credentialId prefix) is not human-friendly; `meta.nickname`
   * is.
   *
   * Gated by `update-authenticator`. PERSONAL_POLICY: tier-1 unlock
   * alone (matches enroll/remove). STRICT_POLICY: tier-1 +
   * TOTP/email-OTP factor proof — a malicious rename on a shared
   * workstation could mislead the user about which device a slot
   * corresponds to, so STRICT requires fresh factor binding.
   *
   * @throws `NoAccessError` when no slot with the given id exists.
   * @throws `ValidationError` when no patch field is provided.
   */
  async updateAuthenticator(
    vault: string,
    slotId: string,
    options: UpdateAuthenticatorOptions,
    factors?: FactorProofBundle,
  ): Promise<void> {
    await this.checkGate(vault, 'update-authenticator', factors)
    const keyring = await this.getKeyringInternal(vault)
    const next = await keyringUpdateAuthenticator(this.options.store, vault, keyring, slotId, options)
    this.keyringCache.set(vault, next)
  }

  /**
   * Native WebAuthn enrollment using the **real** internal keyring.
   *
   * Why this exists: when a consumer is using `createNoydb({ secret })`,
   * they cannot reach the live `UnlockedKeyring` to feed it to
   * `enrollWebAuthn(keyring, vault, opts)` from `@noy-db/on-webauthn`.
   * Constructing a synthetic keyring (the previous workaround) produces
   * a slot whose `wrapped_kek` references the synthetic payload, not
   * the live session — so `unlockViaAuthenticator()` later replaces the
   * live DEK map with stale wrapped DEKs and every decrypt fails.
   *
   * This method runs `ceremony` with the REAL keyring (still in
   * `keyringCache`). The ceremony performs the WebAuthn enrollment and
   * returns the slot options that hub then persists via the standard
   * tier-2 enrollAuthenticator path.
   *
   * Layering note: hub does not import `@noy-db/on-webauthn` (that
   * would invert the dep graph). The consumer wires it in:
   *
   * ```ts
   * import { enrollWebAuthn } from '@noy-db/on-webauthn'
   *
   * await db.enrollWebAuthn('demo', async (keyring) => {
   *   const e = await enrollWebAuthn(keyring, 'demo', { rp: {...} })
   *   return {
   *     id: `webauthn-${e.credentialId.slice(0, 8)}`,
   *     method: 'webauthn',
   *     wrapped_kek: e.wrappedPayload,
   *     meta: {
   *       credentialId: e.credentialId,
   *       wrapIv: e.wrapIv,
   *       prfUsed: e.prfUsed,
   *       beFlag: e.beFlag,
   *       requireSingleDevice: e.requireSingleDevice,
   *     },
   *   }
   * })
   * ```
   *
   * Returns the WebAuthn `credentialId` (extracted from `meta.credentialId`)
   * for the caller's lookup index (a bootstrap vault, a PublicEnvelope,
   * a server-side allowlist).
   *
   * Gated by `enroll-authenticator` like `enrollAuthenticator()` itself.
   */
  async enrollWebAuthn(
    vault: string,
    ceremony: (keyring: UnlockedKeyring) => Promise<EnrollAuthenticatorOptions>,
    factors?: FactorProofBundle,
  ): Promise<{ credentialId: string }> {
    await this.checkGate(vault, 'enroll-authenticator', factors)
    const keyring = await this.getKeyringInternal(vault)
    const slotOptions = await ceremony(keyring)
    if (slotOptions.method !== 'webauthn') {
      throw new ValidationError(
        `enrollWebAuthn: ceremony returned method "${slotOptions.method}"; expected "webauthn". ` +
          'Use db.enrollAuthenticator() for non-webauthn methods.',
      )
    }
    const credentialId = (slotOptions.meta as { credentialId?: unknown }).credentialId
    if (typeof credentialId !== 'string' || credentialId.length === 0) {
      throw new ValidationError(
        'enrollWebAuthn: ceremony result must include `meta.credentialId` (base64 string). ' +
          'See @noy-db/on-webauthn enrollWebAuthn() return shape.',
      )
    }
    const next = await keyringEnrollAuthenticator(this.options.store, vault, keyring, slotOptions)
    this.keyringCache.set(vault, next)
    return { credentialId }
  }

  /**
   * Filter the slot list to webauthn-method slots only. Useful for
   * "you have N WebAuthn credentials enrolled" UI surfaces and for
   * deciding when a new device prompt should appear. Identity is
   * `id` + `enrolled_at`; the `meta.credentialId` (base64) is used by
   * `allowCredentials` at unlock time.
   */
  async listWebAuthnSlots(vault: string): Promise<ReadonlyArray<{
    id: string
    enrolledAt: string
    credentialId: string
  }>> {
    const keyring = await this.getKeyringInternal(vault)
    return keyring.authenticators
      .filter((a) => a.method === 'webauthn')
      .map((a) => {
        const credentialId = (a.meta as { credentialId?: unknown }).credentialId
        return {
          id: a.id,
          enrolledAt: a.enrolled_at,
          credentialId: typeof credentialId === 'string' ? credentialId : '',
        }
      })
  }

  /**
   * Resolve a slot by id, then hand the wrapped-KEK ciphertext + meta
   * to the caller-supplied verifier. The verifier is the
   * `unlockWith*` function from the corresponding `@noy-db/on-*`
   * package, e.g. `unlockWithPassword(slot, password)`.
   *
   * On success, mark the active session tier as 2 — subsequent
   * `checkGate` calls see a tier-2 unlock.
   */
  async unlockViaAuthenticator(
    vault: string,
    slotId: string,
    verify: (slot: KeyringAuthenticator) => Promise<UnlockedKeyring>,
  ): Promise<UnlockedKeyring> {
    const keyring = await this.getKeyringInternal(vault)
    const slot = findAuthenticator(keyring, slotId)
    if (!slot) {
      throw new ValidationError(
        `unlockViaAuthenticator: no slot with id "${slotId}" in vault "${vault}".`,
      )
    }
    const unlocked = await verify(slot)
    this.keyringCache.set(vault, unlocked)
    this.activeTier.set(vault, 2)
    return unlocked
  }

  // ─── Public envelope (docs/subsystems/public-envelope.md) ──────
  /**
   * Set the owner-curated public envelope for a vault. Throws
   * `ValidationError` if the developer did not opt the hub into
   * `publicEnvelope` via `NoydbOptions`, or if the input violates
   * the resolved schema (oversized icon, disallowed MIME, oversized
   * string, unknown field).
   *
   * `createdAt` is set on the first write and preserved on every
   * subsequent write. `updatedAt` is refreshed on every write.
   * `version` is monotonic — increments on every successful write.
   */
  async setPublicEnvelope(
    vault: string,
    input: SetPublicEnvelopeInput,
  ): Promise<PublicEnvelope> {
    if (!this.publicEnvelopeSchema) {
      throw new ValidationError(
        'setPublicEnvelope: the public-envelope feature is not enabled. ' +
          'Pass `publicEnvelope: true` (or a schema object) to `createNoydb`.',
      )
    }
    validatePublicEnvelopeInput(input, this.publicEnvelopeSchema)

    const now = new Date().toISOString()
    const existing = await loadPublicEnvelope(this.options.store, vault)
    const next: PublicEnvelope = {
      _noydb_public: 1,
      version: (existing?.version ?? 0) + 1,
      ...(existing?.createdAt !== undefined ? { createdAt: existing.createdAt } : { createdAt: now }),
      updatedAt: now,
      ...(input.name !== undefined ? { name: input.name } : (existing?.name !== undefined ? { name: existing.name } : {})),
      ...(input.description !== undefined ? { description: input.description } : (existing?.description !== undefined ? { description: existing.description } : {})),
      ...(input.icon !== undefined ? { icon: input.icon } : (existing?.icon !== undefined ? { icon: existing.icon } : {})),
      ...(input.defaultLocale !== undefined ? { defaultLocale: input.defaultLocale } : (existing?.defaultLocale !== undefined ? { defaultLocale: existing.defaultLocale } : {})),
    }
    await savePublicEnvelope(this.options.store, vault, next)
    return next
  }

  /**
   * Read the public envelope for a vault. Returns `undefined` when
   * none has been written. Pass `locale` to resolve any locale-map
   * fields to plain strings; omitting `locale` returns the raw map.
   *
   * Works even when the developer didn't enable
   * `publicEnvelope` — reads are passive and never throw on a
   * missing schema (the envelope is plaintext and exists on disk
   * regardless).
   */
  async getPublicEnvelope(
    vault: string,
    opts: { readonly locale?: string } = {},
  ): Promise<PublicEnvelope | undefined> {
    return fnReadPublicEnvelope(this.options.store, vault, opts)
  }

  // ─── Auth introspection ─────────────────────────────────────────
  /** English summary of the configured auth model. */
  async describeAuthConfig(vault: string): Promise<string> {
    return fnDescribeAuthConfig(this.options.store, vault)
  }

  /** Mermaid `flowchart TB` source for the auth graph. */
  async diagramAuthConfig(vault: string): Promise<string> {
    return fnDiagramAuthConfig(this.options.store, vault)
  }

  /**
   * Per-user enrollment summary. Gated by `view-user-auth` (default:
   * disabled). Sanitization is allowlist-based — never renders cred
   * ids, password hashes, secrets, or any field outside the allowlist.
   */
  async describeUserAuth(
    vault: string,
    userId: string,
    factors?: FactorProofBundle,
  ): Promise<string> {
    await this.checkGate(vault, 'view-user-auth', factors)
    return fnDescribeUserAuth(this.options.store, vault, userId)
  }

  /** Bulk variant for owner dashboards. Gated by `view-user-auth`. */
  async describeAllUsersAuth(
    vault: string,
    factors?: FactorProofBundle,
  ): Promise<Array<{ userId: string; description: string }>> {
    await this.checkGate(vault, 'view-user-auth', factors)
    return fnDescribeAllUsersAuth(this.options.store, vault)
  }

  // ─── Tier-1 change flows ────────────────────────────────────────
  /**
   * Rotate the user's passphrase (user remembers old). Validates the
   * new phrase against the configured `passphrase` policy, runs the
   * `rotate-passphrase` gate, then re-derives + re-wraps every DEK.
   *
   * Tier-2 authenticator slots are dropped — each slot wraps the old
   * KEK and would need its derivation key to be re-presented. Re-enrol
   * via `db.enrollAuthenticator` after rotation.
   *
   * @throws `WeakPassphraseError` on a weak new phrase.
   * @throws `PolicyDeniedError` when the gate denies (missing factor, …).
   * @throws `InvalidKeyError` when `oldPassphrase` is wrong.
   */
  async rotatePassphrase(
    vault: string,
    input: RotatePassphraseInput,
    factors?: FactorProofBundle,
  ): Promise<void> {
    // Managed-passphrase mode: the user does NOT know the
    // current passphrase (hub generated it and sealed it under the
    // provider). Manual rotation via this method is impossible by
    // construction — surface a clear error rather than fail mid-way
    // with InvalidKeyError once `oldPassphrase` doesn't match the
    // hub-generated one. Recovery-under-managed (which mints a fresh
    // sealed passphrase via the provider) is the supported path; it
    // lands in a follow-up.
    if (this.options.passphraseMode === 'managed') {
      throw new PolicyDeniedError(
        'rotate-passphrase',
        'disabled',
        { minTier: 1, enabled: false },
        'Managed-passphrase mode (#14): the passphrase is hub-generated '
        + 'and sealed under the SealingKeyProvider — there is no '
        + 'plaintext to rotate. Use the recovery flow (follow-up issue) '
        + 'to mint a fresh sealed passphrase.',
      )
    }
    await this.checkGate(vault, 'rotate-passphrase', factors)
    const userId = this.options.user
    const next = await keyringRotatePassphrase(this.options.store, vault, userId, input)
    this.keyringCache.set(vault, next)
  }

  /**
   * Reset the passphrase using a recovery proof (user forgot the old).
   * Currently supports the `'paper'` profile end-to-end; the
   * other profiles throw {@link RecoveryProfileNotImplementedError}.
   *
   * Burns the used recovery entry on success.
   */
  async recoverPassphrase(
    vault: string,
    input: RecoverPassphraseInput,
    factors?: FactorProofBundle,
  ): Promise<RecoverPassphraseResult> {
    await this.checkGate(vault, 'recover-passphrase', factors)
    const userId = this.options.user

    // Snapshot the entries BEFORE recovery — the team function burns
    // exactly one entry, so post-recovery `_meta/recovery-paper`
    // contains `entriesBeforeRecovery.length - 1` entries (the ones
    // the user did NOT just consume). Those are what we replace
    // under the auto-rotation logic.
    const entriesBeforeRecovery = await loadPaperRecoveryEntries(this.options.store, vault)

    const next = await keyringRecoverPassphrase(this.options.shamirRecovery, this.options.store, vault, userId, input)
    this.keyringCache.set(vault, next)

    const rotateRemaining = input.rotateRemainingCodes ?? true
    const remainingAfterBurn = Math.max(0, entriesBeforeRecovery.length - 1)
    if (!rotateRemaining || remainingAfterBurn === 0) {
      return { newCodes: [] }
    }

    // Auto-rotate: replace the remaining entries with a fresh set
    // minted under the new keyring's DEKs. Wraps the same DEK set the
    // recovered keyring just got, so the new codes round-trip through
    // a future `db.recoverPassphrase` cleanly.
    //
    // If this step fails (store error mid-mint), we leave the existing
    // post-burn entries in place — the user falls back to the
    // fall back to prior behavior (remaining N-1 codes still valid). Strictly
    // safer than wiping then failing.
    const codeGen = input.codeGenerator ?? generateULID
    const newCodeCount = input.newCodeCount ?? remainingAfterBurn
    const codes: string[] = []
    const newEntries: PaperRecoveryEntry[] = []
    for (let i = 0; i < newCodeCount; i++) {
      const rawCode = codeGen()
      const entry = await mintPaperRecoveryEntry(next.deks, rawCode, generateULID())
      codes.push(rawCode)
      newEntries.push(entry)
    }
    // Single replace-all write — `savePaperRecoveryEntries` overwrites
    // `_meta/recovery-paper` atomically (one envelope `put`).
    await savePaperRecoveryEntries(this.options.store, vault, newEntries)

    return { newCodes: codes }
  }

  /**
   * Deliberate paper-recovery-code regeneration. User knows their
   * passphrase but wants a fresh sheet — they lost the printout or
   * suspect compromise of the off-site copy.
   *
   * Symmetric to {@link rotatePassphrase} for the recovery profile:
   * gated, audit-trackable, ergonomic. Replaces (not appends) the
   * paper sheet under `_meta/recovery-paper` in a single envelope `put`.
   *
   * Gated by the `rotate-recovery` policy gate:
   *   - PERSONAL_POLICY: `{ minTier: 1 }` — knowing the passphrase
   *     suffices, matching the lower-level flow's bar.
   *   - STRICT_POLICY: `{ minTier: 1, factors: [{ anyOf: ['totp',
   *     'email-otp', 'webauthn-roaming'] }] }` — rotation is an
   *     off-site-trust event; require an off-device factor so a
   *     stolen unlocked laptop cannot silently mint a sheet for the
   *     attacker.
   *
   * Defaults `count` to the existing sheet size so consumers aren't
   * surprised by a different code count. Explicit `count` overrides.
   *
   * @throws {@link RecoveryProfileNotImplementedError} when `profile`
   *         is anything other than `'paper'` (v1 dispatch limit).
   * @throws {@link PolicyDeniedError} when the gate denies (missing
   *         factor, tier mismatch, ...).
   * @throws on missing paper sheet — "nothing to rotate" surfaces as
   *         an error rather than silently minting an entire new sheet.
   *
   * @example Default count + show-once UI
   * ```ts
   * const { newCodes } = await db.rotateRecovery('acme', { profile: 'paper' })
   * showCodesToUser(newCodes)
   * ```
   *
   * @example STRICT-policy site with TOTP factor proof
   * ```ts
   * await db.rotateRecovery(
   *   'acme',
   *   { profile: 'paper', count: 10 },
   *   { factors: [{ kind: 'totp', proof: '123456' }] },
   * )
   * ```
   */
  async rotateRecovery(
    vault: string,
    options: RotateRecoveryOptions,
    factors?: FactorProofBundle,
  ): Promise<RotateRecoveryResult> {
    if (options.profile === 'paper') {
      return this.rotateRecoveryPaper(vault, options, factors)
    }
    if (options.profile === 'shamir') {
      return this.rotateRecoveryShamir(vault, options, factors)
    }
    // Defense-in-depth for `as unknown as ...` bypass.
    throw new RecoveryProfileNotImplementedError(
      (options as { profile: string }).profile,
      '#196',
    )
  }

  private async rotateRecoveryPaper(
    vault: string,
    options: Extract<RotateRecoveryOptions, { profile: 'paper' }>,
    factors?: FactorProofBundle,
  ): Promise<RotateRecoveryResult> {
    await this.checkGate(vault, 'rotate-recovery', factors)

    const existing = await loadPaperRecoveryEntries(this.options.store, vault)
    if (existing.length === 0) {
      throw new Error(
        `db.rotateRecovery: no recovery codes are enrolled for vault "${vault}". ` +
        `Call db.enrollRecovery({ profile: 'paper', entries }) first; ` +
        `rotateRecovery replaces an existing sheet rather than minting one from scratch.`,
      )
    }

    const keyring = await this.getKeyring(vault)
    const codeGen = options.codeGenerator ?? generateULID
    const count = options.count ?? existing.length

    const codes: string[] = []
    const newEntries: PaperRecoveryEntry[] = []
    for (let i = 0; i < count; i++) {
      const rawCode = codeGen()
      const entry = await mintPaperRecoveryEntry(keyring.deks, rawCode, generateULID())
      codes.push(rawCode)
      newEntries.push(entry)
    }
    // Atomic replace — `savePaperRecoveryEntries` overwrites
    // `_meta/recovery-paper` in a single envelope `put`.
    await savePaperRecoveryEntries(this.options.store, vault, newEntries)

    return { newCodes: codes, entryId: 'paper-batch' }
  }

  private async rotateRecoveryShamir(
    vault: string,
    options: Extract<RotateRecoveryOptions, { profile: 'shamir' }>,
    factors?: FactorProofBundle,
  ): Promise<RotateRecoveryResult> {
    await this.checkGate(vault, 'rotate-recovery', factors)

    const existing = await loadShamirRecoveryEntries(this.options.store, vault)
    if (existing.length === 0) {
      throw new Error(
        `db.rotateRecovery: no Shamir recovery entry is enrolled for vault "${vault}". ` +
        `Call db.enrollRecovery({ profile: 'shamir', k, n }) first; ` +
        `rotateRecovery replaces an existing entry rather than minting one from scratch.`,
      )
    }

    // Pick which entry to rotate.
    let targetEntryId: string
    if (options.entryId !== undefined) {
      const found = existing.find(e => e.entryId === options.entryId)
      if (!found) {
        throw new Error(
          `db.rotateRecovery: no Shamir entry with entryId="${options.entryId}" found `
          + `in vault "${vault}". Available: ${existing.map(e => `"${e.entryId}"`).join(', ')}.`,
        )
      }
      targetEntryId = options.entryId
    } else {
      if (existing.length > 1) {
        throw new Error(
          `db.rotateRecovery: vault "${vault}" has ${existing.length} Shamir entries `
          + `enrolled (${existing.map(e => `"${e.entryId}"`).join(', ')}). `
          + `Pass \`entryId\` to disambiguate which one to rotate; ambiguous rotation `
          + `would risk replacing the wrong entry.`,
        )
      }
      targetEntryId = existing[0]!.entryId
    }

    const keyring = await this.getKeyring(vault)
    const { entry, shareStrings } = await mintShamirRecoveryEntry(
      this.requireShamirProvider(),
      keyring.deks,
      targetEntryId,
      options.k,
      options.n,
      options.label,
    )

    // Atomic single-doc replace: drop the old entry, insert the new one.
    const next: ShamirRecoveryEntry[] = existing
      .filter(e => e.entryId !== targetEntryId)
      .concat(entry)
    await saveShamirRecoveryEntries(this.options.store, vault, next)

    return { newShares: shareStrings, entryId: targetEntryId }
  }

  /**
   * **Atomic create-and-enroll for managed-mode vaults.**
   *
   * Bootstraps a managed-mode vault and enrolls strong recovery in
   * a single ceremony. Under `passphraseMode: 'managed'`, every
   * `openVault` call requires a strong recovery profile (Shamir
   * today) to be enrolled — otherwise it throws
   * {@link ManagedRecoveryNotEnrolledError}. This method bypasses
   * the check temporarily so the keyring can be created, enrolls
   * the supplied recovery profile(s), then returns the vault.
   *
   * For Shamir enrollments, the show-once share strings come back
   * in `recoveryEnrollments[i].shares`. The hub never retains them
   * — the caller MUST display them to the user (once) before any
   * subsequent operation.
   *
   * Paper alone is NOT a strong profile under managed mode; passing
   * `{ profile: 'paper', ... }` without an accompanying shamir entry
   * is rejected at validation time.
   *
   * ```ts
   * const db = await createNoydb({
   *   store, user: 'alice',
   *   passphraseMode: 'managed',
   *   sealingKey: macosKeychainSealingProvider({ ... }),
   * })
   *
   * const { vault, recoveryEnrollments } = await db.openVaultAndEnrollRecovery('acme', {
   *   recovery: [{ profile: 'shamir', k: 2, n: 3 }],
   * })
   * for (const r of recoveryEnrollments) {
   *   if (r.shares) showSharesToUser(r.shares)  // ONCE
   * }
   * ```
   *
   * @throws ValidationError if recovery is empty, or contains no
   *   strong profile under managed mode.
   */
  async openVaultAndEnrollRecovery(
    vault: string,
    opts: {
      readonly recovery: ReadonlyArray<RecoveryEnrollmentInput>
      readonly locale?: string
    },
  ): Promise<{
    readonly vault: Vault
    readonly recoveryEnrollments: ReadonlyArray<EnrollRecoveryResult>
  }> {
    if (opts.recovery.length === 0) {
      throw new ValidationError(
        'openVaultAndEnrollRecovery: at least one recovery enrollment is required.',
      )
    }

    // Validate "at least one strong" when managed mode is on.
    if (this.options.passphraseMode === 'managed') {
      const hasStrong = opts.recovery.some(r => r.profile === 'shamir')
      if (!hasStrong) {
        throw new ValidationError(
          'openVaultAndEnrollRecovery: managed-mode vaults require at least one strong '
          + 'recovery profile in the `recovery` array. Paper alone is not strong under '
          + 'managed mode (no user passphrase to fall back on). Include '
          + '{ profile: "shamir", k, n } in `recovery`.',
        )
      }
    }

    // Temporarily bypass the managed-mode strong-recovery check so
    // openVault can create the keyring. Recovery enrollment happens
    // inside this window; the check is restored at the end.
    this._skipNextManagedRecoveryCheck = true
    let vaultHandle: Vault
    try {
      vaultHandle = await this.openVault(vault, opts.locale !== undefined ? { locale: opts.locale } : undefined)
    } finally {
      this._skipNextManagedRecoveryCheck = false
    }

    // Enroll each recovery profile.
    const recoveryEnrollments: EnrollRecoveryResult[] = []
    for (const enrollment of opts.recovery) {
      recoveryEnrollments.push(await this.enrollRecovery(vault, enrollment))
    }

    // Belt-and-braces final check — by now, strong recovery must be on disk.
    if (this.options.passphraseMode === 'managed') {
      const policy = this.policyCache.get(vault)
      if (policy) {
        await this.assertRecoveryEnrolled(vault, policy)
      }
    }

    return { vault: vaultHandle, recoveryEnrollments }
  }

  /**
   * **Recovery flow under managed-passphrase mode.**
   *
   * Replaces the sealed passphrase of a managed-mode vault with a
   * fresh 256-bit random, sealed under the configured
   * `SealingKeyProvider`. The user never sees the new passphrase.
   *
   * Internally:
   *   1. Verify the recovery proof (Shamir today) and unwrap the
   *      DEK set.
   *   2. Mint a fresh 256-bit random as the new effective passphrase.
   *   3. Rewrap the DEK set under a fresh KEK derived from the new
   *      passphrase (via the existing `recoverPassphrase` path).
   *   4. Seal the random bytes under the provider and overwrite
   *      `_meta/sealed-passphrase`.
   *   5. Drop the keyring cache so the next operation re-derives.
   *
   * The vault's strong-recovery enrollment is preserved across
   * recovery (Shamir entries are not burned on use).
   *
   * @throws ValidationError if the Noydb instance is not in managed mode.
   */
  async recoverManagedPassphrase(
    vault: string,
    options: {
      readonly recoveryProof: RecoveryProof
      readonly passphrasePolicy?: PassphrasePolicy
    },
  ): Promise<void> {
    if (this.options.passphraseMode !== 'managed') {
      throw new ValidationError(
        'recoverManagedPassphrase: this method only applies to vaults opened '
        + 'in managed-passphrase mode. For standard mode, use db.recoverPassphrase.',
      )
    }
    const provider = this.options.sealingKey
    if (!provider) {
      throw new ValidationError(
        'recoverManagedPassphrase: createNoydb({ passphraseMode: "managed" }) requires '
        + '`sealingKey` to be supplied; without it the new sealed passphrase cannot '
        + 'be persisted.',
      )
    }

    // Mint fresh 256-bit random; base64 it for use as the new
    // effective passphrase. AES-GCM auth-tag failures in the
    // managed-mode envelope catch tampering.
    const randomBytes = new Uint8Array(32)
    globalThis.crypto.getRandomValues(randomBytes)
    let binary = ''
    for (let i = 0; i < randomBytes.length; i++) binary += String.fromCharCode(randomBytes[i]!)
    const newPassphrase = btoa(binary)

    try {
      // Seal first; if the provider fails (KMS down, keychain locked),
      // we don't touch the keyring. Then run recoverPassphrase which
      // rewraps DEKs under the new KEK derived from the random bytes.
      const sealed = await provider.seal(randomBytes)
      await keyringRecoverPassphrase(
        this.options.shamirRecovery,
        this.options.store,
        vault,
        this.options.user,
        {
          newPassphrase,
          recoveryProof: options.recoveryProof,
          // The new passphrase IS 256 bits of random; policy gates on
          // length/entropy don't apply.
          allowWeakPassphrase: true,
          ...(options.passphrasePolicy !== undefined
            ? { passphrasePolicy: options.passphrasePolicy }
            : {}),
        },
      )
      // Update _meta/sealed-passphrase with the freshly sealed random.
      // The previous envelope is overwritten by saveSealedPassphrase.
      await saveSealedPassphrase(this.options.store, vault, {
        providerId: provider.id,
        sealed,
      })
    } finally {
      // Best-effort zero of the in-memory random buffer.
      randomBytes.fill(0)
    }

    // Drop the keyring cache so the next openVault re-derives from
    // the new sealed envelope.
    this.keyringCache.delete(vault)
  }

  /**
   * Atomic peer-recovery — re-wraps an EXISTING user's keyring under
   * a fresh temp passphrase in a single store write. Closes the
   * partial-failure window (the previous compose-from-primitives
   * pattern was `db.revoke + db.grant`, two writes — if the issuer
   * cancelled between them the target was locked out entirely).
   *
   * Different from `db.revoke + db.grant`:
   *
   *   - Same `userId`, role, permissions, capabilities preserved.
   *   - DEKs unchanged → every other principal in the vault keeps
   *     access. No key rotation.
   *   - Allows owner→owner natively. The existing
   *     `db.revoke` retains its block — peer-recovery is a separate,
   *     intentionally-named operation.
   *   - Tier-2 slots dropped (they wrap the old KEK).
   *
   * Gated by `peer-recover-user`; `STRICT_POLICY` requires a
   * recovery / TOTP / email-OTP factor proof at the moment of
   * recovery, so the issuer affirmatively re-asserts identity.
   *
   * The recipient should call `db.rotatePassphrase` on first session
   * to choose their own phrase — the temp acts as a single-use
   * bridge.
   *
   * ```ts
   * await db.recoverUser('acme', {
   *   userId: 'bob',
   *   passphrase: 'temporary-correct-horse-battery-staple-printer',
   * }, { factors: [{ kind: 'recovery' }] })
   * // Bob opens createNoydb({ user: 'bob', secret: tempPhrase })
   * // and immediately calls db.rotatePassphrase to set his own.
   * ```
   *
   * @throws `NoAccessError` when no keyring exists for the target.
   * @throws `PermissionDeniedError` when the caller's role can't
   *         recover the target's role (admin→owner is blocked even
   *         under recovery).
   * @throws `PrivilegeEscalationError` when the caller lacks a DEK
   *         the target previously had access to.
   *
   */
  async recoverUser(
    vault: string,
    options: RecoverUserOptions,
    factors?: FactorProofBundle,
  ): Promise<void> {
    await this.checkGate(vault, 'peer-recover-user', factors)
    const callerKeyring = await this.getKeyringInternal(vault)
    await keyringRecoverUser(this.options.store, vault, callerKeyring, options)
    // If the caller is recovering THEIR OWN keyring (rare but
    // possible — e.g. a self-recovery flow that bypasses the password
    // ceremony), the keyringCache entry is now stale. Drop it so the
    // next access reloads with the fresh wrapping.
    if (options.userId === this.options.user) {
      this.keyringCache.delete(vault)
    }
  }

  /**
   * Persist a recovery enrollment. Accepts the `'paper'`
   * profile.
   *
   * The hub wraps the user's DEK set (not the KEK) under a code-derived
   * AES-GCM key — see `team/recovery.ts` for the rationale. The mint
   * helper {@link mintPaperRecoveryEntry} is the canonical primitive;
   * pair it with `db.getKeyring(vault)` to obtain the live DEK set:
   *
   * ```ts
   * import { mintPaperRecoveryEntry } from '@noy-db/hub'
   *
   * const keyring = await db.getKeyring('acme')
   * const codes: string[] = ['CORRECT-HORSE-1', 'BATTERY-STAPLE-2', ...]
   * const entries = await Promise.all(
   *   codes.map((code, i) => mintPaperRecoveryEntry(keyring.deks, code, `code-${i}`)),
   * )
   * await db.enrollRecovery('acme', { profile: 'paper', entries })
   * showCodesToUser(codes)
   * ```
   *
   * `@noy-db/on-recovery`'s `generateRecoveryCodeSet`
   * delegates to `mintPaperRecoveryEntry` internally — its output is
   * fed directly to this API. Pick whichever fits your code-gen layer:
   *
   * ```ts
   * import { generateRecoveryCodeSet } from '@noy-db/on-recovery'
   * const { codes, entries } = await generateRecoveryCodeSet({ deks: keyring.deks, count: 8 })
   * await db.enrollRecovery('acme', { profile: 'paper', entries })
   * ```
   */
  async enrollRecovery(
    vault: string,
    enrollment: RecoveryEnrollmentInput,
  ): Promise<EnrollRecoveryResult> {
    if (enrollment.profile === 'paper') {
      const existing = await loadPaperRecoveryEntries(this.options.store, vault)
      await savePaperRecoveryEntries(this.options.store, vault, [
        ...existing,
        ...enrollment.entries,
      ])
      // Paper enrollments don't have a single entryId — callers
      // pre-mint with their own ids. Return a stable sentinel so the
      // result type is consistent for both profiles.
      return { entryId: 'paper-batch' }
    }
    if (enrollment.profile === 'shamir') {
      const keyring = await this.getKeyring(vault)
      const entryId = enrollment.entryId ?? generateULID()
      const { entry, shareStrings } = await mintShamirRecoveryEntry(
        this.requireShamirProvider(),
        keyring.deks,
        entryId,
        enrollment.k,
        enrollment.n,
        enrollment.label,
      )
      const existing = await loadShamirRecoveryEntries(this.options.store, vault)
      // If a Shamir entry with this id already exists, replace it
      // (allows callers to be idempotent on `entryId`); otherwise append.
      const next: ShamirRecoveryEntry[] = existing.filter(e => e.entryId !== entryId).concat(entry)
      await saveShamirRecoveryEntries(this.options.store, vault, next)
      return { entryId, shares: shareStrings }
    }
    // Defense-in-depth for `as unknown as ...` bypass at the call site.
    throw new RecoveryProfileNotImplementedError(
      (enrollment as { profile: string }).profile,
      '#196',
    )
  }

  /** Read the persisted recovery entries (paper + Shamir). Used by `describeAuthConfig`. */
  async listRecoveryEntries(
    vault: string,
  ): Promise<{
    paper: ReadonlyArray<PaperRecoveryEntry>
    shamir: ReadonlyArray<ShamirRecoveryEntry>
  }> {
    const paper = await loadPaperRecoveryEntries(this.options.store, vault)
    const shamir = await loadShamirRecoveryEntries(this.options.store, vault)
    return { paper, shamir }
  }

  // ─── Tier-3 enroll / unlock ─────────────────────────────────────
  /**
   * Register a tier-3 quick-unlock state for the vault. The state is
   * an opaque blob produced by `@noy-db/on-pin/enrollPin` (or any
   * compatible primitive). It is held in memory only — never persisted
   * — and auto-clears when its `expiresAt` elapses.
   *
   * Gated by `rotate-unlock` (the same gate covers "set" and "rotate"
   * because tier-3 is a single-slot rolling secret).
   */
  async enrollUnlock(
    vault: string,
    state: QuickUnlockState,
    factors?: FactorProofBundle,
  ): Promise<void> {
    await this.checkGate(vault, 'rotate-unlock', factors)
    this.quickUnlock.set(vault, state)
  }

  /**
   * Resume a session via the registered tier-3 state. The verifier is
   * `@noy-db/on-pin/resumePin` (or compatible). On success, mark the
   * active session tier as 3 — every operation must re-authenticate at
   * tier 2 to elevate.
   *
   * Returns `undefined` (caller should fall back to tier 2) when no
   * tier-3 state is registered.
   */
  async unlockViaPin(
    vault: string,
    resume: (state: QuickUnlockState) => Promise<UnlockedKeyring>,
  ): Promise<UnlockedKeyring | undefined> {
    const state = this.quickUnlock.get(vault)
    if (!state) return undefined
    const keyring = await resume(state)
    this.keyringCache.set(vault, keyring)
    this.activeTier.set(vault, 3)
    return keyring
  }

  /** Drop the tier-3 state for a vault — explicit logout. */
  clearQuickUnlock(vault: string): void {
    this.quickUnlock.delete(vault)
  }

  /**
   * Public accessor for the unlocked keyring of a vault.
   *
   * Returns a **defensive shallow copy** so consumers can read the DEK
   * map and authenticator list without the risk of mutating the hub's
   * internal cache. Internal hub code paths use a live reference
   * via `getKeyringInternal`; ceremonies and external consumers always
   * get a snapshot.
   *
   * The CryptoKey values inside `deks` are not cloned — Web Crypto
   * keys are opaque handles, and a shared handle is intentional
   * (encrypt / decrypt go through the same key the cache holds).
   * Only the container Map / authenticator array is fresh.
   *
   * Used by `@noy-db/on-*` ceremonies that need the live DEK set
   * (paper recovery via {@link mintPaperRecoveryEntry}, tier-3 PIN
   * enrolment via on-pin's `enrollPin`, custom on-* ceremonies that
   * don't have a hub-side wrapper).
   *
   * No new permission gate — this is an accessor over already-unlocked
   * state. The keyring is materialized only after the calling session
   * has unlocked the vault at tier 1, 2, or 3, so exposing it does not
   * widen access. Throws `ValidationError` when encryption is enabled
   * and no `secret` / `getKeyring` is configured.
   *
   * ```ts
   * const keyring = await db.getKeyring('acme')
   * // keyring.deks: Map<collection, CryptoKey>
   * // keyring.kek:  CryptoKey | null   (null for tier-3 / wrap-DEKs sessions)
   * // keyring.role / .permissions / .authenticators
   * ```
   */
  async getKeyring(vault: string): Promise<UnlockedKeyring> {
    const live = await this.getKeyringInternal(vault)
    // Deep-ish defensive copy. Each container the consumer might
    // reasonably mutate is freshly cloned. CryptoKey handles inside
    // `deks` are intentionally shared — they're opaque references that
    // both encrypt and decrypt go through. `salt` (Uint8Array) is left
    // as-is: no realistic mutation path.
    return {
      ...live,
      deks: new Map(live.deks),
      permissions: { ...live.permissions },
      authenticators: live.authenticators.map((a) => ({
        ...a,
        meta: { ...a.meta },
      })),
      ...(live.policy !== undefined ? { policy: { ...live.policy } } : {}),
      ...(live.exportCapability !== undefined
        ? { exportCapability: { ...live.exportCapability } }
        : {}),
      ...(live.importCapability !== undefined
        ? { importCapability: { ...live.importCapability } }
        : {}),
    }
  }

  /**
   * Live-reference variant used by the hub's own code paths. Internal
   * mutations on `deks` (e.g. {@link ensureCollectionDEK} adding a
   * collection key) need to land on the cached keyring so subsequent
   * accesses see them. Not exposed publicly — callers outside hub
   * should use {@link getKeyring}, which returns a defensive copy.
   */
  private async getKeyringInternal(
    vault: string,
    opts: { create: boolean } = { create: true },
  ): Promise<UnlockedKeyring> {
    if (this.options.encrypt === false) {
      return createPlaintextKeyring(this.options.user)
    }

    const cached = this.keyringCache.get(vault)
    if (cached) return cached

    // Custom unlock path (e.g. WebAuthn / OIDC / Shamir): caller-supplied
    // callback owns "open existing vs create new" — no automatic NoAccessError
    // fallback because the callback owner has the UI context for that choice.
    if (this.options.getKeyring) {
      const keyring = await this.options.getKeyring(vault)
      this.keyringCache.set(vault, keyring)
      return keyring
    }

    // Pre-gate (#313): refuse to self-provision into a vault held by other
    // principals; create-on-open only for a genuinely-new vault. Runs BEFORE
    // resolveManagedSecret (which persists on first open) so a fail-closed open
    // writes nothing. encrypt:false returned a plaintext keyring above, so we're
    // always on the encrypted path here. Logic lives in team/keyring.ts.
    await assertKeyringOpenAllowed(this.options.store, vault, this.options.user, opts.create)

    // Managed-passphrase mode — resolve the effective secret
    // before falling into the normal load/create path. The first call
    // mints + seals + persists; subsequent calls unseal what's there.
    // The returned string takes the place of `options.secret` for the
    // rest of this method (and is NOT persisted on `this.options`).
    let effectiveSecret: string | undefined
    if (this.options.passphraseMode === 'managed') {
      // sealingKey presence was validated at createNoydb time.
       
      effectiveSecret = await resolveManagedSecret(
        this.options.store,
        vault,
        this.options.sealingKey!,
      )
    } else {
      effectiveSecret = this.options.secret
    }

    if (!effectiveSecret) {
      throw new ValidationError('A secret (passphrase) or getKeyring callback is required when encryption is enabled')
    }

    let keyring: UnlockedKeyring
    try {
      keyring = await loadKeyring(this.options.store, vault, this.options.user, effectiveSecret)
    } catch (err) {
      if (err instanceof NoAccessError) {
        // No keyring on disk — first boot or cleared store.
        keyring = await createOwnerKeyring(
          this.options.store,
          vault,
          this.options.user,
          effectiveSecret,
          {
            // Managed mode generates 256-bit base64 strings that don't satisfy
            // the human-passphrase strength rules (no spaces, no "words").
            // Skip validation in managed mode — the entropy floor is already
            // 256 bits by construction.
            validate: this.options.passphraseMode === 'managed'
              ? false
              : this.options.validatePassphrase === true,
          },
        )
      } else if (err instanceof InvalidKeyError && this.options.onInvalidKey === 'reset') {
        // Stale keyring: exists in the store but the current credentials can't
        // decrypt it (e.g. the data records were cleared while the _keyring row
        // survived, or a WebAuthn credential was rotated between sessions).
        // The caller opted into reset — delete the stale row and start fresh.
        await this.options.store.delete(vault, '_keyring', this.options.user)
        keyring = await createOwnerKeyring(
          this.options.store,
          vault,
          this.options.user,
          effectiveSecret,
          {
            validate: this.options.passphraseMode === 'managed'
              ? false
              : this.options.validatePassphrase === true,
          },
        )
      } else {
        throw err
      }
    }

    this.keyringCache.set(vault, keyring)
    return keyring
  }

  /**
   * Take an on-demand checkpoint of the given vault.
   * Requires `snapshotStrategy: withSnapshots({ store })` in `createNoydb`.
   * @throws ValidationError when the vault is not open
   */
  async snapshot(vault: string, opts?: { label?: string; note?: string }): Promise<SnapshotMeta> {
    if (this.closed) throw new ValidationError('Instance is closed')
    const v = this.vaultCache.get(vault)
    if (!v) {
      throw new ValidationError(
        `Vault "${vault}" is not open. Call openVault() first.`,
      )
    }
    return this.snapshotStrategy.snapshot(v, this.options.user, opts)
  }

  /**
   * Wire the automatic-snapshot cadence when a non-manual `snapshotPolicy` is
   * configured. Subscribes to `onAfterWrite` to mark the written vault dirty and
   * nudge the scheduler; the scheduler fires `autoSnapshot()` per dirty vault.
   * No-op for `mode:'manual'` or no policy.
   */
  private initSnapshotCadence(): void {
    const policy = this.snapshotStrategy.policy
    if (!policy || !policy.mode || policy.mode === 'manual') return

    const scheduler = new SnapshotScheduler(policy, {
      fire: async () => {
        const names = [...this.dirtySnapshotVaults]
        this.dirtySnapshotVaults.clear()
        for (const name of names) {
          const v = this.vaultCache.get(name)
          if (!v) continue
          try {
            await this.snapshotStrategy.autoSnapshot(v, this.options.user)
          } catch (err) {
            // Keep the vault pending so a later cadence tick (interval) or the
            // next write (debounce) retries; a failed auto-snapshot is logged,
            // never thrown (it runs inside the after-write hook contract).
            this.dirtySnapshotVaults.add(name)
            console.warn(
              `[noy-db] auto-snapshot failed for vault "${name}": ` +
              (err instanceof Error ? err.message : String(err)),
            )
          }
        }
      },
      pendingCount: () => this.dirtySnapshotVaults.size,
    })

    this.onAfterWrite((event) => {
      this.dirtySnapshotVaults.add(event.vault)
      scheduler.notifyChange()
    })
    scheduler.start()
    this.snapshotScheduler = scheduler
  }

  /**
   * List all snapshots for the given vault, newest first.
   * Reads only the sidecar index — does not download snapshot bytes.
   */
  async listSnapshots(vault: string): Promise<SnapshotMeta[]> {
    if (this.closed) throw new ValidationError('Instance is closed')
    return this.snapshotStrategy.listSnapshots(vault)
  }

  /**
   * Restore the vault to a previously snapshotted state.
   * Runs `verifyBackupIntegrity()` automatically on restore.
   * @throws SnapshotNotFoundError when `version` doesn't exist in the store
   * @throws ValidationError when the vault is not open
   */
  async restoreSnapshot(vault: string, version: string): Promise<void> {
    if (this.closed) throw new ValidationError('Instance is closed')
    const v = this.vaultCache.get(vault)
    if (!v) {
      throw new ValidationError(
        `Vault "${vault}" is not open. Call openVault() first.`,
      )
    }
    return this.snapshotStrategy.restoreSnapshot(v, version)
  }
}

/** Create a new NOYDB instance. */
export async function createNoydb(options: NoydbOptions): Promise<Noydb> {
  const encrypted = options.encrypt !== false
  const managed = options.passphraseMode === 'managed'

  if (options.secret && options.getKeyring) {
    throw new ValidationError('Provide either `secret` or `getKeyring`, not both')
  }

  // Managed-passphrase mode — mutually exclusive with both
  // `secret` (the whole point is hub generates and seals; the user
  // doesn't supply one) and `getKeyring` (a custom unlock path that
  // bypasses the sealing flow entirely). Requires a SealingKeyProvider.
  if (managed) {
    if (options.secret) {
      throw new ValidationError(
        '`passphraseMode: "managed"` is mutually exclusive with `secret` — '
        + 'managed mode generates the passphrase itself. Drop `secret`.',
      )
    }
    if (options.getKeyring) {
      throw new ValidationError(
        '`passphraseMode: "managed"` is mutually exclusive with `getKeyring` — '
        + 'a custom unlock callback would bypass the sealing flow. Drop `getKeyring`.',
      )
    }
    if (!options.sealingKey) {
      throw new ValidationError(
        '`passphraseMode: "managed"` requires `sealingKey: SealingKeyProvider` '
        + '(see @noy-db/seal-macos-keychain / @noy-db/seal-aws-kms / etc.).',
      )
    }
  }

  if (encrypted && !managed && !options.secret && !options.getKeyring) {
    throw new ValidationError('A secret (passphrase) or getKeyring callback is required when encryption is enabled')
  }

  return new Noydb(options)
}

// ─── Internal helpers ─────────────────────────────────────────────────

/**
 * Normalize `NoydbOptions.sync` to a `SyncTarget[]`.
 * Accepts a bare NoydbStore, a SyncTarget, or an array.
 */
function normalizeSyncTargets(
  sync: NoydbOptions['sync'],
): SyncTarget[] {
  if (!sync) return []
  if (Array.isArray(sync)) return sync
  // SyncTarget has a `role` property; bare NoydbStore does not
  if ('role' in sync && typeof sync.role === 'string') {
    return [sync]
  }
  // Bare NoydbStore — wrap as sync-peer
  return [{ store: sync as NoydbStore, role: 'sync-peer' }]
}
