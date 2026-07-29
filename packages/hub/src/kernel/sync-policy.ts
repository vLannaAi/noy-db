/**
 * Sync scheduling policy.
 *
 * ## What it controls
 *
 * A {@link SyncPolicy} has two halves:
 * - **push** ({@link PushPolicy}) — when dirty local writes are sent to the remote.
 * - **pull** ({@link PullPolicy}) — when the remote is polled for new data.
 *
 * ## Choosing a policy
 *
 * The right policy depends on the backend's operational characteristics:
 *
 * | Backend type | Recommended policy |
 * |---|---|
 * | Per-record (DynamoDB, S3, IDB) | {@link INDEXED_STORE_POLICY} — `on-change` push, `manual` pull |
 * | Bundle (Drive, WebDAV, Git) | {@link POD_STORE_POLICY} — `debounce` push, `interval` pull |
 *
 * Consumers can override via `createNoydb({ syncPolicy: { ... } })`:
 *
 * ```ts
 * const db = await createNoydb({
 *   store: toFile({ dir: './data' }),
 *   syncPolicy: {
 *     push: { mode: 'debounce', debounceMs: 5_000 },
 *     pull: { mode: 'on-focus' },
 *   },
 * })
 * ```
 *
 * ## Scheduler lifecycle
 *
 * {@link SyncScheduler} owns all timers, debounce logic, and browser lifecycle
 * hooks (`visibilitychange`, `pagehide`, `beforeExit`). Call `scheduler.start()`
 * after opening a vault and `scheduler.stop()` when closing it. The scheduler
 * delegates actual push/pull work to {@link SyncSchedulerCallbacks} provided
 * by the {@link SyncEngine}.
 *
 * @module
 */

// ─── Policy types ───────────────────────────────────────────────────────

/**
 * When push operations are triggered automatically.
 *
 * - `'manual'` — only on explicit `sync.push()` calls.
 * - `'on-change'` — immediately after every local write (respecting `minIntervalMs`).
 * - `'debounce'` — after `debounceMs` of inactivity following a write.
 * - `'interval'` — on a fixed timer regardless of writes.
 */
export type PushMode = 'manual' | 'on-change' | 'debounce' | 'interval'

/**
 * When pull operations are triggered automatically.
 *
 * - `'manual'` — only on explicit `sync.pull()` calls.
 * - `'interval'` — on a fixed `intervalMs` timer.
 * - `'on-focus'` — when the browser tab regains visibility.
 * - `'phased'` — pull the collections named in `sequence`, in order, one at a
 *   time, then settle into steady state. For thin clients that need their
 *   navigation-critical collections before bulk history.
 */
export type PullMode = 'manual' | 'interval' | 'on-focus' | 'phased'

/**
 * Push half of a sync policy. Controls the trigger mode and timing guards
 * for outbound sync operations.
 */
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

/**
 * Pull half of a sync policy. Controls when and how often inbound sync
 * operations are triggered.
 */
export interface PullPolicy {
  /** Pull trigger mode. */
  readonly mode: PullMode
  /**
   * Interval in ms between automatic pulls. Used by `'interval'` mode. Default: 60_000.
   * Under `'phased'` it is the steady-state cadence adopted *after* the sequence
   * completes; omit it to go idle instead.
   */
  readonly intervalMs?: number
  /**
   * Collection names to pull in order, one at a time. Required when
   * `mode: 'phased'` and rejected otherwise. Entries must be non-empty and
   * unique — without period narrowing a repeated collection can only be a
   * mistake, so it is rejected rather than silently merged.
   *
   * Period-scoped phases (`collection@period`) are deferred to `partitions`;
   * use `db.pull(vault, { periods })` explicitly meanwhile.
   */
  readonly sequence?: readonly string[]
}

/**
 * Combined push + pull sync scheduling policy for a vault.
 *
 * Pass via `createNoydb({ syncPolicy })` to override the default policy
 * derived from the active store type. Pre-built defaults are available
 * as `INDEXED_STORE_POLICY` and `POD_STORE_POLICY`.
 */
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
export const POD_STORE_POLICY: SyncPolicy = {
  push: { mode: 'debounce', debounceMs: 30_000, minIntervalMs: 120_000, onUnload: true },
  pull: { mode: 'interval', intervalMs: 60_000 },
}

