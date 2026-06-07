/**
 * Owns timers + unload hooks for the automatic snapshot cadence. Distinct from
 * the sync `SyncScheduler` (whose push/pull/dirty-count shape doesn't map to
 * snapshots) — it borrows only the policy vocabulary. Delegates the actual
 * snapshot work to `callbacks.fire()`.
 */
import type { SnapshotPolicy } from './policy.js'

export interface SnapshotSchedulerCallbacks {
  /** Fire one auto-snapshot cycle (per dirty vault). Swallows its own per-vault errors. */
  fire(): Promise<void>
  /** Number of vaults with pending writes since the last fire. */
  pendingCount(): number
}

export class SnapshotScheduler {
  private readonly policy: SnapshotPolicy
  private readonly callbacks: SnapshotSchedulerCallbacks

  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private intervalTimer: ReturnType<typeof setInterval> | null = null
  private lastFireTime = 0
  private firing = false
  private started = false

  private readonly boundVisibility: (() => void) | null = null
  private readonly boundUnload: (() => void) | null = null

  constructor(policy: SnapshotPolicy, callbacks: SnapshotSchedulerCallbacks) {
    this.policy = policy
    this.callbacks = callbacks
    if (this.shouldRegisterUnload()) {
      this.boundVisibility = this.handleVisibility.bind(this)
      this.boundUnload = this.handleUnload.bind(this)
    }
  }

  start(): void {
    if (this.started) return
    this.started = true

    if (this.policy.mode === 'interval') {
      const ms = this.policy.intervalMs ?? 300_000
      this.intervalTimer = setInterval(() => { void this.execFire() }, ms)
    }

    if (this.boundVisibility && this.boundUnload) {
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', this.boundVisibility)
      }
      if (typeof globalThis.addEventListener === 'function') {
        globalThis.addEventListener('pagehide', this.boundUnload)
      }
      if (typeof process !== 'undefined' && typeof process.on === 'function') {
        process.on('beforeExit', this.boundUnload)
      }
    }
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null }
    if (this.intervalTimer) { clearInterval(this.intervalTimer); this.intervalTimer = null }

    if (this.boundVisibility && this.boundUnload) {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this.boundVisibility)
      }
      if (typeof globalThis.removeEventListener === 'function') {
        globalThis.removeEventListener('pagehide', this.boundUnload)
      }
      if (typeof process !== 'undefined' && typeof process.removeListener === 'function') {
        process.removeListener('beforeExit', this.boundUnload)
      }
    }
  }

  notifyChange(): void {
    if (!this.started) return
    if (this.policy.mode === 'debounce') this.resetDebounce()
  }

  private resetDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    const ms = this.policy.debounceMs ?? 30_000
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.execFire()
    }, ms)
  }

  private async execFire(): Promise<void> {
    if (this.firing) return

    const minInterval = this.policy.minIntervalMs ?? 0
    if (minInterval > 0 && Date.now() - this.lastFireTime < minInterval) {
      if (this.policy.mode === 'debounce') this.resetDebounce()
      return
    }
    if (this.callbacks.pendingCount() === 0) return

    this.firing = true
    try {
      await this.callbacks.fire()
      this.lastFireTime = Date.now()
    } catch {
      // fire() swallows per-vault errors; this guards the contract regardless.
    } finally {
      this.firing = false
    }
  }

  private handleVisibility(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      this.flush()
    }
  }

  private handleUnload(): void {
    this.flush()
  }

  private flush(): void {
    if (this.callbacks.pendingCount() === 0) return
    void this.callbacks.fire().catch(() => {})
  }

  private shouldRegisterUnload(): boolean {
    return this.policy.onUnload ?? (this.policy.mode !== 'manual')
  }
}
