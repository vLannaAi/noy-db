# Issue #18 — v0.3 changeset, release prep, npm publish, tag v0.3.0

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-06
- **Closed:** 2026-04-07
- **Milestone:** v0.3.0
- **Labels:** type: chore, release: v0.3, area: ci

---

# Changeset, release prep, and `v0.3.0` publish

Part of #6 (v0.3 release).

## Scope

Coordinate all v0.3 changesets, bump every package to `0.3.0`, run the release pipeline (privacy guard → lint → typecheck → test on Node 18/20/22 → build → pack verify → npm publish), tag `v0.3.0`, mark the milestone as released, and update `ROADMAP.md` to move v0.3 from "next" to "shipped". Includes adding three new packages to the publish list: `@noy-db/nuxt`, `@noy-db/pinia`, `create-noy-db`.

## Why

The release issue closes the loop. Without it, none of the v0.3 work reaches users.

## Technical design

- Aggregate all per-feature changesets created in #1–#10 into a single release.
- Update `package.json#version` for every package to `0.3.0` via `pnpm changeset version`.
- Add `@noy-db/nuxt`, `@noy-db/pinia`, and `create-noy-db` to:
  - the changesets `fixed` group (so they version-bump together with core),
  - the publish workflow's package list,
  - the privacy-guard allowlist if any new file paths need exemptions (avoid if possible),
  - the README badges block.
- New packages must enter CI with **real** test coverage — not `--passWithNoTests`. Coverage threshold of 90% statements is enforced for `create-noy-db`, `@noy-db/nuxt`, `@noy-db/pinia`. Existing `dynamo`, `s3`, `vue` (currently zero tests) are NOT in scope to fix here, but the workflow must reject the addition of any new package that uses `--passWithNoTests`.
- Run `pnpm pack` for every package and verify the tarballs contain only the expected files.
- Tag `v0.3.0`, push, watch the publish workflow, verify on npm.
- Update `ROADMAP.md` to mark v0.3 ✅ shipped and bump the table.
- Draft GitHub release notes summarizing the 9 deliverables and linking to the epic.

## Acceptance criteria

- [ ] **Implementation:** all changesets aggregated; every package at `0.3.0`; lockfile updated; `pnpm install` clean.
- [ ] **CI green:** privacy guard, lint, typecheck, test on Node 18/20/22, build, pack-verify, e2e-scaffolder, nuxt-module-test, playground-nuxt-e2e all pass on `v0.3-dev` and on the merge to `main`.
- [ ] **Coverage gate:** new packages enforce 90% statement coverage in CI; PR fails otherwise.
- [ ] **`--passWithNoTests` ban:** workflow grep asserts no test script for a *new* package contains `--passWithNoTests`.
- [ ] **Pack verification:** every tarball contains `dist/`, `README.md`, `package.json`, `LICENSE`, and no source maps with absolute paths or developer machine identifiers.
- [ ] **Privacy guard:** final pre-publish run passes — no client names anywhere in the published tarballs.
- [ ] **Bundle budgets:** core <30 KB gzipped, each adapter <10 KB, Nuxt module <15 KB, Pinia plugin/defineStore <8 KB. Enforced in CI.
- [ ] **Publish:** `@noy-db/core`, `@noy-db/memory`, `@noy-db/file`, `@noy-db/dynamo`, `@noy-db/s3`, `@noy-db/browser`, `@noy-db/vue`, `@noy-db/nuxt`, `@noy-db/pinia`, `create-noy-db` all live on npm at `0.3.0`.
- [ ] **Tag + release:** `v0.3.0` git tag pushed; GitHub release published with the deliverable summary and Definition of Done checklist from the epic.
- [ ] **Roadmap:** `ROADMAP.md` updated; v0.3 row marked ✅ shipped; v0.4 row marked 🚧 next.
- [ ] **Docs:** README badges and version references updated.

## Dependencies

- Blocked by: #1, #2, #3, #4, #5, #6, #7, #8, #9, #10, #11
- Blocks: nothing

## Estimate

S

## Labels

`release: v0.3`, `area: core`, `type: chore`
