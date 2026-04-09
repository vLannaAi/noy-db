# v0.6 release retrospective

> **Purpose:** document the surprises, bugs, and recovery actions from
> the v0.6.0 merge + publish window so future releases don't step on
> the same rakes. Read this before running a release that involves
> stacked PRs or `pnpm changeset version`.
>
> **Context:** v0.6.0 shipped 2026-04-09 with 8 PRs closing 9 issues
> (#73, #74, #75, #76, #97, #98, #99, #100 + the #87 meta-issue).
> Execution followed `docs/v0.6/merge-runbook.md` — which itself needs
> several corrections this retrospective documents.

## TL;DR — three things will bite you if you don't fix them first

1. **`gh pr merge --delete-branch` auto-closes every downstream
   stacked PR** whose base points at the branch being deleted. Fix
   is one line per downstream PR: pre-emptively rebase to `main`
   before the first merge.
2. **`pnpm changeset version` computes `major` bumps for adapter
   packages** even when the peer dep is `workspace:*`, due to a
   changeset heuristic that doesn't inspect constraint looseness.
   In pre-1.0 (`0.x → 1.0.0`) this is catastrophically wrong. Fix
   is a post-version manual override OR a release-script wrapper.
3. **Stack-2 PRs branched from old main will have merge conflicts**
   with the stack-1 PRs if both touch the same barrel files
   (`errors.ts`, `src/index.ts`, `query/index.ts`). The #125
   container-format PR hit this and needed a rebase + force-push
   mid-release.

Everything else in this document is context, evidence, and the exact
commands that worked.

---

## What actually happened in v0.6

The release window ran through all 8 PRs + version-bump + publish +
tag + GitHub release in one session. The clean path took about 90
minutes but three recovery events added maybe 30 minutes of
troubleshooting. Nothing was lost, no code corruption, no published
versions had to be un-published. All tests passed at every step. But
the runbook predicted 65-75 minutes and it actually took closer to
two hours once the surprises were factored in.

Timeline:

| Event | Outcome |
|---|---|
| Pre-merge sanity check | ✅ clean main, 13/13 CI on all 8 PRs, no unresolved comments |
| Merge #115 (eager join) via `--merge --delete-branch` | ✅ main at `52b9bbf`, CI green |
| Attempt to merge #116 (multi-FK chaining) | ❌ **#116 was auto-CLOSED** when #115's branch was deleted |
| Recovery: reopen #116 | ❌ "Could not open the pull request" — base branch is gone |
| Recovery: pre-emptively rebase #120/#121/#122/#123/#124 bases to `main` | ✅ all 5 PRs OPEN + MERGEABLE again |
| Merge #120 (which contained #116's commit in its history) | ✅ `bd21ad7` and `f968f83` both landed on main; issue #75 auto-closed via commit message |
| Add explanatory comment on closed #116 for audit trail | ✅ |
| Merge #121/#122/#123/#124 in sequence with CI waits | ✅ all green |
| Merge #125 (container format, independent base) | ❌ **CONFLICTING** against new main |
| Recovery: rebase #125 locally, resolve 3 conflict files, force-push | ✅ |
| Re-run #125 CI, merge | ✅ 13/13 pass, merged |
| Run `pnpm changeset version` | ⚠️ **wrong versions**: core 0.6.0 ✅, adapters 1.0.0 ✗, create 0.5.1 ✗ |
| Investigation: read changeset status, try `fixed` group, try `workspace:*` peer deps | None of those worked alone |
| Recovery: run version anyway, manually overwrite 9 package.json versions + 9 CHANGELOG headers to 0.6.0 | ✅ |
| Commit release, push, verify CI | ✅ |
| Tag `v0.6.0`, push tag | ✅ |
| `pnpm changeset publish` | ✅ 10 packages live on npm |
| GitHub release + milestone close | ✅ |

---

## Surprise #1 — `--delete-branch` auto-closes downstream stacked PRs

### What happened

The runbook's Stack 1 merge sequence was:

```bash
gh pr merge 115 --repo vLannaAi/noy-db --merge --delete-branch
# ... wait for CI ...
gh pr edit 116 --repo vLannaAi/noy-db --base main
gh pr merge 116 --repo vLannaAi/noy-db --merge --delete-branch
```

The assumption was that `gh pr edit --base main` could rebase #116's
base **after** #115's branch was deleted. It cannot — GitHub
auto-closes a PR the instant its base branch disappears, and
`gh pr edit` then fails with:

```
GraphQL: Cannot change the base branch of a closed pull request. (updatePullRequest)
```

And `gh pr reopen 116` also fails:

```
API call failed: GraphQL: Could not open the pull request. (reopenPullRequest)
```

A closed PR whose base branch no longer exists cannot be reopened by
the API. The only recovery paths are: create a new PR from the same
head branch targeting main, OR let the commit ride along with a
downstream PR that shares the same history.

### Recovery in this release

`#116`'s branch `feat/v0.6/multi-fk-chaining-75` was stacked *inside*
`#120`'s branch `feat/v0.6/join-live-74` — because #120 was opened
with `feat/v0.6/multi-fk-chaining-75` as its base, #120's branch
contained both #116's commit (`bd21ad7`) and #120's commit (`f968f83`).
When #120 merged to main, **both commits landed**.

Issue #75 (which #116 was "closing") auto-closed correctly because the
commit message contained `(#75)` as a cross-reference — GitHub's
auto-close mechanism reads commit messages, not just PR titles. The
only cosmetic remediation needed was an explanatory comment on closed
PR #116 for audit trail.

### Fix for the next stacked release

**Pre-rebase every downstream PR's base to `main` BEFORE starting the
merge sequence, not between merges.** The correct runbook opener is:

```bash
# One-shot: pre-rebase every stacked PR's base to main
for pr in 116 120 121 122 123 124; do
  gh pr edit $pr --repo vLannaAi/noy-db --base main
done

# Verify every PR is still OPEN + MERGEABLE
for pr in 115 116 120 121 122 123 124; do
  gh pr view $pr --repo vLannaAi/noy-db --json state,mergeable
done

# NOW merge in order — deleting branches no longer orphans anyone
```

This changes the semantics slightly: each PR's diff will show all
upstream changes until the upstream PR merges, at which point the
diff narrows. That's fine for review (reviewers read per-PR, and the
PR body describes what's new). The GitHub UI shows "X commits" even
when most of them come from upstream branches — also fine.

**Alternative if you need to keep the stacked diff shape:** create
one meta-branch that contains all the stacked commits, open a single
mega-PR for review, and skip the per-PR ceremony. Not recommended for
reviewable work, but faster for solo development.

---

## Surprise #2 — `pnpm changeset version` computes wrong versions in pre-1.0 lockstep monorepos

### What happened

After Stack 1 + Stack 2 landed and all 8 changesets were in place
(each correctly marked `'@noy-db/core': minor` with one also marking
`'@noy-db/file': minor` for the #100 bundle work), running
`pnpm changeset version` produced:

| Package | Expected | Got |
|---|---|---|
| `@noy-db/core` | `0.6.0` | **`0.6.0`** ✅ |
| `@noy-db/file` | `0.6.0` | `1.0.0` ❌ |
| `@noy-db/memory` | `0.6.0` | `1.0.0` ❌ |
| `@noy-db/dynamo` | `0.6.0` | `1.0.0` ❌ |
| `@noy-db/s3` | `0.6.0` | `1.0.0` ❌ |
| `@noy-db/browser` | `0.6.0` | `1.0.0` ❌ |
| `@noy-db/vue` | `0.6.0` | `1.0.0` ❌ |
| `@noy-db/nuxt` | `0.6.0` | `1.0.0` ❌ |
| `@noy-db/pinia` | `0.6.0` | `1.0.0` ❌ |
| `@noy-db/create` | `0.6.0` | `0.5.1` ❌ |

Nine wrong versions. The adapter packages all jumped to `1.0.0`
(catastrophic — `v1.0` is reserved for the LTS release per ROADMAP.md)
and `@noy-db/create` went to `0.5.1` (patch) because it uses
`workspace:*` not `workspace:^`.

### Diagnosis — a changeset dep-propagation heuristic

`pnpm changeset status` confirmed the decision:

```
Packages to be bumped at minor:
  - @noy-db/core
Packages to be bumped at major:
  - @noy-db/file
  - @noy-db/browser
  - @noy-db/dynamo
  - @noy-db/memory
  - @noy-db/nuxt
  - @noy-db/pinia
  - @noy-db/s3
  - @noy-db/vue
```

The reasoning changeset uses:

1. `@noy-db/core` bumps minor (0.5.0 → 0.6.0), per the explicit
   `'@noy-db/core': minor` declaration
2. The adapters declare `@noy-db/core` in `peerDependencies`
3. Changeset has a hard-coded rule: **when a peer dep minor-bumps,
   the dependent package must major-bump** (because a peer dep
   version change is presumed to be a breaking change for consumers
   of the dependent package)
4. In pre-1.0 semver, `major` means `0.x → 1.0`, not `0.x → 0.(x+1)`
5. Therefore adapter packages jump to `1.0.0`

The `updateInternalDependencies: "patch"` config option does NOT
override this — it sets a *minimum* bump for dep changes, not a
*maximum*.

### Things I tried that did NOT fix it

| Attempt | Result |
|---|---|
| Change adapter peer deps from `workspace:^` → `workspace:*` | No change — the heuristic doesn't inspect constraint looseness |
| Add a `fixed` group in `.changeset/config.json` listing all 10 packages | `fixed` propagates the **highest** bump type to every group member, so with one member computing `major`, all members bump major |
| Add a lockstep meta-changeset declaring every package at `minor` | Changeset takes `max(declared_bump, propagated_bump)` = `max(minor, major)` = `major` |
| Install fresh and re-run | No change — the heuristic is deterministic, not state-dependent |

### What DID work — manual post-version override

1. Run `pnpm changeset version` — lets changeset do the heavy lifting
   of consuming the changeset files, generating CHANGELOG.md entries,
   and updating internal dep references
2. Manually overwrite every wrong version in `package.json` using
   `Edit` tool calls (9 files: file, memory, dynamo, s3, browser, vue,
   nuxt, pinia, create)
3. Manually overwrite every wrong version header in `CHANGELOG.md`
   (same 9 files, `## 1.0.0` → `## 0.6.0`, `## 0.5.1` → `## 0.6.0`)
4. Run `pnpm install` to refresh the workspace lockfile
5. Verify all 10 packages read `0.6.0`
6. Commit as a single `chore: release v0.6.0`

This takes about 5 minutes of tedious but mechanical editing. It
works every time.

### Permanent fix — `workspace:*` in peer dependencies

As part of the v0.6.0 release commit I converted all 8 adapter peer
deps from `workspace:^` to `workspace:*`. This **does not** fix the
changeset heuristic by itself (tested above) — but it does make the
published package constraints permissive enough that consumers can
install any matching version without semver friction, and it pairs
with the next fix to reduce the manual override burden for v0.7.

**Rule going forward:** adapter packages in this monorepo always use
`"@noy-db/core": "workspace:*"` in `peerDependencies`, never
`"workspace:^"`. This is documented in `CLAUDE.md` under the
"Peer-dep convention" section and enforced by code review.

### Longer-term fix — release wrapper script

Next step (not done in v0.6, tracked for v0.7+): write a
`scripts/release.mjs` that runs `pnpm changeset version` and then
automatically normalizes all `@noy-db/*` versions to match
`@noy-db/core`. The script would be deterministic and eliminate the
manual override entirely:

```js
// Sketch — scripts/release.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const corePkg = JSON.parse(
  readFileSync('packages/core/package.json', 'utf8'),
)
const targetVersion = corePkg.version

const pkgDirs = [
  'memory', 'file', 'dynamo', 's3', 'browser',
  'vue', 'nuxt', 'pinia', 'create-noy-db',
]

for (const dir of pkgDirs) {
  const pkgPath = join('packages', dir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (pkg.version !== targetVersion) {
    console.log(`${pkg.name}: ${pkg.version} → ${targetVersion}`)
    pkg.version = targetVersion
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  }
  // Also rewrite CHANGELOG.md header
  const changelogPath = join('packages', dir, 'CHANGELOG.md')
  const changelog = readFileSync(changelogPath, 'utf8')
  const fixed = changelog.replace(
    /^## \d+\.\d+\.\d+$/m,
    `## ${targetVersion}`,
  )
  if (fixed !== changelog) writeFileSync(changelogPath, fixed)
}
```

Wire it into `package.json`:

```json
{
  "scripts": {
    "release:version": "changeset version && node scripts/release.mjs",
    "release:publish": "pnpm install && turbo build --filter='@noy-db/*' && changeset publish"
  }
}
```

Then the runbook becomes `pnpm release:version` + commit + tag +
`pnpm release:publish`, with no manual overrides.

---

## Surprise #3 — independent stack PRs conflict with merged feature stacks

### What happened

`#125` (the `.noydb` container format PR) was deliberately branched
from `main` baseline (`87dbeea`) rather than stacking on the query-DSL
chain, because the container format has zero dependency on joins or
aggregations. The plan was to merge it in parallel — faster for
review, no cross-dependency coupling.

