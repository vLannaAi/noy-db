# session

> **Subpath:** `@noy-db/hub/session`
> **Factory:** `withSession()`
> **Cluster:** F — Collaboration & Auth
> **LOC cost:** ~495 (off-bundle when not opted in)

## What it does

Session-policy enforcement: idle timeouts, absolute timeouts, lock-on-background, re-auth gates for high-risk operations (export, grant, revoke, rotate, changeSecret). Also exposes a global session-token registry for multi-tab coordination. Dev-unlock (`enableDevUnlock` / `loadDevUnlock`) for development-mode persistent sessions is a separate import that tree-shakes naturally.

## When you need it

- Long-running web apps that need idle/absolute timeouts
- Sensitive operations that must require fresh re-auth
- Mobile/desktop apps that should lock when backgrounded
- Multi-tab coordination via `revokeSession(id)` / `revokeAllSessions()`

## Opt-in

```ts
import { createNoydb } from '@noy-db/hub'
import { withSession } from '@noy-db/hub/session'

const db = await createNoydb({
  store: ...,
  user: ...,
  sessionStrategy: withSession(),

  sessionPolicy: {
    idleTimeoutMs: 15 * 60_000,
    absoluteTimeoutMs: 8 * 60 * 60_000,
    lockOnBackground: true,
    reAuthOps: ['export', 'grant', 'rotate'],
  },
})
```

Dev-unlock (separate, no strategy):

```ts
import { enableDevUnlock, loadDevUnlock, isDevUnlockActive } from '@noy-db/hub'
```

## API

- `createSession(opts)` / `resolveSession(token)` / `revokeSession(token)` / `revokeAllSessions()`
- `isSessionAlive(token)` / `activeSessionCount()`
- `validateSessionPolicy(policy)` — call-time validation
- `PolicyEnforcer` — internal class wired by `createEnforcer()`

## Behavior when NOT opted in

- Setting `sessionPolicy` in `createNoydb` throws with a pointer to `@noy-db/hub/session`
- `revokeAllSessions()` is a silent no-op (registry never populated)

## Pairs well with

- **team** — token sessions enforce grant policies
- **on-webauthn / on-oidc / on-magic-link** (separate packages) — unlock paths that issue session tokens

## Edge cases & limits

- `lockOnBackground` registers a `visibilitychange` listener; no-op in non-browser environments
- Absolute timeout overrides idle timeout (you can't extend past `absoluteTimeoutMs` no matter how active you are)
- Re-auth ops trigger `SessionPolicyError` until the user re-unlocks

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- `__tests__/session-policy.test.ts`, `__tests__/dev-unlock.test.ts`
