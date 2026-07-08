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
  UserApiFactory,
  ActiveTier,
  FactorProofBundle,
  GateName,
  VaultPolicy,
  NoydbPolicyApi,
  PolicyCheckGateFn,
} from './types.js'
import { ValidationError, NoAccessError, InvalidKeyError, KeyringCorruptError, StoreCapabilityError, PermissionDeniedError, DebugPlaintextError, RecoveryNotEnrolledError, ManagedRecoveryNotEnrolledError } from './errors.js'
import {
  readDirectoryConfig,
  persistDirectoryConfig,
} from '../with-party/directory/storage.js'
import type { PassphrasePolicy } from './validation.js'
import {
  type RotatePassphraseInput,
  type RecoverPassphraseInput,
  type RecoverPassphraseResult,
  type RotateRecoveryOptions,
  type RotateRecoveryResult,
  type EnrollRecoveryResult,
  type RecoveryEnrollmentInput,
  type RecoveryProof,
} from '../with-party/team/rotate-recover.js'
import type { RecoverUserOptions } from '../with-party/team/peer-recover.js'
import {
  hasRecoveryEnrolled,
  hasStrongRecoveryEnrolled,
  type PaperRecoveryEntry,
  type ShamirRecoveryEntry,
} from '../with-party/team/recovery.js'
import { resolveManagedSecret } from '../with-party/team/managed-passphrase.js'
import { generateULID } from '../with-pod/ulid.js'
import { createDefaultCoordinationProvider, type CoordinationProvider } from '../port/by/default-provider.js'
import type { PublicEnvelope } from '../with-party/directory/public-envelope/types.js'
import type { SetPublicEnvelopeInput } from '../with-party/directory/public-envelope/schema.js'
import { Vault } from './vault.js'
import type { VaultMeta } from '../with-shape/introspection/meta.js'
import { NoydbEventEmitter } from './events.js'
import { WriteQueueTracker, type WriteQueue } from './write-queue.js'
import { WriteHookRegistry, type WriteHook, type Unsubscribe } from '../port/with/write-hooks.js'
import { ServiceBus } from '../port/with/service-bus.js'
import { TabCoordinator, defaultLockManager, defaultChannel, type TabCoordinationOptions, type TabRole, type TabPresence } from '../with-party/tab-coordination.js'
import { CrossTabWriteRelay } from '../with-party/tab-write-relay.js'
import {
  loadKeyring,
  createOwnerKeyring,
  assertKeyringOpenAllowed,
  changeSecret as keyringChangeSecret,
  listUsers as keyringListUsers,
  updateKeyringIdentity,
} from '../with-party/team/keyring.js'
import { NO_TEAM, type TeamStrategy } from '../port/with/team-strategy.js'
import type { UnlockedKeyring } from '../with-party/team/keyring.js'
import {
  type EnrollAuthenticatorOptions,
  type UpdateAuthenticatorOptions,
} from '../with-party/team/authenticators.js'
import { QuickUnlockStore, type QuickUnlockState } from '../with-party/session/unlock-state.js'
import type { KeyringAuthenticator } from './types.js'
import type { SyncEngine } from '../with-party/team/sync.js'
import type { SyncTransaction } from '../with-party/team/sync-transaction.js'
import { NO_SYNC, type SyncStrategy } from '../with-party/team/sync-strategy.js'
import { type SnapshotMeta } from '../with-fork/snapshots/strategy.js'
import { NoydbSnapshots, NO_SNAPSHOTS } from '../with-fork/snapshots/noydb-facade.js'
import type { AmendmentTxOptions } from '../with-commit/tx/transaction.js'
import { TxContext } from '../with-commit/tx/transaction.js'
import type { DryRunResult } from '../with-commit/tx/dry-run.js'
import { NO_TX, type TxStrategy } from '../with-commit/tx/strategy.js'
import { NO_FORGET, type ForgetStrategy } from '../with-audit/forget/strategy.js'
import { NO_CUSTODY, type CustodyStrategy, type CustodyHost } from '../with-party/custody/strategy.js'
import { readDottedPath, coerceSubjectId } from '../with-audit/forget/subject-index.js'
import { INDEXED_STORE_POLICY } from './sync-policy.js'
import { memoryStore } from './memory-store.js'
import type { PolicyEnforcer } from '../with-party/session/session-policy.js'
import { NO_SESSION, type SessionStrategy } from '../with-party/session/strategy.js'
import { TeamFacade } from '../with-party/team/noydb-facade.js'

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
  // FR-6: custodian is operationally admin-rank (rw + access on every
  // collection) — it ranks alongside admin for "how much can this
  // principal see/operate." It is NOT above admin, and explicitly below
  // owner: a custodian can never grant/revoke/rotate/sever (those are
  // owner meta-capabilities), so it must not outrank or equal the owner.
  custodian: 4,
  admin: 4,
  owner: 5,
}

/** Dummy keyring for unencrypted mode. */
function createPlaintextKeyring(userId: string, debugPlaintext = false): UnlockedKeyring {
  return {
    userId,
    displayName: userId,
    role: 'owner',
    permissions: {},
    deks: new Map(),
    kek: null,
    salt: new Uint8Array(0),
    authenticators: [],
    ...(debugPlaintext ? { debugPlaintext } : {}),
  }
}

/** NoydbOptions with the store resolved to a non-optional value (internal use only). */
type ResolvedNoydbOptions = NoydbOptions & { readonly store: NoydbStore }