But the query-DSL stack modified the same barrel files (`src/errors.ts`,
`src/index.ts`, `src/query/index.ts`) that `#125` also modified — both
stacks added new error classes and new exports. When #125 was merged
after Stack 1 landed, GitHub reported `CONFLICTING`:

```json
{"mergeStateStatus":"DIRTY","mergeable":"CONFLICTING"}
```

### Recovery — rebase-and-force-push

```bash
git fetch origin main
git checkout feat/v0.6/noydb-container-100
git rebase origin/main
# 3 files conflicted in the barrel exports — resolve by keeping BOTH sets
# of additions (they were structurally disjoint, just textually adjacent)
git add packages/core/src/{errors,index}.ts packages/core/src/query/index.ts
pnpm -F @noy-db/core typecheck
git rebase --continue
pnpm -F @noy-db/core test bundle  # sanity check after rebase
pnpm -F @noy-db/file test bundle
git push --force-with-lease origin feat/v0.6/noydb-container-100
```

Then wait for CI on the rebased #125 (re-triggered by the force push)
and merge normally.

### Fix for the next independent-PR release

Independent PRs are fine — they're faster to review than a
multi-branch chain. But **always rebase them onto `main` right before
merging**, especially if they touch any barrel file. The cheapest
check is `gh pr view <N> --json mergeable,mergeStateStatus` before
the merge command; if it's `DIRTY`/`CONFLICTING`, rebase locally,
force-push, wait for CI, then merge.

