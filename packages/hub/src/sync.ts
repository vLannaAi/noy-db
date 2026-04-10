import type {
  NoydbStore,
  DirtyEntry,
  Conflict,
  ConflictStrategy,
  CollectionConflictResolver,
  PushOptions,
  PullOptions,
  PushResult,
  PullResult,
  SyncStatus,
  EncryptedEnvelope,
  SyncMetadata,
  SyncTargetRole,
} from './types.js'
import { NOYDB_SYNC_VERSION } from './types.js'
import { ConflictError } from './errors.js'
import type { NoydbEventEmitter } from './events.js'
import type { SyncPolicy } from './sync-policy.js'
import { SyncScheduler, INDEXED_STORE_POLICY } from './sync-policy.js'

/** Sync engine: dirty tracking, push, pull, conflict resolution, scheduling. */
export class SyncEngine {
  private readonly local: NoydbStore
  private readonly remote: NoydbStore
  private readonly strategy: ConflictStrategy
  private readonly emitter: NoydbEventEmitter
  private readonly vault: string
  readonly role: SyncTargetRole
  readonly label: string | undefined

  private dirty: DirtyEntry[] = []
  private lastPush: string | null = null
  private lastPull: string | null = null
  private loaded = false
  private autoSyncInterval: ReturnType<typeof setInterval> | null = null
  private isOnline = true

  /** Sync scheduler (v0.12 #101). Manages push/pull timing. */
  readonly scheduler: SyncScheduler | null

  /** Per-collection conflict resolvers registered by Collection instances (#131). */
  private readonly conflictResolvers = new Map<string, CollectionConflictResolver>()

  constructor(opts: {
    local: NoydbStore
    remote: NoydbStore
    vault: string
    strategy: ConflictStrategy
    emitter: NoydbEventEmitter
    syncPolicy?: SyncPolicy
    role?: SyncTargetRole
    label?: string
  }) {
    this.local = opts.local
    this.remote = opts.remote
    this.vault = opts.vault
    this.strategy = opts.strategy
    this.emitter = opts.emitter
    this.role = opts.role ?? 'sync-peer'
    this.label = opts.label

    // Create scheduler if a policy is provided
    const policy = opts.syncPolicy
    if (policy && policy.push.mode !== 'manual') {
      this.scheduler = new SyncScheduler(policy, {
        push: () => this.push().then(() => {}),
        pull: () => this.pull().then(() => {}),
        getDirtyCount: () => this.dirty.length,
      })
    } else {
      this.scheduler = null
    }
  }

  /** Start the sync scheduler. Called after vault is fully opened. */
  startScheduler(): void {
    this.scheduler?.start()
  }

  /** Stop the sync scheduler. Called on close. */
  stopScheduler(): void {
    this.scheduler?.stop()
  }

  /**
   * Register a per-collection conflict resolver (v0.9 #131).
   * Called by Collection when `conflictPolicy` is set.
   */
  registerConflictResolver(collection: string, resolver: CollectionConflictResolver): void {
    this.conflictResolvers.set(collection, resolver)
  }

  /** Record a local change for later push. */
  async trackChange(collection: string, id: string, action: 'put' | 'delete', version: number): Promise<void> {
    await this.ensureLoaded()

    // Deduplicate: if same collection+id already in dirty, update it
    const idx = this.dirty.findIndex(d => d.collection === collection && d.id === id)
    const entry: DirtyEntry = {
      vault: this.vault,
      collection,
      id,
      action,
      version,
      timestamp: new Date().toISOString(),
    }

    if (idx >= 0) {
      this.dirty[idx] = entry
    } else {
      this.dirty.push(entry)
    }

    await this.persistMeta()

    // Notify scheduler of the write (triggers on-change or debounce)
    this.scheduler?.notifyChange()
  }

