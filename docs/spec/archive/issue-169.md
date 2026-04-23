# Issue #169 — Showcase 04: Sync Two Offices (Vue)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-11
- **Closed:** 2026-04-20
- **Milestone:** Showcases
- **Labels:** showcases

---

## 04-sync-two-offices.showcase.ts — "Bangkok and Chiang Mai"

**Framework:** Vue (`useSync`, `useCollection`) | **Store:** `memory()` × 3 | **Branch:** `showcase/04-sync-two-offices`

### Flow
- `effectScope()` → `useCollection(dbA, vault, 'invoices')` + `useSync(dbA, vault)`
- A writes offline → B writes offline → both push → both pull
- Assert `collection.data.value` has all records, `sync.status.value.dirty === 0`
- Same-record conflict with version/local-wins strategies

**Goal:** Prove offline-first sync with reactive Vue state.
**Dimension:** Offline-first, sync, conflict resolution