A runbook update for v0.7+ should add this pre-merge check to the
final-PR section:

```bash
# Before merging the independent PR, verify it's still mergeable against current main
STATE=$(gh pr view $PR --repo vLannaAi/noy-db --json mergeable --jq .mergeable)
if [ "$STATE" != "MERGEABLE" ]; then
  echo "PR $PR is $STATE — rebase required"
  # ... rebase + force-push flow
fi
```

---

## Other things worth remembering

### Background bash commands with long sleeps will drift

Several `sleep 90 && gh run watch ...` calls moved to background
unexpectedly during the Stack 1 merge sequence. The CI completion
notifications arrived much later (one batch arrived hours after the
release was already published). They were harmless — the information
was obsolete — but they cluttered the notification stream.

**Fix:** don't use background bash for CI-wait loops. Use synchronous
`gh run watch --exit-status` or poll in a short-timeout shell with
`sleep 30` increments that complete before the harness timeout. The
runbook's original `sleep 90 && gh run list` pattern is fine for
short waits, wrong for anything over 60 seconds.

### Tests on main after each merge are worth the time

Every Stack 1 merge was followed by a `gh run watch` for main CI
before the next merge. This added maybe 2-3 minutes per merge (18-21
minutes total for 7 merges) but it was the thing that would have
caught a breaking interaction between PRs *before* it compounded into
the next PR's merge. Nothing broke in this release, so the checks
were "wasted" in the sense that none failed — but skipping them is
an obvious false economy.

