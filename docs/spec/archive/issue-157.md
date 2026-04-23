# Issue #157 — feat(scaffolder): template — vanilla (Vite + hub + to-browser-idb, no framework)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-10
- **Closed:** 2026-04-21
- **Milestone:** v0.13.0 — Developer tools (P1)
- **Labels:** type: feature, area: scaffolder

---

Split from #39.

Adds a `vanilla` template to `create-noy-db` — zero UI framework, TypeScript only.

## Stack

- Vite (bundler only)
- `@noy-db/hub` + `@noy-db/to-browser-idb`
- No Vue, no React, no Pinia — raw TypeScript + DOM

## Use case

Consumers who want to integrate noy-db into an existing app with their own framework, or who are evaluating the library before committing to a stack.

## Deliverables

- [ ] `packages/create-noy-db/templates/vanilla/` with working scaffold
- [ ] `--template vanilla` flag and wizard prompt option
- [ ] Template-specific README
- [ ] E2E CI coverage
- [ ] Changeset for `create-noy-db`

## Related

- #39 — original combined issue (closed, split into 3)
- #155 — vite-vue template
- #156 — electron template
