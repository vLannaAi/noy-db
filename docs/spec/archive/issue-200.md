# Issue #200 — feat(tools): configuration validator / generator — sanity-check NoydbOptions + emit .env templates

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.13.0 — Developer tools (P1)
- **Labels:** type: feature

---

CLI: `noydb config validate <file.ts>` checks that a NoydbOptions object is coherent (e.g. casAtomic consumers use a casAtomic adapter; sync targets pair with syncPolicy; blob adapters support chunking). Also `noydb config scaffold --profile=C` emits a working .env + config.ts for the topology pattern from docs/topology-matrix.md.
