import type { NoydbOptions, NoydbEventMap, GrantOptions, RevokeOptions, UserInfo, PushResult, PullResult, SyncStatus } from './types.js'
import { ValidationError, NoAccessError } from './errors.js'
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

  constructor(options: NoydbOptions) {
    this.options = options
    this.resetSessionTimer()
  }

  private resetSessionTimer(): void {
    if (this.sessionTimer) clearTimeout(this.sessionTimer)
    if (this.options.sessionTimeout && this.options.sessionTimeout > 0) {
      this.sessionTimer = setTimeout(() => {
        this.close()
      }, this.options.sessionTimeout)
    }
  }

  /** Open a compartment by name. */
  async openCompartment(name: string): Promise<Compartment> {
    if (this.closed) throw new ValidationError('Instance is closed')
    this.resetSessionTimer()

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
    const keyring = await this.getKeyring(compartment)
    await keyringGrant(this.options.adapter, compartment, keyring, options)
  }

  /** Revoke a user's access to a compartment. */
  async revoke(compartment: string, options: RevokeOptions): Promise<void> {
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

  /** Change the current user's passphrase for a compartment. */
  async changeSecret(compartment: string, newPassphrase: string): Promise<void> {
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
