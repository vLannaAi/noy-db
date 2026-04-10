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
} from './keyring.js'
import type { UnlockedKeyring } from './keyring.js'
import { SyncEngine } from './sync.js'
import { SyncTransaction } from './sync-transaction.js'
import { INDEXED_STORE_POLICY } from './sync-policy.js'
import { revokeAllSessions } from './session.js'
import { createEnforcer, validateSessionPolicy } from './session-policy.js'
import type { PolicyEnforcer } from './session-policy.js'

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
  }
}

/** The top-level NOYDB instance. */
export class Noydb {
  private readonly options: NoydbOptions
  private readonly emitter = new NoydbEventEmitter()
  private readonly vaultCache = new Map<string, Vault>()
  private readonly keyringCache = new Map<string, UnlockedKeyring>()
  private readonly syncEngines = new Map<string, SyncEngine>()
  private closed = false
  private sessionTimer: ReturnType<typeof setTimeout> | null = null
  /** Per-vault policy enforcers (v0.7 #114). */
  private readonly policyEnforcers = new Map<string, PolicyEnforcer>()

  // ─── plaintextTranslator state (v0.8 #83) ─────────────────────────
  /**
   * In-process translation cache. Key is `"${field}\x00${collection}\x00${from}\x00${to}\x00${text}"`.
   * Cleared on `close()` alongside the KEK and DEKs.
   */
  private readonly translatorCache = new Map<string, string>()
  /** Audit log for all translator invocations in this session. Cleared on `close()`. */
  private readonly _translatorAuditLog: TranslatorAuditEntry[] = []

  constructor(options: NoydbOptions) {
    this.options = options
    // Validate sessionPolicy at construction time (developer error if invalid)
    if (options.sessionPolicy) {
      validateSessionPolicy(options.sessionPolicy)
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
   * Attach a policy enforcer for a vault (v0.7 #114).
   * Called internally when a session is started for a vault; the
   * enforcer handles idle/absolute timeouts and background-lock behavior.
   */
  private attachPolicyEnforcer(vault: string, sessionId: string): void {
    const policy = this.options.sessionPolicy
    if (!policy) return

    // Tear down any previous enforcer for this vault
    this.policyEnforcers.get(vault)?.destroy()

    const enforcer = createEnforcer({
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
   *                     (v0.8 #81 #82). Set here to avoid passing `{ locale }`
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

    // Set up sync engine(s) — handles bare NoydbStore, SyncTarget, or SyncTarget[]
    let syncEngine: SyncEngine | undefined
    const targets = normalizeSyncTargets(this.options.sync)
    if (targets.length > 0) {
      // Primary sync engine is the first sync-peer (or first target if none)
      const primary = targets.find(t => t.role === 'sync-peer') ?? targets[0]!
      const effectivePolicy = this.options.syncPolicy ?? primary.policy ?? INDEXED_STORE_POLICY
      syncEngine = new SyncEngine({
        local: this.options.store,
        remote: primary.store,
        vault: name,
        strategy: this.options.conflict ?? 'version',
        emitter: this.emitter,
        syncPolicy: effectivePolicy,
        role: primary.role,
        label: primary.label,
      })
      this.syncEngines.set(name, syncEngine)

      // Additional targets get their own engines (backup/archive are push-only)
      for (const target of targets) {
        if (target === primary) continue
        const targetPolicy = target.policy ?? this.options.syncPolicy ?? INDEXED_STORE_POLICY
        const engine = new SyncEngine({
          local: this.options.store,
          remote: target.store,
          vault: name,
          strategy: this.options.conflict ?? 'version',
          emitter: this.emitter,
          syncPolicy: targetPolicy,
          role: target.role,
          label: target.label,
        })
        const key = `${name}::${target.label ?? target.role}`
        this.syncEngines.set(key, engine)
      }
    }

    comp = new Vault({
      adapter: this.options.store,
      name,
      keyring,
      encrypted: this.options.encrypt !== false,
      emitter: this.emitter,
      onDirty: targets.length > 0
        ? (coll, id, action, version) => {
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
      locale: opts?.locale,
      // Thread the translator hook so Collection.put() can invoke it (v0.8 #83)
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
        keyring,
        encrypted: false,
        emitter: this.emitter,
        historyConfig: this.options.history,
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
      keyring,
      encrypted: true,
      historyConfig: this.options.history,
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

  // ─── Cross-vault queries (v0.5 #63) ──────────────────────

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
   * **Known v0.4 edge case.** A vault whose keyring file
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
   * via a passphrase canary in the keyring file is tracked as a
   * v0.6+ follow-up.
   *
   * **Cost.** O(compartments × keyring-load) — one `loadKeyring`
   * attempt per vault in the universe. Each attempt does one
   * adapter `get` + one PBKDF2 derivation + N AES-KW unwraps. For
   * dozens of compartments this is fine; for thousands the consumer
   * should cache the result and refresh on grant/revoke events. A
   * future optimization could batch the keyring reads via
   * `loadAll('_keyring')` if such a thing existed at the adapter
   * layer, but the v0.5 contract doesn't expose that.
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
   * Create a sync transaction for the given vault (v0.9 #135).
   * The vault must already be open via `openVault()`.
   * Call `tx.put()` / `tx.delete()` to stage changes, then `tx.commit()`
   * to write all locally and push atomically to remote.
   */
  transaction(vault: string): SyncTransaction {
    const comp = this.vaultCache.get(vault)
    if (!comp) {
      throw new ValidationError(
        `Vault "${vault}" is not open. Call openVault() first.`,
      )
    }
    const engine = this.getSyncEngine(vault)
    return new SyncTransaction(comp, engine)
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
    // Revoke all in-memory session keys (v0.7 #109)
    revokeAllSessions()
    // Stop all sync engines
    for (const engine of this.syncEngines.values()) {
      engine.stopAutoSync()
    }
    this.syncEngines.clear()
    this.keyringCache.clear()
    this.vaultCache.clear()
    this.emitter.removeAllListeners()
    // Clear translator state — same lifetime as KEK/DEKs (v0.8 #83)
    this.translatorCache.clear()
    this._translatorAuditLog.length = 0
  }

  /**
   * Returns a snapshot of all translator invocations since the last
   * `close()`. Useful for testing and compliance auditing. The log is
   * in-memory only — it is cleared when `db.close()` is called.
   *
   * Entries deliberately omit content hashes. See `TranslatorAuditEntry`
   * and issue #83 for the rationale.
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

  /** Get or load the keyring for a vault. */
  private async getKeyring(vault: string): Promise<UnlockedKeyring> {
    if (this.options.encrypt === false) {
      return createPlaintextKeyring(this.options.user)
    }

    const cached = this.keyringCache.get(vault)
    if (cached) return cached

    if (!this.options.secret) {
      throw new ValidationError('A secret (passphrase) is required when encryption is enabled')
    }

    let keyring: UnlockedKeyring
    try {
      keyring = await loadKeyring(this.options.store, vault, this.options.user, this.options.secret)
    } catch (err) {
      // Only create a new keyring if no keyring exists (NoAccessError).
      // If the keyring exists but the passphrase is wrong (InvalidKeyError), propagate the error.
      if (err instanceof NoAccessError) {
        keyring = await createOwnerKeyring(this.options.store, vault, this.options.user, this.options.secret)
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

  if (encrypted && !options.secret) {
    throw new ValidationError('A secret (passphrase) is required when encryption is enabled')
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
    return [sync as SyncTarget]
  }
  // Bare NoydbStore — wrap as sync-peer
  return [{ store: sync as NoydbStore, role: 'sync-peer' }]
}
