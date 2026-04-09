# v0.6 merge runbook

> **Audience:** the engineer landing the v0.6 stack to `main` and tagging
> v0.6.0 on npm. Probably future-you. Read top-to-bottom before starting —
> some steps depend on earlier ones in non-obvious ways (force-pushes
> cascading through PR bases, changeset versioning ordering vs publish).
>
> **Last verified:** 2026-04-09 against the v0.6.0 milestone snapshot —
> 8 open PRs, 9 milestone issues, 1 design meta-issue (#87).

## Goal

Merge 8 PRs to `main`, close 8 issues, version-bump every `@noy-db/*`
package to `0.6.0`, tag, and publish to npm. End state: v0.6.0 live on
the registry, milestone closed, branch cleanup done.

## Inventory

**Stack 1 — Query DSL completion (7 PRs, linear stack, must merge bottom-up):**

```
main
 └─ #115 feat/v0.6/eager-join-73             closes #73 (eager .join())
     └─ #116 feat/v0.6/multi-fk-chaining-75  closes #75 (multi-FK chain)
         └─ #120 feat/v0.6/join-live-74       closes #74 (Query.live())
             └─ #121 feat/v0.6/aggregations-97 closes #97 (reducers + .aggregate())
                 └─ #122 feat/v0.6/groupby-98  closes #98 (.groupBy())
                     └─ #123 feat/v0.6/scan-aggregate-99  closes #99 (scan().aggregate())
                         └─ #124 feat/v0.6/scan-join-76   closes #76 (scan().join())
```

**Stack 2 — Container format (1 PR, fully independent):**

```
main
 └─ #125 feat/v0.6/noydb-container-100  closes #100 (.noydb format)
```

**Design constraint (no PR — already honored across the 8):**

- #87 partition-awareness seams (`partitionScope` in joins, `{ seed }`
  in reducers). Verified by tests in `query-aggregate.test.ts` and
  `query-join.test.ts`.

---

## Pre-merge checklist

Run before touching any PR. If any item fails, stop and fix before
proceeding — partial merges of a stack are very hard to recover from.

```bash
# 1. Local main is up to date
git fetch origin
git checkout main
git pull --ff-only

# 2. All 8 PRs are mergeable and CI-green
gh pr list --repo vLannaAi/noy-db --state open --limit 20 \
  --json number,title,mergeable,statusCheckRollup,reviewDecision

# Expected output: every PR shows "MERGEABLE", every checks summary
# shows SUCCESS (or NEUTRAL — info-only checks count). Reviews are
# at the project's discretion; this runbook assumes the engineer
# has either reviewed or accepted self-review.

# 3. No PR has unresolved review comments
for pr in 115 116 120 121 122 123 124 125; do
  echo "=== PR #$pr ==="
  gh api "repos/vLannaAi/noy-db/pulls/$pr/comments" --jq '.[].body' | head -5
done

# 4. Working tree clean, no stray branches
git status
git branch -vv | grep -v 'origin/'

# 5. Local turbo passes for the latest stack tip
git checkout feat/v0.6/scan-join-76    # tip of Stack 1
pnpm install
pnpm turbo test lint typecheck build --filter=@noy-db/core
# Expected: 530/530 core tests passing, all 4 tasks green

git checkout feat/v0.6/noydb-container-100   # Stack 2
pnpm turbo test lint typecheck build --filter=@noy-db/core --filter=@noy-db/file
# Expected: 444/444 core + 6/6 file tests passing
```

If anything fails locally, **debug locally first** — never start a merge
sequence with uncertainty about any branch's state.

---

## Merge Stack 1 (Query DSL, 7 PRs, bottom-up)

The hard rule: each PR's base is the previous PR's branch, so they must
merge in order. Merging out of order leaves orphan PRs targeting
branches that no longer exist.

After each merge, the next PR's base auto-updates from "the previous
branch" to "the next previous branch" — except in `gh pr merge` with
the squash strategy, which can leave the next PR's base pointing at a
deleted branch. The runbook below uses **merge commits** (not squash)
specifically because the merge-commit history preserves the per-PR
context and avoids the auto-rebase cascade.

### Why merge commits, not squash

- Each PR is a coherent feature with a single descriptive commit
  already (the v0.6 work is one-commit-per-PR by design)
- Squashing would lose the Co-Authored-By footer Claude attribution
- Merge commits make the v0.6 release window obvious in `git log`
  on `main` — every feature is a single commit, with merge bubbles
  marking the integration points

### Merge order (execute one at a time, verify between each)

