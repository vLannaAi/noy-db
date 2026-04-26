/**
 * Strategy seam for the optional session-policy subsystem. Core
 * imports `SessionStrategy` type-only + `NO_SESSION` stub; real
 * `validateSessionPolicy`, `createEnforcer`, and `revokeAllSessions`
 * are only reachable via `withSession()` in `./active.ts`.
 *
 * Solo apps that never set `sessionPolicy` and never issue a session
 * token ship none of the ~495 LOC of policy + token machinery
 * (session-policy.ts + session.ts). Dev-unlock (~299 LOC) is a
 * separate import already tree-shake-friendly via direct named
 * imports.
 *
 * Behavior under NO_SESSION:
 *
 * - **validateSessionPolicy** — throws when called. Only fires if
 *   `createNoydb({ sessionPolicy })` was passed; if you set a policy
 *   you must opt into the strategy.
 * - **createEnforcer** — throws. Same gate.
 * - **revokeAllSessions** — silent no-op. Called unconditionally on
 *   `db.close()`; without the strategy the global session registry
 *   never recorded anything, so the no-op is correct.
 *
 * @internal
 */

import type { SessionPolicy } from '../types.js'
import type { PolicyEnforcer, PolicyEnforcerOptions } from './session-policy.js'

/**
 * @internal
 */
export interface SessionStrategy {
  validateSessionPolicy(policy: SessionPolicy): void
  createEnforcer(opts: PolicyEnforcerOptions): PolicyEnforcer
  revokeAllSessions(): void
}

function notEnabled(op: string): Error {
  return new Error(
    `${op} requires the session strategy. Import ` +
    '`{ withSession }` from "@noy-db/hub/session" and pass it to ' +
    '`createNoydb({ sessionStrategy: withSession() })`.',
  )
}

/**
 * No-session stub. Policy validation + enforcer construction throw
 * with an actionable pointer; global session revocation is a silent
 * no-op (the registry was never populated).
 *
 * @internal
 */
export const NO_SESSION: SessionStrategy = {
  validateSessionPolicy() { throw notEnabled('sessionPolicy') },
  createEnforcer() { throw notEnabled('session policy enforcement') },
  revokeAllSessions() {},
}
