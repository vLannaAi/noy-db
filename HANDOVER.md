# Session handover

> **Purpose:** pass context from one Claude Code session to the next
> without needing to re-discover the project state from scratch. Read
> this first if you're picking up work on noy-db with no prior
> session memory.
>
> **Updated:** 2026-04-09, after shipping v0.7.0.

## What this project is

NOYDB ("None Of Your Damn Business") is a zero-knowledge, offline-
first, encrypted document store with pluggable backends and
multi-user access control. TypeScript monorepo targeting Node 18+
and modern browsers. See `SPEC.md` for the full design reference and
`docs/architecture.md` for the reader-facing architecture doc.

**First consumer:** an established regional accounting-firm platform.
Per the auto-memory client-privacy constraint, **never name the
client** — use generic terms like "accounting firm" or "first
consumer" in commits, docs, and comments. Grep for the client's
actual name before any commit or publish that touches user-facing
copy.

## Where things stand right now

### v0.7.0 shipped (2026-04-09).

All 12 `@noy-db/*` packages published at `0.7.0` on npm. Milestone
closed. GitHub release at https://github.com/vLannaAi/noy-db/releases/tag/v0.7.0.

### v0.7 feature summary

| Issue | Feature | Tests | Package |
|-------|---------|-------|---------|
| #109 | Session tokens | 18 | `@noy-db/core` |
| #110 | `_sync_credentials` | 16 | `@noy-db/core` |
| #111 | `@noy-db/auth-webauthn` | 18 | new package |
| #112 | `@noy-db/auth-oidc` | 21 | new package |
| #113 | Magic-link unlock | 17 | `@noy-db/core` |
| #114 | Session policies | 17 | `@noy-db/core` |
| #119 | Dev-mode persistent unlock | 23 | `@noy-db/core` |

**Total tests:** 688 (649 core + 18 auth-webauthn + 21 auth-oidc)

### Main branch state

```
main  803d17e  chore: release v0.7.0
```

Working tree is clean.

## Next milestone: v0.8.0

See `ROADMAP.md` for the v0.8 feature list. The v0.8.0 milestone has 5 open issues.

## Release-time invariants (from v0.6 retrospective)

1. **`pnpm release:version`** — always use the custom script, never raw
   `pnpm changeset version`. The script normalises all packages to core's
   canonical version and prevents changeset's pre-1.0 major-bump heuristic
   from producing stray `1.0.0` entries.

2. **Peer dep `workspace:*`** — all adapter packages use `"@noy-db/core":
   "workspace:*"` in `peerDependencies` (not `workspace:^`). Do not revert.

3. **New packages need lockfile entries before CI.** When a new workspace
   package is added, run `pnpm install` locally, commit the lockfile update,
   and push it on the feature branch. CI uses `--frozen-lockfile` and will
   fail if the new package isn't in the lockfile.

4. **Rebase auth branches onto core branch, not main.** Auth packages depend
   on core barrel exports added in the same release. Rebase auth feature
   branches onto the core feature branch so the needed exports are available
   during CI.

5. **happy-dom flakiness.** The `enrollOidc + unlockOidc round-trip > DEK
   crypto` test intermittently fails with `Cipher job failed` in CI. This is
   a happy-dom WebCrypto race; re-running the job resolves it every time.
   Not worth fixing now — note it if it recurs.
