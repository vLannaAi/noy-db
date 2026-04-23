# Issue #40 — E2E CI matrix for @noy-db/create

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **Closed:** 2026-04-07
- **Milestone:** v0.5.0
- **Labels:** type: chore, priority: high, area: scaffolder, release: v0.5

---

Deferred from #7. Add e2e-scaffolder job to ci.yml that runs the full wizard + noy-db CLI flow across OS (ubuntu/macos/windows) × Node (20/22) × pm (npm/pnpm/yarn) × adapter (browser/file/memory). Per cell: pnpm pack → install tarball → run wizard → install → build → verify. Would have caught the v0.3.1 → v0.3.2 missing-runtime-deps bug. Estimate: M.
