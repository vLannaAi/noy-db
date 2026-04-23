# Pull Request #5 — chore(workflow): governance — PR/issue templates, label catalog, expanded CODEOWNERS

- **State:** MERGED
- **Author:** @vLannaAi
- **Created:** 2026-04-06
- **Merged:** 2026-04-06

- **Branch:** `chore/v0.3-workflow` → `main`
- **Merge commit:** [`4d547c20f7`](../../../../../commit/4d547c20f778745d82c50b1cba040025d814565a)
- **Labels:** _(none)_

---

## Summary

Establishes the OSS workflow for v0.3 development with multiple contributors. No code changes — governance and templates only.

## What's added

### `.github/`
- **`pull_request_template.md`** — summary, closes/part-of, acceptance criteria touched, test plan, **security checklist** required for any PR touching `packages/core/`
- **`ISSUE_TEMPLATE/`** — config (disables blank issues, points security reports to private advisories), `bug.yml`, `feature.yml` (with invariant compliance checkboxes), `epic.yml` (maintainer release tracking)
- **`labels.yml`** — full 28-label catalog covering type, priority, release, area (per package), and status
- **`CODEOWNERS`** — expanded from a single line to per-path ownership including planned v0.3 packages

### Tooling
- **`scripts/sync-labels.sh`** — idempotent label sync via `gh CLI`. Run with `bash scripts/sync-labels.sh` whenever `labels.yml` changes.

### Documentation
- **`CONTRIBUTING.md`** — new \"Workflow\" section documenting issue-driven flow, branch naming conventions per work type, target-branch matrix, merge rules (squash sub-PRs / merge-commit releases), test requirements (≥90% coverage on new packages, type tests required), changeset requirements

## How this enables v0.3

After this lands, the v0.3 release plan will:

1. Create the v0.3 epic + 12 sub-issues using the new templates and labels
2. Branch off `v0.3-dev` (also created after this PR merges)
3. Each contributor follows the workflow in CONTRIBUTING.md
4. Branch protection on `main` and `v0.3-dev` enforces PR review

## Test plan

- [x] Privacy guard clean
- [x] All YAML templates parse (verified by `gh` CLI rendering)
- [x] Label sync script tested locally — idempotent, handles create/update
- [ ] CI lint/typecheck/test/build pass on this branch (no code changes, expected pass)

## Notes for reviewers

- This PR is intentionally **not** for v0.3 features — it's pure workflow setup so the v0.3 epic can be opened immediately after merge.
- The label catalog is intentionally generous (covers v0.4 and v1.0 too) so we don't have to keep editing it as releases progress.
- Branch protection rules need to be configured in repo Settings (manual one-time setup) — see the followup checklist below.

## Follow-up (manual, repo settings)

After merging this PR, configure on GitHub.com:

- [ ] Branch protection on `main`: require PR + 1 approval + status checks (lint, typecheck, test, build, privacy-guard)
- [ ] Branch protection on `v0.3-dev`: same as above; allow direct push by maintainers for integration fixes
- [ ] Run `bash scripts/sync-labels.sh` to push the label catalog
- [ ] Create the v0.3.0 milestone

🤖 Generated with [Claude Code](https://claude.com/claude-code)
