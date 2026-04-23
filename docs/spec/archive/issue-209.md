# Issue #209 — feat(core): temporary access delegation — time-boxed cross-tier grant

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** v0.18.0 — Hierarchical access levels
- **Labels:** type: feature, area: core

---

Higher-tier user: `db.delegate({ toUser, tier, record?, collection?, until })`. Signs a delegation token wrapping the target DEK for the lower user, stamped with an expiry. Lower user can unlock up to that tier until the token expires. Revocable.