```bash
# ─── #115 eager join ───────────────────────────────────────────────
gh pr merge 115 --repo vLannaAi/noy-db --merge --delete-branch
# Wait for CI on main to start, verify it's green before continuing.
gh run list --repo vLannaAi/noy-db --branch main --limit 3
sleep 90  # CI is fast on main; this is a courtesy buffer
gh run watch --repo vLannaAi/noy-db --exit-status

# ─── #116 multi-FK chain ───────────────────────────────────────────
# Auto-rebase: GitHub will detect that #116's base (feat/v0.6/eager-join-73)
# was deleted and prompt to update the base to main. The PR diff should
# narrow to just the multi-FK changes once the base is updated.
gh pr edit 116 --repo vLannaAi/noy-db --base main
# Re-run CI on the rebased branch
gh pr checks 116 --repo vLannaAi/noy-db
# Wait for green, then merge
gh pr merge 116 --repo vLannaAi/noy-db --merge --delete-branch
gh run watch --repo vLannaAi/noy-db --exit-status

# ─── #120 Query.live() ─────────────────────────────────────────────
gh pr edit 120 --repo vLannaAi/noy-db --base main
gh pr checks 120 --repo vLannaAi/noy-db
gh pr merge 120 --repo vLannaAi/noy-db --merge --delete-branch
gh run watch --repo vLannaAi/noy-db --exit-status

# ─── #121 aggregations ─────────────────────────────────────────────
gh pr edit 121 --repo vLannaAi/noy-db --base main
gh pr checks 121 --repo vLannaAi/noy-db
gh pr merge 121 --repo vLannaAi/noy-db --merge --delete-branch
gh run watch --repo vLannaAi/noy-db --exit-status

# ─── #122 groupBy ──────────────────────────────────────────────────
gh pr edit 122 --repo vLannaAi/noy-db --base main
gh pr checks 122 --repo vLannaAi/noy-db
gh pr merge 122 --repo vLannaAi/noy-db --merge --delete-branch
gh run watch --repo vLannaAi/noy-db --exit-status

# ─── #123 scan().aggregate() ───────────────────────────────────────
gh pr edit 123 --repo vLannaAi/noy-db --base main
gh pr checks 123 --repo vLannaAi/noy-db
gh pr merge 123 --repo vLannaAi/noy-db --merge --delete-branch
gh run watch --repo vLannaAi/noy-db --exit-status

# ─── #124 scan().join() ────────────────────────────────────────────
gh pr edit 124 --repo vLannaAi/noy-db --base main
gh pr checks 124 --repo vLannaAi/noy-db
gh pr merge 124 --repo vLannaAi/noy-db --merge --delete-branch
gh run watch --repo vLannaAi/noy-db --exit-status
```

After Stack 1 lands, **issues #73 / #75 / #74 / #97 / #98 / #99 / #76
auto-close** via the "closes #N" markers in the PR titles.

### Post-Stack-1 verification

```bash
# Local main reflects all 7 PRs
git checkout main
git pull --ff-only
git log --oneline -10
# Expected: 7 merge commits + 7 feat commits since 87dbeea, in the order
# above.

# Tests pass on the integrated main
pnpm install
pnpm turbo test lint typecheck build --filter=@noy-db/core
# Expected: 530/530 core tests passing — same number you saw at the tip
# of #124 locally before merging.

# Milestone shows 7 of 9 issues closed
gh issue list --repo vLannaAi/noy-db --milestone "v0.6.0" --state closed
gh issue list --repo vLannaAi/noy-db --milestone "v0.6.0" --state open
# Expected closed: #73 #74 #75 #76 #97 #98 #99
# Expected open: #87 (meta — close manually with explanation), #100
```

---

## Merge Stack 2 (Container format, 1 PR)

Independent of Stack 1 — can merge before, after, or interleaved with
Stack 1 in principle. **Recommendation:** merge AFTER Stack 1 lands so
the v0.6 stats are fully gathered in one place when changeset versioning
runs (see next section).

```bash
# #125 is already targeting main and has no dependencies
gh pr checks 125 --repo vLannaAi/noy-db
gh pr merge 125 --repo vLannaAi/noy-db --merge --delete-branch
gh run watch --repo vLannaAi/noy-db --exit-status

# Verify
git checkout main
git pull --ff-only
pnpm turbo test lint typecheck build --filter=@noy-db/core --filter=@noy-db/file
# Expected on main after BOTH stacks:
#   @noy-db/core: 558/558 tests (530 from Stack 1 + 28 new bundle tests)
#   @noy-db/file: existing tests + 6 new bundle tests
```

**Issue #100 auto-closes** via "closes #100" in the PR title.

---