/** The top-level NOYDB instance. */
export class Noydb {
  private readonly options: ResolvedNoydbOptions
  private readonly emitter = new NoydbEventEmitter()
  private readonly writeQueueTracker = new WriteQueueTracker()
  private readonly writeHooks = new WriteHookRegistry()
  private readonly subsystemBus = new ServiceBus()
  private readonly clientId = generateULID()
  /** Session that owns this instance's writers (one user's writers across vaults). */
  private readonly sessionId: string
  /** Drain-barrier coordination transport for the schema fence. */
  private readonly coordinationProvider: CoordinationProvider
  /** Pre-resolved `vault.user` API factory (mirrors `coordinationProvider` above). Public so `Vault` can call it. */
  readonly userApiFactory: UserApiFactory
  private readonly vaultCache = new Map<string, Vault>()
  /**
   * In-flight `openVault` promise per name — concurrent opens of the same
   * vault must converge on ONE Vault instance. Without this, two callers
   * racing past the `vaultCache` miss each construct a Vault (and later two
   * Collections with independent DEKs for the same store slice), so a record
   * written through one fails decryption through the other with a spurious
   * `TamperedError` (#564).
   */
  private readonly vaultOpening = new Map<string, Promise<Vault>>()
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
  private closed = false
  private sessionTimer: ReturnType<typeof setTimeout> | null = null
  /** Same-device multi-tab coordinator; created on `enableTabCoordination()`. */
  private tabCoordinator: TabCoordinator | undefined
  /** Cross-tab write relay; created on `enableTabCoordination()`. */
  private writeRelay: CrossTabWriteRelay | undefined
  /** Per-vault policy enforcers. */
  private readonly policyEnforcers = new Map<string, PolicyEnforcer>()
  private readonly txStrategy: TxStrategy
  private readonly forgetStrategy: ForgetStrategy
  /**
   * Opt-in sovereign-custody (FR-6) strategy — `NO_CUSTODY` (throwing) unless
   * `withCustody()` was passed. Public so `Vault` routes `vault.custody.liberate`
   * through it; grant/revoke route through it from this class. @internal
   */
  readonly custodyStrategy: CustodyStrategy
  /**
   * Opt-in multi-user team strategy (#267 keyring-grant → team split) —
   * `NO_TEAM` (throwing) unless `withTeam()` was passed; the keyring
   * engines are linked only by the active strategy, not by this file. */
  private readonly teamStrategy: TeamStrategy
  private readonly sessionStrategy: SessionStrategy
  private readonly syncStrategy: SyncStrategy
  private readonly snapshots: NoydbSnapshots
  private readonly policyManager: NoydbPolicyApi
  /** Pre-resolved policy-gate engine function (mirrors `coordinationProvider`/`userApiFactory` above). */
  private readonly policyCheckGate: PolicyCheckGateFn
  private readonly team: TeamFacade
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

  constructor(options: ResolvedNoydbOptions) {
    this.options = options
    // Debug-plaintext is an unencrypted-only inspection mode; combining it with
    // encryption is meaningless and unsafe, so reject the coupling loudly.
    if (options.debugPlaintext === true && options.encrypt !== false) {
      throw new DebugPlaintextError()
    }
    if (options.debugPlaintext === true) {
      console.warn(
        '[noydb] debugPlaintext is ON — records are stored UNENCRYPTED and laid ' +
          'out for native store inspection. NEVER use this for production or client data.',
      )
    }
    this.sessionId = options.sessionId ?? generateULID()
    // createNoydb() always resolves the store-backed default before constructing.
    if (!options.coordinationStrategy) {
      throw new ValidationError(
        'Noydb must be constructed via createNoydb(), which resolves the default coordination provider.',
      )
    }
    this.coordinationProvider = options.coordinationStrategy
    if (!options.userApiFactory) throw new ValidationError('Noydb must be constructed via createNoydb(), which resolves the default user-envelope API factory.')
    this.userApiFactory = options.userApiFactory
    if (!options.policyFactory || !options.policyCheckGateFn) throw new ValidationError('Noydb must be constructed via createNoydb(), which resolves the default policy service.')
    this.policyCheckGate = options.policyCheckGateFn
    this.txStrategy = options.txStrategy ?? NO_TX
    this.forgetStrategy = options.forgetStrategy ?? NO_FORGET
    this.custodyStrategy = options.custodyStrategy ?? NO_CUSTODY
    this.teamStrategy = options.teamStrategy ?? NO_TEAM
    this.sessionStrategy = options.sessionStrategy ?? NO_SESSION
    this.syncStrategy = options.syncStrategy ?? NO_SYNC
    this.snapshots = new NoydbSnapshots({
      strategy: options.snapshotStrategy ?? NO_SNAPSHOTS,
      user: options.user,
      isClosed: () => this.closed,
      getVault: (name) => this.vaultCache.get(name),
      onAfterWrite: (h) => this.onAfterWrite(h),
    })
    this.policyManager = options.policyFactory({
      policyCache: this.policyCache,
      policyEnforcers: this.policyEnforcers,
      store: this.options.store,
      encrypted: this.options.encrypt !== false,
      sessionPolicy: this.options.sessionPolicy,
      policyOption: this.options.policy,
      isClosed: () => this.closed,
      resetSessionTimer: () => this.resetSessionTimer(),
      assertRecoveryEnrolled: (vault, policy, opts) =>
        this.assertRecoveryEnrolled(vault, policy, opts),
      onSessionRevoke: (vault) => {
        this.keyringCache.delete(vault)
        this.vaultCache.delete(vault)
      },
    })
    this.team = new TeamFacade({
      options: this.options,
      keyringCache: this.keyringCache,
      activeTier: this.activeTier,
      quickUnlock: this.quickUnlock,
      policyCache: this.policyCache,
      checkGate: (vault, gate, factors) => this.checkGate(vault, gate, factors),
      checkPolicyOperation: (vault, op) => this.checkPolicyOperation(vault, op),
      getKeyringInternal: (vault, opts) => this._getKeyringInternal(vault, opts),
      assertRecoveryEnrolled: (vault, policy, opts) =>
        this.assertRecoveryEnrolled(vault, policy, opts),
      openVault: (vault, opts) => this.openVault(vault, opts),
      setSkipNextManagedRecoveryCheck: (value) => {
        this._skipNextManagedRecoveryCheck = value
      },
    })
    // Validate sessionPolicy at construction time (developer error if invalid).
    // The strategy's stub throws with a pointer at the subpath if the
    // consumer set a policy without opting in.
    if (options.sessionPolicy) {
      this.sessionStrategy.validateSessionPolicy(options.sessionPolicy)
    }
    this.#registerGuardGate()
    this.#registerPeriodGate()
    this.#registerForgetHooks()
    this.resetSessionTimer()
  }

