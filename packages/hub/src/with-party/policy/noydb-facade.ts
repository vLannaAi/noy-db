/**
 * Noydb-side policy / session-policy facade.
 *
 * Holds the vault-policy read/update/bootstrap logic (`getPolicy`,
 * `updatePolicy`, `bootstrapPolicy`) and the per-vault session-policy
 * enforcer wiring (`touchPolicy`, `checkPolicyOperation`). The session
 * *timer* and the managed-recovery enrolment check stay kernel-resident on
 * `Noydb` (interleaved with the instance lifecycle) and arrive here as the
 * `resetSessionTimer` / `assertRecoveryEnrolled` callbacks. The policy cache
 * and the enforcer map stay `Noydb`-resident too (touched by
 * `openVault`/`close`) and arrive by reference; behaviour is byte-identical
 * to the inline `Noydb` methods it replaced — every other dependency the
 * moving code touched on `this.*` arrives via {@link NoydbPolicyDeps}.
 *
 * Internal service — reached through `noydb.getPolicy(...)` etc. Public
 * contract ({@link NoydbPolicyApi} / {@link NoydbPolicyDeps} /
 * {@link NoydbPolicyFactory}) lives in the kernel spine; `createNoydb()`
 * wires this file's {@link createNoydbPolicy} in via a pre-resolved dynamic
 * import (the S4 gate recipe).
 */
import { ValidationError } from '../../kernel/errors.js'
import { PERSONAL_POLICY, mergePolicy } from './presets.js'
import { loadVaultPolicy, saveVaultPolicy } from './storage.js'
import type { VaultPolicy, ReAuthOperation, NoydbPolicyApi, NoydbPolicyDeps, NoydbPolicyFactory } from '../../kernel/types.js'

export class NoydbPolicy implements NoydbPolicyApi {
  constructor(private readonly deps: NoydbPolicyDeps) {}

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

/**
 * Factory that builds the `NoydbPolicy` service. `createNoydb()`
 * pre-resolves this via a dynamic import (mirrors
 * `with-party/directory/user-envelope/api.js#createUserApi`) and threads
 * it through `NoydbOptions.policyFactory` so `Noydb`'s constructor can
 * build `this.policyManager` synchronously.
 */
export const createNoydbPolicy: NoydbPolicyFactory = (deps) => new NoydbPolicy(deps)
