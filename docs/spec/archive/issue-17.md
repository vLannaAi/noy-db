# Issue #17 — Docs updates for v0.3 features

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-06
- **Closed:** 2026-04-06
- **Milestone:** v0.3.0
- **Labels:** type: docs, release: v0.3, area: docs

---

# Docs updates for v0.3

Part of #6 (v0.3 release).

## Scope

Update the existing documentation set to reflect every v0.3 feature. Touches `docs/reference/architecture.md`, `docs/guides/getting-started.md`, `docs/guides/end-user-features.md`, `docs/packages/stores.md`, `docs/guides/deployment-profiles.md`, plus the root `README.md` and `ROADMAP.md`. No new doc site infrastructure — that's v1.0. Each doc must show the v0.3 idiomatic example (Pinia store), with the low-level `Compartment`/`Collection` API kept as a "Going lower" appendix.

## Why

The v0.3 adoption story collapses if the docs still lead with `createNoydb()` boilerplate. New users must land on the Pinia / Nuxt happy path immediately.

## Technical design

- `docs/guides/getting-started.md`: rewrite the intro to lead with `npm create noy-db@latest`. Add a second section "Existing Nuxt 4 project" using `@noy-db/nuxt`. Move the manual `createNoydb()` walkthrough to an appendix.
- `docs/reference/architecture.md`: note that the memory-first invariant is now opt-in via `prefetch: true`. Add a "Caching and lazy hydration" subsection cross-linking to #9. Document how the Pinia store sits on top of `Collection` without weakening the encryption boundary.
- `docs/guides/end-user-features.md`: add sections for query DSL (#6), encrypted indexes (#7), pagination + scan (#8), lazy hydration (#9), Pinia integration (#4/#5), Nuxt module (#2). Each section gets a runnable code snippet.
- `docs/packages/stores.md`: document the optional `listPage` capability and the capability flag pattern.
- `docs/guides/deployment-profiles.md`: add a "Nuxt 4 + browser adapter + Dynamo sync" profile and a "Nuxt 4 + file adapter (USB workflow)" profile.
- Root `README.md`: replace the "Quick start" with the two-minute Pinia story.
- `ROADMAP.md`: mark v0.3 as shipped (in the release PR — #12).

## Acceptance criteria

- [ ] **Content:** every file above updated with the v0.3 examples.
- [ ] **Link check:** all internal links resolve (CI markdown link check).
- [ ] **Code-snippet check:** every code block in `docs/guides/getting-started.md` and `docs/guides/end-user-features.md` is extracted and type-checked in CI (extend the existing snippet test or add one if missing).
- [ ] **Privacy guard:** all examples use generic names; privacy guard CI passes.
- [ ] **Cross-links:** every new feature section links to the issue number that introduced it (or the PR).
- [ ] **No new files:** unless absolutely required — prefer editing existing docs (per CLAUDE.md).
- [ ] **Changeset:** docs-only changeset for whichever package the change conceptually belongs to (or omit if all docs are root-level).
- [ ] **CI:** existing docs-lint job passes; add the snippet type-check job if it does not exist.

## Dependencies

- Blocked by: #1, #2, #3, #4, #5, #6, #7, #8, #9, #10 (docs land last so examples reflect shipped behavior)
- Blocks: #12 (release)

## Estimate

M

## Labels

`release: v0.3`, `area: docs`, `type: docs`
