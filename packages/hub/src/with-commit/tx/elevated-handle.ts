/**
 * The scoped {@link ElevatedHandle} returned by `vault.elevate(...)`, lifted
 * off the `Vault` god-object (Phase 5 A6 of the microkernel refactoring).
 *
 * The handle holds only a reference to its issuing {@link Vault} and delegates
 * the single elevated write back to `vault._elevatedPut`. It is a pure move —
 * behaviour is byte-identical to the inner class it replaced. The `Vault` type
 * is imported `type`-only so the runtime import graph stays acyclic (vault.ts
 * imports this module for the value; this module imports vault.ts only for the
 * type).
 */
import { ElevationExpiredError } from '../../errors.js'
import type { Vault } from '../../vault.js'

/**
 * Reserved collection that holds the audit ledger of elevation
 * sessions. One envelope per `vault.elevate(...)` call.
 */
export const ELEVATION_AUDIT_COLLECTION = '_elevation_audit'

/**
 * Scoped handle returned by `vault.elevate(...)`. Writes through this
 * handle land at the elevated tier with `authorization: 'elevation'`
 * stamped on the audit event; reads stay on the original `Vault`.
 *
 * The handle lazily checks its TTL on every operation, so a
 * forgotten `release()` cannot keep elevated writes alive past
 * `expiresAt` — the next call simply throws
 * {@link ElevationExpiredError}.
 *
 * Naming note: the issue's spec text used `elevated.session`
 * for this field; we name the field `handle` to avoid conflicting
 * with the codebase's existing `SessionToken` value type. The
 * semantics are unchanged.
 */
export class ElevatedHandle {
  /** Target tier this handle writes at. */
  readonly tier: number
  /** Audit string stamped on every cross-tier event. */
  readonly reason: string
  /** Absolute expiration in ms (Date.now()). */
  readonly expiresAt: number
  private released = false
  private readonly vault: Vault
  private readonly onRelease: () => void

  constructor(opts: {
    vault: Vault
    tier: number
    reason: string
    expiresAt: number
    onRelease: () => void
  }) {
    this.vault = opts.vault
    this.tier = opts.tier
    this.reason = opts.reason
    this.expiresAt = opts.expiresAt
    this.onRelease = opts.onRelease
  }

  /**
   * Scoped collection accessor. Returns a thin wrapper exposing the
   * single elevated operation (`put`). Reads, deletes, queries —
   * everything else — should go through the original `vault`'s
   * `collection(...)`, which keeps "writes elevated, reads
   * unprivileged" trivially true.
   */
  collection<T>(name: string): { put(id: string, record: T): Promise<void> } {
    // Don't gate the wrapper itself — just the operation. Adopters
    // commonly cache `const docs = elev.collection('docs')` and the
    // lazy-check still works correctly because assertActive runs at
    // every `put` call, against a fresh `Date.now()`.
    return {
      put: async (id: string, record: T): Promise<void> => {
        this.assertActive()
        await this.vault._elevatedPut<T>(name, id, record, this.tier, this.reason)
      },
    }
  }

  /**
   * Manually revert the elevation. Idempotent — calling twice (or
   * after the TTL expired) is a safe no-op. The vault's
   * active-elevation slot is cleared so a subsequent
   * `vault.elevate(...)` succeeds without throwing
   * {@link AlreadyElevatedError}.
   */
  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    this.onRelease()
  }

  private assertActive(): void {
    if (this.released) {
      throw new ElevationExpiredError({ tier: this.tier, expiresAt: this.expiresAt })
    }
    if (Date.now() > this.expiresAt) {
      // Auto-release on first use past TTL so the vault's active
      // slot frees up without requiring the caller to think about
      // explicit release on expiry.
      this.released = true
      this.onRelease()
      throw new ElevationExpiredError({ tier: this.tier, expiresAt: this.expiresAt })
    }
  }
}
