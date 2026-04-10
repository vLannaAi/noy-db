/**
 * Sync scheduling policy (v0.12 #101).
 *
 * Controls when push and pull operations fire. Adapters declare a
 * `defaultSyncPolicy` matching their operational characteristics:
 * - Per-record stores (DynamoDB, S3): `on-change` push, `on-open` pull
 * - Bundle stores (Drive, WebDAV): `debounce` push, `interval` pull
 *
 * Consumers can override via `createNoydb({ syncPolicy: { ... } })`.
 *
 * @module
 */

// ─── Policy types ───────────────────────────────────────────────────────

export type PushMode = 'manual' | 'on-change' | 'debounce' | 'interval'
export type PullMode = 'manual' | 'interval' | 'on-focus'

export interface PushPolicy {
  /** Push trigger mode. */
  readonly mode: PushMode
  /** Debounce delay in ms. Only used when `mode: 'debounce'`. Default: 30_000. */
  readonly debounceMs?: number
  /** Interval in ms between automatic pushes. Used by `'interval'` and as floor for `'debounce'`. */
  readonly intervalMs?: number
  /**
   * Hard floor between pushes regardless of mode. Prevents burst writes
   * from hammering the remote. Default: 0 (no floor).
   */
  readonly minIntervalMs?: number
  /**
   * Force a push on page unload (`pagehide` / `visibilitychange → hidden`)
   * in browsers, `beforeExit` in Node. Default: true for non-manual modes.
   */
  readonly onUnload?: boolean
}

export interface PullPolicy {
  /** Pull trigger mode. */
  readonly mode: PullMode
  /** Interval in ms between automatic pulls. Used by `'interval'` mode. Default: 60_000. */
  readonly intervalMs?: number
}

export interface SyncPolicy {
  readonly push: PushPolicy
  readonly pull: PullPolicy
}

// ─── Default policies by store category ─────────────────────────────────

/** Default for per-record stores (DynamoDB, S3, file, IDB). */
export const INDEXED_STORE_POLICY: SyncPolicy = {
  push: { mode: 'on-change', minIntervalMs: 0, onUnload: true },
  pull: { mode: 'manual' },
}

/** Default for bundle stores (Drive, WebDAV, Git). */
export const BUNDLE_STORE_POLICY: SyncPolicy = {
  push: { mode: 'debounce', debounceMs: 30_000, minIntervalMs: 120_000, onUnload: true },
  pull: { mode: 'interval', intervalMs: 60_000 },
}

// ─── Sync scheduler ─────────────────────────────────────────────────────

export type SyncSchedulerState = 'idle' | 'pending' | 'pushing' | 'pulling' | 'error'

export interface SyncSchedulerStatus {
  readonly state: SyncSchedulerState
  readonly lastPushAt: string | null
  readonly lastPullAt: string | null
  readonly lastError: Error | null
  readonly pendingWrites: number
}

export interface SyncSchedulerCallbacks {
  push(): Promise<void>
  pull(): Promise<void>
  getDirtyCount(): number
}

/**
 * Manages sync timing according to a `SyncPolicy`.
 *
 * The scheduler owns all timers and lifecycle hooks. It delegates actual
 * push/pull work to callbacks provided by the SyncEngine.
 */
export class SyncScheduler {
  private readonly policy: SyncPolicy
  private readonly callbacks: SyncSchedulerCallbacks

  private _state: SyncSchedulerState = 'idle'
  private _lastPushAt: string | null = null
  private _lastPullAt: string | null = null
  private _lastError: Error | null = null
  private _lastPushTime = 0 // monotonic ms for minIntervalMs enforcement

  // Timers
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private pushIntervalTimer: ReturnType<typeof setInterval> | null = null
  private pullIntervalTimer: ReturnType<typeof setInterval> | null = null

  // Bound handlers for cleanup
  private readonly boundOnVisibilityChange: (() => void) | null = null
  private readonly boundOnBeforeExit: (() => void) | null = null
  private readonly boundOnPageHide: (() => void) | null = null

  private started = false

  constructor(policy: SyncPolicy, callbacks: SyncSchedulerCallbacks) {
    this.policy = policy
    this.callbacks = callbacks

    // Pre-bind handlers
    if (this.shouldRegisterUnload()) {
      this.boundOnVisibilityChange = this.handleVisibilityChange.bind(this)
      this.boundOnPageHide = this.handlePageHide.bind(this)
      this.boundOnBeforeExit = this.handleBeforeExit.bind(this)
    }
  }

  /** Current scheduler status snapshot. */
  get status(): SyncSchedulerStatus {
    return {
      state: this._state,
      lastPushAt: this._lastPushAt,
      lastPullAt: this._lastPullAt,
      lastError: this._lastError,
      pendingWrites: this.callbacks.getDirtyCount(),
    }
  }

