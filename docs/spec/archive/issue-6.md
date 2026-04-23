# Issue #6 — v0.3 — Pinia-first DX + query & scale (tracking epic)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-06
- **Closed:** 2026-04-07
- **Milestone:** v0.3.0
- **Labels:** type: feature, release: v0.3, epic

---

# v0.3 — Pinia-first DX + query & scale (tracking epic)

**Milestone:** [`v0.3.0`](https://github.com/vLannaAi/noy-db/milestone/1)
**Branch:** `v0.3-dev` (long-lived integration branch — all v0.3 PRs target this branch, not `main`)

## Goal

> Zero to working encrypted Pinia store in under two minutes. A Vue/Nuxt/Pinia developer either runs `npm create noy-db` (greenfield) or installs `@noy-db/nuxt` (existing project), and gets a fully wired reactive encrypted store without writing boilerplate. Opt into advanced features (query DSL, indexes, sync) incrementally.

See [`ROADMAP.md#v03--pinia-first-dx--query--scale`](https://github.com/vLannaAi/noy-db/blob/main/ROADMAP.md#v03--pinia-first-dx--query--scale) for full design and rationale.

## Sub-issues

**Adoption surface** (items 1–5 — the headline):

- [ ] #7  — `create-noy-db` guided scaffolder
- [x] #8  — `@noy-db/nuxt` Nuxt 4 module (auto-imports, SSR safety, devtools tab)
- [ ] #9  — `nuxi noydb <cmd>` extension (add / rotate / verify / seed / backup)
- [x] #10 — `@noy-db/pinia` `defineNoydbStore` greenfield path
- [x] #11 — `@noy-db/pinia` augmentation plugin (`noydb:` option for existing stores)

**Power surface** (items 6–9 — opt-in, surfaced through the Pinia store):

- [x] #12 — Reactive query DSL in `@noy-db/core`
- [x] #13 — Encrypted secondary indexes in `@noy-db/core`
- [x] #14 — Paginated `listPage()` + streaming `scan()` in `@noy-db/core` + adapters
- [x] #15 — Lazy collection hydration + LRU eviction in `@noy-db/core`

**Wrap-up:**

- [x] #16 — Reference Nuxt 4 accounting demo in `playground/nuxt/`
- [ ] #17 — Docs updates (architecture, getting-started, end-user-features, deployment-profiles)
- [ ] #18 — Changeset, release prep, npm publish, tag `v0.3.0`

## Dependency graph

```
#12 (query DSL)        ──┐
                         ├──▶ #10 (defineNoydbStore)  ──┬──▶ #7  (scaffolder templates)
#13 (encrypted indexes)──┘                              ├──▶ #8  (Nuxt module)
                                                        ├──▶ #11 (Pinia plugin)
#14 (pagination)         ──▶ #15 (lazy hydration)       └──▶ #16 (reference demo)

#8  (Nuxt module)        ──▶ #9  (nuxi extension)
#7  (scaffolder)         ──▶ #16 (reference demo)

(everything)             ──▶ #17 (docs) ──▶ #18 (release)
```

## How to contribute

1. **Claim an issue** by commenting on it. A maintainer will assign it.
2. **Branch from `v0.3-dev`**: `git checkout v0.3-dev && git pull && git checkout -b feat/<short-name>`
3. **Open a PR back to `v0.3-dev`** (NOT `main`). Fill in the PR template, link the issue with `Closes #N` and `Part of #6`, add a changeset (`pnpm changeset`).
4. **Squash merge** once CI is green and at least one reviewer approves.
5. The release PR (`v0.3-dev` → `main`) is opened from #18 with a merge commit (preserves per-PR history).

See [`CONTRIBUTING.md`](https://github.com/vLannaAi/noy-db/blob/main/CONTRIBUTING.md#workflow) for the full workflow.

## Definition of done (22 testable criteria)

### Scaffolder

- [ ] `npm create noy-db@latest` works on Node 20+ across macOS, Linux, Windows
- [ ] All four package managers (npm, pnpm, yarn, bun) detected and used for install
- [ ] Generated Nuxt 4 starter passes `dev` + `build` + `typecheck` cleanly
- [ ] End-to-end install + verify under 60 seconds on a warm npm cache
- [ ] Privacy guard pre-commit hook installed only on opt-in
- [ ] Passphrases never written to disk; AWS credentials never requested
- [ ] Wizard re-runnable inside an existing project to add collections
- [ ] Prompts available in English and Thai
- [ ] CI matrix exercises a representative subset of (framework × adapter × sync × auth) combinations

### Nuxt module

- [ ] One-line install: `pnpm add @noy-db/nuxt` + `modules: ['@noy-db/nuxt']` produces a working encrypted store with no other code
- [ ] All composables auto-imported without manual `import` statements
- [ ] Server bundle contains zero references to `crypto.subtle`, `decrypt`, or DEK/KEK symbols (CI-verified)
- [ ] Devtools tab shows live compartment state in dev and is absent in production
- [ ] `nuxi noydb <command>` namespace registered when the module is installed
- [ ] Type-checks against `nuxt.config.ts` with autocomplete on every option
- [ ] Reference Nuxt 4 accounting demo in `playground/nuxt/` works with one config block

### Pinia integration

- [ ] `defineNoydbStore` works as a drop-in for `defineStore` in a clean Vue 3 + Pinia project
- [ ] Existing Pinia stores opt in via the `noydb:` option without component changes
- [ ] Devtools, `storeToRefs`, SSR, and `pinia-plugin-persistedstate` all keep working

### Power features

- [ ] Query DSL passes a parity test against `Array.filter` for 50 random predicates
- [ ] Indexed queries are measurably faster than linear scans on a 10K-record benchmark
- [ ] Streaming `scan()` handles a 100K-record collection in under 200MB peak memory
- [ ] Reference Vue/Nuxt accounting demo in `playground/` uses **only** the Pinia API — no direct `Compartment`/`Collection` calls

## Cross-cutting requirements

- **Bundle budgets** enforced in CI: `@noy-db/core` <30 KB gzipped, each adapter <10 KB.
- **Test coverage** ≥90% statement coverage on every new package (CI-enforced).
- **Integration tests** required: every new package ships with at least one end-to-end test against `@noy-db/memory`.
- **No new test gaps**: packages currently with zero tests (`dynamo`, `s3`, `vue` — using `--passWithNoTests`) are NOT a precedent. New v0.3 packages start with real coverage from day one.
- All work respects the *Guiding principles* in `ROADMAP.md` and the invariants in `NOYDB_SPEC.md`.

## Baseline (verified before v0.3 work began)

- 233 tests passing across 12 test files (memory: 25, browser: 59, file: 25, core: 124)
- All 36 turbo tasks green (lint, typecheck, test, build for every package)
- Privacy guard clean








## Progress log

- **2026-04-06** — 8 of 12 sub-issues complete:
  - PR #4 (docs reorg) merged
  - PR #5 (governance) merged
  - PR #21 (CI trigger fix) merged
  - PR #19 (#12 query DSL) — 65 tests
  - PR #22 (#10 defineNoydbStore + Vue/Pinia playground) — 18 tests
  - PR #23 (#11 createNoydbPiniaPlugin) — 15 tests
  - PR #24 (#13 secondary indexes) — 22 tests
  - PR #25 (#14 listPage + scan) — 45 tests
  - PR #26 (#15 lazy hydration + LRU) — 43 tests
  - PR #27 (#8 @noy-db/nuxt module) — 14 tests, NEW package
  - PR #28 (#16 Nuxt 4 demo) — build is the integration test; caught and fixed a real runtime-plugin bug in #27
  - Branch protection enabled on main and v0.3-dev
- Closed sub-issues: **#8, #10, #11, #12, #13, #14, #15, #16** (8 of 12 — 67% done)
- Test totals: 233 (v0.2 baseline) → 455 passing (+222 from v0.3 work)
- v0.3-dev branch is 11 commits ahead of v0.2.0
- **The Nuxt 4 demo builds and runs against the full v0.3 stack — the integration test is green.** Remaining work: scaffolder (#7), nuxi extension (#9), docs sweep (#17), release prep (#18).
