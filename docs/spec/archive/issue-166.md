# Issue #166 — Showcase 01: Accounting Day (Pinia)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-11
- **Closed:** 2026-04-20
- **Milestone:** Showcases
- **Labels:** showcases

---

## 01-accounting-day.showcase.ts — "A Day at the Office"

**Framework:** Pinia (`defineNoydbStore`) | **Store:** `memory()` | **Branch:** `showcase/01-accounting-day`

### Flow
- `setActivePinia` + `setActiveNoydb` → `defineNoydbStore<Invoice>('invoices', { vault })`
- `store.add()` → assert `store.items` length and `store.count` reactivity
- `query().where('status','==','draft').aggregate({ total: sum('amount') })`
- `store.update()` → verify totals change

**Goal:** Prove noy-db + Pinia is approachable — reactive store in ~30 lines.
**Dimension:** Easy-to-use, real-world workflow
