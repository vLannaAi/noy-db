# Issue #179 — feat(to-sqlite): @noy-db/to-sqlite — single-file SQLite KV for 10K+ records

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** Fork · Stores (@noy-db/to-*)
- **Labels:** type: feature, area: adapters

---

better-sqlite3 under Node, sql.js / wa-sqlite in browser. Single-file portable database — better than JSON once the record count passes ~10K (faster loadAll via indexed primary key). CAS-atomic via UPDATE WHERE _v = ?.
