import type {
  NoydbOptions,
  NoydbEventMap,
  GrantOptions,
  RevokeOptions,
  UserInfo,
  PushResult,
  PullResult,
  SyncStatus,
  Role,
  AccessibleCompartment,
  ListAccessibleCompartmentsOptions,
  QueryAcrossOptions,
  QueryAcrossResult,
  ReAuthOperation,
} from './types.js'
import { ValidationError, NoAccessError, InvalidKeyError, AdapterCapabilityError } from './errors.js'
import { Compartment } from './compartment.js'
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
import { revokeAllSessions } from './session.js'
import { createEnforcer, validateSessionPolicy } from './session-policy.js'
import type { PolicyEnforcer } from './session-policy.js'

/**
 * Privilege rank used by `listAccessibleCompartments({ minRole })` to
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
  private readonly compartmentCache = new Map<string, Compartment>()
  private readonly keyringCache = new Map<string, UnlockedKeyring>()
  private readonly syncEngines = new Map<string, SyncEngine>()
  private closed = false
  private sessionTimer: ReturnType<typeof setTimeout> | null = null
  /** Per-compartment policy enforcers (v0.7 #114). */
  private readonly policyEnforcers = new Map<string, PolicyEnforcer>()

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
   * Attach a policy enforcer for a compartment (v0.7 #114).
   * Called internally when a session is started for a compartment; the
   * enforcer handles idle/absolute timeouts and background-lock behavior.
   */
  private attachPolicyEnforcer(compartment: string, sessionId: string): void {
    const policy = this.options.sessionPolicy
    if (!policy) return

    // Tear down any previous enforcer for this compartment
    this.policyEnforcers.get(compartment)?.destroy()

    const enforcer = createEnforcer({
      policy,
      sessionId,
      onRevoke: (_reason) => {
        this.keyringCache.delete(compartment)
        this.compartmentCache.delete(compartment)
        this.policyEnforcers.delete(compartment)
      },
    })
    this.policyEnforcers.set(compartment, enforcer)
  }

  /**
   * Touch the policy enforcer for a compartment (records activity, resets
   * idle timer). Also touches the legacy session timer. No-op if no enforcer.
   */
  private touchPolicy(compartment?: string): void {
    this.resetSessionTimer()
    if (compartment) {
      this.policyEnforcers.get(compartment)?.touch()
    }
  }

  /**
   * Check that a policy-guarded operation is permitted.
   * Throws `SessionPolicyError` if re-auth is required.
   */
  private checkPolicyOperation(compartment: string, op: ReAuthOperation): void {
    this.policyEnforcers.get(compartment)?.checkOperation(op)
  }

  /** Open a compartment by name. */
  async openCompartment(name: string): Promise<Compartment> {
    if (this.closed) throw new ValidationError('Instance is closed')
    this.touchPolicy(name)

    let comp = this.compartmentCache.get(name)
    if (comp) return comp

    const keyring = await this.getKeyring(name)

    // Set up sync engine if remote adapter is configured
    let syncEngine: SyncEngine | undefined
    if (this.options.sync) {
      syncEngine = new SyncEngine({
        local: this.options.adapter,
        remote: this.options.sync,
        compartment: name,
        strategy: this.options.conflict ?? 'version',
        emitter: this.emitter,
      })
      this.syncEngines.set(name, syncEngine)
    }

    comp = new Compartment({
      adapter: this.options.adapter,
      name,
      keyring,
      encrypted: this.options.encrypt !== false,
      emitter: this.emitter,
      onDirty: syncEngine
        ? (coll, id, action, version) => syncEngine.trackChange(coll, id, action, version)
        : undefined,
      historyConfig: this.options.history,
      // Refresh callback used by Compartment.load() to re-derive
      // the in-memory keyring from a freshly-loaded keyring file.
      // Encrypted compartments need this so post-load decrypts work
      // against the loaded session's wrapped DEKs; plaintext
      // compartments leave it null and load() skips the refresh.
      reloadKeyring:
        this.options.encrypt !== false && this.options.secret
          ? async () => {
              // Drop the cached keyring so the next loadKeyring
              // call reads fresh from the adapter, then update the
              // cache so subsequent openCompartment calls see the
              // refreshed keyring too.
              this.keyringCache.delete(name)
              const refreshed = await loadKeyring(
                this.options.adapter,
                name,
                this.options.user,
                this.options.secret as string,
              )
              this.keyringCache.set(name, refreshed)
              return refreshed
            }
          : undefined,
    })
    this.compartmentCache.set(name, comp)
    return comp
  }

  /** Synchronous compartment access (must call openCompartment first, or auto-opens). */
  compartment(name: string): Compartment {
    const cached = this.compartmentCache.get(name)
    if (cached) return cached

    // For backwards compat: if not opened yet, create with cached keyring or plaintext
    if (this.options.encrypt === false) {
      const keyring = createPlaintextKeyring(this.options.user)
      const comp = new Compartment({
        adapter: this.options.adapter,
        name,
        keyring,
        encrypted: false,
        emitter: this.emitter,
        historyConfig: this.options.history,
      })
      this.compartmentCache.set(name, comp)
      return comp
    }

    const keyring = this.keyringCache.get(name)
    if (!keyring) {
      throw new ValidationError(
        `Compartment "${name}" not opened. Use await db.openCompartment("${name}") first.`,
      )
    }

    const comp = new Compartment({
      adapter: this.options.adapter,
      name,
      keyring,
      encrypted: true,
      historyConfig: this.options.history,
      emitter: this.emitter,
    })
    this.compartmentCache.set(name, comp)
    return comp
  }

  /** Grant access to a user for a compartment. */
  async grant(compartment: string, options: GrantOptions): Promise<void> {
    this.checkPolicyOperation(compartment, 'grant')
    const keyring = await this.getKeyring(compartment)
    await keyringGrant(this.options.adapter, compartment, keyring, options)
  }

  /** Revoke a user's access to a compartment. */
  async revoke(compartment: string, options: RevokeOptions): Promise<void> {
    this.checkPolicyOperation(compartment, 'revoke')
    const keyring = await this.getKeyring(compartment)
    await keyringRevoke(this.options.adapter, compartment, keyring, options)
  }

  /**
   * Rotate the DEKs for the given collections in a compartment.
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
  async rotate(compartment: string, collections: string[]): Promise<void> {
    this.checkPolicyOperation(compartment, 'rotate')
    const keyring = await this.getKeyring(compartment)
    await keyringRotate(this.options.adapter, compartment, keyring, collections)
    // Refresh the cached keyring so subsequent operations see the
    // freshly-rotated DEKs. Without this, `ensureCollectionDEK` on
    // the next Collection access would still hold the old ones.
    this.keyringCache.set(compartment, keyring)
  }

  /** List all users with access to a compartment. */
  async listUsers(compartment: string): Promise<UserInfo[]> {
    return keyringListUsers(this.options.adapter, compartment)
  }

  // ─── Cross-compartment queries (v0.5 #63) ──────────────────────

  /**
   * Enumerate every compartment the calling principal can unwrap,
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
   * Requires the optional `NoydbAdapter.listCompartments()` capability.
   * Throws `AdapterCapabilityError` against adapters that don't
   * implement it (today: dynamo, s3, browser). For those backends the
   * consumer should either pass an explicit candidate list to
   * `queryAcross()` directly, or maintain a compartment index out of
   * band.
   *
   * **Privacy note.** This method's return value never reveals the
   * existence of a compartment the caller cannot unwrap. The adapter
   * sees the enumeration call (it has to — it owns the storage), but
   * downstream consumers of `listAccessibleCompartments()` only see
   * the filtered list. That's the boundary the existence-leak
   * guarantee draws.
   *
   * **Known v0.4 edge case.** A compartment whose keyring file
   * happens to have an empty wrapped-DEKs map (because the owner
   * granted access before any collection was created) will pass the
   * `loadKeyring` probe with *any* passphrase — there are no DEKs to
   * unwrap, so the integrity-checked unwrap that normally rejects
   * wrong passphrases never runs. The result is that an unrelated
   * principal who happens to know the user-id and the compartment
   * name can show up in `listAccessibleCompartments()` as having
   * access to that empty compartment. They cannot read any actual
   * data (their DEK set is empty), so this is a metadata leak
   * (compartment name + user-id), not a content leak. Hardening this
   * via a passphrase canary in the keyring file is tracked as a
   * v0.6+ follow-up.
   *
   * **Cost.** O(compartments × keyring-load) — one `loadKeyring`
   * attempt per compartment in the universe. Each attempt does one
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
   * const all = await db.listAccessibleCompartments()
   *
   * // Only compartments where I'm at least admin
   * const admin = await db.listAccessibleCompartments({ minRole: 'admin' })
   *
   * // Only compartments I own
   * const owned = await db.listAccessibleCompartments({ minRole: 'owner' })
   * ```
   */
  async listAccessibleCompartments(
    options: ListAccessibleCompartmentsOptions = {},
  ): Promise<AccessibleCompartment[]> {
    if (this.closed) throw new ValidationError('Instance is closed')
    this.resetSessionTimer()

    const adapter = this.options.adapter
    if (typeof adapter.listCompartments !== 'function') {
      throw new AdapterCapabilityError(
        'listCompartments',
        'Noydb.listAccessibleCompartments()',
        adapter.name,
      )
    }

    if (this.options.encrypt === false) {
      // Plaintext mode: no keyrings exist; every compartment the
      // adapter knows about is "accessible" trivially as owner.
      const all = await adapter.listCompartments()
      return all.map((id) => ({ id, role: 'owner' as Role }))
    }

    if (!this.options.secret) {
      throw new ValidationError(
        'Noydb.listAccessibleCompartments(): a secret (passphrase) is required ' +
          'when encryption is enabled.',
      )
    }

    const minRank = ROLE_RANK[options.minRole ?? 'client']
    const universe = await adapter.listCompartments()
    const accessible: AccessibleCompartment[] = []

    for (const compartment of universe) {
      // Probe with loadKeyring directly (NOT getKeyring, which would
      // auto-create a fresh owner keyring on miss — that would
      // silently grant access to every empty compartment in the
      // universe and is exactly the wrong shape for an enumeration
      // API). The two expected failure modes — no keyring file, or
      // wrong passphrase — are caught and silently dropped so the
      // return value never leaks existence.
      let keyring: UnlockedKeyring
      try {
        keyring = await loadKeyring(
          adapter,
          compartment,
          this.options.user,
          this.options.secret,
        )
      } catch (err) {
        if (err instanceof NoAccessError || err instanceof InvalidKeyError) {
          continue // silent: caller has no key material for this compartment
        }
        throw err // unexpected error — surface it
      }

      if (ROLE_RANK[keyring.role] < minRank) continue
      accessible.push({ id: compartment, role: keyring.role })

      // Opportunistically prime the keyring cache so a subsequent
      // openCompartment() doesn't have to re-derive the KEK. The cost
      // is one Map.set per compartment we already paid to unwrap.
      this.keyringCache.set(compartment, keyring)
    }

    return accessible
  }

  /**
   * Run a per-compartment callback against a list of compartments and
   * collect the results.
   *
   * Pure orchestration — there is no new crypto, no new sync, no new
   * authorization layer. Each compartment is opened via the existing
   * `openCompartment()` path (which honors the cache primed by
   * `listAccessibleCompartments`), the callback runs against the
   * resulting `Compartment` instance, and the result (or thrown
   * error) is captured into the per-compartment slot.
   *
   * **Per-compartment errors do not abort the fan-out.** If one
   * compartment's callback throws, that compartment's slot carries
   * the error and the remaining compartments still run. The caller
   * decides how to handle the partition between success and failure.
   * This is the right shape for cross-tenant reports where one
   * tenant's outage shouldn't hide the other tenants' data.
   *
   * **Concurrency** is opt-in via `options.concurrency`. The default
   * is `1` (sequential) — conservative because per-compartment
   * callbacks typically do their own I/O and an unbounded fan-out
   * can exhaust adapter connections (DynamoDB throughput, S3 socket
   * limits, browser fetch concurrency). Bump to 4-8 for cloud-backed
   * adapters where parallelism is the whole point.
   *
   * @example
   * ```ts
   * // Cross-tenant invoice totals as a flat list
   * const accessible = await db.listAccessibleCompartments({ minRole: 'admin' })
   * const results = await db.queryAcross(
   *   accessible.map((c) => c.id),
   *   async (comp) => {
   *     return comp.collection<Invoice>('invoices').query()
   *       .where('month', '==', '2026-03')
   *       .toArray()
   *   },
   *   { concurrency: 4 },
   * )
   * // results: Array<{ compartment, result?: Invoice[], error?: Error }>
   *
   * // Compose with exportStream() — cross-compartment plaintext export
   * const exports = await db.queryAcross(accessible.map((c) => c.id), async (comp) => {
   *   const out: unknown[] = []
   *   for await (const chunk of comp.exportStream()) out.push(chunk)
   *   return out
   * })
   * ```
   */
  async queryAcross<T>(
    compartmentIds: string[],
    fn: (compartment: Compartment) => Promise<T>,
    options: QueryAcrossOptions = {},
  ): Promise<QueryAcrossResult<T>[]> {
    if (this.closed) throw new ValidationError('Instance is closed')
    this.resetSessionTimer()

    const concurrency = Math.max(1, options.concurrency ?? 1)
    const results: QueryAcrossResult<T>[] = new Array(compartmentIds.length)

    // Tiny inline p-limit. Maintains a sliding window of `concurrency`
    // in-flight promises and schedules the next compartment as each
    // one settles. No external dep. Index-keyed result array so the
    // output preserves caller-supplied order even when concurrency
    // > 1 lets later compartments finish before earlier ones.
    let nextIndex = 0
    const inFlight: Set<Promise<void>> = new Set()

    const launch = (): Promise<void> | null => {
      if (nextIndex >= compartmentIds.length) return null
      const idx = nextIndex++
      const compartmentId = compartmentIds[idx]!
      const task = (async () => {
        try {
          const comp = await this.openCompartment(compartmentId)
          const result = await fn(comp)
          results[idx] = { compartment: compartmentId, result }
        } catch (err) {
          results[idx] = {
            compartment: compartmentId,
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
      while (inFlight.size < concurrency && nextIndex < compartmentIds.length) {
        if (launch() === null) break
      }
    }

    return results
  }

  /** Change the current user's passphrase for a compartment. */
  async changeSecret(compartment: string, newPassphrase: string): Promise<void> {
    this.checkPolicyOperation(compartment, 'changeSecret')
    const keyring = await this.getKeyring(compartment)
    const updated = await keyringChangeSecret(
      this.options.adapter,
      compartment,
      keyring,
      newPassphrase,
    )
    this.keyringCache.set(compartment, updated)
  }

  // ─── Sync ──────────────────────────────────────────────────────

  /** Push local changes to remote for a compartment. */
  async push(compartment: string): Promise<PushResult> {
    const engine = this.getSyncEngine(compartment)
    return engine.push()
  }

  /** Pull remote changes to local for a compartment. */
  async pull(compartment: string): Promise<PullResult> {
    const engine = this.getSyncEngine(compartment)
    return engine.pull()
  }

  /** Bidirectional sync: pull then push. */
  async sync(compartment: string): Promise<{ pull: PullResult; push: PushResult }> {
    const engine = this.getSyncEngine(compartment)
    return engine.sync()
  }

  /** Get sync status for a compartment. */
  syncStatus(compartment: string): SyncStatus {
    const engine = this.syncEngines.get(compartment)
    if (!engine) {
      return { dirty: 0, lastPush: null, lastPull: null, online: true }
    }
    return engine.status()
  }

  private getSyncEngine(compartment: string): SyncEngine {
    const engine = this.syncEngines.get(compartment)
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
    this.compartmentCache.clear()
    this.emitter.removeAllListeners()
  }

  /** Get or load the keyring for a compartment. */
  private async getKeyring(compartment: string): Promise<UnlockedKeyring> {
    if (this.options.encrypt === false) {
      return createPlaintextKeyring(this.options.user)
    }

    const cached = this.keyringCache.get(compartment)
    if (cached) return cached

    if (!this.options.secret) {
      throw new ValidationError('A secret (passphrase) is required when encryption is enabled')
    }

    let keyring: UnlockedKeyring
    try {
      keyring = await loadKeyring(this.options.adapter, compartment, this.options.user, this.options.secret)
    } catch (err) {
      // Only create a new keyring if no keyring exists (NoAccessError).
      // If the keyring exists but the passphrase is wrong (InvalidKeyError), propagate the error.
      if (err instanceof NoAccessError) {
        keyring = await createOwnerKeyring(this.options.adapter, compartment, this.options.user, this.options.secret)
      } else {
        throw err
      }
    }

    this.keyringCache.set(compartment, keyring)
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
