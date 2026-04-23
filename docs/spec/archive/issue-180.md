# Issue #180 — feat(to-turso): @noy-db/to-turso — edge SQLite with replication

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** Fork · Stores (@noy-db/to-*)
- **Labels:** type: feature, area: adapters

---

Turso ships libSQL with edge-replicated read replicas + single-writer primary. Implement a noy-db store that uses the @libsql/client package. Useful for globally distributed read-heavy noy-db deployments.
