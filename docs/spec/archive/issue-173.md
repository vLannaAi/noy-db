# Issue #173 — Showcase 08: Resilient Middleware (Node.js)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-11
- **Closed:** 2026-04-20
- **Milestone:** Showcases
- **Labels:** showcases

---

## 08-resilient-middleware.showcase.ts — "Network Chaos"

**Framework:** Node.js (pure hub) | **Store:** `wrapStore(flaky, ...)` | **Branch:** `showcase/08-resilient-middleware`

### Flow
- Wrap flaky store with `withRetry`, `withCircuitBreaker`, `withMetrics`, `withLogging`
- Write succeeds after retries → metrics show attempts
- Permanent failure → circuit opens → fast-fail nulls
- Restore → circuit recovers

**Goal:** Enterprise resilience with zero custom code.
**Dimension:** Production resilience, middleware composition
