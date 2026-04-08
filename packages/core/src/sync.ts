import type {
  NoydbAdapter,
  DirtyEntry,
  Conflict,
  ConflictStrategy,
  PushResult,
  PullResult,
  SyncStatus,
  EncryptedEnvelope,
  SyncMetadata,
} from './types.js'
import { NOYDB_SYNC_VERSION } from './types.js'
import { ConflictError } from './errors.js'
import type { NoydbEventEmitter } from './events.js'

/** Sync engine: dirty tracking, push, pull, conflict resolution. */
export class SyncEngine {
  private readonly local: NoydbAdapter
  private readonly remote: NoydbAdapter
  private readonly strategy: ConflictStrategy
  private readonly emitter: NoydbEventEmitter
  private readonly compartment: string

  private dirty: DirtyEntry[] = []
  private lastPush: string | null = null
  private lastPull: string | null = null
  private loaded = false
  private autoSyncInterval: ReturnType<typeof setInterval> | null = null
  private isOnline = true

  constructor(opts: {
    local: NoydbAdapter
    remote: NoydbAdapter
    compartment: string
    strategy: ConflictStrategy
    emitter: NoydbEventEmitter
  }) {
    this.local = opts.local
    this.remote = opts.remote
    this.compartment = opts.compartment
    this.strategy = opts.strategy
    this.emitter = opts.emitter
  }

  /** Record a local change for later push. */
  async trackChange(collection: string, id: string, action: 'put' | 'delete', version: number): Promise<void> {
    await this.ensureLoaded()

    // Deduplicate: if same collection+id already in dirty, update it
    const idx = this.dirty.findIndex(d => d.collection === collection && d.id === id)
    const entry: DirtyEntry = {
      compartment: this.compartment,
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
  }

  /** Push dirty records to remote adapter. */
  async push(): Promise<PushResult> {
    await this.ensureLoaded()

    let pushed = 0
    const conflicts: Conflict[] = []
    const errors: Error[] = []
    const completed: number[] = []

    for (let i = 0; i < this.dirty.length; i++) {
      const entry = this.dirty[i]!
      try {
        if (entry.action === 'delete') {
          await this.remote.delete(this.compartment, entry.collection, entry.id)
          completed.push(i)
          pushed++
        } else {
          const envelope = await this.local.get(this.compartment, entry.collection, entry.id)
          if (!envelope) {
            // Record was deleted locally after being marked dirty
            completed.push(i)
            continue
          }

          try {
            await this.remote.put(
              this.compartment,
              entry.collection,
              entry.id,
              envelope,
              entry.version > 1 ? entry.version - 1 : undefined,
            )
            completed.push(i)
            pushed++
          } catch (err) {
            if (err instanceof ConflictError) {
              const remoteEnvelope = await this.remote.get(this.compartment, entry.collection, entry.id)
              if (remoteEnvelope) {
                const conflict: Conflict = {
                  compartment: this.compartment,
                  collection: entry.collection,
                  id: entry.id,
                  local: envelope,
                  remote: remoteEnvelope,
                  localVersion: envelope._v,
                  remoteVersion: remoteEnvelope._v,
                }
                conflicts.push(conflict)
                this.emitter.emit('sync:conflict', conflict)

                // Auto-resolve based on strategy
                const resolution = this.resolveConflict(conflict)
                if (resolution === 'local') {
                  await this.remote.put(this.compartment, entry.collection, entry.id, envelope)
                  completed.push(i)
                  pushed++
                } else if (resolution === 'remote') {
                  await this.local.put(this.compartment, entry.collection, entry.id, remoteEnvelope)
                  completed.push(i)
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

  /** Pull remote records to local adapter. */
  async pull(): Promise<PullResult> {
    await this.ensureLoaded()

    let pulled = 0
    const conflicts: Conflict[] = []
    const errors: Error[] = []

    try {
      const remoteSnapshot = await this.remote.loadAll(this.compartment)

      for (const [collName, records] of Object.entries(remoteSnapshot)) {
        for (const [id, remoteEnvelope] of Object.entries(records)) {
          try {
            const localEnvelope = await this.local.get(this.compartment, collName, id)

            if (!localEnvelope) {
              // New record from remote
              await this.local.put(this.compartment, collName, id, remoteEnvelope)
              pulled++
            } else if (remoteEnvelope._v > localEnvelope._v) {
              // Remote is newer — check if we have a dirty entry for this
              const isDirty = this.dirty.some(d => d.collection === collName && d.id === id)
              if (isDirty) {
                // Both changed — conflict
                const conflict: Conflict = {
                  compartment: this.compartment,
                  collection: collName,
                  id,
                  local: localEnvelope,
                  remote: remoteEnvelope,
                  localVersion: localEnvelope._v,
                  remoteVersion: remoteEnvelope._v,
                }
                conflicts.push(conflict)
                this.emitter.emit('sync:conflict', conflict)

                const resolution = this.resolveConflict(conflict)
                if (resolution === 'remote') {
                  await this.local.put(this.compartment, collName, id, remoteEnvelope)
                  // Remove from dirty log
                  this.dirty = this.dirty.filter(d => !(d.collection === collName && d.id === id))
                  pulled++
                }
                // 'local' keeps local version, push will handle it
              } else {
                // Remote is newer, no local changes — update
                await this.local.put(this.compartment, collName, id, remoteEnvelope)
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
  async sync(): Promise<{ pull: PullResult; push: PushResult }> {
    const pullResult = await this.pull()
    const pushResult = await this.push()
    return { pull: pullResult, push: pushResult }
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

  /** Stop auto-sync. */
  stopAutoSync(): void {
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

  /** Resolve a conflict using the configured strategy. */
  private resolveConflict(conflict: Conflict): 'local' | 'remote' {
    if (typeof this.strategy === 'function') {
      return this.strategy(conflict)
    }

    switch (this.strategy) {
      case 'local-wins':
        return 'local'
      case 'remote-wins':
        return 'remote'
      case 'version':
      default:
        return conflict.localVersion >= conflict.remoteVersion ? 'local' : 'remote'
    }
  }

  // ─── Persistence ─────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return

    const envelope = await this.local.get(this.compartment, '_sync', 'meta')
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

    await this.local.put(this.compartment, '_sync', 'meta', envelope)
  }
}