  /** @internal — resolved forget strategy (NO_FORGET when not configured). */
  get _forgetStrategy(): ForgetStrategy {
    return this.forgetStrategy
  }

  // GDPR subject-index maintenance. When `withForgetCascade` declares
  // any subject fields, keep the encrypted `_subject_index` in lock-step with
  // writes so `vault.forget(subjectId)` can find every record for a subject.
  //
  // Two consumers are required because they cover disjoint events:
  //   - onAfterWrite fires on create/update (NOT delete) — add the new ref;
  //     on an update that changed the subject value, drop the stale ref.
  //   - the subsystemBus `afterDelete` observer fires on delete (onAfterWrite
  //     does NOT) — drop the ref so a deleted record never lingers in the
  //     index (RISK #2). Without it, forget() would try to shred a ghost.
  #registerForgetHooks(): void {
    const subjects = this.forgetStrategy.subjects
    if (Object.keys(subjects).length === 0) return

    const subjectFieldFor = (collection: string): string | undefined => subjects[collection]

    this.writeHooks.onAfterWrite(async (event) => {
      const field = subjectFieldFor(event.collection)
      if (field === undefined) return
      const vault = this.vaultCache.get(event.vault)
      if (!vault) return
      // Add the ref for the new subject value.
      if (event.after !== null && typeof event.after === 'object') {
        const subjectValue = readDottedPath(event.after as Record<string, unknown>, field)
        if (subjectValue !== undefined && subjectValue !== null) {
          await vault._addSubjectRef(coerceSubjectId(subjectValue), { collection: event.collection, id: event.docId })
        }
      }
      // On update, if the subject value changed, drop the stale ref.
      if (event.op === 'update' && event.before !== null && typeof event.before === 'object') {
        const beforeValue = readDottedPath(event.before as Record<string, unknown>, field)
        const afterValue =
          event.after !== null && typeof event.after === 'object'
            ? readDottedPath(event.after as Record<string, unknown>, field)
            : undefined
        const beforeId = beforeValue === undefined || beforeValue === null ? undefined : coerceSubjectId(beforeValue)
        const afterId = afterValue === undefined || afterValue === null ? undefined : coerceSubjectId(afterValue)
        if (beforeId !== undefined && beforeId !== afterId) {
          await vault._removeSubjectRef(beforeId, { collection: event.collection, id: event.docId })
        }
      }
    })

    this.subsystemBus.register('afterDelete', async (event) => {
      const field = subjectFieldFor(event.collection)
      if (field === undefined) return
      const vault = this.vaultCache.get(event.vault)
      if (!vault) return
      if (event.before !== null && typeof event.before === 'object') {
        const subjectValue = readDottedPath(event.before as Record<string, unknown>, field)
        if (subjectValue !== undefined && subjectValue !== null) {
          await vault._removeSubjectRef(coerceSubjectId(subjectValue), { collection: event.collection, id: event.docId })
        }
      }
    })
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
      const { GuardExecutor } = await import('../with-audit/guards/executor.js')
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
   * Register closed-period write guards on the service bus when a
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
   * Touch the policy enforcer for a vault (records activity, resets
   * idle timer). Also touches the legacy session timer. No-op if no enforcer.
   */
  private touchPolicy(vault?: string): void {
    this.policyManager.touchPolicy(vault)
  }

  /**
   * Check that a policy-guarded operation is permitted.
   * Throws `SessionPolicyError` if re-auth is required.
   */
  private checkPolicyOperation(vault: string, op: ReAuthOperation): void {
    this.policyManager.checkPolicyOperation(vault, op)
  }

