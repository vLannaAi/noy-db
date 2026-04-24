# Pull Request #4 — docs: restructure roadmap, add architecture + deployment profiles, plan v0.3

- **State:** MERGED
- **Author:** @vLannaAi
- **Created:** 2026-04-06
- **Merged:** 2026-04-06

- **Branch:** `docs/v0.3-restructure` → `main`
- **Merge commit:** [`433f23ff76`](../../../../../commit/433f23ff7616262b9dd722a0d7a33f4a494e55b2)
- **Labels:** _(none)_

---

## Summary

Restructures the documentation around three concerns and plans v0.3 in detail:

1. **Roadmap moved to repo root** (`docs/ROADMAP.md` → `ROADMAP.md`) following GitHub community-health convention. Slimmed from 1521 → 383 lines: release table, Mermaid Gantt, per-version sections, 22 testable acceptance criteria for v0.3.

2. **Two new docs split out** with Mermaid diagrams (no ASCII art):
   - `docs/reference/architecture.md` — data flow, key hierarchy, multi-user model, key rotation, envelope format, adapter interface, threat model
   - `docs/guides/deployment-profiles.md` — 8 deployment topologies with install commands

3. **Filename casing normalized** under `docs/`:
   - `docs/NOYDB_FOR_AI.md` → `docs/guides/noydb-for-ai.md` (kebab-case convention)
   - Internal links updated across `README.md`, `packages/core/README.md`, both new docs

## v0.3 plan (Pinia-first DX + query & scale)

The roadmap section for v0.3 is now structured as 9 deliverables split into an *adoption surface* (1–5) and a *power surface* (6–9):

**Adoption surface** (the headline for v0.3):
1. `create-noy-db` guided scaffolder (`npm create noy-db`)
2. `@noy-db/nuxt` Nuxt 4-only module with auto-imports, SSR safety, devtools tab
3. `nuxi noydb <command>` extension
4. `@noy-db/pinia` — `defineNoydbStore` (greenfield path)
5. `@noy-db/pinia` — augmentation plugin for existing stores

**Power surface** (opt-in, surfaced through the Pinia store):
6. Reactive query DSL
7. Encrypted secondary indexes
8. Paginated `list()` / streaming `scan()`
9. Lazy hydration + LRU eviction

A separate PR (`chore/v0.3-workflow`) will add the governance files (PR template, issue templates, expanded CODEOWNERS, label definitions) and the v0.3 epic + sub-issues will then be opened against `v0.3-dev`.

## Test plan

- [x] Privacy guard clean (`pnpm run guard:privacy`)
- [x] All Mermaid diagrams render (verified by syntax — GitHub will catch any errors)
- [x] All internal markdown links resolve (manual check; no stale `docs/ROADMAP.md` references remain)
- [ ] CI lint/typecheck/test/build pass on this branch

## Notes for reviewers

- No code changes — docs only.
- The detailed phase walkthrough that used to live in `ROADMAP.md` (Phase 0 scaffolding, Phase 1 source files, etc.) has been removed; that content is now historical and lives in `git log`. A 7-bullet "Implementation history" summary is preserved at the bottom of `docs/reference/architecture.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
