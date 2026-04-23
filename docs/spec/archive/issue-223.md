# Issue #223 — docs(entry-point): consolidate SPEC.md + architecture.md + topology-matrix.md into a single reader-facing entry doc

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.15.0 — Pre-distribution & documentation (P3)
- **Labels:** type: feature

---

The current docs (SPEC.md, architecture.md, topology-matrix.md, CLAUDE.md, ROADMAP.md, oidc-providers.md, v0.12-blob-design.md, adapters.md, getting-started.md, end-user-features.md, noydb-for-ai.md) are comprehensive but fragmented. An external adopter currently has to cross-reference 10 files to understand the shape. Produce a single docs/START_HERE.md that is the authoritative entry: what is noy-db (1 page), how does it work (1 page), which topology fits my app (1 page → topology-matrix.md), here is a runnable quickstart, links to the deep docs. Keep the deep docs intact — just add the index layer on top.