  /** Push dirty records to remote adapter. Accepts optional `PushOptions` for partial sync (#133). */
  async push(options?: PushOptions): Promise<PushResult> {
    await this.ensureLoaded()

    let pushed = 0
    const conflicts: Conflict[] = []
    const errors: Error[] = []
    const completed: number[] = []

    for (let i = 0; i < this.dirty.length; i++) {
      const entry = this.dirty[i]!

      // Partial sync: skip collections not in the filter (#133)
      if (options?.collections && !options.collections.includes(entry.collection)) {
        continue
      }

      try {
        if (entry.action === 'delete') {
          await this.remote.delete(this.vault, entry.collection, entry.id)
          completed.push(i)
          pushed++
        } else {
          const envelope = await this.local.get(this.vault, entry.collection, entry.id)
          if (!envelope) {
            // Record was deleted locally after being marked dirty
            completed.push(i)
            continue
          }

          try {
            await this.remote.put(
              this.vault,
              entry.collection,
              entry.id,
              envelope,
              entry.version - 1,
            )
            completed.push(i)
            pushed++
          } catch (err) {
            if (err instanceof ConflictError) {
              const remoteEnvelope = await this.remote.get(this.vault, entry.collection, entry.id)
              if (remoteEnvelope) {
                const { handled, conflict } = await this.handleConflict(
                  entry.collection,
                  entry.id,
                  envelope,
                  remoteEnvelope,
                  'push',
                )
                conflicts.push(conflict)
                if (handled === 'local') {
                  await this.remote.put(this.vault, entry.collection, entry.id, conflict.local)
                  completed.push(i)
                  pushed++
                } else if (handled === 'remote') {
                  await this.local.put(this.vault, entry.collection, entry.id, conflict.remote)
                  completed.push(i)
                } else if (handled === 'merged' && conflict.local !== envelope) {
                  // Merged envelope is stored in conflict.local (the winner)
                  const merged = conflict.local
                  await this.remote.put(this.vault, entry.collection, entry.id, merged)
                  await this.local.put(this.vault, entry.collection, entry.id, merged)
                  completed.push(i)
                  pushed++
                }
                // handled === 'deferred': leave in dirty log
              }
            } else {
              throw err
            }
          }
        }
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)))
      }
    }

    // Remove completed entries from dirty log (reverse order to preserve indices)
    for (const i of completed.sort((a, b) => b - a)) {
      this.dirty.splice(i, 1)
    }

    this.lastPush = new Date().toISOString()
    await this.persistMeta()

    const result: PushResult = { pushed, conflicts, errors }
    this.emitter.emit('sync:push', result)
    return result
  }

  /** Pull remote records to local adapter. Accepts optional `PullOptions` for partial sync (#133). */
  async pull(options?: PullOptions): Promise<PullResult> {
    await this.ensureLoaded()

    let pulled = 0
    const conflicts: Conflict[] = []
    const errors: Error[] = []

    try {
      const remoteSnapshot = await this.remote.loadAll(this.vault)

      for (const [collName, records] of Object.entries(remoteSnapshot)) {
        // Partial sync: skip collections not in the filter (#133)
        if (options?.collections && !options.collections.includes(collName)) {
          continue
        }

        for (const [id, remoteEnvelope] of Object.entries(records)) {
          // Partial sync: modifiedSince filter (#133)
          if (options?.modifiedSince && remoteEnvelope._ts <= options.modifiedSince) {
            continue
          }

          try {
            const localEnvelope = await this.local.get(this.vault, collName, id)

            if (!localEnvelope) {
              // New record from remote
              await this.local.put(this.vault, collName, id, remoteEnvelope)
              pulled++
            } else if (remoteEnvelope._v > localEnvelope._v) {
              // Remote is newer — check if we have a dirty entry for this
              const isDirty = this.dirty.some(d => d.collection === collName && d.id === id)
              if (isDirty) {
                // Both changed — conflict
                const { handled, conflict } = await this.handleConflict(
                  collName,
                  id,
                  localEnvelope,
                  remoteEnvelope,
                  'pull',
                )
                conflicts.push(conflict)
                if (handled === 'remote') {
                  await this.local.put(this.vault, collName, id, conflict.remote)
                  this.dirty = this.dirty.filter(d => !(d.collection === collName && d.id === id))
                  pulled++
                } else if (handled === 'merged' && conflict.local !== localEnvelope) {
                  const merged = conflict.local
                  await this.local.put(this.vault, collName, id, merged)
                  this.dirty = this.dirty.filter(d => !(d.collection === collName && d.id === id))
                  pulled++
                }
                // 'local' or 'deferred': push handles it
              } else {
                // Remote is newer, no local changes — update
                await this.local.put(this.vault, collName, id, remoteEnvelope)
                pulled++
              }
            }
            // Same version or local is newer — skip (push will handle)
          } catch (err) {
            errors.push(err instanceof Error ? err : new Error(String(err)))
          }
        }
      }
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)))
    }

    this.lastPull = new Date().toISOString()
    await this.persistMeta()

    const result: PullResult = { pulled, conflicts, errors }
    this.emitter.emit('sync:pull', result)
    return result
  }

  /** Bidirectional sync: pull then push. */
  async sync(options?: { push?: PushOptions; pull?: PullOptions }): Promise<{ pull: PullResult; push: PushResult }> {
    const pullResult = await this.pull(options?.pull)
    const pushResult = await this.push(options?.push)
    return { pull: pullResult, push: pushResult }
  }

  /**
   * Push a specific subset of dirty entries (for sync transactions, #135).
   * Entries are matched by collection+id from the dirty log; matched entries
   * are removed from the dirty log on success.
   */
  async pushFiltered(predicate: (entry: DirtyEntry) => boolean): Promise<PushResult> {
    await this.ensureLoaded()

    let pushed = 0
    const conflicts: Conflict[] = []
    const errors: Error[] = []
    const completed: number[] = []

    for (let i = 0; i < this.dirty.length; i++) {
      const entry = this.dirty[i]!
      if (!predicate(entry)) continue

      try {
        if (entry.action === 'delete') {
          await this.remote.delete(this.vault, entry.collection, entry.id)
          completed.push(i)
          pushed++
        } else {
          const envelope = await this.local.get(this.vault, entry.collection, entry.id)
          if (!envelope) {
            completed.push(i)
            continue
          }

          try {
            await this.remote.put(
              this.vault,
              entry.collection,
              entry.id,
              envelope,
              entry.version - 1,
            )
            completed.push(i)
            pushed++
          } catch (err) {
            if (err instanceof ConflictError) {
              const remoteEnvelope = await this.remote.get(this.vault, entry.collection, entry.id)
              if (remoteEnvelope) {
                const { handled, conflict } = await this.handleConflict(
                  entry.collection,
                  entry.id,
                  envelope,
                  remoteEnvelope,
                  'push',
                )
                conflicts.push(conflict)
                if (handled === 'local') {
                  await this.remote.put(this.vault, entry.collection, entry.id, conflict.local)
                  completed.push(i)
                  pushed++
                } else if (handled === 'remote') {
                  await this.local.put(this.vault, entry.collection, entry.id, conflict.remote)
                  completed.push(i)
                } else if (handled === 'merged' && conflict.local !== envelope) {
                  const merged = conflict.local
                  await this.remote.put(this.vault, entry.collection, entry.id, merged)
                  await this.local.put(this.vault, entry.collection, entry.id, merged)
                  completed.push(i)
                  pushed++
                }
              }
            } else {
              throw err
            }
          }
        }
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)))
      }
    }

    for (const i of completed.sort((a, b) => b - a)) {
      this.dirty.splice(i, 1)
    }

    this.lastPush = new Date().toISOString()
    await this.persistMeta()

    const result: PushResult = { pushed, conflicts, errors }
    this.emitter.emit('sync:push', result)
    return result
  }

  /** Get current sync status. */
  status(): SyncStatus {
    return {
      dirty: this.dirty.length,
      lastPush: this.lastPush,
      lastPull: this.lastPull,
      online: this.isOnline,
    }
  }

  // ─── Auto-Sync ───────────────────────────────────────────────────

  /** Start auto-sync: listen for online/offline events, optional periodic sync. */
  startAutoSync(intervalMs?: number): void {
    // Online/offline detection
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('online', this.handleOnline)
      globalThis.addEventListener('offline', this.handleOffline)
    }

    // Periodic sync
    if (intervalMs && intervalMs > 0) {
      this.autoSyncInterval = setInterval(() => {
        if (this.isOnline) {
          void this.sync()
        }
      }, intervalMs)
    }
  }

  /** Stop auto-sync and scheduler. */
  stopAutoSync(): void {
    this.stopScheduler()
    if (typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('online', this.handleOnline)
      globalThis.removeEventListener('offline', this.handleOffline)
    }
    if (this.autoSyncInterval) {
      clearInterval(this.autoSyncInterval)
      this.autoSyncInterval = null
    }
  }

  private handleOnline = (): void => {
    this.isOnline = true
    this.emitter.emit('sync:online', undefined as never)
    void this.sync()
  }

  private handleOffline = (): void => {
    this.isOnline = false
    this.emitter.emit('sync:offline', undefined as never)
  }

  /**
   * Resolve a conflict, checking per-collection resolvers first (#131),
   * then falling back to the db-level `ConflictStrategy`.
   *
   * Returns the resolved `Conflict` object (possibly with `resolve` set for
   * manual mode) and a `handled` discriminant:
   * - `'local'` — keep the local envelope; push it to remote.
   * - `'remote'` — keep the remote envelope; update local.
   * - `'merged'` — a custom merge fn produced a new envelope stored as `conflict.local`.
   * - `'deferred'` — manual mode, resolve was not called synchronously.
   */
  private async handleConflict(
    collection: string,
    id: string,
    local: EncryptedEnvelope,
    remote: EncryptedEnvelope,
    _phase: 'push' | 'pull',
  ): Promise<{ handled: 'local' | 'remote' | 'merged' | 'deferred'; conflict: Conflict }> {
    const resolver = this.conflictResolvers.get(collection)

    if (resolver) {
      // Per-collection resolver is responsible for emitting sync:conflict
      // (manual policy emits with a resolve callback; LWW/FWW/custom are silent).
      const winner = await resolver(id, local, remote)
      const base: Conflict = {
        vault: this.vault,
        collection,
        id,
        local,
        remote,
        localVersion: local._v,
        remoteVersion: remote._v,
      }
      if (winner === null) return { handled: 'deferred', conflict: base }
      if (winner === local) return { handled: 'local', conflict: base }
      if (winner === remote) return { handled: 'remote', conflict: base }
      // Custom merge fn produced a new envelope — store as conflict.local for the caller
      return {
        handled: 'merged',
        conflict: { ...base, local: winner, localVersion: winner._v },
      }
    }

    // Fall back to db-level strategy — emit once
    const baseConflict: Conflict = {
      vault: this.vault,
      collection,
      id,
      local,
      remote,
      localVersion: local._v,
      remoteVersion: remote._v,
    }
    this.emitter.emit('sync:conflict', baseConflict)
    const side = this.legacyResolve(baseConflict)
    return { handled: side, conflict: baseConflict }
  }

  /** DB-level ConflictStrategy resolution (legacy, kept for backward compat). */
  private legacyResolve(conflict: Conflict): 'local' | 'remote' {
    if (typeof this.strategy === 'function') {
      return this.strategy(conflict)
    }
    switch (this.strategy) {
      case 'local-wins': return 'local'
      case 'remote-wins': return 'remote'
      case 'version':
      default:
        return conflict.localVersion >= conflict.remoteVersion ? 'local' : 'remote'
    }
  }

  // ─── Persistence ─────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return

    const envelope = await this.local.get(this.vault, '_sync', 'meta')
    if (envelope) {
      const meta = JSON.parse(envelope._data) as SyncMetadata
      this.dirty = [...meta.dirty]
      this.lastPush = meta.last_push
      this.lastPull = meta.last_pull
    }

    this.loaded = true
  }

  private async persistMeta(): Promise<void> {
    const meta: SyncMetadata = {
      _noydb_sync: NOYDB_SYNC_VERSION,
      last_push: this.lastPush,
      last_pull: this.lastPull,
      dirty: this.dirty,
    }

    const envelope: EncryptedEnvelope = {
      _noydb: 1,
      _v: 1,
      _ts: new Date().toISOString(),
      _iv: '',
      _data: JSON.stringify(meta),
    }

    await this.local.put(this.vault, '_sync', 'meta', envelope)
  }
}
