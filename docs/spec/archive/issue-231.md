# Issue #231 — refactor(hub/i18n): group dictionary + i18n code into packages/hub/src/i18n/

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.15.1 — Hub refactor (backward-compat)
- **Labels:** type: feature, area: core

---

Move `dictionary.ts` and `i18n.ts` into `packages/hub/src/i18n/` subdirectory. Barrel re-exports preserved on the main entry. Subpath entry `@noy-db/hub/i18n` added.

Rationale: English-only apps no longer bundle the dictKey/i18nText/resolveI18nText code (estimated ~2 KB savings for solo English apps that opt into subpath imports). Keeps the i18n scope visually isolated in the file tree.
