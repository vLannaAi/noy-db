/**
 * Policy gate engine — the {@link checkGate} entry point.
 *
 * Given a configured {@link VaultPolicy}, an active session tier, and
 * the factor proofs an actor is presenting, decide whether the gate
 * permits the action. On denial, throws {@link PolicyDeniedError} with
 * a stable {@link PolicyDenyReason} so consumers can branch in error
 * UIs.
 *
 * @see docs/subsystems/session-tiers.md → checkGate() API
 *
 * @module
 */
import { PolicyDeniedError, type PolicyDenyReason } from './errors.js'
import type {
  ActiveTier,
  FactorProof,
  GateName,
  GatePolicy,
  VaultPolicy,
  FactorRequirement,
} from './types.js'

/** Default freshness window — 5 minutes. */
export const DEFAULT_FRESHNESS_MS = 5 * 60 * 1000

/** Caller-supplied context for one `checkGate` invocation. */
export interface CheckGateContext {
  /** Tier the active session currently holds. */
  readonly activeTier: ActiveTier
  /** Proofs the actor is presenting for this gate. */
  readonly factors?: ReadonlyArray<FactorProof>
  /**
   * If the host knows the actor is on a shared device, set this to
   * `true` so the engine can apply `warn.sharedDevice` rules. Defaults
   * to `false`.
   */
  readonly sharedDevice?: boolean
  /**
   * Override `now()` for tests. Defaults to `Date.now()`.
   * @internal
   */
  readonly now?: number
}

/**
 * Decide whether `gate` permits the action under `context`. Throws
 * {@link PolicyDeniedError} on denial; resolves with `void` on success.
 *
 * Lookup rules:
 * - **Built-in gates** without a configured policy fail closed
 *   (`enabled: false`).
 * - **App-defined gates** (`app:*`) without a configured policy are
 *   treated as no-op (allow). The developer registered the policy if
 *   they wanted enforcement; absence means the gate is informational.
 */
export async function checkGate(
  policy: VaultPolicy,
  gate: GateName,
  context: CheckGateContext,
): Promise<void> {
  const configured = policy.gates[gate]
  if (!configured) {
    if (gate.startsWith('app:')) {
      // Custom app gate without a policy — the developer hasn't
      // registered one; engine treats it as an unenforced label.
      return
    }
    // Built-in gate without a policy — fail closed.
    throw deny(gate, 'disabled', { minTier: 1, enabled: false })
  }

  if (configured.enabled === false) {
    throw deny(gate, 'disabled', configured)
  }

  // Tier check first — cheap and a hard prerequisite.
  if (context.activeTier > configured.minTier) {
    // Higher number is a LOWER tier in this model (1 is most privileged).
    throw deny(gate, 'insufficient-tier', configured)
  }

  // Factor checks — every requirement entry must be satisfied.
  if (configured.factors && configured.factors.length > 0) {
    const presented = context.factors ?? []
    const now = context.now ?? Date.now()
    for (const requirement of configured.factors) {
      const matches = countMatchingFactors(presented, requirement, now)
      const need = requirement.count ?? 1
      if (matches.fresh < need) {
        if (matches.totalKindMatches < need) {
          throw deny(gate, 'missing-factor', configured)
        }
        // Some matched the kind list but not the freshness window.
        throw deny(gate, 'stale-proof', configured)
      }
    }
  }

  // Soft signals — only `'block'` raises here.
  if (configured.warn?.sharedDevice === 'block' && context.sharedDevice === true) {
    throw deny(gate, 'shared-device-blocked', configured)
  }
}

/**
 * Same as {@link checkGate} but returns a structured verdict instead
 * of throwing. Useful when an error UI wants to show the user
 * "you'll need TOTP plus a recovery code to do that" without first
 * triggering the action.
 */
export async function describeGate(
  policy: VaultPolicy,
  gate: GateName,
  context: CheckGateContext,
): Promise<{ ok: true } | { ok: false; reason: PolicyDenyReason; required: GatePolicy }> {
  try {
    await checkGate(policy, gate, context)
    return { ok: true }
  } catch (err) {
    if (err instanceof PolicyDeniedError) {
      return { ok: false, reason: err.reason, required: err.required }
    }
    throw err
  }
}

function countMatchingFactors(
  presented: ReadonlyArray<FactorProof>,
  requirement: FactorRequirement,
  now: number,
): { totalKindMatches: number; fresh: number } {
  const freshnessMs = requirement.freshnessMs ?? DEFAULT_FRESHNESS_MS
  let totalKindMatches = 0
  let fresh = 0
  for (const proof of presented) {
    if (!requirement.anyOf.includes(proof.kind)) continue
    totalKindMatches += 1
    const minted = proof.mintedAt ? Date.parse(proof.mintedAt) : now
    if (Number.isFinite(minted) && now - minted <= freshnessMs) {
      fresh += 1
    }
  }
  return { totalKindMatches, fresh }
}

function deny(gate: GateName, reason: PolicyDenyReason, required: GatePolicy): PolicyDeniedError {
  return new PolicyDeniedError(gate, reason, required)
}
