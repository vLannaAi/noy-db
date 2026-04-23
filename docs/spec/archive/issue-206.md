# Issue #206 — feat(core): data elevation — promote record to higher tier

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** v0.18.0 — Hierarchical access levels
- **Labels:** type: feature, area: core

---

record.elevate(newTier) rewraps the record with a higher-tier DEK. Requires the operator to have at least that tier in their keyring. Reverse operation (demote) only allowed by the original elevator or an owner. Audit ledger records every tier change.
