# Issue #207 — feat(core): invisibility mode — records above user tier return NOT_FOUND

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** v0.18.0 — Hierarchical access levels
- **Labels:** type: feature, type: security, area: core

---

Mode A of cross-tier access: lower-tier users get a NOT_FOUND response when querying records above their tier — they can not even tell those records exist. Zero-information-leak stance. Mode chosen per-collection at creation.
