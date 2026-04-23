# Issue #233 — refactor(hub/session): group session tokens + policies into packages/hub/src/session/

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.15.1 — Hub refactor (backward-compat)
- **Labels:** type: feature, area: core

---

Move `session.ts`, `session-policy.ts`, session-credential helpers, dev-unlock helpers into `packages/hub/src/session/`. Barrel re-exports preserved. Subpath entry `@noy-db/hub/session` added.

Rationale: apps that do not use session tokens (single-user, single-shot unlock pattern) save ~2 KB via subpath import. The session layer is conceptually a distinct layer on top of the keyring.

NOTE: `magic-link` helpers currently live in hub/session — those extract separately into `@noy-db/on-magic-link` (Fork · On).
