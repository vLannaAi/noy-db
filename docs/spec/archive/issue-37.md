# Issue #37 — magicast: wizard patches existing nuxt.config.ts

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **Closed:** 2026-04-07
- **Milestone:** v0.5.0
- **Labels:** type: feature, priority: medium, area: scaffolder, release: v0.5

---

Deferred from #7. Extend @noy-db/create so running the wizard inside an existing Nuxt 4 project detects nuxt.config.ts and edits it via magicast to add '@noy-db/nuxt' to the modules array and a noydb: key. Shows diff + requires confirmation before writing. Idempotent, supports --dry-run. Estimate: M.