/** @deprecated Use `POD_STORE_POLICY`. */
export const BUNDLE_STORE_POLICY = POD_STORE_POLICY

// ─── Sync scheduler ─────────────────────────────────────────────────────

/**
 * Current operational state of the `SyncScheduler`.
 *
 * - `'idle'` — no pending or active sync operations.
 * - `'pending'` — local writes are queued, waiting for debounce/interval to fire.
 * - `'pushing'` — push in progress.
 * - `'pulling'` — pull in progress.
 * - `'error'` — last sync operation failed; `lastError` holds the cause.
 */
export type SyncSchedulerState = 'idle' | 'pending' | 'pushing' | 'pulling' | 'error'

/**
 * How much of a collection a caller may rely on, under a `'phased'` pull.
 *
 * - `'cold'` — not pulled yet, or its phase did not complete cleanly. A miss
 *   from `get()` proves nothing.
 * - `'pulling'` — its phase is in flight. Never terminal: a phase always ends
 *   in `'live'` or back in `'cold'`, because a stuck `'pulling'` would leave a
 *   permanent skeleton in the UI.
 * - `'live'` — its phase completed cleanly, so a miss is a real absence.
 */
export type ReadinessState = 'cold' | 'pulling' | 'live'

/**
 * What a scheduler-initiated pull achieved, as reported by the callback.
 *
 * `'incomplete'` covers both a pull that reported errors (`PullResult.errors`
 * accumulates without throwing) and one that was skipped — e.g. role-gated on a
 * backup target. Either way nothing may be claimed about completeness.
 */
export type PullPhaseOutcome = 'complete' | 'incomplete'

/**
 * Snapshot of the sync scheduler's state, returned by `SyncScheduler.status`.
 * Safe to expose in a reactive UI status indicator.
 */
export interface SyncSchedulerStatus {
  readonly state: SyncSchedulerState
  readonly lastPushAt: string | null
  readonly lastPullAt: string | null
  readonly lastError: Error | null
  readonly pendingWrites: number
  /**
   * Per-collection readiness. Empty unless `pull.mode === 'phased'`.
   *
   * A collection the sequence never names is **absent** from the map, and
   * `undefined` means *"no claim made"* — never a reason to gate a UI.
   */
  readonly readiness: ReadonlyMap<string, ReadinessState>
  /** 1-based position in the sequence, or `null` outside a phased run. */
  readonly phase: { readonly index: number; readonly total: number } | null
}

/**
 * Callbacks injected into `SyncScheduler` by the SyncEngine.
 *
 * The scheduler owns timers and lifecycle hooks; it delegates actual push/pull
 * work to these callbacks to stay decoupled from the sync implementation.
 */
export interface SyncSchedulerCallbacks {
  push(): Promise<void>
  /**
   * @param collections - Narrow the pull to these collections. Passed by a
   * `'phased'` sequence, one collection per phase; omitted for a whole-vault pull.
   * @returns Whether the pull may be treated as complete. Returning `void` reads
   * as `'complete'`, so callers with nothing to report need not opt in.
   */
  pull(collections?: readonly string[]): Promise<PullPhaseOutcome | void>
  getDirtyCount(): number
}

/**
 * Reject a policy that cannot mean anything, at construction rather than on
 * the first tick. Module-private: `SyncScheduler` is the choke point every
 * policy that can actually schedule must pass through — primary and per-target
 * alike — so validating here needs no new public surface and costs the kernel
 * floor nothing.
 */