  /**
   * Open a vault by name.
   *
   * @param name    Vault identifier.
   * @param opts    Optional settings for this session.
   * @param opts.locale  Default locale for i18n/dictKey field resolution
   *. Set here to avoid passing `{ locale }`
   *                     on every individual `get()`/`list()` call.
   * @param opts.meta    Vault descriptive metadata (label, description, etc.). First-wins: applied on first open, ignored on subsequent opens.
   */
  async openVault(
    name: string,
    opts?: { locale?: string; create?: boolean; meta?: VaultMeta },
  ): Promise<Vault> {
    if (this.closed) throw new ValidationError('Instance is closed')
    this.touchPolicy(name)

    let comp = this.vaultCache.get(name)
    if (!comp) {
      // Serialize concurrent opens of the same name (#564): the loser of the
      // race awaits the winner's construction instead of building a second,
      // key-divergent Vault for the same store slice.
      const pending = this.vaultOpening.get(name)
      if (pending) comp = await pending
    }
    if (comp) {
      // Update locale on existing cached vault if specified
      if (opts?.locale !== undefined) {
        comp.setLocale(opts.locale)
      }
      return comp
    }

    const opening = this.#openVaultFresh(name, opts)
    this.vaultOpening.set(name, opening)
    try {
      return await opening
    } finally {
      this.vaultOpening.delete(name)
    }
  }

