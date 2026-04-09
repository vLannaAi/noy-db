# v0.7 merge runbook

> **Audience:** the engineer landing the v0.7 stack to `main` and tagging
> v0.7.0 on npm. Probably future-you. Read top-to-bottom before starting —
> some steps are non-obvious and were learned the hard way in v0.6.
>
> **Corrections from v0.6:** This runbook incorporates all six fixes from
> `docs/v0.6/retrospective.md`. READ THAT DOCUMENT BEFORE STARTING.
>
> Key differences from v0.6 runbook:
> 1. **Pre-rebase loop at the top of every stack** — do this BEFORE any merge,
>    not after (the v0.6 lesson: deleting a branch auto-closes downstream PRs).
> 2. **Mergeability check for independent PRs** before starting the stack.
> 3. **`pnpm release:version` instead of raw `pnpm changeset version`** — the
>    wrapper in `scripts/release.mjs` normalizes versions to prevent
>    0.x.0 → 1.0.0 major-bump heuristic from biting (v0.6 §Surprise #2).
> 4. **Stray `1.0.0` grep** after the version step.
> 5. **`gh run watch --exit-status`** for every CI wait — no `sleep`.
> 6. **`npm view` verification loop** after publish.

## Goal

Merge v0.7 PRs to `main`, close 7 issues, version-bump every `@noy-db/*`
package to `0.7.0`, add the 2 new packages (`@noy-db/auth-webauthn`,
`@noy-db/auth-oidc`), tag, and publish to npm. End state: v0.7.0 live,
milestone closed, branches cleaned up.

## Inventory

> Fill in PR numbers as PRs are created. Leave as `#TBD` until created.

**Stack 1 — Core session layer (linear stack; #109 must land first):**

```
main
 └─ #TBD feat/v0.7/session-tokens-109          closes #109
     └─ #TBD feat/v0.7/session-policies-114    closes #114
         └─ #TBD feat/v0.7/sync-credentials-110  closes #110
             └─ #TBD feat/v0.7/dev-mode-unlock-119  closes #119
```

**Stack 2 — New auth packages (independent of each other; both depend on #109):**

```
main
 └─ #TBD feat/v0.7/auth-webauthn-111           closes #111
main
 └─ #TBD feat/v0.7/magic-link-113              closes #113
```

**Stack 3 — OIDC bridge (independent; depends on #109):**

```
main
 └─ #TBD feat/v0.7/auth-oidc-112               closes #112
```

**Design constraint (no PR):**

- All v0.7 auth methods are unlock layers over the same KEK; no new crypto
  primitives added. The passphrase-as-root invariant (discussion #117)
  is honored across every PR.

---

## Step 0 — Pre-rebase ALL stacked PRs before touching anything

> **v0.6 lesson (Surprise #1):** `gh pr merge --delete-branch` deletes the
> source branch the moment the merge commits. If the next PR in the stack
> has that deleted branch as its base, GitHub auto-closes it and the PR
> becomes unrecoverable via the API. The fix is to rebase every stacked PR
> to `main` BEFORE starting any merges.

```bash
# Ensure local main is current
git fetch origin
git checkout main
git pull --ff-only

# Pre-rebase Stack 1 (bottom-up order — each builds on the previous rebase)
# Substitute real PR branch names once PRs are created:
STACK1=(
  feat/v0.7/session-tokens-109
  feat/v0.7/session-policies-114
  feat/v0.7/sync-credentials-110
  feat/v0.7/dev-mode-unlock-119
)

for branch in "${STACK1[@]}"; do
  echo "=== Rebasing $branch onto main ==="
  git checkout "$branch"
  git rebase main
  git push --force-with-lease origin "$branch"
  # Update the PR base to main
  gh pr edit --repo vLannaAi/noy-db --base main \
    "$(gh pr list --repo vLannaAi/noy-db --head "$branch" --json number --jq '.[0].number')"
done

git checkout main
```

For Stacks 2 and 3 (independent PRs), verify they already target `main`:

```bash
gh pr list --repo vLannaAi/noy-db --state open \
  --json number,title,baseRefName,headRefName
# Confirm every PR has baseRefName == "main"
```

---

## Pre-merge checklist

Run before touching any PR. If any item fails, stop and fix first.

```bash
# 1. Local main is up to date
git checkout main
git pull --ff-only

# 2. All v0.7 PRs are mergeable and CI-green
gh pr list --repo vLannaAi/noy-db --state open --limit 20 \
  --json number,title,mergeable,statusCheckRollup
# Expected: every PR shows "MERGEABLE", every check shows SUCCESS or NEUTRAL

# 3. No unresolved review comments
for pr in <PR_NUMBERS_HERE>; do
  echo "=== PR #$pr ==="
  gh api "repos/vLannaAi/noy-db/pulls/$pr/comments" --jq '.[].body' | head -5
done

# 4. Working tree clean
git status

# 5. Local turbo passes on the tip of Stack 1
git checkout feat/v0.7/dev-mode-unlock-119
pnpm install
pnpm turbo test lint typecheck build --filter=@noy-db/core
# Expected: all tests passing (558 v0.6 + v0.7 new tests)

# 6. New package builds pass
pnpm turbo test lint typecheck build --filter=@noy-db/auth-webauthn
pnpm turbo test lint typecheck build --filter=@noy-db/auth-oidc

git checkout main
```

---

## Merge Stack 1 (core session layer, 4 PRs, bottom-up)

After the pre-rebase loop above, every PR in Stack 1 already targets `main`.
Merge them in order.

```bash
# ─── Session tokens (foundation) ──────────────────────────────────────
PR_109=<PR number for #109>
gh pr merge $PR_109 --repo vLannaAi/noy-db --merge --delete-branch
gh run watch --repo vLannaAi/noy-db --exit-status

# ─── Session policies ──────────────────────────────────────────────────
PR_114=<PR number for #114>
gh pr checks $PR_114 --repo vLannaAi/noy-db
gh pr merge $PR_114 --repo vLannaAi/noy-db --merge --delete-branch
gh run watch --repo vLannaAi/noy-db --exit-status

# ─── _sync_credentials ─────────────────────────────────────────────────
PR_110=<PR number for #110>
gh pr checks $PR_110 --repo vLannaAi/noy-db
gh pr merge $PR_110 --repo vLannaAi/noy-db --merge --delete-branch
gh run watch --repo vLannaAi/noy-db --exit-status

# ─── Dev-mode unlock ───────────────────────────────────────────────────
PR_119=<PR number for #119>
gh pr checks $PR_119 --repo vLannaAi/noy-db
gh pr merge $PR_119 --repo vLannaAi/noy-db --merge --delete-branch
gh run watch --repo vLannaAi/noy-db --exit-status
```

### Post-Stack-1 verification

```bash
git checkout main
git pull --ff-only
git log --oneline -8

pnpm install
pnpm turbo test lint typecheck build --filter=@noy-db/core
# All tests must pass before continuing to Stack 2

gh issue list --repo vLannaAi/noy-db --milestone "v0.7.0" --state closed
# Expected closed: #109 #114 #110 #119
# Expected open: #111 #112 #113
```

---

## Merge Stacks 2 and 3 (new packages and magic-link)

Independent of each other — can merge in any order.

```bash
# ─── auth-webauthn package ─────────────────────────────────────────────
PR_111=<PR number for #111>
gh pr checks $PR_111 --repo vLannaAi/noy-db
gh pr merge $PR_111 --repo vLannaAi/noy-db --merge --delete-branch
gh run watch --repo vLannaAi/noy-db --exit-status

# ─── magic-link ────────────────────────────────────────────────────────
PR_113=<PR number for #113>
gh pr checks $PR_113 --repo vLannaAi/noy-db
gh pr merge $PR_113 --repo vLannaAi/noy-db --merge --delete-branch
gh run watch --repo vLannaAi/noy-db --exit-status

# ─── auth-oidc package ─────────────────────────────────────────────────
PR_112=<PR number for #112>
gh pr checks $PR_112 --repo vLannaAi/noy-db
gh pr merge $PR_112 --repo vLannaAi/noy-db --merge --delete-branch
gh run watch --repo vLannaAi/noy-db --exit-status
```

### Post-Stack-2/3 verification

```bash
git checkout main
git pull --ff-only
pnpm install
pnpm turbo test lint typecheck build
# All packages, all tests

gh issue list --repo vLannaAi/noy-db --milestone "v0.7.0" --state open
# Expected: empty (all 7 issues auto-closed by PR titles)
```

---

## Version, tag, publish

Run after ALL stacks merged and CI is green on `main`.

> **v0.6 lesson (Surprise #2):** raw `pnpm changeset version` major-bumps
> adapter packages (0.x → 1.0). Use `pnpm release:version` which runs the
> changeset step then normalizes all versions to match @noy-db/core.

```bash
# 1. Pull integrated main
git checkout main
git pull --ff-only

# 2. Version step — uses the normalization wrapper
pnpm release:version
# Expected: all @noy-db/* packages at 0.7.0; scripts/release.mjs prints
# a summary of any packages it corrected.

# 3. Sanity-check: no stray 1.0.0
grep -r '"version": "1.0.0"' packages/*/package.json
# Expected: no output

# 4. Inspect changelogs
git diff packages/core/CHANGELOG.md | head -80
git diff packages/file/CHANGELOG.md | head -40

# 5. Verify the two new packages are present
ls packages/auth-webauthn/package.json
ls packages/auth-oidc/package.json
cat packages/auth-webauthn/package.json | grep '"version"'
cat packages/auth-oidc/package.json | grep '"version"'
# Expected: "0.7.0" for both

# 6. Commit the version bump
git add .
git commit -m "$(cat <<'EOF'
chore: release v0.7.0

- Session tokens: unlock-once JWE, tab-scoped non-extractable session key (#109)
- Session policies: idle/absolute timeouts, requireReAuthFor, lockOnBackground (#114)
- _sync_credentials: encrypted per-adapter OAuth token store (#110)
- @noy-db/auth-webauthn: WebAuthn + PRF + BE-flag hardware-key keyrings (#111)
- Magic-link unlock: one-shot read-only viewer session for client portals (#113)
- @noy-db/auth-oidc: OAuth/OIDC bridge, split-key connector (#112)
- Dev-mode persistent unlock: opt-in, guardrailed, dev-only (#119)
EOF
)"

# 7. Push and wait for CI
git push origin main
gh run watch --repo vLannaAi/noy-db --exit-status

# 8. Tag
git tag -a v0.7.0 -m "v0.7.0 — Identity & sessions"
git push origin v0.7.0

# 9. Publish
pnpm changeset publish
# Expected: 12 packages published at 0.7.0:
#   @noy-db/core, @noy-db/memory, @noy-db/file, @noy-db/dynamo,
#   @noy-db/s3, @noy-db/browser, @noy-db/vue, @noy-db/nuxt,
#   @noy-db/pinia, @noy-db/create,
#   @noy-db/auth-webauthn (NEW), @noy-db/auth-oidc (NEW)

# 10. Verify npm
for pkg in core memory file dynamo s3 browser vue nuxt pinia create auth-webauthn auth-oidc; do
  echo -n "@noy-db/$pkg: "
  npm view "@noy-db/$pkg" version 2>/dev/null || echo "(not found)"
done
# Expected: 0.7.0 for every package
```

---

## Close the milestone

```bash
gh issue list --repo vLannaAi/noy-db --milestone "v0.7.0" --state open
# Expected: empty

gh api -X PATCH "repos/vLannaAi/noy-db/milestones/5" -F state=closed
gh api "repos/vLannaAi/noy-db/milestones/5" --jq '.state'
# Expected: "closed"
```

---

## Post-release housekeeping

```bash
# Local branch cleanup
git branch | grep -E 'feat/v0.7/' | xargs -n1 git branch -d 2>/dev/null

# Create GitHub release
gh release create v0.7.0 \
  --repo vLannaAi/noy-db \
  --title "v0.7.0 — Identity & sessions" \
  --notes-file docs/v0.7/release-notes-draft.md

# Update HANDOVER.md for the next session
```

---

## Rollback procedure

### CI fails on main mid-stack

```bash
git log --oneline main | head -10
gh run view <failing-run-id> --repo vLannaAi/noy-db --log
# If the failure is in the just-merged PR:
git revert -m 1 <merge-commit-sha>
git push origin main
```

### `pnpm release:version` produces unexpected output

If the wrapper script errors after running `changeset version` but before
normalizing, the `packages/*/package.json` files may be partially correct.
Recovery:

```bash
git checkout -- packages/  # discard all package.json changes
# Inspect the changeset files — are they already consumed?
ls .changeset/*.md
# If consumed (files deleted), restore them:
git checkout HEAD -- .changeset/
# Re-run from scratch:
pnpm release:version
```

### npm publish partially fails

Same procedure as v0.6 — do NOT publish affected packages manually.
Re-run `pnpm changeset publish` to retry; it skips already-published packages.
Check `.changeset/pre.json` if the state is inconsistent.

---

## Sanity-check the inventory before starting

```bash
# All v0.7 PRs
gh pr list --repo vLannaAi/noy-db --state open --limit 20 \
  --json number,title,baseRefName,headRefName,mergeable

# 7 issues in milestone
gh issue list --repo vLannaAi/noy-db --milestone "v0.7.0" --state all --limit 20

# Changeset files (one per PR)
ls .changeset/*.md
# Expected files (one per feature PR):
#   session-tokens-109.md
#   session-policies-114.md
#   sync-credentials-110.md
#   dev-mode-unlock-119.md
#   auth-webauthn-111.md
#   magic-link-113.md
#   auth-oidc-112.md
```

---

## Time budget

| Phase | Time |
|---|---|
| Pre-rebase loop | 5–10 min |
| Pre-merge checklist | 10 min |
| Stack 1 (4 PRs × ~3 min + CI waits) | 15–20 min |
| Stacks 2 & 3 (3 independent PRs) | 10–15 min |
| Post-merge verification | 5 min |
| `pnpm release:version` + commit + push | 5 min |
| Tag + `pnpm changeset publish` | 10 min |
| npm verification loop | 5 min |
| Close milestone + GitHub release | 5 min |
| Post-release cleanup | 5 min |
| **Total (clean run)** | **75–90 min** |

---

*Last updated: 2026-04-09. If PR numbers differ from placeholders above,
fill them in at the top of the "Inventory" section before executing.*
