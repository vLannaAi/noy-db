/**
 * `@noy-db/hub/broker` — subpath export for the credential-broker capability
 * (#479, credential-broker spec). Apps that never call `vault.broker()` can
 * exclude this subpath entirely: the floor default `NO_BROKER` throws, and
 * this module's real engine (`with-party/broker/{seed,active}.ts`) is only
 * ever reached through `withBroker()`'s dynamic imports, so it never enters
 * a floor bundle.
 *
 * Also re-exports the host-side helpers (`issueChallenge`, `verifyBrokerProof`)
 * from the enclave barrel, so a Lambda/Worker implementing the reference
 * broker host can import just this one subpath and get everything it
 * needs, `crypto.subtle`-only.
 */

// ─── Capability opt-in seam ──────────────────────────────────
export { withBroker } from './active.js'
export {
  NO_BROKER,
  type BrokerStrategy,
  type BrokerCtx,
  type BrokerConfig,
  type CredentialBrokerHandle,
} from '../../port/with/broker-strategy.js'
export { BrokerNotEnabledError, BrokerEnrolmentError, BrokerProofError } from '../../kernel/errors.js'

// ─── Host helpers (verify side — for a reference broker host) ───
import { issueChallenge as issueChallengeRaw, verifyBrokerProof } from '../../kernel/enclave/index.js'
import type { IssuedChallenge, VerifyBrokerProofArgs } from '../../kernel/enclave/index.js'

/**
 * Floor — a challenge TTL must survive network latency + clock drift
 * between host and client. The enclave's `issueChallenge` is deliberately
 * unclamped (a mechanical primitive, not a policy); this floor is host
 * POLICY, so it lives here in the party layer, not
 * `kernel/enclave/broker/proof.ts` (carried forward from Task 2's review,
 * I6b).
 */
const MIN_CHALLENGE_TTL_MS = 10_000
/** Ceiling — spec §2 step 2: "TTL ≤ 60 s". */
const MAX_CHALLENGE_TTL_MS = 60_000

/**
 * {@link issueChallengeRaw} (the enclave's mechanical primitive) with a
 * `[10s, 60s]` TTL clamp applied, so a reference host built on this barrel
 * gets a safe challenge TTL without having to know the bounds itself.
 */
export function issueChallenge(opts?: { ttlMs?: number }): IssuedChallenge {
  const requested = opts?.ttlMs ?? MAX_CHALLENGE_TTL_MS
  const clamped = Math.min(Math.max(requested, MIN_CHALLENGE_TTL_MS), MAX_CHALLENGE_TTL_MS)
  return issueChallengeRaw({ ttlMs: clamped })
}
export { verifyBrokerProof }
export type { VerifyBrokerProofArgs }
