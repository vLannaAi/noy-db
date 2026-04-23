# Issue #205 — feat(core): nested security levels — per-record classification tier

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** v0.18.0 — Hierarchical access levels
- **Labels:** type: feature, type: security, area: core

---

Each record carries a numeric tier (default 0). Users have a "clearance" set on their keyring. The keyring stores one DEK per tier per collection (so tier-promotion is a rewrap, not a data migration). Breaking change to keyring format — ships as an opt-in feature flag before becoming default in v1.0.
