# Issue #232 — refactor(hub/team): group sync + multi-user keyring into packages/hub/src/team/

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.15.1 — Hub refactor (backward-compat)
- **Labels:** type: feature, area: core

---

Move `sync.ts` + multi-user keyring helpers (grant, revoke, rotateKeys, changeSecret, listUsers) + SyncTarget/SyncStrategy types into `packages/hub/src/team/` subdirectory. Barrel re-exports preserved on main entry. Subpath entry `@noy-db/hub/team` added.

Rationale: solo apps that never call `grant()` / `sync.push()` can avoid bundling the sync engine + keyring manipulation code (~4–6 KB estimated savings when imported via subpath). Keeps the multi-user abstraction visually isolated.