## Close the design meta-issue (#87)

Issue #87 has no PR because it's a design constraint, not a feature.
Close it manually with a comment summarizing the seams it requested
and the PRs that honored each one:

```bash
gh issue comment 87 --repo vLannaAi/noy-db --body "$(cat <<'EOF'
v0.6 partition-awareness seams — closing as honored across the v0.6 PR set.

| Constraint | Honored in |
|---|---|
| `JoinLeg.partitionScope: 'all'` plumbed through the planner | #115 (eager join), #124 (streaming join) — every JoinLeg constructed in v0.6 sets `partitionScope: 'all'` |
| Reducer factories accept `{ seed }` parameter | #121 (every factory: count/sum/avg/min/max), #122 (delegates), #123 (delegates) |
| Export envelope `auxiliaryState` field | Deferred until v0.8 i18n consumer ask materializes |

Dedicated tests pin both seams as no-op in v0.6:
- `query-aggregate.test.ts` "every reducer factory accepts a { seed } option without affecting v0.6 output"
- `query-join.test.ts` `partitionScope: 'all'` surfaced via `toPlan()`

When v0.10 lands partitioned collections, populating these seams
becomes a non-breaking change — the API surface is already shaped to
accept partition state.
EOF
)"

gh issue close 87 --repo vLannaAi/noy-db --reason completed
```

---

## Version, tag, publish

Run after **both stacks have merged** and CI is green on `main`.

```bash
# 1. Pull the integrated main
git checkout main
git pull --ff-only

# 2. Run changeset version — aggregates all 8 changeset markdown files
#    in .changeset/ into per-package version bumps and CHANGELOG.md updates
pnpm changeset version

# Expected: every @noy-db/* package's package.json bumps from 0.5.0 to
# 0.6.0, every package's CHANGELOG.md gains a v0.6.0 section assembled
# from the changeset bodies. The 8 source changeset files are deleted
# from .changeset/ (consumed).

# 3. Inspect the resulting changes
git status
git diff packages/core/CHANGELOG.md | head -100
git diff packages/file/CHANGELOG.md | head -100

# 4. Commit the version bump
git add .
git commit -m "$(cat <<'EOF'
chore: release v0.6.0

- Query DSL completion: joins (eager #73 + multi-FK #75 + live #74 +
  streaming #76), aggregations v1 (reducers + .aggregate() #97,
  groupBy #98, scan().aggregate() #99)
- .noydb container format (#100) — minimum-disclosure binary wrapper
  around compartment.dump() for safe cloud storage
- Partition-awareness seams (#87) honored across all features
EOF
)"

# 5. Push the version commit
git push origin main

# 6. Wait for CI green on the version commit
gh run watch --repo vLannaAi/noy-db --exit-status

# 7. Tag and push the tag
git tag -a v0.6.0 -m "v0.6.0 — Query DSL completion + .noydb container"
git push origin v0.6.0

# 8. Publish to npm — every @noy-db/* package on the unified version line
pnpm changeset publish
# Expected: 10 packages published at 0.6.0:
#   @noy-db/core, @noy-db/memory, @noy-db/file, @noy-db/dynamo,
#   @noy-db/s3, @noy-db/browser, @noy-db/vue, @noy-db/nuxt,
#   @noy-db/pinia, @noy-db/create

# Verify npm has them all
for pkg in core memory file dynamo s3 browser vue nuxt pinia create; do
  npm view "@noy-db/$pkg" version
done
# Expected: 0.6.0 for every package
```

---

## Close the milestone

```bash
# All 9 issues should be closed at this point — the 8 features via
# auto-close and #87 manually closed in the previous step.
gh issue list --repo vLannaAi/noy-db --milestone "v0.6.0" --state open
# Expected: empty output

gh api -X PATCH "repos/vLannaAi/noy-db/milestones/4" -F state=closed
# Confirm
gh api "repos/vLannaAi/noy-db/milestones/4" --jq '.state'
# Expected: "closed"
```

---

## Post-release housekeeping

```bash
# Local cleanup — every merged feature branch should already be deleted
# on the remote via --delete-branch above. Clean up local copies.
git branch | grep -E 'feat/v0.6/' | xargs -n1 git branch -d 2>/dev/null

# Worktree cleanup if any are left
git worktree list
# Remove any v0.6/* worktrees
# git worktree remove <path>

# Publish the GitHub release with the rendered notes
gh release create v0.6.0 \
  --repo vLannaAi/noy-db \
  --title "v0.6.0 — Query DSL completion + .noydb container" \
  --notes-file docs/v0.6/release-notes-draft.md
```

---

## Rollback procedure

