# Issue #168 — Showcase 03: Store Routing (Node.js)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-11
- **Closed:** 2026-04-20
- **Milestone:** Showcases
- **Labels:** showcases

---

## 03-store-routing.showcase.ts — "Right Data, Right Store"

**Framework:** Node.js (pure hub) | **Store:** `routeStore(...)` | **Branch:** `showcase/03-store-routing`

### Flow
- `routeStore({ default: memory(), routes: { audit: memory() } })`
- Write invoices → default store; write audit → audit store
- Cross-check records in correct backing store
- Override a route at runtime → suspend/resume with queue

**Goal:** Show `routeStore` eliminates one-size-fits-all storage.
**Dimension:** Extreme versatility, store multiplexing
