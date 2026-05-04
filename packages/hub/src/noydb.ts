import type {
  NoydbOptions,
  NoydbEventMap,
  GrantOptions,
  RevokeOptions,
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
} from './types.js'
import { ValidationError, NoAccessError, InvalidKeyError, StoreCapabilityError } from './errors.js'
import {
  rotatePassphrase as keyringRotatePassphrase,
  recoverPassphrase as keyringRecoverPassphrase,
  type RotatePassphraseInput,
  type RecoverPassphraseInput,
  type RecoveryProof,
} from './team/rotate-recover.js'
import {
  loadPaperRecoveryEntries,
  savePaperRecoveryEntries,
  hasRecoveryEnrolled,
  type PaperRecoveryEntry,
} from './team/recovery.js'
import { RecoveryNotEnrolledError } from './policy/errors.js'
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
import {
  loadKeyring,
  createOwnerKeyring,
  grant as keyringGrant,
  revoke as keyringRevoke,
  rotateKeys as keyringRotate,
  changeSecret as keyringChangeSecret,
  listUsers as keyringListUsers,
} from './team/keyring.js'
import type { UnlockedKeyring } from './team/keyring.js'
import {
  enrollAuthenticator as keyringEnrollAuthenticator,
  removeAuthenticator as keyringRemoveAuthenticator,
  findAuthenticator,
  type EnrollAuthenticatorOptions,
} from './team/authenticators.js'
import { QuickUnlockStore, type QuickUnlockState } from './session/unlock-state.js'
import type { KeyringAuthenticator } from './types.js'
import type { SyncEngine } from './team/sync.js'
import type { SyncTransaction } from './team/sync-transaction.js'
import { NO_SYNC, type SyncStrategy } from './team/sync-strategy.js'
import type { TxContext } from './tx/transaction.js'
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
  type FactorProof,
  type GateName,
  type VaultPolicy,
} from './policy/index.js'

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
    kek: null as unknown as CryptoKey,
    salt: new Uint8Array(0),
    authenticators: [],
  }
}

/** The top-level NOYDB instance. */
export class Noydb {
  private readonly options: NoydbOptions
  private readonly emitter = new NoydbEventEmitter()
  private readonly vaultCache = new Map<string, Vault>()
  private readonly keyringCache = new Map<string, UnlockedKeyring>()
  private readonly syncEngines = new Map<string, SyncEngine>()
  /**
   * Per-vault active session tier — defaults to `1` after a passphrase
   * unlock; tier-2 / tier-3 unlocks (issue #11) downgrade it. Used by
   * {@link checkGate} to evaluate `gate.minTier`.
   */
  private readonly activeTier = new Map<string, ActiveTier>()
  /**
   * Per-vault loaded policy. Cached after the first
   * `_meta/policy` load; replaced by `db.updatePolicy()`.
   */
  private readonly policyCache = new Map<string, VaultPolicy>()
  /** Per-vault tier-3 (PIN / quick-resume) state — issue #11. */
  private readonly quickUnlock = new QuickUnlockStore()
  /**
   * Resolved public-envelope schema. Lazily computed once from
   * `NoydbOptions.publicEnvelope`; `undefined` when the developer
   * didn't opt in.
   */
  private readonly publicEnvelopeSchema: ResolvedPublicEnvelopeSchema | undefined
  private closed = false
  private sessionTimer: ReturnType<typeof setTimeout> | null = null
  /** Per-vault policy enforcers. */
  private readonly policyEnforcers = new Map<string, PolicyEnforcer>()
  private readonly txStrategy: TxStrategy
  private readonly sessionStrategy: SessionStrategy
  private readonly syncStrategy: SyncStrategy

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
    this.publicEnvelopeSchema = resolvePublicEnvelopeSchema(options.publicEnvelope)
    // Validate sessionPolicy at construction time (developer error if invalid).
    // The strategy's stub throws with a pointer at the subpath if the
    // consumer set a policy without opting in.
    if (options.sessionPolicy) {
      this.sessionStrategy.validateSessionPolicy(options.sessionPolicy)
    }
    this.resetSessionTimer()
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
    opts?: { locale?: string },
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