Things that can go wrong and how to recover.

### CI fails on main mid-stack

If CI breaks after merging one PR but before the next, **stop the merge
sequence immediately**. Do not keep merging — each subsequent PR will
either fail to merge or land on a broken main, multiplying the recovery
work.

```bash
# Identify which commit on main broke CI
git log --oneline main | head -10
gh run view <failing-run-id> --repo vLannaAi/noy-db --log

# If the failure is in the just-merged PR's tests, revert the merge:
git checkout main
git revert -m 1 <merge-commit-sha>
git push origin main
```

The reverted PR can be reopened, fixed, and re-merged later. The PRs
above it in the stack stay open — they need to be rebased onto the
new (post-revert) main.

### Force-push corrupted a stacked branch's history

If a `git push --force-with-lease` to a stacked branch leaves the
remote in a bad state (rare; lease should prevent it), the recovery is
to re-create the branch from a known-good state:

```bash
# Find the last good commit in your local reflog
git reflog feat/v0.6/<branch-name>

# Restore to that commit
git checkout feat/v0.6/<branch-name>
git reset --hard <last-good-sha>
git push --force-with-lease origin feat/v0.6/<branch-name>
```

If your local reflog is also gone, the GitHub web UI's "compare
branches" page can show the history before the bad push (search for
the PR by number, click "Files changed", then "Browse commits at this
revision"). Reconstructing from there is more work but always possible.

### `pnpm changeset version` produces wrong bumps

If a changeset file specified `patch` instead of `minor` (or vice
versa), `pnpm changeset version` will produce a wrong version bump.
Recovery: revert the version commit, edit the offending changeset
file in `.changeset/`, re-run `pnpm changeset version`.

```bash
git revert HEAD                                    # back out the bump
# Restore the consumed changeset files from the previous commit
git checkout HEAD~1 -- .changeset/
# Edit the offending file
$EDITOR .changeset/<file>.md
# Re-run versioning
pnpm changeset version
git commit -am "chore: release v0.6.0 (corrected)"
```

### npm publish partially fails

`pnpm changeset publish` is not atomic — if 5 of 10 packages publish
and the 6th fails, the npm registry has a half-published v0.6.0. Do
NOT try to publish the missing packages by hand without first
investigating why the 6th failed (auth, network, version conflict).

Most common cause: the package's `.npmignore` or `package.json#files`
field excludes a build artifact that the publish step expected. Fix
the package, run `pnpm turbo build` for it, then re-run
`pnpm changeset publish` — it will skip the already-published 5 and
retry the remaining 5.

If the registry is left in an inconsistent state for more than a few
minutes, file an internal note and decide whether to:
- Bump the next patch version (0.6.1) for the affected packages, OR
- Use `npm unpublish` (only works within 72 hours) to roll back the
  partial publish, then republish from scratch as 0.6.0

---

## Sanity-check the runbook against current state

Before executing any of the above, verify the inventory still matches
reality:

```bash
# 8 PRs in v0.6 milestone
gh pr list --repo vLannaAi/noy-db --state open --search "v0.6" --limit 20 \
  --json number,title,baseRefName,headRefName

# 9 issues (8 features + #87 meta)
gh issue list --repo vLannaAi/noy-db --milestone "v0.6.0" --state all --limit 20

# All 8 changeset files exist
ls .changeset/*.md
# Expected files:
#   eager-join-73.md
#   multi-fk-chaining-75.md
#   join-live-74.md
#   aggregations-97.md
#   groupby-98.md
#   scan-aggregate-99.md
#   scan-join-76.md
#   noydb-container-100.md
```

If any of these don't match, **stop and reconcile** before starting the
merge sequence. The runbook assumes the inventory above; deviations are
either a sign that something has changed since this document was
written or that the merge sequence is already partially complete.

---

## Time budget

Rough estimates for a clean run with no surprises:

| Phase | Time |
|---|---|
| Pre-merge checklist | 10 min |
| Stack 1 (7 PRs × ~3 min each, including CI waits) | 20–30 min |
| Stack 2 (1 PR) | 5 min |
| Post-merge verification | 5 min |
| Close #87 + close milestone | 5 min |
| `changeset version` + commit + push | 5 min |
| Tag + `changeset publish` | 10 min |
| Post-release cleanup | 5 min |
| **Total (clean run)** | **65–75 min** |

Add 30+ min if any rebases need to happen interactively, or 60+ min if
a CI failure forces a revert.

---

*Last updated: 2026-04-09. If this runbook drifts from reality (PR
numbers reused, branches renamed, milestone renumbered), update the
inventory section and re-verify before executing.*
