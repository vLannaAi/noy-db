# Issue #172 — Showcase 07: Query Analytics (Pinia)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-11
- **Closed:** 2026-04-20
- **Milestone:** Showcases
- **Labels:** showcases

---

## 07-query-analytics.showcase.ts — "Monthly Report"

**Framework:** Pinia (`defineNoydbStore` + `query()`) | **Store:** `memory()` | **Branch:** `showcase/07-query-analytics`

### Flow
- Seed 200 invoices (12 months, 5 statuses, 10 clients)
- `groupBy('month').aggregate({ total: sum('amount'), n: count() })`
- `groupBy('clientId').aggregate({ avg: avg('amount') })`
- `where('amount', '>', 10000).orderBy('amount', 'desc').limit(5)`
- `where('status', '==', 'overdue').count()`

**Goal:** Prove in-memory query engine handles real analytics via Pinia.
**Dimension:** Efficiency, aggregation, groupBy, top-N
