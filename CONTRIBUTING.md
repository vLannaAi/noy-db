# Contributing to noy-db

Thank you for your interest in contributing to noy-db!

## Development Setup

```bash
# Clone the repository
git clone https://github.com/vLannaAi/noy-db.git
cd noy-db

# Install dependencies (requires pnpm)
pnpm install

# Build all packages
pnpm turbo build

# Run all tests
pnpm turbo test

# Lint
pnpm turbo lint

# Type check
pnpm turbo typecheck
```

## Project Structure

- `packages/` — Published npm packages (`@noy-db/*`)
- `test-harnesses/` — Private test infrastructure (never published)

## Adding a New Adapter

1. Create `packages/{name}/` following the existing adapter structure
2. Implement the `NoydbAdapter` interface (6 methods)
3. Import and run the conformance test suite:

```ts
// packages/{name}/__tests__/conformance.test.ts
import { runAdapterConformanceTests } from '@noy-db/test-adapter-conformance'
import { myAdapter } from '../src/index.js'

runAdapterConformanceTests('my-adapter', async () => myAdapter(/* opts */))
```

4. All 22 conformance tests must pass

## Workflow

NOYDB uses an issue-driven workflow with long-lived feature branches for releases.

### 1. Find or open an issue first

- **Bug reports** → use the bug template
- **Feature requests** → check `ROADMAP.md` first; if not already planned, use the feature template
- **Large designs** → open a [Discussion](https://github.com/vLannaAi/noy-db/discussions) before any code
- **Release planning** → maintainers open an `epic` issue (e.g., the release tracker)

Comment on an issue to claim it before starting work. Maintainers will assign it to you.

### 2. Branch from the right base

| Type of work                     | Base branch     | Branch name                          |
|----------------------------------|-----------------|--------------------------------------|
| Bug fix that ships now           | `main`          | `fix/<short-name>`                   |
| feature work                | `dev`      | `feat/<short-name>`                  |
| Future-release work              | `<vX.Y>-dev`    | `feat/<short-name>`                  |
| Documentation only               | `main`          | `docs/<short-name>`                  |
| Tooling / CI / refactor          | `main`          | `chore/<short-name>` or `refactor/…` |

```bash
git checkout dev && git pull
git checkout -b feat/pinia-store
```

Branch names are kebab-case, scoped by type, descriptive but short. Never use personal names.

### 3. Open a PR against the same base branch

- Target the same base you branched from (don't accidentally PR into `main` from a dev branch).
- Fill in every section of the PR template.
- Mark as draft if WIP.
- Link the issue with `Closes #N` and (for release work) `Part of #<epic>`.

### 4. Merging

- **Sub-PRs into a release branch** → squash merge (one commit per PR keeps the integration branch readable).
- **Release branch into `main`** → merge commit (preserves the per-PR history on main).

### 5. Tests, types, lint

Every PR must pass:

```bash
pnpm turbo lint typecheck test build
pnpm run guard:privacy
```

Plus:

- **New packages** require ≥90% statement coverage and at least one integration test against the in-memory adapter.
- **New public APIs** require unit tests AND type tests (`expect-type` or `tsd`).
- **Touching `packages/core/`** triggers the security checklist in the PR template.

### 6. Changesets

Public-facing changes need a changeset:

```bash
pnpm changeset
```

Pick the bump level (patch/minor/major) per package, write a one-line user-facing summary. CI will block the PR if a public change lands without a changeset.

### 7. Releasing to npm

Releases are **manual and event-driven**. There is no automated "merge to main → publish" path. The procedure is:

1. **On a release branch** (e.g. `release/v0.X.0`), bump every changed package's `version` in its `package.json` to the target version.
2. Generate per-package CHANGELOG entries from the `.changeset/*.md` files (or write them by hand — usually richer that way), then **delete the consumed changesets**.
3. Update `ROADMAP.md` to mark the version as shipped.
4. **Pre-publish smoke test** (non-negotiable — see below).
5. Open a PR against `main`, get CI green, and merge.
6. **Create a GitHub Release** targeting `main` with tag `v0.X.0` and release notes:
   ```bash
   # Stable release → publishes to npm `@latest`
   gh release create v0.X.0 --target main --title "..." --notes "..."

   # Early-adopter release → publishes to npm `@next`
   gh release create v0.X.0 --target main --prerelease --title "..." --notes "..."
   ```
   The **`--prerelease` flag is what flips the dist-tag**: the workflow reads `github.event.release.prerelease` and routes the publish to `@next` when the box is checked, `@latest` when it is not. The chosen tag is echoed in the run summary before any `npm publish` runs, so an unintended target shows up immediately and can be cancelled.
7. Creating the release fires `.github/workflows/release.yml`, which checks out the tag, runs build + test + privacy guard, and publishes every package whose local version is ahead of npm — with provenance attestations via `NPM_CONFIG_PROVENANCE=true`. The workflow's "Resolve npm dist-tag" step is the source of truth — read its summary line in the GitHub Actions UI before authorising any retry.
8. Verify all packages are live: `for pkg in hub to-memory to-file to-browser-idb in-nuxt in-pinia in-vue on-password create-noy-db; do npm view @noy-db/$pkg dist-tags; done`. (Cloud/SQL adapters live in the [noy-db-to](https://github.com/vLannaAi/noy-db-to) companion repo — verify them separately if released together.) The output should list both `latest` and (if applicable) `next` with the version you just shipped. Note that `registry.npmjs.org` may serve a stale CDN cache for first-time package publishes — use `https://registry.npmjs.com/@noy-db/<pkg>` (note `.com`, not `.org`) for the canonical response if you see lingering 404s.
9. **Post-publish dogfood test** — install the public packages into a fresh temp dir and run an end-to-end smoke. Catches CDN issues, metadata bugs, and the rare "published but actually broken" scenario. For an `@next` publish, install with the explicit tag (`pnpm add @noy-db/hub@next`) — the default install path stays on `@latest` and would test the wrong version.

#### When to publish `@latest` vs `@next`

The two dist-tags exist to separate the curated, themed release line from the in-flight line that early-adopter consumers can opt into:

| Channel | When to use | Consumer install command |
|---|---|---|
| **`@latest`** | Themed pre-releases bundling a coherent story (e.g. `0.1.0-pre.5` — three-tier auth). The default install. | `pnpm add @noy-db/hub` |
| **`@next`** | In-flight features published on a tighter cadence so a pilot consumer can pull them ahead of the next themed release. Expect breakage between `@next` versions. | `pnpm add @noy-db/hub@next` |

The version-number sequence is **shared across both channels** — there is no separate "next-only" version line. A `@next` publish at `0.1.0-pre.6-feat.public-envelope.0` is followed by a `@latest` publish at `0.1.0-pre.6` once the work consolidates. Consumers who want the latest stable always type `pnpm add @noy-db/hub` and never have to think about the channel; consumers who want the in-flight code opt in once with `@next` and stay there until they're ready to switch back.

#### Manual workflow_dispatch

The `Release to npm` workflow also exposes a manual dispatch with two inputs:

- `confirm` — must be the literal string `PUBLISH` (typo guard).
- `tag` — npm dist-tag, default `latest`. Allowlist: `latest | next | canary | rc | beta | alpha`. Anything else aborts the publish.

Useful for first-publish, re-publish debugging, or when you want to ship a `canary`/`rc` version without making a full GitHub Release. Same provenance + verification gates as the release-event path.

The release workflow used to also have a changesets-action-driven path (push to main → auto version PR → publish on merge). It was removed after because it raced against the release-event flow and the changesets `linked` config was brittle. **Don't add it back without consensus.**

### 7a. The non-negotiable pre-publish smoke test

**Every release since has been bitten by a bug that only shows up when you install the packed tarballs in a fresh directory.** The workspace's symlinked `node_modules` hides three different classes of bug:

1. **Runtime deps declared as `devDependencies`.** Workspace symlinks make them resolve anyway; a real `npm install` can't find them. (→ patch.)
2. **`workspace:*` in `peerDependencies` publishes as a pinned version string**, not a caret range, so adapter packages refuse to install alongside a newer `@noy-db/core`. (→ patch.)
3. **Missing files in the `files` list.** The workspace sees the source tree; the published tarball doesn't.

The only defense that works is to reproduce the consumer's perspective before publishing. Before merging any release PR:

```bash
# 1. Pack every package that's bumping version
for pkg in packages/core packages/memory packages/pinia; do
  (cd $pkg && pnpm pack)
done

# 2. Install them together in a fresh directory
mkdir /tmp/release-smoke && cd /tmp/release-smoke
npm init -y
npm install /path/to/noy-db-core-X.Y.Z.tgz \
            /path/to/noy-db-memory-X.Y.Z.tgz \
            /path/to/noy-db-pinia-X.Y.Z.tgz

# 3. Run a minimal end-to-end smoke test
cat > smoke.mjs <<'EOF'
import { createNoydb, ref, LedgerStore } from '@noy-db/core'
import { memory } from '@noy-db/memory'
const db = await createNoydb({ adapter: memory(), user: 'smoke', secret: 'abc12345' })
const c = await db.openCompartment('demo')
await c.collection('x').put('1', { id: '1', v: 1 })
console.log('verify:', (await c.ledger().verify()).ok)
db.close()
EOF
node smoke.mjs
```

If the install fails, if an import is missing, if a symbol is `undefined`, or if a feature throws on first use — **fix it and re-pack before merging the release PR**. Every past release that skipped this step needed a patch release within hours.

### 7b. `workspace:*` vs `workspace:^`

Critical distinction for monorepo peer deps:

| Spec | Expands on publish to | Use for |
|---|---|---|
| `workspace:*` | The **exact** current version (`"0.4.1"`) | `dependencies` only |
| `workspace:^` | A caret range (`"^0.4.1"`) | `peerDependencies` — **always** |
| `workspace:~` | A tilde range (`"~0.4.1"`) | Rare |

`workspace:*` in `peerDependencies` pins the consumer to the exact version the workspace was built against. Any consumer that installs a newer compatible version hits `ERESOLVE`. This is the bug that produced →. Use `workspace:^` for peer deps **unconditionally**.

### 8. Starting a new release epic

When kicking off a new release (v0.X.0) that touches multiple packages and spans several PRs:

1. **Create the tracking issue** for the epic with `epic` + `release: v0.X` labels.
2. **Create sub-issues** for each deliverable, assign the epic as their parent (use "Part of #NNN" text until GitHub has real sub-issue support).
3. **Create the GitHub milestone** `v0.X.0` and assign the epic + sub-issues + all subsequent PRs to it. (**We forgot this for and created it retroactively.**)
4. **Create the long-lived release branch** `v0.X-dev` from `main`.
5. **Apply branch protection** to `v0.X-dev` matching the existing `main` protection:
   ```bash
   gh api -X PUT repos/vLannaAi/noy-db/branches/v0.X-dev/protection --input .github/branch-protection.json
   ```
6. Feature PRs target `v0.X-dev`, not `main`. The release PR is the only one that targets `main`.

Following this checklist from day one means no retroactive milestone assignments at the end.

## Pull Request quick rules

- One feature or fix per PR — keep them small and reviewable.
- Run `pnpm turbo lint typecheck test build` locally before requesting review.
- Don't skip pre-commit hooks (`--no-verify`) without maintainer approval.
- Don't `git push --force` on a branch someone else might be reviewing — use `--force-with-lease` if you must rewrite.

## Crypto Rules

- All cryptography uses Web Crypto API (`crypto.subtle`) only
- Never add npm crypto dependencies
- Never reuse IVs — fresh 12-byte random IV per encrypt
- PBKDF2 iterations must stay at 600,000 minimum
- KEK must never be persisted to any storage
