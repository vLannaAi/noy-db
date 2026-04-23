# Issue #184 — feat(to-postgres): @noy-db/to-postgres — Postgres KV with jsonb column (KV-pattern, separate from #107 SQL migration)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** Fork · Stores (@noy-db/to-*)
- **Labels:** type: feature, area: adapters

---

Separate from #107 (decrypt-sql export) and #108 (full schema migration). This is the KV-pattern — single table with (pk, sk, envelope jsonb), same shape as DynamoDB adapter. pg or postgres.js as driver. Useful for teams already running Postgres who want noy-db without a schema migration.
