# Issue #171 — Showcase 06: Cascade Delete FK (Nuxt+Pinia)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-11
- **Closed:** 2026-04-20
- **Milestone:** Showcases
- **Labels:** showcases

---

## 06-cascade-delete-fk.showcase.ts — "Delete Client, Orphan Check"

**Framework:** Nuxt + Pinia | **Store:** `memory()` | **Branch:** `showcase/06-cascade-delete-fk`

### Flow
- `defineNoydbStore<Client>('clients')` + `defineNoydbStore<Invoice>('invoices')`
- Add clients → add invoices with `clientId` FK
- `checkIntegrity()` clean → `clients.remove('c-1')` → violation!
- `join('clientId', { ref: 'warn' })` → null on orphans
- Fix orphans → `checkIntegrity()` clean

**Goal:** FK integrity with reactive Pinia stores in Nuxt context.
**Dimension:** Data integrity, FK relationships, Nuxt+Pinia
