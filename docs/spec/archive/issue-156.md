# Issue #156 — feat(scaffolder): template — electron (Electron + Vue 3 + to-file, USB workflow)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-10
- **Closed:** 2026-04-22
- **Milestone:** v0.17.1 Good to have scaffolding
- **Labels:** type: feature, area: scaffolder

---

Split from #39.

Adds an `electron` template to `create-noy-db`.

## Stack

- Electron (main process) + Vue 3 (renderer)
- `@noy-db/hub` + `@noy-db/to-file` on the main process
- `@noy-db/in-vue` + `@noy-db/in-pinia` in the renderer
- USB stick / local disk workflow — vault stored as a `.noydb` bundle or JSON directory

## Deliverables

- [ ] `packages/create-noy-db/templates/electron/` with working scaffold
- [ ] IPC bridge between main-process store and renderer composables
- [ ] `--template electron` flag and wizard prompt option
- [ ] Template-specific README covering the USB workflow
- [ ] E2E CI coverage
- [ ] Changeset for `create-noy-db`

## Related

- #39 — original combined issue (closed, split into 3)
- #155 — vite-vue template
- #156 — vanilla template
