# Session handover

> **Purpose:** context for the next Claude Code session. Read this first —
> it will save you 10 minutes of re-discovery.
>
> **Updated:** 2026-04-10 — v0.11.0 code complete (hub/to-*/in-* rename shipped); npm cleanup in progress before publishing; v0.12 developer experience is next.

---

## What this project is

NOYDB is a zero-knowledge, offline-first, encrypted document store with
pluggable backends and multi-user access control. TypeScript monorepo,
Node 18+ and modern browsers. See `SPEC.md` for the full design reference;
`CLAUDE.md` for coding conventions.

**Privacy rule (CLAUDE.md):** never name the first consumer (an accounting
firm). Use "accounting firm", "first consumer", or "the platform". Grep for
the actual name before any commit or publish that touches user-facing copy.

---

## Current state: v0.11.0 code complete — npm cleanup in progress

```
main  bb53cca  docs: update HANDOVER — npm cleanup status, v0.11 rename plan
```

Working tree clean. **npm publishing is PAUSED** — the release workflow
(`.github/workflows/release.yml`) requires manual `workflow_dispatch`.
Do not re-enable until npm cleanup is complete (see below).

v0.11 code work is **done**: all 15 packages renamed to the hub/to-*/in-* taxonomy,
all 1065 tests passing, issue #150 closed, milestones v0.10.0 + v0.11.0 closed.

**Open milestones:** v0.12.0 (developer experience), v0.13.0 (store expansion).

---

## npm cleanup status — DO THIS BEFORE ANY PUBLISHING

### The plan (execute in order)

**Step 1 — Try again tomorrow (2026-04-11):**
Some versions that are currently blocked by the 72h window will have expired.
Retry unpublishing any remaining versions from the old package names.

**Step 2 — Send npm support email:**
Go to **https://www.npmjs.com/support** (available on free plan).
Request hard deletion of all pre-v0.10.0 versions across the old package names.
Key points to include:
- Pre-release cleanup before first public launch
- Zero downloads across all affected versions
- All versions already deprecated with migration messages
- Packages to clean: `@noy-db/hub`, `@noy-db/file`, `@noy-db/memory`,
  `@noy-db/vue`, `@noy-db/pinia`, `@noy-db/nuxt`, `@noy-db/s3`,
  `@noy-db/browser`, `@noy-db/dynamo`, `@noy-db/create`
- Versions: everything `<0.10.0` plus the stuck last-versions

**Step 3 — Once registry is clean, publish v0.11.0:**
Re-enable the release workflow and publish all 15 packages under the new names.
Version to publish: **0.11.0**. All code is ready on `main`.

### Current npm state (as of 2026-04-10)

**New packages at 0.10.0 — FORCE-UNPUBLISHED (will need re-publishing):**
- `@noy-db/to-file@0.10.0` — deleted
- `@noy-db/to-memory@0.10.0` — deleted
- `@noy-db/to-browser-local@0.10.0` — deleted
- `@noy-db/to-browser-idb@0.10.0` — deleted
- `@noy-db/to-aws-s3@0.10.0` — deleted
- `@noy-db/to-aws-dynamo@0.10.0` — deleted
- `create-noy-db@0.10.0` — deleted

**Still live at 0.10.0 (good — keep these):**
- `@noy-db/hub@0.10.0` ✓
- `@noy-db/vue@0.10.0` ✓
- `@noy-db/pinia@0.10.0` ✓
- `@noy-db/nuxt@0.10.0` ✓

**Old package names — stuck, deprecated, need npm support to fully remove:**

| Package | Remaining versions | Status |
|---|---|---|
| `@noy-db/hub` | 0.1.0–0.9.0 | All deprecated ✓ |
| `@noy-db/file` | 0.1.0–0.3.0 (>72h), 0.5.0–0.9.0 | All deprecated ✓; E405 on unpublish |
| `@noy-db/memory` | 0.1.0 (>72h), 0.1.1–0.9.0 | All deprecated ✓ |
| `@noy-db/vue` | 0.1.0 (>72h), 0.1.1–0.9.0 | All deprecated ✓ |
| `@noy-db/pinia` | 0.3.0 (>72h), 0.4.0–0.9.0 | All deprecated ✓; E405 on unpublish |
| `@noy-db/nuxt` | 0.3.0 (>72h), 0.4.1–0.9.0 | Needs deprecation; E405 on unpublish |
| `@noy-db/s3` | 0.9.0 | Deprecated ✓; E422 on force-delete |
| `@noy-db/browser` | 0.9.0 | Deprecated ✓; E422 on force-delete |
| `@noy-db/dynamo` | 0.9.0 | Deprecated ✓; E422 on force-delete |
| `@noy-db/create` | all gone | ✓ fully unpublished |

**npm error codes reference:**
- **E405** — "has dependent packages in the registry" — another package peer-deps on this one
- **E422** — full package DELETE blocked (package first published >72h ago; npm policy)
- **EUSAGE** — refusing to delete last version without `--force`
- `@noy-db/nuxt@0.10.0` peer-deps on `@noy-db/vue`, `@noy-db/pinia`, `@noy-db/hub` — this is why pinia/vue old versions get E405

---

## v0.12.0 — Developer experience (next milestone)

GitHub milestone: https://github.com/vLannaAi/noy-db/milestone/9

Issues in scope:
- **#146** `@noy-db/store-probe` — setup-time suitability test + runtime monitor
- **#106** naked mode — dev-only plaintext storage with guardrails
- **#102** `.noydb` reader — CLI commands + browser extension
- **#39** scaffolder templates — Vite+Vue, Electron, vanilla

See ROADMAP.md for full design notes on each item.

---

## Release-time invariants (hard-won — do not skip)

1. **Always use `pnpm release:version`** — never `pnpm changeset version` directly.
2. **Peer deps must be `workspace:*`** not `workspace:^` — prevents changeset pre-1.0 major-bump bug.
3. **New packages need lockfile updates before CI** — `pnpm install` locally, commit lockfile.
4. **Auth branches must rebase onto core branch, not main** when new core barrel exports added.
5. **happy-dom WebCrypto is occasionally flaky** — just re-run the CI job if `auth-oidc` fails.
6. **PR merge order matters** — core PR first, then auth PRs rebased onto updated main.

---

## Build commands

```bash
pnpm install                      # install all workspace deps
pnpm turbo build                  # build all packages
pnpm turbo test                   # run all tests
pnpm turbo lint                   # lint all packages
pnpm turbo typecheck              # typecheck all packages
pnpm vitest run packages/hub      # run core tests only
pnpm vitest run -t "session"      # run tests matching pattern

# Release (PAUSED — do not run until npm cleanup is complete and v0.11.0 is published)
pnpm release:version              # bump all packages to core's version
git add . && git commit -m "chore: release vX.Y.Z"
git push origin main && git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
pnpm turbo build && pnpm changeset publish
```

---

## ESLint rules that bite

| Rule | What it requires |
|------|-----------------|
| `@typescript-eslint/no-unused-vars` | Prefix unused vars with `_` |
| `@typescript-eslint/no-explicit-any` | Use `unknown` instead of `any` |
| `@typescript-eslint/no-non-null-assertion` | Avoid `!` — narrow the type |
| `@typescript-eslint/no-unnecessary-type-assertion` | Don't cast when already narrowed |
| `import/no-cycle` | No circular imports |
| `no-restricted-syntax` (inline import) | No `import()` type refs inline — import at top |
