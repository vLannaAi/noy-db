/**
 * Noydb-side policy / session-policy facade.
 *
 * Holds the vault-policy read/update/bootstrap logic (`getPolicy`,
 * `updatePolicy`, `bootstrapPolicy`) and the per-vault session-policy
 * enforcer wiring (`attachPolicyEnforcer`, `touchPolicy`,
 * `checkPolicyOperation`). The session *timer* and the managed-recovery
 * enrolment check stay kernel-resident on `Noydb` (interleaved with the
 * instance lifecycle) and arrive here as the `resetSessionTimer` /
 * `assertRecoveryEnrolled` callbacks. The policy cache and the enforcer map
 * stay `Noydb`-resident too (touched by `openVault`/`close`) and arrive by
 * reference; behaviour is byte-identical to the inline `Noydb` methods it
 * replaced — every other dependency the moving code touched on `this.*` arrives
 * via {@link NoydbPolicyDeps}.
 *
 * Internal service — reached through `noydb.getPolicy(...)` etc.
 */
import { ValidationError } from '../errors.js'
import { PERSONAL_POLICY, mergePolicy } from './presets.js'
import { loadVaultPolicy, saveVaultPolicy } from './storage.js'
import type { VaultPolicy } from './types.js'
import type { NoydbStore, ReAuthOperation, SessionPolicy } from '../types.js'
import type { PolicyEnforcer } from '../../with-party/session/session-policy.js'
import type { SessionStrategy } from '../../with-party/session/strategy.js'

/** Everything the moving policy/session methods touched on the Noydb instance's `this.*`. */
export interface NoydbPolicyDeps {
  /** In-memory vault-policy cache (Noydb-resident; read/written by reference). */
  readonly policyCache: Map<string, VaultPolicy>
  /** Per-vault session-policy enforcers (Noydb-resident; read/written by reference). */
  readonly policyEnforcers: Map<string, PolicyEnforcer>
  /** Resolved session strategy (NO_SESSION when not configured). */
  readonly sessionStrategy: SessionStrategy
  /** The ciphertext store. */
  readonly store: NoydbStore
  /** Whether records are encrypted (`options.encrypt !== false`). */
  readonly encrypted: boolean
  /** The configured session policy, or undefined. */
  readonly sessionPolicy: SessionPolicy | undefined
  /** The developer-supplied default policy, or undefined. */
  readonly policyOption: VaultPolicy | undefined
  /** Whether the owning instance has been closed. */
  isClosed(): boolean
  /** Reset the kernel-resident idle/session timer. */
  resetSessionTimer(): void
  /** Managed-recovery enrolment check (kernel-resident; called on bootstrap). */
  assertRecoveryEnrolled(
    vault: string,
    policy: VaultPolicy,
    opts?: { skipManagedCheck?: boolean },
  ): Promise<void>
  /** Evict the keyring + vault caches when a session is revoked. */
  onSessionRevoke(vault: string): void
}

export class NoydbPolicy {
  constructor(private readonly deps: NoydbPolicyDeps) {}

  /**
   * Attach a policy enforcer for a vault.
   * Called internally when a session is started for a vault; the
   * enforcer handles idle/absolute timeouts and background-lock behavior.
   */
  attachPolicyEnforcer(vault: string, sessionId: string): void {
    const policy = this.deps.sessionPolicy
    if (!policy) return

    // Tear down any previous enforcer for this vault
    this.deps.policyEnforcers.get(vault)?.destroy()

    const enforcer = this.deps.sessionStrategy.createEnforcer({
      policy,
      sessionId,
      onRevoke: (_reason) => {
        this.deps.onSessionRevoke(vault)
        this.deps.policyEnforcers.delete(vault)
      },
    })
    this.deps.policyEnforcers.set(vault, enforcer)
  }

  /**
   * Touch the policy enforcer for a vault (records activity, resets
   * idle timer). Also touches the legacy session timer. No-op if no enforcer.
   */
  touchPolicy(vault?: string): void {
    this.deps.resetSessionTimer()
    if (vault) {
      this.deps.policyEnforcers.get(vault)?.touch()
    }
  }

  /**
   * Check that a policy-guarded operation is permitted.
   * Throws `SessionPolicyError` if re-auth is required.
   */
  checkPolicyOperation(vault: string, op: ReAuthOperation): void {
    this.deps.policyEnforcers.get(vault)?.checkOperation(op)
  }

  /**
   * Read the active policy for a vault. Loads from `_meta/policy` on
   * first call; subsequent calls hit the in-memory cache. Throws
   * `ValidationError` if the vault has not been opened.
   */
  async getPolicy(vault: string): Promise<VaultPolicy> {
    if (this.deps.isClosed()) throw new ValidationError('Instance is closed')
    const cached = this.deps.policyCache.get(vault)
    if (cached) return cached
    await this.bootstrapPolicy(vault)
    return this.deps.policyCache.get(vault) ?? PERSONAL_POLICY
  }

  /**
   * Replace the policy document at `_meta/policy` and update the
   * in-memory cache. Gated by the `enroll-user` policy (a policy
   * change is fundamentally a privilege-management action).
   */
  async updatePolicy(vault: string, override: Partial<VaultPolicy>): Promise<VaultPolicy> {
    if (this.deps.isClosed()) throw new ValidationError('Instance is closed')
    const current = await this.getPolicy(vault)
    const merged = mergePolicy(current, override)
    if (this.deps.encrypted) {
      await saveVaultPolicy(this.deps.store, vault, merged)
    }
    this.deps.policyCache.set(vault, merged)
    return merged
  }

  /** Read or persist the vault policy at `_meta/policy` on first open. */
  async bootstrapPolicy(
    vault: string,
    opts?: { skipManagedCheck?: boolean },
  ): Promise<void> {
    const onDisk = await loadVaultPolicy(this.deps.store, vault)
    if (onDisk) {
      // Honour the on-disk document; developer overrides cannot
      // weaken what the vault committed to at creation time.
      this.deps.policyCache.set(vault, onDisk)
      await this.deps.assertRecoveryEnrolled(vault, onDisk, opts)
      return
    }
    // First time — persist the developer's policy (or default preset).
    const initial = this.deps.policyOption
      ? mergePolicy(PERSONAL_POLICY, this.deps.policyOption)
      : PERSONAL_POLICY
    await saveVaultPolicy(this.deps.store, vault, initial)
    this.deps.policyCache.set(vault, initial)
    await this.deps.assertRecoveryEnrolled(vault, initial, opts)
  }
}
