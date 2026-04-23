# Pull Request #2 — chore(release): version packages

- **State:** CLOSED
- **Author:** @vLannaAi
- **Created:** 2026-04-06

- **Closed without merge:** 2026-04-06
- **Branch:** `changeset-release/main` → `main`

- **Labels:** _(none)_

---

This PR was created manually from the changesets action, which could not create it itself due to the repo setting "Allow GitHub Actions to create and approve pull requests" being disabled.

**To fix this permanently:** go to **Settings → Actions → General → Workflow permissions** and check **"Allow GitHub Actions to create and approve pull requests"**. After that, the changesets flow will open these PRs automatically on every changeset push.

## Releases

All `@noy-db/*` packages bumped from `0.1.1` to `0.2.0` (minor bump).

See individual package CHANGELOG.md files for details.

Merging this PR will trigger the release workflow to publish all packages to npm and create a GitHub Release with provenance attestations.