### The `_meta/handle` adapter bypass pattern worked as documented

`Compartment.getBundleHandle()` writes its ULID to a reserved
`_meta/handle` envelope using the same "plain JSON inside an empty-IV
envelope" pattern that `_keyring` already uses. No new adapter
contract was needed — the adapter just sees another envelope. This
means cloud adapters (Drive, Dropbox, iCloud, etc. in v0.11) will
automatically pick up the handle without any special cases.

### `compartment.dump()` timestamp races bit the tests twice

`compartment.dump()` regenerates `_exported_at` on every call, so:

```ts
const dumpDirect = await c.dump()
const bundleBytes = await writeNoydbBundle(c)  // calls dump() internally
const result = await readNoydbBundle(bundleBytes)
expect(result.dumpJson).toBe(dumpDirect)  // FLAKY — timestamps differ
```

**Fix:** test the round-trip by parsing the result as JSON and
checking structural fields, OR by comparing two reads of the same
bundle (which IS deterministic). Never compare the bundle's unwrapped
dump to a separate `dump()` call. The v0.6 bundle test suite has
this documented inline.

---

## Runbook corrections for v0.7+

The existing `docs/v0.6/merge-runbook.md` should be copied to
`docs/v0.7/merge-runbook.md` (when v0.7 starts) with these corrections
applied:

1. **Replace the per-merge `gh pr edit --base main` step** with a
   one-shot pre-rebase loop at the top of the stack-1 section.
2. **Add a pre-merge mergeability check** for independent-stack PRs
   (`gh pr view --json mergeable,mergeStateStatus`).
3. **Replace the `pnpm changeset version` step** with either the
   manual-override recipe documented above, or ideally with a
   `pnpm release:version` wrapper script.
4. **Add an explicit "check changeset output is sane" gate** after
   the version step — grep for `"version": "1.0.0"` in any
   `@noy-db/*` package.json and refuse to proceed if found.
5. **Move CI waits from background bash to `gh run watch`** to avoid
   the stale-notification issue.
6. **Add a "post-publish npm verification" step** that runs
   `npm view @noy-db/<pkg> version` in a loop to confirm all 10
   packages are actually live on the registry (not just
   `changeset publish` reporting success).

---

## Conclusion

v0.6.0 shipped successfully despite three release-time surprises that
collectively added ~30 minutes to the planned 65-75 minute window.
Two of the three (stacked PR auto-close, changeset pre-1.0 heuristic)
will recur on every future release unless the runbook and tooling are
updated. The third (independent-stack conflicts) will recur whenever
a parallel PR touches the same barrel files as the main stack.

None of the surprises lost code, corrupted state, or produced a bad
npm release. Recovery was always possible. But the combined effect
was enough friction that the next release MUST start with these fixes
already in place — v0.7 should open with a runbook update and a
`scripts/release.mjs` wrapper as its first two tasks, **before** any
feature work.

---

*Generated 2026-04-09 during the v0.6.0 release window. Author: the
engineer who just finished the release + Claude (Opus 4.6 1M-context)
pair session. Co-author footer on every v0.6 commit.*