function validatePullPolicy(pull: PullPolicy): void {
  if (pull.mode !== 'phased') {
    if (pull.sequence !== undefined) {
      throw new Error(
        `syncPolicy.pull.sequence is only meaningful with mode: 'phased' (got '${pull.mode}'). ` +
          `Set mode: 'phased' to run the sequence, or drop the field.`,
      )
    }
    return
  }

  const { sequence } = pull
  if (!sequence || sequence.length === 0) {
    throw new Error(
      `syncPolicy.pull.mode: 'phased' requires a non-empty 'sequence' of collection names.`,
    )
  }
  for (const name of sequence) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(
        `syncPolicy.pull.sequence entries must be non-empty collection names (got ${JSON.stringify(name)}).`,
      )
    }
  }
  const duplicate = sequence.find((name, i) => sequence.indexOf(name) !== i)
  if (duplicate !== undefined) {
    throw new Error(
      `syncPolicy.pull.sequence lists "${duplicate}" more than once. ` +
        `Each collection is pulled whole, so a repeat does no additional work.`,
    )
  }
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

  // Phased-pull progress. Empty for every other mode, so non-adopters carry
  // an empty Map and a null — no per-read cost, nothing to interpret.
  private readonly _readiness = new Map<string, ReadinessState>()
  private _phase: { readonly index: number; readonly total: number } | null = null

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
    validatePullPolicy(policy.pull)
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
      // Copied, not aliased — a status snapshot must not mutate under its reader.
      readiness: new Map(this._readiness),
      phase: this._phase,
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
    if (this.policy.pull.mode === 'interval') {
      this.startPullInterval()
    }

    // Pull: phased mode — walk the sequence in order, then settle into steady
    // state. Unawaited by design: start() is synchronous and the caller
    // (vault open) must not block on a bootstrap pull.
    if (this.policy.pull.mode === 'phased') {
      const sequence = this.policy.pull.sequence ?? []
      // Every named collection is 'cold' from the moment we start, so a reader
      // that races the first phase sees "not ready", never a missing entry.
      for (const collection of sequence) this._readiness.set(collection, 'cold')
      void this.runSequence(sequence)
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

    // A sequence cut mid-phase must not leave that collection 'pulling' —
    // a reader would show a skeleton that never resolves.
    for (const [collection, state] of this._readiness) {
      if (state === 'pulling') this._readiness.set(collection, 'cold')
    }
    this._phase = null

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

  /**
   * Arm the steady-state pull timer, if the policy specifies a cadence.
   * Shared by `'interval'` mode and by `'phased'` once its sequence drains.
   */
  private startPullInterval(): void {
    if (this.pullIntervalTimer || !this.policy.pull.intervalMs) return
    this.pullIntervalTimer = setInterval(() => {
      void this.executePull()
    }, this.policy.pull.intervalMs)
  }

  /**
   * Pull each collection in turn, then hand over to steady state.
   *
   * Strictly sequential — running phases concurrently would defeat the
   * prioritisation that is the entire point of a sequence. Each phase is an
   * ordinary scoped pull, so a phase that reports errors does not abort the
   * ones behind it; `executePull` records the failure and the walk continues.
   * `started` is re-checked between phases so `stop()` cuts a sequence short
   * instead of letting it run on against a closed vault.
   */
  private async runSequence(sequence: readonly string[]): Promise<void> {
    for (const [i, collection] of sequence.entries()) {
      if (!this.started) return
      this._readiness.set(collection, 'pulling')
      this._phase = { index: i + 1, total: sequence.length }

      const outcome = await this.executePull([collection])

      // 'live' only on a clean phase. Anything else — reported errors, a
      // role-gated skip, a throw — goes back to 'cold', because 'live' is a
      // promise that a miss from get() is a real absence.
      this._readiness.set(collection, outcome === 'complete' ? 'live' : 'cold')
    }
    this._phase = null
    if (this.started) this.startPullInterval()
  }

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

  private async executePull(collections?: readonly string[]): Promise<PullPhaseOutcome> {
    if (this._state === 'pulling') return 'incomplete'

    const previousState = this._state
    this._state = 'pulling'
    try {
      const outcome = await this.callbacks.pull(collections)
      this._lastPullAt = new Date().toISOString()
      this._lastError = null
      this._state = previousState === 'pending' ? 'pending' : 'idle'
      return outcome ?? 'complete'
    } catch (err) {
      this._lastError = err instanceof Error ? err : new Error(String(err))
      this._state = 'error'
      return 'incomplete'
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
