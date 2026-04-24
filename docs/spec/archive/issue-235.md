# Issue #235 — docs(hub-subpaths): update START_HERE.md + topology-matrix.md + CLAUDE.md for the hub subpath layout

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.15.1 — Hub refactor (backward-compat)
- **Labels:** type: feature, area: core

---

Once the subpath reorganization lands, update adopter-facing docs:

- `docs/guides/START_HERE.md` — add a "Hub subpaths" subsection under "The mental model" showing which subpath to import from for which concern. Keep the main-entry example as the default (backward compat).
- `docs/guides/topology-matrix.md` — add a "Tree-shaking recipe" note to each pattern showing subpath imports for the opted-in case.
- `CLAUDE.md` — update "Monorepo Structure" with the `packages/hub/src/{store,i18n,team,session,ledger,query}/` layout.

Depends on the 6 file-move + subpath-exports issues above being merged.