  /** Uncached single-flight body of {@link openVault} — see `vaultOpening`. */
  async #openVaultFresh(
    name: string,
    opts?: { locale?: string; create?: boolean; meta?: VaultMeta },
  ): Promise<Vault> {
    const keyring = await this._getKeyringInternal(name, { create: opts?.create !== false })
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

    const comp = new Vault({
      adapter: this.options.store,
      name,
      noydb: this,
      keyring,
      encrypted: this.options.encrypt !== false,
      emitter: this.emitter,
      onDirty: targets.length > 0
        ? async (coll, id, action, version) => {
            // Fan out dirty tracking to all sync engines for this vault.
            // 'revert' (satellite fan-out compensation, spec #591) un-dirties
            // instead of tracking a new change.
            for (const [key, engine] of this.syncEngines) {
              if (key === name || key.startsWith(`${name}::`)) {
                if (action === 'revert') void engine.removeDirty(coll, id)
                else void engine.trackChange(coll, id, action, version)
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
      ...(this.options.objectStore !== undefined ? { objectStore: this.options.objectStore } : {}),
      ...(this.options.archiveStrategy !== undefined ? { archiveStrategy: this.options.archiveStrategy } : {}),
      ...(this.options.indexStrategy !== undefined ? { indexStrategy: this.options.indexStrategy } : {}),
      ...(this.options.lazyStrategy !== undefined ? { lazyStrategy: this.options.lazyStrategy } : {}),
      ...(this.options.aggregateStrategy !== undefined ? { aggregateStrategy: this.options.aggregateStrategy } : {}),
      ...(this.options.crdtStrategy !== undefined ? { crdtStrategy: this.options.crdtStrategy } : {}),
      ...(this.options.tiersStrategy !== undefined ? { tiersStrategy: this.options.tiersStrategy } : {}),
      ...(this.options.searchStrategy !== undefined ? { searchStrategy: this.options.searchStrategy } : {}),
      ...(this.options.cargoStrategy !== undefined ? { cargoStrategy: this.options.cargoStrategy } : {}),
      ...(this.options.consentStrategy !== undefined ? { consentStrategy: this.options.consentStrategy } : {}),
      ...(this.options.periodsStrategy !== undefined ? { periodsStrategy: this.options.periodsStrategy } : {}),
      ...(this.options.shadowStrategy !== undefined ? { shadowStrategy: this.options.shadowStrategy } : {}),
      ...(this.options.historyStrategy !== undefined ? { historyStrategy: this.options.historyStrategy } : {}),
      ...(this.options.i18nStrategy !== undefined ? { i18nStrategy: this.options.i18nStrategy } : {}),
      ...(this.options.syncStrategy !== undefined ? { syncStrategy: this.options.syncStrategy } : {}),
      ...(this.options.guardStrategies !== undefined ? { guardStrategies: this.options.guardStrategies } : {}),
      ...(this.options.numbering !== undefined ? { numberingConfigs: this.options.numbering } : {}),
      forgetStrategy: this.forgetStrategy,
      ...(this.options.attestationStrategy !== undefined ? { attestationStrategy: this.options.attestationStrategy } : {}),
      ...(this.options.classifiedStrategy !== undefined ? { classifiedStrategy: this.options.classifiedStrategy } : {}),
      ...(this.options.sealedRecordStrategy !== undefined ? { sealedRecordStrategy: this.options.sealedRecordStrategy } : {}),
      ...(this.options.portabilityStrategy !== undefined ? { portabilityStrategy: this.options.portabilityStrategy } : {}),
      ...(this.options.sequenceStrategy !== undefined ? { sequenceStrategy: this.options.sequenceStrategy } : {}),
      locale: opts?.locale,
      ...(opts?.meta !== undefined ? { meta: opts.meta } : {}),
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
    // #598: sync-applied writes must refresh Collection in-memory views.
    this._forEachSyncEngine(name, engine => {
      engine.setCacheInvalidator((collection, id) => comp._invalidateSyncApplied(collection, id))
    })
    // Initialise the optional guard + derivation registries via
    // dynamic-import. Both calls are no-ops when the corresponding
    // strategies array is empty / unset, leaving the service code
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
      const keyring = createPlaintextKeyring(this.options.user, this.options.debugPlaintext === true)
      const comp = new Vault({
        adapter: this.options.store,
        name,
        noydb: this,
        keyring,
        encrypted: false,
        emitter: this.emitter,
        historyConfig: this.options.history,
      ...(this.options.blobStrategy !== undefined ? { blobStrategy: this.options.blobStrategy } : {}),
      ...(this.options.objectStore !== undefined ? { objectStore: this.options.objectStore } : {}),
      ...(this.options.archiveStrategy !== undefined ? { archiveStrategy: this.options.archiveStrategy } : {}),
      ...(this.options.indexStrategy !== undefined ? { indexStrategy: this.options.indexStrategy } : {}),
      ...(this.options.lazyStrategy !== undefined ? { lazyStrategy: this.options.lazyStrategy } : {}),
      ...(this.options.aggregateStrategy !== undefined ? { aggregateStrategy: this.options.aggregateStrategy } : {}),
      ...(this.options.crdtStrategy !== undefined ? { crdtStrategy: this.options.crdtStrategy } : {}),
      ...(this.options.tiersStrategy !== undefined ? { tiersStrategy: this.options.tiersStrategy } : {}),
      ...(this.options.searchStrategy !== undefined ? { searchStrategy: this.options.searchStrategy } : {}),
      ...(this.options.cargoStrategy !== undefined ? { cargoStrategy: this.options.cargoStrategy } : {}),
      ...(this.options.consentStrategy !== undefined ? { consentStrategy: this.options.consentStrategy } : {}),
      ...(this.options.periodsStrategy !== undefined ? { periodsStrategy: this.options.periodsStrategy } : {}),
      ...(this.options.shadowStrategy !== undefined ? { shadowStrategy: this.options.shadowStrategy } : {}),
      ...(this.options.historyStrategy !== undefined ? { historyStrategy: this.options.historyStrategy } : {}),
      ...(this.options.i18nStrategy !== undefined ? { i18nStrategy: this.options.i18nStrategy } : {}),
      ...(this.options.syncStrategy !== undefined ? { syncStrategy: this.options.syncStrategy } : {}),
      ...(this.options.guardStrategies !== undefined ? { guardStrategies: this.options.guardStrategies } : {}),
      ...(this.options.numbering !== undefined ? { numberingConfigs: this.options.numbering } : {}),
      forgetStrategy: this.forgetStrategy,
      ...(this.options.attestationStrategy !== undefined ? { attestationStrategy: this.options.attestationStrategy } : {}),
      ...(this.options.classifiedStrategy !== undefined ? { classifiedStrategy: this.options.classifiedStrategy } : {}),
      ...(this.options.sealedRecordStrategy !== undefined ? { sealedRecordStrategy: this.options.sealedRecordStrategy } : {}),
      ...(this.options.portabilityStrategy !== undefined ? { portabilityStrategy: this.options.portabilityStrategy } : {}),
      ...(this.options.sequenceStrategy !== undefined ? { sequenceStrategy: this.options.sequenceStrategy } : {}),
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
      ...(this.options.objectStore !== undefined ? { objectStore: this.options.objectStore } : {}),
      ...(this.options.archiveStrategy !== undefined ? { archiveStrategy: this.options.archiveStrategy } : {}),
      ...(this.options.indexStrategy !== undefined ? { indexStrategy: this.options.indexStrategy } : {}),
      ...(this.options.lazyStrategy !== undefined ? { lazyStrategy: this.options.lazyStrategy } : {}),
      ...(this.options.aggregateStrategy !== undefined ? { aggregateStrategy: this.options.aggregateStrategy } : {}),
      ...(this.options.crdtStrategy !== undefined ? { crdtStrategy: this.options.crdtStrategy } : {}),
      ...(this.options.tiersStrategy !== undefined ? { tiersStrategy: this.options.tiersStrategy } : {}),
      ...(this.options.searchStrategy !== undefined ? { searchStrategy: this.options.searchStrategy } : {}),
      ...(this.options.cargoStrategy !== undefined ? { cargoStrategy: this.options.cargoStrategy } : {}),
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
   * Opt-in (#267): throws {@link TeamNotEnabledError} without `withTeam()`.
   */
  async grant(
    vault: string,
    options: GrantOptions,
    factors?: FactorProofBundle,
  ): Promise<void> {
    return this.teamStrategy.grant(this.team, vault, options, factors)
  }

  /**
   * Revoke a user's access to a vault.
   *
   * Gated by `revoke-user`. `STRICT_POLICY` requires a TOTP / email-OTP
   * factor proof; `PERSONAL_POLICY` accepts a tier-1 unlock alone.
   *
   * The legacy `requireReAuthFor: ['revoke']` session-policy check still
   * fires on top — both are independent opt-ins.
   * Opt-in (#267): throws {@link TeamNotEnabledError} without `withTeam()`.
   */
  async revoke(
    vault: string,
    options: RevokeOptions,
    factors?: FactorProofBundle,
  ): Promise<void> {
    return this.teamStrategy.revoke(this.team, vault, options, factors)
  }

  /**
   * Grant the FR-6 `custodian` role to a user (owner-only custody API).
   *
   * A custodian operates every collection (rw + access) but is provably
   * unable to grant / revoke / rotate / extract-and-sever. Only the Deed
   * owner may mint one. Defended in depth: the `grant-custodian` gate
   * (fail-closed) AND an explicit `keyring.role !== 'owner'` check — the
   * gate enforces host policy, the role check enforces the cryptographic
   * owner-only invariant even if a host mis-configures the gate.
   */
  async grantCustodian(
    vault: string,
    options: Omit<GrantOptions, 'role'>,
    factors?: FactorProofBundle,
  ): Promise<void> {
    // Opt-in gate (S4): NO_CUSTODY throws CustodyNotEnabledError unless
    // `custodyStrategy: withCustody()` was passed; withCustody() runs the impl.
    return this.custodyStrategy.grantCustodian(this as CustodyHost, vault, options, factors)
  }

  /** @internal — grant-custodian engine, reached only via withCustody(); the
   * keyring engine arrives as an argument so the floor never carries it (#267). */
  async _grantCustodianImpl(
    engine: (adapter: NoydbStore, vault: string, callerKeyring: UnlockedKeyring, options: GrantOptions) => Promise<void>,
    vault: string,
    options: Omit<GrantOptions, 'role'>,
    factors?: FactorProofBundle,
  ): Promise<void> {
    this.checkPolicyOperation(vault, 'grant')
    await this.checkGate(vault, 'grant-custodian', factors)
    const keyring = await this._getKeyringInternal(vault)
    if (keyring.role !== 'owner') throw new PermissionDeniedError('only the Deed owner can grant a custodian')
    await engine(this.options.store, vault, keyring, { ...options, role: 'custodian' })
  }

  /**
   * Revoke a custodian (owner-only custody API).
   *
   * Mirrors {@link revoke} but pins the caller to the Deed owner: defended
   * in depth by the `revoke-user` gate AND an explicit `keyring.role !==
   * 'owner'` check, so an admin cannot unwind a custodianship.
   */
  async revokeCustodian(
    vault: string,
    options: RevokeOptions,
    factors?: FactorProofBundle,
  ): Promise<void> {
    // Opt-in gate (S4): NO_CUSTODY throws unless withCustody() was opted in.
    return this.custodyStrategy.revokeCustodian(this as CustodyHost, vault, options, factors)
  }

  /** @internal — revoke-custodian engine, reached only via withCustody().
   * Mirrors `_grantCustodianImpl` (#267: engine passed in). */
  async _revokeCustodianImpl(
    engine: (adapter: NoydbStore, vault: string, callerKeyring: UnlockedKeyring, options: RevokeOptions) => Promise<void>,
    vault: string,
    options: RevokeOptions,
    factors?: FactorProofBundle,
  ): Promise<void> {
    this.checkPolicyOperation(vault, 'revoke')
    await this.checkGate(vault, 'revoke-user', factors)
    const keyring = await this._getKeyringInternal(vault)
    if (keyring.role !== 'owner') throw new PermissionDeniedError('only the Deed owner can revoke a custodian')
    await engine(this.options.store, vault, keyring, options)
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
    const keyring = await this._getKeyringInternal(vault)
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
   * Opt-in (#267): throws {@link TeamNotEnabledError} without `withTeam()`.
   */
  async rotate(vault: string, collections: string[]): Promise<void> {
    return this.teamStrategy.rotate(this.team, vault, collections)
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
   * @internal True once `close()` has been called. Read by outward
   * orchestration frameworks whose entry points can't see the private
   * `closed` field.
   */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * @internal — true when an encrypted shard vault is provisioned
   * (its keyring exists in the store).
   */
  async _shardVaultProvisioned(vaultId: string): Promise<boolean> {
    return (await this.options.store.list(vaultId, '_keyring')).length > 0
  }

  /**
   * @internal — the physical backend store a vault id maps to. A
   * `routeStore` resolves the vault-prefix route via its `resolveBackend`;
   * a plain store is its own backend. Used by the federation data-residency
   * guard to read the placement backend's `capabilities.region`.
   */
  _resolveBackend(vaultId: string): NoydbStore {
    const store = this.options.store as NoydbStore & {
      resolveBackend?: (vaultId: string) => NoydbStore
    }
    return store.resolveBackend ? store.resolveBackend(vaultId) : this.options.store
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
    const keyring = await this._getKeyringInternal(vault)
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

  private getSyncEngine(vault: string): SyncEngine {
    const engine = this.syncEngines.get(vault)
    if (!engine) {
      throw new ValidationError('No sync adapter configured. Pass a `sync` adapter to createNoydb().')
    }
    return engine
  }

  _forEachSyncEngine(vault: string, fn: (engine: SyncEngine) => void): void {
    for (const [key, engine] of this.syncEngines) if (key === vault || key.startsWith(`${vault}::`)) fn(engine)
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
  get _subsystemBus(): ServiceBus {
    return this.subsystemBus
  }

  /** @internal Stable per-instance id for schema-cutover coordination. */
  get _clientId(): string {
    return this.clientId
  }

  /** @internal Session that owns this instance's writers. */
  get _sessionId(): string {
    return this.sessionId
  }

  /**
   * @internal Drain-barrier coordination transport for the schema fence.
   * The default store-backed provider reproduces today's fence behavior; a
   * `by-*` real-time transport is injected via `coordinationStrategy`.
   */
  get coordination(): CoordinationProvider {
    return this.coordinationProvider
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
    this.snapshots.stop()
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
    for (const v of this.vaultCache.values()) void v._flushSearchIndexes() // best-effort flush
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
    return this.policyManager.getPolicy(vault)
  }

  /**
   * Replace the policy document at `_meta/policy` and update the
   * in-memory cache. Gated by the `enroll-user` policy (a policy
   * change is fundamentally a privilege-management action).
   */
  async updatePolicy(vault: string, override: Partial<VaultPolicy>): Promise<VaultPolicy> {
    return this.policyManager.updatePolicy(vault, override)
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
   * `https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/user-envelope.md` → "Directory visibility".
   */
  async setDirectoryEnabled(vault: string, enabled: boolean): Promise<void> {
    if (this.closed) throw new ValidationError('Instance is closed')
    const keyring = await this._getKeyringInternal(vault)
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
    await this.policyCheckGate(policy, gate, {
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
    return this.policyManager.bootstrapPolicy(vault, opts)
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
  /** Add a tier-2 authenticator slot — see {@link TeamFacade.enrollAuthenticator}. */
  async enrollAuthenticator(
    vault: string,
    options: EnrollAuthenticatorOptions,
    factors?: FactorProofBundle,
  ): Promise<void> {
    return this.team.enrollAuthenticator(vault, options, factors)
  }

  /** Remove a tier-2 authenticator slot — see {@link TeamFacade.removeAuthenticator}. */
  async removeAuthenticator(
    vault: string,
    slotId: string,
    factors?: FactorProofBundle,
  ): Promise<void> {
    return this.team.removeAuthenticator(vault, slotId, factors)
  }

  /** Read the slot list for a vault — see {@link TeamFacade.listAuthenticators}. */
  async listAuthenticators(vault: string): Promise<ReadonlyArray<KeyringAuthenticator>> {
    return this.team.listAuthenticators(vault)
  }

  /** Mutate an authenticator slot's `meta` — see {@link TeamFacade.updateAuthenticator}. */
  async updateAuthenticator(
    vault: string,
    slotId: string,
    options: UpdateAuthenticatorOptions,
    factors?: FactorProofBundle,
  ): Promise<void> {
    return this.team.updateAuthenticator(vault, slotId, options, factors)
  }

  /** Native WebAuthn enrollment — see {@link TeamFacade.enrollWebAuthn}. */
  async enrollWebAuthn(
    vault: string,
    ceremony: (keyring: UnlockedKeyring) => Promise<EnrollAuthenticatorOptions>,
    factors?: FactorProofBundle,
  ): Promise<{ credentialId: string }> {
    return this.team.enrollWebAuthn(vault, ceremony, factors)
  }

  /** List webauthn-method slots — see {@link TeamFacade.listWebAuthnSlots}. */
  async listWebAuthnSlots(vault: string): Promise<ReadonlyArray<{
    id: string
    enrolledAt: string
    credentialId: string
  }>> {
    return this.team.listWebAuthnSlots(vault)
  }

  /** Unlock via a tier-2 authenticator slot — see {@link TeamFacade.unlockViaAuthenticator}. */
  async unlockViaAuthenticator(
    vault: string,
    slotId: string,
    verify: (slot: KeyringAuthenticator) => Promise<UnlockedKeyring>,
  ): Promise<UnlockedKeyring> {
    return this.team.unlockViaAuthenticator(vault, slotId, verify)
  }

  // ─── Public envelope (https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/public-envelope.md) ──────
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
    if (!this.options.publicEnvelope) {
      throw new ValidationError(
        'setPublicEnvelope: the public-envelope feature is not enabled. ' +
          'Pass `publicEnvelope: true` (or a schema object) to `createNoydb`.',
      )
    }
    const { loadPublicEnvelope, savePublicEnvelope, resolveSchema, validatePublicEnvelopeInput } =
      await import('../with-party/directory/public-envelope/index.js')
    const schema = resolveSchema(this.options.publicEnvelope)!
    validatePublicEnvelopeInput(input, schema)

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
    const { readPublicEnvelope } = await import('../with-party/directory/public-envelope/index.js')
    return readPublicEnvelope(this.options.store, vault, opts)
  }

  // ─── Auth introspection ─────────────────────────────────────────
  /** English summary of the configured auth model — see {@link TeamFacade.describeAuthConfig}. */
  async describeAuthConfig(vault: string): Promise<string> {
    return this.team.describeAuthConfig(vault)
  }

  /** Mermaid `flowchart TB` source for the auth graph — see {@link TeamFacade.diagramAuthConfig}. */
  async diagramAuthConfig(vault: string): Promise<string> {
    return this.team.diagramAuthConfig(vault)
  }

  /** Per-user enrollment summary — see {@link TeamFacade.describeUserAuth}. */
  async describeUserAuth(
    vault: string,
    userId: string,
    factors?: FactorProofBundle,
  ): Promise<string> {
    return this.team.describeUserAuth(vault, userId, factors)
  }

  /** Bulk per-user enrollment summary — see {@link TeamFacade.describeAllUsersAuth}. */
  async describeAllUsersAuth(
    vault: string,
    factors?: FactorProofBundle,
  ): Promise<Array<{ userId: string; description: string }>> {
    return this.team.describeAllUsersAuth(vault, factors)
  }

  // ─── Tier-1 change flows ────────────────────────────────────────
  /** Rotate the user's passphrase (user remembers old) — see {@link TeamFacade.rotatePassphrase}. */
  async rotatePassphrase(
    vault: string,
    input: RotatePassphraseInput,
    factors?: FactorProofBundle,
  ): Promise<void> {
    return this.team.rotatePassphrase(vault, input, factors)
  }

  /** Reset the passphrase using a recovery proof — see {@link TeamFacade.recoverPassphrase}. */
  async recoverPassphrase(
    vault: string,
    input: RecoverPassphraseInput,
    factors?: FactorProofBundle,
  ): Promise<RecoverPassphraseResult> {
    return this.team.recoverPassphrase(vault, input, factors)
  }

  /** Deliberate paper/Shamir recovery-code regeneration — see {@link TeamFacade.rotateRecovery}. */
  async rotateRecovery(
    vault: string,
    options: RotateRecoveryOptions,
    factors?: FactorProofBundle,
  ): Promise<RotateRecoveryResult> {
    return this.team.rotateRecovery(vault, options, factors)
  }

  /** Atomic create-and-enroll for managed-mode vaults — see {@link TeamFacade.openVaultAndEnrollRecovery}. */
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
    return this.team.openVaultAndEnrollRecovery(vault, opts)
  }

  /** Recovery flow under managed-passphrase mode — see {@link TeamFacade.recoverManagedPassphrase}. */
  async recoverManagedPassphrase(
    vault: string,
    options: {
      readonly recoveryProof: RecoveryProof
      readonly passphrasePolicy?: PassphrasePolicy
    },
  ): Promise<void> {
    return this.team.recoverManagedPassphrase(vault, options)
  }

  /** Atomic peer-recovery of an existing user's keyring — see {@link TeamFacade.recoverUser}. */
  async recoverUser(
    vault: string,
    options: RecoverUserOptions,
    factors?: FactorProofBundle,
  ): Promise<void> {
    return this.team.recoverUser(vault, options, factors)
  }

  /** Persist a recovery enrollment (paper or Shamir) — see {@link TeamFacade.enrollRecovery}. */
  async enrollRecovery(
    vault: string,
    enrollment: RecoveryEnrollmentInput,
  ): Promise<EnrollRecoveryResult> {
    return this.team.enrollRecovery(vault, enrollment)
  }

  /** Read the persisted recovery entries (paper + Shamir) — see {@link TeamFacade.listRecoveryEntries}. */
  async listRecoveryEntries(
    vault: string,
  ): Promise<{
    paper: ReadonlyArray<PaperRecoveryEntry>
    shamir: ReadonlyArray<ShamirRecoveryEntry>
  }> {
    return this.team.listRecoveryEntries(vault)
  }

  // ─── Tier-3 enroll / unlock ─────────────────────────────────────
  /** Register a tier-3 quick-unlock state — see {@link TeamFacade.enrollUnlock}. */
  async enrollUnlock(
    vault: string,
    state: QuickUnlockState,
    factors?: FactorProofBundle,
  ): Promise<void> {
    return this.team.enrollUnlock(vault, state, factors)
  }

  /** Resume a session via the registered tier-3 state — see {@link TeamFacade.unlockViaPin}. */
  async unlockViaPin(
    vault: string,
    resume: (state: QuickUnlockState) => Promise<UnlockedKeyring>,
  ): Promise<UnlockedKeyring | undefined> {
    return this.team.unlockViaPin(vault, resume)
  }

  /** Drop the tier-3 state for a vault — see {@link TeamFacade.clearQuickUnlock}. */
  clearQuickUnlock(vault: string): void {
    this.team.clearQuickUnlock(vault)
  }

  /** Public defensive-copy accessor for the unlocked keyring — see {@link TeamFacade.getKeyring}. */
  async getKeyring(vault: string): Promise<UnlockedKeyring> {
    return this.team.getKeyring(vault)
  }

  /**
   * Live-reference variant used by the hub's own code paths. Internal
   * mutations on `deks` (e.g. {@link ensureCollectionDEK} adding a
   * collection key) need to land on the cached keyring so subsequent
   * accesses see them. Not exposed publicly — callers outside hub
   * should use {@link getKeyring}, which returns a defensive copy.
   */
  private async _getKeyringInternal(
    vault: string,
    opts: { create: boolean } = { create: true },
  ): Promise<UnlockedKeyring> {
    if (this.options.encrypt === false) {
      return createPlaintextKeyring(this.options.user, this.options.debugPlaintext === true)
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

    // Pre-gate: refuse to self-provision into a vault held by other
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
    return this.snapshots.snapshot(vault, opts)
  }

  /**
   * List all snapshots for the given vault, newest first.
   * Reads only the sidecar index — does not download snapshot bytes.
   */
  async listSnapshots(vault: string): Promise<SnapshotMeta[]> {
    return this.snapshots.listSnapshots(vault)
  }

  /**
   * Restore the vault to a previously snapshotted state.
   * Runs `verifyBackupIntegrity()` automatically on restore.
   * @throws SnapshotNotFoundError when `version` doesn't exist in the store
   * @throws ValidationError when the vault is not open
   */
  async restoreSnapshot(vault: string, version: string): Promise<void> {
    return this.snapshots.restoreSnapshot(vault, version)
  }
}

/** Create a new NOYDB instance. */
export async function createNoydb(options: NoydbOptions): Promise<Noydb> {
  if (!options.store) options = { ...options, store: memoryStore() }
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

  if (!options.coordinationStrategy) options = { ...options, coordinationStrategy: await createDefaultCoordinationProvider(options.store!) }
  if (!options.userApiFactory) options = { ...options, userApiFactory: (await import('../with-party/directory/user-envelope/api.js')).createUserApi }
  if (!options.policyFactory) {
    const policyModule = await import('../with-party/policy/index.js')
    options = { ...options, policyFactory: policyModule.createNoydbPolicy, policyCheckGateFn: policyModule.checkGate }
  }

  return new Noydb(options as ResolvedNoydbOptions)
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
