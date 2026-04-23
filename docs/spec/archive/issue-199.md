# Issue #199 — feat(tools): runtime monitor — live dashboard for vault metrics, sync status, health

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.13.0 — Developer tools (P1)
- **Labels:** type: feature

---

Standalone tool (web + CLI): shows real-time vault stats — open collections, record counts, dirty queue depth, last sync timestamp, middleware circuit states, blob chunk counts, memory footprint. Useful for dev + ops. Consumes the existing withMetrics middleware stream.