    const keyring = await this.getKeyring(name)
    // Tier-1 unlock — passphrase / getKeyring callbacks both yield the
    // most-privileged tier. Tier-2 / tier-3 unlocks (issue #11) install
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
      ...(this.options.indexStrategy !== undefined ? { indexStrategy: this.options.indexStrategy } : {}),
      ...(this.options.aggregateStrategy !== undefined ? { aggregateStrategy: this.options.aggregateStrategy } : {}),
      ...(this.options.crdtStrategy !== undefined ? { crdtStrategy: this.options.crdtStrategy } : {}),
      ...(this.options.consentStrategy !== undefined ? { consentStrategy: this.options.consentStrategy } : {}),
      ...(this.options.periodsStrategy !== undefined ? { periodsStrategy: this.options.periodsStrategy } : {}),
      ...(this.options.shadowStrategy !== undefined ? { shadowStrategy: this.options.shadowStrategy } : {}),
      ...(this.options.historyStrategy !== undefined ? { historyStrategy: this.options.historyStrategy } : {}),
      ...(this.options.i18nStrategy !== undefined ? { i18nStrategy: this.options.i18nStrategy } : {}),
      ...(this.options.syncStrategy !== undefined ? { syncStrategy: this.options.syncStrategy } : {}),
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
      ...(this.options.indexStrategy !== undefined ? { indexStrategy: this.options.indexStrategy } : {}),
      ...(this.options.aggregateStrategy !== undefined ? { aggregateStrategy: this.options.aggregateStrategy } : {}),
      ...(this.options.crdtStrategy !== undefined ? { crdtStrategy: this.options.crdtStrategy } : {}),
      ...(this.options.consentStrategy !== undefined ? { consentStrategy: this.options.consentStrategy } : {}),
      ...(this.options.periodsStrategy !== undefined ? { periodsStrategy: this.options.periodsStrategy } : {}),
      ...(this.options.shadowStrategy !== undefined ? { shadowStrategy: this.options.shadowStrategy } : {}),
      ...(this.options.historyStrategy !== undefined ? { historyStrategy: this.options.historyStrategy } : {}),
      ...(this.options.i18nStrategy !== undefined ? { i18nStrategy: this.options.i18nStrategy } : {}),
      ...(this.options.syncStrategy !== undefined ? { syncStrategy: this.options.syncStrategy } : {}),
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
      ...(this.options.indexStrategy !== undefined ? { indexStrategy: this.options.indexStrategy } : {}),
      ...(this.options.aggregateStrategy !== undefined ? { aggregateStrategy: this.options.aggregateStrategy } : {}),
      ...(this.options.crdtStrategy !== undefined ? { crdtStrategy: this.options.crdtStrategy } : {}),
      ...(this.options.consentStrategy !== undefined ? { consentStrategy: this.options.consentStrategy } : {}),
      ...(this.options.periodsStrategy !== undefined ? { periodsStrategy: this.options.periodsStrategy } : {}),
      ...(this.options.shadowStrategy !== undefined ? { shadowStrategy: this.options.shadowStrategy } : {}),
      ...(this.options.historyStrategy !== undefined ? { historyStrategy: this.options.historyStrategy } : {}),
      ...(this.options.i18nStrategy !== undefined ? { i18nStrategy: this.options.i18nStrategy } : {}),
      ...(this.options.syncStrategy !== undefined ? { syncStrategy: this.options.syncStrategy } : {}),
      emitter: this.emitter,
    })
    this.vaultCache.set(name, comp)
    return comp
  }

  /** Grant access to a user for a vault. */
  async grant(vault: string, options: GrantOptions): Promise<void> {
    this.checkPolicyOperation(vault, 'grant')
    const keyring = await this.getKeyring(vault)
    await keyringGrant(this.options.store, vault, keyring, options)
  }

  /** Revoke a user's access to a vault. */
  async revoke(vault: string, options: RevokeOptions): Promise<void> {
    this.checkPolicyOperation(vault, 'revoke')
    const keyring = await this.getKeyring(vault)
    await keyringRevoke(this.options.store, vault, keyring, options)
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
    const keyring = await this.getKeyring(vault)
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
        if (err instanceof NoAccessError || err instanceof InvalidKeyError) {
          continue // silent: caller has no key material for this vault
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
          const comp = await this.openVault(vaultId)
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

  /** Change the current user's passphrase for a vault. */
  async changeSecret(vault: string, newPassphrase: string): Promise<void> {
    this.checkPolicyOperation(vault, 'changeSecret')
    const keyring = await this.getKeyring(vault)
    const updated = await keyringChangeSecret(
      this.options.store,
      vault,
      keyring,
      newPassphrase,
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
   * Create a sync transaction for the given vault.
   * The vault must already be open via `openVault()`.
   * Call `tx.put()` / `tx.delete()` to stage changes, then `tx.commit()`
   * to write all locally and push atomically to remote.
   */
  transaction(vault: string): SyncTransaction
  transaction<T>(
    arg: string | ((tx: TxContext) => Promise<T> | T),
  ): SyncTransaction | Promise<T> {
    if (typeof arg === 'function') {
      return this.txStrategy.runTransaction(this, arg)
    }
    const vault = arg
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

  // ─── Events ────────────────────────────────────────────────────

  on<K extends keyof NoydbEventMap>(event: K, handler: (data: NoydbEventMap[K]) => void): void {
    this.emitter.on(event, handler)
  }

  off<K extends keyof NoydbEventMap>(event: K, handler: (data: NoydbEventMap[K]) => void): void {
    this.emitter.off(event, handler)
  }

  close(): void {
    this.closed = true
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
    presented?: { factors?: ReadonlyArray<FactorProof>; sharedDevice?: boolean },
  ): Promise<void> {
    const policy = await this.getPolicy(vault)
    const tier = this.activeTier.get(vault) ?? 1
    await policyCheckGate(policy, gate, {
      activeTier: tier,
      ...(presented?.factors !== undefined ? { factors: presented.factors } : {}),
      ...(presented?.sharedDevice !== undefined
        ? { sharedDevice: presented.sharedDevice }
        : {}),
    })
  }

  /** Read or persist the vault policy at `_meta/policy` on first open. */
  private async bootstrapPolicy(vault: string): Promise<void> {
    const onDisk = await loadVaultPolicy(this.options.store, vault)
    if (onDisk) {
      // Honour the on-disk document; developer overrides cannot
      // weaken what the vault committed to at creation time.
      this.policyCache.set(vault, onDisk)
      await this.assertRecoveryEnrolled(vault, onDisk)
      return
    }
    // First time — persist the developer's policy (or default preset).
    const initial = this.options.policy
      ? mergePolicy(PERSONAL_POLICY, this.options.policy)
      : PERSONAL_POLICY
    await saveVaultPolicy(this.options.store, vault, initial)
    this.policyCache.set(vault, initial)
    await this.assertRecoveryEnrolled(vault, initial)
  }

  /**
   * Throw {@link RecoveryNotEnrolledError} when the developer
   * explicitly opts into strict mandatory-recovery enforcement
   * (`createNoydb({ requireRecovery: true })`) and no recovery
   * entries are persisted.
   *
   * The default behavior is lenient — `recover-passphrase` is enabled
   * in `PERSONAL_POLICY` but the hub does not block vault open on
   * missing enrollment. v1.0 will flip the default to strict; for now,
   * apps that want the spec-mandated check turn it on per-vault.
   */
  private async assertRecoveryEnrolled(vault: string, policy: VaultPolicy): Promise<void> {
    if (this.options.requireRecovery !== true) return
    const gate = policy.gates['recover-passphrase']
    if (gate?.enabled === false) return
    const enrolled = await hasRecoveryEnrolled(this.options.store, vault)
    if (enrolled) return
    throw new RecoveryNotEnrolledError()
  }

  /**
   * Internal accessor used by tier-2/tier-3 unlock paths (issue #11)
   * to mark the active session tier.
   * @internal
   */
  _setActiveTier(vault: string, tier: ActiveTier): void {
    this.activeTier.set(vault, tier)
  }

  // ─── Tier-2 enroll / remove (issue #11) ────────────────────────
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
    presented?: { factors?: ReadonlyArray<FactorProof>; sharedDevice?: boolean },
  ): Promise<void> {
    await this.checkGate(vault, 'enroll-authenticator', presented)
    const keyring = await this.getKeyring(vault)
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
    presented?: { factors?: ReadonlyArray<FactorProof>; sharedDevice?: boolean },
  ): Promise<void> {
    await this.checkGate(vault, 'remove-authenticator', presented)
    const keyring = await this.getKeyring(vault)
    const next = await keyringRemoveAuthenticator(this.options.store, vault, keyring, slotId)
    this.keyringCache.set(vault, next)
  }

  /** Read the slot list for a vault. Internal — `describeAuthConfig` (#13) consumes this. */
  async listAuthenticators(vault: string): Promise<ReadonlyArray<KeyringAuthenticator>> {
    const keyring = await this.getKeyring(vault)
    return keyring.authenticators
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
    const keyring = await this.getKeyring(vault)
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

  // ─── Auth introspection (issue #13) ────────────────────────────
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
    factors?: { factors?: ReadonlyArray<FactorProof>; sharedDevice?: boolean },
  ): Promise<string> {
    await this.checkGate(vault, 'view-user-auth', factors)
    return fnDescribeUserAuth(this.options.store, vault, userId)
  }

  /** Bulk variant for owner dashboards. Gated by `view-user-auth`. */
  async describeAllUsersAuth(
    vault: string,
    factors?: { factors?: ReadonlyArray<FactorProof>; sharedDevice?: boolean },
  ): Promise<Array<{ userId: string; description: string }>> {
    await this.checkGate(vault, 'view-user-auth', factors)
    return fnDescribeAllUsersAuth(this.options.store, vault)
  }

  // ─── Tier-1 change flows (issue #10) ───────────────────────────
  /**
   * Rotate the user's passphrase (user remembers old). Validates the
   * new phrase against the configured `passphrase` policy, runs the
   * `rotate-passphrase` gate, then re-derives + re-wraps every DEK.
   *
   * Tier-2 authenticator slots are dropped — each slot wraps the old
   * KEK and would need its derivation key to be re-presented. Re-enrol
   * via `db.enrollAuthenticator` after rotation. Tracked as a
   * v0.1.0-pre.5 limitation.
   *
   * @throws `WeakPassphraseError` on a weak new phrase.
   * @throws `PolicyDeniedError` when the gate denies (missing factor, …).
   * @throws `InvalidKeyError` when `oldPassphrase` is wrong.
   */
  async rotatePassphrase(
    vault: string,
    input: RotatePassphraseInput,
    factors?: { factors?: ReadonlyArray<FactorProof>; sharedDevice?: boolean },
  ): Promise<void> {
    await this.checkGate(vault, 'rotate-passphrase', factors)
    const userId = this.options.user
    const next = await keyringRotatePassphrase(this.options.store, vault, userId, input)
    this.keyringCache.set(vault, next)
  }

  /**
   * Reset the passphrase using a recovery proof (user forgot the old).
   * v0.1.0-pre.5 supports the `'paper'` profile end-to-end; the
   * other three profiles throw {@link RecoveryProfileNotImplementedError}.
   *
   * Burns the used recovery entry on success.
   */
  async recoverPassphrase(
    vault: string,
    input: RecoverPassphraseInput,
    factors?: { factors?: ReadonlyArray<FactorProof>; sharedDevice?: boolean },
  ): Promise<void> {
    await this.checkGate(vault, 'recover-passphrase', factors)
    const userId = this.options.user
    const next = await keyringRecoverPassphrase(this.options.store, vault, userId, input)
    this.keyringCache.set(vault, next)
  }

  /**
   * Persist a recovery enrollment. v0.1.0-pre.5 accepts the `'paper'`
   * profile — the developer first calls
   * `@noy-db/on-recovery/generateRecoveryCodeSet` to mint codes +
   * entries, shows the codes to the user once, then hands the entries
   * here.
   *
   * ```ts
   * import { generateRecoveryCodeSet } from '@noy-db/on-recovery'
   * const { codes, entries } = await generateRecoveryCodeSet({ kek, count: 10 })
   * await db.enrollRecovery('acme', { profile: 'paper', entries })
   * showCodesToUser(codes)
   * ```
   */
  async enrollRecovery(
    vault: string,
    enrollment: { profile: 'paper'; entries: ReadonlyArray<PaperRecoveryEntry> },
  ): Promise<void> {
    if (enrollment.profile !== 'paper') {
      throw new ValidationError(
        `enrollRecovery: only 'paper' is implemented in v0.1.0-pre.5. ` +
          `Profile '${enrollment.profile as string}' is tracked under issue #10.`,
      )
    }
    const existing = await loadPaperRecoveryEntries(this.options.store, vault)
    await savePaperRecoveryEntries(this.options.store, vault, [
      ...existing,
      ...enrollment.entries,
    ])
  }

  /** Read the persisted paper-recovery entries. Used by `describeAuthConfig` (#13). */
  async listRecoveryEntries(
    vault: string,
  ): Promise<{ paper: ReadonlyArray<PaperRecoveryEntry> }> {
    const paper = await loadPaperRecoveryEntries(this.options.store, vault)
    return { paper }
  }

  // ─── Tier-3 enroll / unlock (issue #11) ────────────────────────
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
    presented?: { factors?: ReadonlyArray<FactorProof>; sharedDevice?: boolean },
  ): Promise<void> {
    await this.checkGate(vault, 'rotate-unlock', presented)
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

  /** Get or load the keyring for a vault. */
  private async getKeyring(vault: string): Promise<UnlockedKeyring> {
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

    if (!this.options.secret) {
      throw new ValidationError('A secret (passphrase) or getKeyring callback is required when encryption is enabled')
    }

    let keyring: UnlockedKeyring
    try {
      keyring = await loadKeyring(this.options.store, vault, this.options.user, this.options.secret)
    } catch (err) {
      // Only create a new keyring if no keyring exists (NoAccessError).
      // If the keyring exists but the passphrase is wrong (InvalidKeyError), propagate the error.
      if (err instanceof NoAccessError) {
        keyring = await createOwnerKeyring(
          this.options.store,
          vault,
          this.options.user,
          this.options.secret,
          { validate: this.options.validatePassphrase === true },
        )
      } else {
        throw err
      }
    }

    this.keyringCache.set(vault, keyring)
    return keyring
  }
}

/** Create a new NOYDB instance. */
export async function createNoydb(options: NoydbOptions): Promise<Noydb> {
  const encrypted = options.encrypt !== false

  if (options.secret && options.getKeyring) {
    throw new ValidationError('Provide either `secret` or `getKeyring`, not both')
  }

  if (encrypted && !options.secret && !options.getKeyring) {
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
