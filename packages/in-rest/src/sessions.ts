import type { Noydb } from '@noy-db/hub'

interface Session {
  db: Noydb
  expiresAt: number
}

/**
 * Options for `SessionStore`.
 *
 * `sweepIntervalMs` controls the periodic background sweep that drops
 * expired sessions from the map (#279 item #5). Without it, expired
 * tokens only clear when a matching `get()` / `peek()` call happens —
 * a long-running process with many short-lived sessions accumulates
 * dead entries unbounded. Default is 5 minutes; pass `0` to disable
 * the sweep (appropriate for tests or very short-lived CLI processes).
 */
export interface SessionStoreOptions {
  sweepIntervalMs?: number
}

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000

export class SessionStore {
  private readonly sessions = new Map<string, Session>()
  private readonly ttlMs: number
  private readonly sweepTimer: ReturnType<typeof setInterval> | null

  constructor(ttlSeconds: number, options: SessionStoreOptions = {}) {
    this.ttlMs = ttlSeconds * 1000
    const sweepMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
    if (sweepMs > 0) {
      // Node's setInterval returns a Timeout whose `.unref()` prevents
      // the timer from keeping the event loop alive. That matters in
      // CLI / serverless contexts where the Node process should exit
      // cleanly once the request cycle ends.
      const timer = setInterval(() => this.sweep(), sweepMs)
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref()
      }
      this.sweepTimer = timer
    } else {
      this.sweepTimer = null
    }
  }

  create(db: Noydb): string {
    const token = crypto.randomUUID()
    this.sessions.set(token, { db, expiresAt: Date.now() + this.ttlMs })
    return token
  }

  /**
   * Look up a session and refresh its sliding-window TTL. Call from
   * auth-guarded routes that are treated as "activity".
   */
  get(token: string): Noydb | null {
    const session = this.sessions.get(token)
    if (!session) return null
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token)
      return null
    }
    session.expiresAt = Date.now() + this.ttlMs
    return session.db
  }

  delete(token: string): void {
    this.sessions.delete(token)
  }

  /**
   * Non-refreshing existence check. Used by polling endpoints like
   * `GET /sessions/current` that should not extend the session merely
   * by being queried.
   */
  peek(token: string): boolean {
    const session = this.sessions.get(token)
    if (!session) return false
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token)
      return false
    }
    return true
  }

  /**
   * Drop every session whose TTL has elapsed. Called automatically by
   * the internal interval timer; exposed so tests can deterministically
   * trigger the sweep without waiting. Returns the count of entries
   * removed — useful for logging / metrics hooks.
   */
  sweep(): number {
    const now = Date.now()
    let removed = 0
    for (const [token, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.sessions.delete(token)
        removed++
      }
    }
    return removed
  }

  /**
   * Current number of tracked sessions (expired or not). Primarily for
   * tests that verify the sweep is working; operators wanting live
   * metrics should wrap the store or emit their own counters.
   */
  size(): number {
    return this.sessions.size
  }

  /**
   * Stop the background sweep timer and drop every session. Call this
   * on shutdown to allow the event loop to exit cleanly — `unref()`
   * handles most cases, but explicit cleanup is cheaper than relying
   * on finalization.
   */
  close(): void {
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer)
    this.sessions.clear()
  }
}
