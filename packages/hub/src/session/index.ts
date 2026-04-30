/**
 * `@noy-db/hub/session` — subpath export for session tokens + policies.
 *
 * Apps that use single-shot unlock (one `createNoydb()` call per user
 * action) can exclude this subpath — ~2 KB saved. Long-running apps
 * with idle timeout, re-auth policies, magic-link viewer sessions,
 * or dev-mode unlock opt in here.
 *
 * The main `@noy-db/hub` entry still re-exports every symbol for
 * backward compatibility through.x.
 *
 * NOTE: magic-link helpers are expected to extract into a new
 * `@noy-db/on-magic-link` package per Fork · On #8. Until that lands,
 * they live here alongside session primitives.
 */

// ─── Session tokens ─────────────────────────────────────
export {
  createSession,
  resolveSession,
  revokeSession,
  revokeAllSessions,
  isSessionAlive,
  activeSessionCount,
} from './session.js'
export type {
  SessionToken,
  CreateSessionResult,
  CreateSessionOptions,
} from './session.js'

// ─── Session policy enforcement ─────────────────────────
export { PolicyEnforcer, createEnforcer, validateSessionPolicy } from './session-policy.js'

// ─── Dev-mode persistent unlock ─────────────────────────
export {
  enableDevUnlock,
  loadDevUnlock,
  clearDevUnlock,
  isDevUnlockActive,
} from './dev-unlock.js'
export type { DevUnlockOptions } from './dev-unlock.js'

// Magic-link extracted to @noy-db/on-magic-link in.
// `import { ... } from '@noy-db/on-magic-link'`

// ─── Strategy seam ─────────────────────────────────────
export { withSession } from './active.js'
export type { SessionStrategy } from './strategy.js'
