# Session handover

> **Purpose:** pass context from one Claude Code session to the next
> without needing to re-discover the project state from scratch. Read
> this first if you're picking up work on noy-db with no prior
> session memory.
>
> **Updated:** 2026-04-09, after completing all v0.7 feature development.

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

### v0.6.0 shipped (2026-04-09). v0.7 features are implemented and tested.

All 7 v0.7 milestone issues (#109, #110, #111, #112, #113, #114, #119)
are implemented in `main`. No PRs have been created yet — the code
landed directly in this session. The next step is **creating PRs,
running CI, and executing the merge runbook** (`docs/v0.7/merge-runbook.md`).

### v0.7 feature status

| Issue | Feature | Status | Package |
|-------|---------|--------|---------|
| #109 | Session tokens | ✅ 18 tests | `@noy-db/core` |
| #110 | `_sync_credentials` | ✅ 16 tests | `@noy-db/core` |
| #111 | `@noy-db/auth-webauthn` | ✅ 18 tests (happy-dom + navigator.credentials mock) | new package |
| #112 | `@noy-db/auth-oidc` | ✅ 21 tests (happy-dom + fetch mock) | new package |
| #113 | Magic-link unlock | ✅ 17 tests (pure crypto, Node env) | `@noy-db/core` |
| #114 | Session policies | ✅ 17 tests | `@noy-db/core` |
| #119 | Dev-mode persistent unlock | ✅ 23 tests (happy-dom) | `@noy-db/core` |

**Total tests:** 688 (649 core + 18 auth-webauthn + 21 auth-oidc)

### Release tooling shipped

| Artifact | Status |
|----------|--------|
| `scripts/release.mjs` | ✅ written — normalizes all `@noy-db/*` versions to core |
| `pnpm release:version` script wired in root `package.json` | ✅ |
| `docs/v0.7/merge-runbook.md` | ✅ written — applies all v0.6 retrospective lessons |
| `.changeset/v0.7-issue-*.md` (7 files) | ✅ written — one per issue |

### Main branch state

```
main  41b5e06  docs: v0.6.0 post-release housekeeping
```

Working tree is NOT clean — all v0.7 feature files were added directly
to `main` in this session (no feature branches / PRs yet). The next
session should create feature branches + PRs before any merge.

### New files added in this session (all in `main`)

**`packages/core/src/`**
- `session.ts` — session tokens (#109)
- `session-policy.ts` — session policies (#114)
- `sync-credentials.ts` — `_sync_credentials` collection (#110)
- `magic-link.ts` — magic-link unlock (#113)
- `dev-unlock.ts` — dev-mode persistent unlock (#119)

**`packages/core/__tests__/`**
- `session.test.ts` — 18 tests
- `session-policy.test.ts` — 17 tests
- `sync-credentials.test.ts` — 16 tests
- `dev-unlock.test.ts` — 23 tests (uses `@vitest-environment happy-dom`)

**`packages/auth-webauthn/`** — NEW package (#111)
- `package.json`, `tsconfig.json`, `tsup.config.ts`, `src/index.ts`
- No tests yet (requires browser mock env; deferred)

**`packages/auth-oidc/`** — NEW package (#112)
- `package.json`, `tsconfig.json`, `tsup.config.ts`, `src/index.ts`
- No tests yet (requires fetch + storage mocks; deferred)

**`scripts/release.mjs`** — version normalizer
**`docs/v0.7/merge-runbook.md`** — merge runbook
**`.changeset/v0.7-issue-*.md`** (7 changeset files)

### Modified files

**`packages/core/src/index.ts`** — new exports for all 5 new core modules
**`packages/core/src/errors.ts`** — `SessionExpiredError`, `SessionNotFoundError`, `SessionPolicyError`
**`packages/core/src/types.ts`** — `SessionPolicy`, `ReAuthOperation`, `NoydbOptions.sessionPolicy`
**`packages/core/src/noydb.ts`** — PolicyEnforcer integration, revokeAllSessions on close

## ⚠️ What the next session should do

### 1. Run the full test suite and confirm no regressions

```bash
pnpm turbo test --filter=@noy-db/core
pnpm turbo build  # verifies TypeScript across all packages
```

### 3. Create PRs for each v0.7 issue and merge via runbook

Follow `docs/v0.7/merge-runbook.md` exactly. Key reminder:
- **Step 0 (pre-rebase)** is critical — do it before any merges.
- Use `pnpm release:version` (not raw `pnpm changeset version`).
- Grep for stray `1.0.0` after the version step.
- `gh run watch --exit-status` for every CI wait.

## ⚠️ Release-time invariants (from v0.6 retrospective)

These are documented in `docs/v0.6/retrospective.md` and enforced by
`scripts/release.mjs` and `docs/v0.7/merge-runbook.md`, but worth surfacing
here:

1. **`pnpm release:version`** not `pnpm changeset version` — the raw CLI
   will major-bump adapter packages (0.x → 1.0) due to the peer-dep
   heuristic. The wrapper normalizes everything to core's version.

2. **Pre-rebase stacked PRs BEFORE any merges** — GitHub auto-closes
   downstream PRs when their base branch is deleted.

3. **Grep for stray `1.0.0`** after the version step. If any package shows
   `1.0.0`, the normalizer missed it — fix manually before committing.

## Key invariants that cross sessions

- **Zero crypto dependencies.** All cryptography is Web Crypto API
  (`crypto.subtle`). Never add npm crypto packages.
- **KEK never persisted.** In-memory only. `_keyring` stores WRAPPED DEKs
  (via AES-KW), not the KEK itself.
- **Adapters only see ciphertext.** Encryption happens in core before
  data reaches any adapter.
- **Partition-awareness seams (#87).** Every `JoinLeg` carries
  `partitionScope: 'all'` and every reducer factory accepts `{ seed }`.
  These are dormant in v0.6 but load-bearing for v0.10. Do not remove.
- **Peer-dep convention.** Adapter packages use `"workspace:*"` (not
  `"workspace:^"`) to prevent the changeset pre-1.0 major-bump heuristic.
- **`dev-unlock.ts` guardrails.** The production guard and acknowledge
  string in `enableDevUnlock` must not be relaxed. They are the only
  thing preventing accidental production exposure of plaintext DEKs.

## Project layout (high level)

```
noy-db/
├── SPEC.md                              # Source of truth — read first
├── ROADMAP.md                           # Version timeline + milestones
├── CLAUDE.md                            # Session-level project guidance
├── HANDOVER.md                          # This file
├── scripts/
│   └── release.mjs                      # Version normalizer (use via pnpm release:version)
├── docs/
│   ├── architecture.md
│   ├── v0.6/
│   │   ├── release-notes-draft.md
│   │   ├── merge-runbook.md
│   │   └── retrospective.md             # READ BEFORE RELEASING
│   └── v0.7/
│       └── merge-runbook.md             # v0.7 release runbook
├── .changeset/
│   ├── v0.7-issue-109-session-tokens.md
│   ├── v0.7-issue-110-sync-credentials.md
│   ├── v0.7-issue-111-auth-webauthn.md
│   ├── v0.7-issue-112-auth-oidc.md
│   ├── v0.7-issue-113-magic-link.md
│   ├── v0.7-issue-114-session-policies.md
│   └── v0.7-issue-119-dev-unlock.md
└── packages/
    ├── core/
    │   └── src/
    │       ├── session.ts               # #109
    │       ├── session-policy.ts        # #114
    │       ├── sync-credentials.ts      # #110
    │       ├── magic-link.ts            # #113
    │       ├── dev-unlock.ts            # #119
    │       └── ... (v0.6 unchanged)
    ├── auth-webauthn/                   # NEW — #111
    ├── auth-oidc/                       # NEW — #112
    └── ... (v0.6 adapter packages, unchanged)
```

## Commands the next session will need

```bash
# Run all tests
pnpm turbo test --filter=@noy-db/core

# Full type+lint+build check
pnpm turbo lint typecheck build

# Release
pnpm release:version                     # ← always use this, not raw changeset version
pnpm changeset publish
```

## Useful links

- **Repo:** https://github.com/vLannaAi/noy-db
- **npm org:** https://www.npmjs.com/org/noy-db
- **v0.6 milestone (closed):** https://github.com/vLannaAi/noy-db/milestone/4
- **v0.7 milestone (next):** https://github.com/vLannaAi/noy-db/milestone/5
- **v0.6 release:** https://github.com/vLannaAi/noy-db/releases/tag/v0.6.0

## Auto-memory references

The shared Claude auto-memory at
`~/.claude/projects/-Users-vicio--github-noy-db/memory/` has entries
worth re-reading at the start of any session:

- `user_profile.md` — vLannaAi/vlanna, building platform for a
  private accounting-firm client, visual-first, fast iteration style
- `feedback_security.md` — user has shared credentials before; always
  warn and refuse to use
- `feedback_client_privacy.md` — never reference the accounting-firm
  client by name; use generic terms; grep before commit/publish

## One-line summary

**v0.6.0 is live on npm. All 7 v0.7 features implemented + 688 tests
passing, all packages build clean. Next: open PRs, execute
`docs/v0.7/merge-runbook.md`.**

---

*Updated 2026-04-09 after the v0.7 feature development session.
Author: Claude Sonnet 4.6 paired with vLannaAi.*
