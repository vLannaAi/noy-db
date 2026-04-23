# Issue #155 — feat(scaffolder): template — vite-vue (Vite + Vue 3 + Pinia + to-browser-idb)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-10
- **Closed:** 2026-04-21
- **Milestone:** v0.17.1 Good to have scaffolding
- **Labels:** type: feature, area: scaffolder

---

Split from #39.

Adds a `vite-vue` template to `create-noy-db` / the `--template` flag and wizard prompt.

## Stack

- Vite + Vue 3 + Pinia
- `@noy-db/hub` + `@noy-db/in-vue` + `@noy-db/in-pinia` + `@noy-db/to-browser-idb`
- No Nuxt, no SSR — pure client-side SPA

## Deliverables

- [ ] `packages/create-noy-db/templates/vite-vue/` directory with working scaffold
- [ ] `--template vite-vue` flag wired in the CLI
- [ ] Wizard prompt option alongside `nuxt-default`
- [ ] Template-specific README
- [ ] E2E CI coverage (new template added to the e2e matrix)
- [ ] Changeset for `create-noy-db`

## Related

- #39 — original combined issue (closed, split into 3)
- #155 — electron template
- #156 — vanilla template
