/**
 * Per-vault tier-3 (PIN / quick-resume) state — issue #11.
 *
 * The hub holds a `PinResumeState`-shaped record in memory, keyed by
 * vault. `enrollUnlock` populates it; `unlockViaPin` consumes it via
 * `@noy-db/on-pin`'s `resumePin`. The cached state is wiped when the
 * idle timer fires or `db.close()` is called.
 *
 * Importantly, this module does NOT depend on `@noy-db/on-pin` — the
 * caller passes the already-built state in. That keeps the hub's
 * `peerDependencies` empty for tier-3 and lets developers swap the
 * primitive (e.g. an OS biometric in place of a PIN).
 *
 * @module
 */

/**
 * Opaque `PinResumeState`-compatible record. Mirrored from
 * `@noy-db/on-pin/PinResumeState`. The hub treats the contents as
 * a black box.
 */
export interface QuickUnlockState {
  readonly _noydb_on_pin: 1
  readonly salt: string
  readonly iv: string
  readonly wrappedKeyring: string
  readonly expiresAt: string
  readonly maxAttempts: number
  attempts: number
}

/** In-memory store for tier-3 unlock state, keyed by vault. */
export class QuickUnlockStore {
  private readonly states = new Map<string, QuickUnlockState>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * Register a quick-unlock state for a vault. Replaces any existing
   * state. Schedules an automatic clear when the state's `expiresAt`
   * elapses.
   */
  set(vault: string, state: QuickUnlockState): void {
    this.clearTimer(vault)
    this.states.set(vault, state)
    const ttl = new Date(state.expiresAt).getTime() - Date.now()
    if (ttl > 0) {
      const timer = setTimeout(() => this.delete(vault), ttl)
      this.timers.set(vault, timer)
    }
  }

  /** Read the state for a vault. Returns undefined when none is registered. */
  get(vault: string): QuickUnlockState | undefined {
    return this.states.get(vault)
  }

  /** Drop the state for a vault. Cancels the auto-clear timer. */
  delete(vault: string): void {
    this.clearTimer(vault)
    this.states.delete(vault)
  }

  /** Drop every cached state. Called on `db.close()`. */
  clear(): void {
    for (const vault of this.states.keys()) {
      this.clearTimer(vault)
    }
    this.states.clear()
  }

  private clearTimer(vault: string): void {
    const t = this.timers.get(vault)
    if (t) clearTimeout(t)
    this.timers.delete(vault)
  }
}