  /** Start the scheduler — registers timers, event listeners. */
  start(): void {
    if (this.started) return
    this.started = true

    // Push: interval mode
    if (this.policy.push.mode === 'interval' && this.policy.push.intervalMs) {
      this.pushIntervalTimer = setInterval(() => {
        void this.executePush()
      }, this.policy.push.intervalMs)
    }

    // Pull: interval mode
    if (this.policy.pull.mode === 'interval' && this.policy.pull.intervalMs) {
      this.pullIntervalTimer = setInterval(() => {
        void this.executePull()
      }, this.policy.pull.intervalMs)
    }

    // Pull: on-focus mode
    if (this.policy.pull.mode === 'on-focus' && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleFocusPull)
    }

    // Unload hooks
    if (this.shouldRegisterUnload()) {
      if (typeof document !== 'undefined' && this.boundOnVisibilityChange) {
        document.addEventListener('visibilitychange', this.boundOnVisibilityChange)
      }
      if (typeof globalThis.addEventListener === 'function' && this.boundOnPageHide) {
        globalThis.addEventListener('pagehide', this.boundOnPageHide)
      }
      if (typeof process !== 'undefined' && this.boundOnBeforeExit) {
        process.on('beforeExit', this.boundOnBeforeExit)
      }
    }
  }

  /** Stop the scheduler — clears timers, removes event listeners. */
  stop(): void {
    if (!this.started) return
    this.started = false

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.pushIntervalTimer) {
      clearInterval(this.pushIntervalTimer)
      this.pushIntervalTimer = null
    }
    if (this.pullIntervalTimer) {
      clearInterval(this.pullIntervalTimer)
      this.pullIntervalTimer = null
    }

    // Focus pull
    if (this.policy.pull.mode === 'on-focus' && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleFocusPull)
    }

    // Unload hooks
    if (typeof document !== 'undefined' && this.boundOnVisibilityChange) {
      document.removeEventListener('visibilitychange', this.boundOnVisibilityChange)
    }
    if (typeof globalThis.removeEventListener === 'function' && this.boundOnPageHide) {
      globalThis.removeEventListener('pagehide', this.boundOnPageHide)
    }
    if (typeof process !== 'undefined' && this.boundOnBeforeExit) {
      process.removeListener('beforeExit', this.boundOnBeforeExit)
    }
  }

  /**
   * Notify the scheduler that a local write occurred.
   * For `on-change` mode: triggers immediate push (respecting minIntervalMs).
   * For `debounce` mode: resets the debounce timer.
   * For `manual` / `interval`: no-op.
   */
  notifyChange(): void {
    if (!this.started) return

    if (this.policy.push.mode === 'on-change') {
      void this.executePush()
    } else if (this.policy.push.mode === 'debounce') {
      this.resetDebounce()
    }
  }

  /** Force an immediate push, bypassing the scheduler. */
  async forcePush(): Promise<void> {
    await this.executePush()
  }

  /** Force an immediate pull, bypassing the scheduler. */
  async forcePull(): Promise<void> {
    await this.executePull()
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private async executePush(): Promise<void> {
    if (this._state === 'pushing') return // already in progress

    // minIntervalMs enforcement
    const minInterval = this.policy.push.minIntervalMs ?? 0
    if (minInterval > 0) {
      const elapsed = Date.now() - this._lastPushTime
      if (elapsed < minInterval) {
        // Schedule for later if debounce mode
        if (this.policy.push.mode === 'debounce') {
          this.scheduleDebounce(minInterval - elapsed)
        }
        return
      }
    }

    // Nothing to push
    if (this.callbacks.getDirtyCount() === 0) {
      this._state = 'idle'
      return
    }

    this._state = 'pushing'
    try {
      await this.callbacks.push()
      this._lastPushAt = new Date().toISOString()
      this._lastPushTime = Date.now()
      this._lastError = null
      this._state = this.callbacks.getDirtyCount() > 0 ? 'pending' : 'idle'
    } catch (err) {
      this._lastError = err instanceof Error ? err : new Error(String(err))
      this._state = 'error'
    }
  }

  private async executePull(): Promise<void> {
    if (this._state === 'pulling') return

    const previousState = this._state
    this._state = 'pulling'
    try {
      await this.callbacks.pull()
      this._lastPullAt = new Date().toISOString()
      this._lastError = null
      this._state = previousState === 'pending' ? 'pending' : 'idle'
    } catch (err) {
      this._lastError = err instanceof Error ? err : new Error(String(err))
      this._state = 'error'
    }
  }

  private resetDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    const ms = this.policy.push.debounceMs ?? 30_000
    this._state = 'pending'
    this.scheduleDebounce(ms)
  }

  private scheduleDebounce(ms: number): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.executePush()
    }, ms)
  }

  private shouldRegisterUnload(): boolean {
    const onUnload = this.policy.push.onUnload
    if (onUnload !== undefined) return onUnload
    return this.policy.push.mode !== 'manual'
  }

  // ─── Event handlers ───────────────────────────────────────────────

  private handleVisibilityChange(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      this.fireUnloadPush()
    }
  }

  private handlePageHide(): void {
    this.fireUnloadPush()
  }

  private handleBeforeExit(): void {
    this.fireUnloadPush()
  }

  private handleFocusPull = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      void this.executePull()
    }
  }

  private fireUnloadPush(): void {
    if (this.callbacks.getDirtyCount() === 0) return
    // Best-effort synchronous-ish push on unload
    void this.callbacks.push().catch(() => {})
  }
}
