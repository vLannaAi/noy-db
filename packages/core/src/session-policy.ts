/**
 * Session policies — v0.7 #114
 *
 * A `SessionPolicy` is a small declarative object that controls how long a
 * session lives and which operations require re-authentication. It is
 * evaluated by the `PolicyEnforcer` class, which the Noydb instance
 * integrates to replace the bare `sessionTimeout` timer from v0.6.
 *
 * Design decisions
 * ────────────────
 * Policies are stateless value objects — no timers, no event listeners.
 * The Noydb instance is the stateful coordinator: it holds the enforcer,
 * calls `enforcer.touch()` on every operation, and calls
 * `enforcer.checkOperation()` before high-risk operations.
 *
 * This keeps the policy module easy to unit-test (no global timers to mock)
 * and avoids the "who owns cleanup" problem that comes with timer-based
 * callbacks embedded in a value object.
 *
 * `lockOnBackground` registers a `visibilitychange` listener on the document
 * at enforcer creation time and removes it on `destroy()`. It is a no-op in
 * non-browser environments (no `document`).
 */

import type { SessionPolicy, ReAuthOperation } from './types.js'
import { SessionExpiredError, SessionPolicyError } from './errors.js'
import { revokeSession } from './session.js'

// ─── PolicyEnforcer ────────────────────────────────────────────────────

export interface PolicyEnforcerOptions {
  /** The policy to enforce. */
  policy: SessionPolicy
  /** The session ID to revoke when idle/absolute timeouts fire. */
  sessionId: string
  /**
   * Called when the policy decides the session should end (idle timeout,
   * absolute timeout, or lockOnBackground). Use this to trigger the
   * same cleanup that `Noydb.close()` would perform.
   */
  onRevoke: (reason: 'idle' | 'absolute' | 'background') => void
}

/**
 * Stateful enforcer for a single session policy.
 *
 * Create one per open session, call `touch()` on every operation,
 * call `checkOperation(op)` before export/grant/revoke/rotate/changeSecret,
 * and call `destroy()` when the session ends.
 */
export class PolicyEnforcer {
  private readonly policy: SessionPolicy
  private readonly sessionId: string
  private readonly onRevoke: PolicyEnforcerOptions['onRevoke']
  private readonly createdAt: number
  private lastActivityAt: number
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private absoluteTimer: ReturnType<typeof setTimeout> | null = null
  private visibilityHandler: (() => void) | null = null

  constructor(opts: PolicyEnforcerOptions) {
    this.policy = opts.policy
    this.sessionId = opts.sessionId
    this.onRevoke = opts.onRevoke
    this.createdAt = Date.now()
    this.lastActivityAt = Date.now()

    this.scheduleIdleTimer()
    this.scheduleAbsoluteTimer()
    this.registerBackgroundLock()
  }

  /**
   * Record an activity timestamp and reset the idle timer.
   * Call this at the top of every Noydb public method.
   */
  touch(): void {
    this.lastActivityAt = Date.now()
    this.scheduleIdleTimer()
  }

  /**
   * Check whether the given operation is allowed under the active policy.
   * Throws `SessionPolicyError` if the operation requires re-authentication.
   * Throws `SessionExpiredError` if the absolute timeout has been exceeded
   * (defensive check in case the timer fired before the call arrived).
   *
   * This is a synchronous check — callers don't await it.
   */
  checkOperation(op: ReAuthOperation): void {
    // Defensive absolute-timeout check (timer may have fired late)
    const { absoluteTimeoutMs } = this.policy
    if (absoluteTimeoutMs !== undefined && Date.now() - this.createdAt >= absoluteTimeoutMs) {
      this.expire('absolute')
      throw new SessionExpiredError(this.sessionId)
    }

    const required = this.policy.requireReAuthFor ?? []
    if (required.includes(op)) {
      throw new SessionPolicyError(op)
    }
  }

  /**
   * Tear down timers and background-lock listener. Call from `Noydb.close()`
   * and whenever the session is revoked externally.
   */
  destroy(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.absoluteTimer) {
      clearTimeout(this.absoluteTimer)
      this.absoluteTimer = null
    }
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler)
      this.visibilityHandler = null
    }
  }

  /** How long since the last activity, in ms. */
  get idleMs(): number {
    return Date.now() - this.lastActivityAt
  }

  /** How long since session creation, in ms. */
  get ageMs(): number {
    return Date.now() - this.createdAt
  }

  // ── Private ──────────────────────────────────────────────────────────

  private scheduleIdleTimer(): void {
    const { idleTimeoutMs } = this.policy
    if (!idleTimeoutMs) return

    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.expire('idle')
    }, idleTimeoutMs)
  }

  private scheduleAbsoluteTimer(): void {
    const { absoluteTimeoutMs } = this.policy
    if (!absoluteTimeoutMs) return

    if (this.absoluteTimer) clearTimeout(this.absoluteTimer)
    this.absoluteTimer = setTimeout(() => {
      this.expire('absolute')
    }, absoluteTimeoutMs)
  }

  private registerBackgroundLock(): void {
    if (!this.policy.lockOnBackground) return
    if (typeof document === 'undefined') return

    this.visibilityHandler = () => {
      if (document.hidden) {
        this.expire('background')
      }
    }
    document.addEventListener('visibilitychange', this.visibilityHandler)
  }

  private expire(reason: 'idle' | 'absolute' | 'background'): void {
    this.destroy()
    revokeSession(this.sessionId)
    this.onRevoke(reason)
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Build a `PolicyEnforcer` from a policy + session token, and return it
 * alongside a cleanup function. Convenience wrapper for Noydb.
 */
export function createEnforcer(opts: PolicyEnforcerOptions): PolicyEnforcer {
  return new PolicyEnforcer(opts)
}

/**
 * Validate that a `SessionPolicy` is well-formed.
 * Throws a plain `Error` (not `NoydbError`) because this is a developer
 * error — invalid policies passed at construction time, not at runtime.
 */
export function validateSessionPolicy(policy: SessionPolicy): void {
  const { idleTimeoutMs, absoluteTimeoutMs } = policy
  if (idleTimeoutMs !== undefined && (typeof idleTimeoutMs !== 'number' || idleTimeoutMs <= 0)) {
    throw new Error(`SessionPolicy.idleTimeoutMs must be a positive number, got ${idleTimeoutMs}`)
  }
  if (absoluteTimeoutMs !== undefined && (typeof absoluteTimeoutMs !== 'number' || absoluteTimeoutMs <= 0)) {
    throw new Error(`SessionPolicy.absoluteTimeoutMs must be a positive number, got ${absoluteTimeoutMs}`)
  }
  if (idleTimeoutMs !== undefined && absoluteTimeoutMs !== undefined && idleTimeoutMs >= absoluteTimeoutMs) {
    throw new Error(
      `SessionPolicy.idleTimeoutMs (${idleTimeoutMs}ms) must be less than absoluteTimeoutMs (${absoluteTimeoutMs}ms)`,
    )
  }
}
