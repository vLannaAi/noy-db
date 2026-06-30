/**
 * Active session strategy — `withSession()` returns the real
 * implementation that wires `SessionPolicy` validation, the
 * `PolicyEnforcer`, and the global session-token registry into the
 * Noydb lifecycle.
 *
 * Consumers opt in by:
 *
 * ```ts
 * import { createNoydb } from '@noy-db/hub'
 * import { withSession } from '@noy-db/hub/session'
 *
 * const db = await createNoydb({
 *   store: ...,
 *   user: ...,
 *   sessionPolicy: { idleTimeoutMs: 15 * 60_000 },
 *   sessionStrategy: withSession(),
 * })
 * ```
 *
 * The factory delegates to the existing `session-policy.ts` and
 * `session.ts` modules. Splitting the import chain through this file
 * is what lets tsup tree-shake the ~495 LOC of policy + token code
 * out of the default bundle when no `withSession()` import is
 * present.
 *
 * Note: dev-unlock (`devUnlock`, `cancelDevUnlock`) is a separate
 * named import from `@noy-db/hub` and tree-shakes independently —
 * apps that don't import it never include it.
 *
 * @public
 */

import type { SessionStrategy } from './strategy.js'
import { createEnforcer, validateSessionPolicy } from './session-policy.js'
import { revokeAllSessions } from './session.js'

export function withSession(): SessionStrategy {
  return {
    validateSessionPolicy,
    createEnforcer,
    revokeAllSessions,
  }
}
