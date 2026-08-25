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
- **Feature requests** → check [`ROADMAP.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/ROADMAP.md) first; if not already planned, use the feature template
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

#### Which packages ship their `CHANGELOG.md` (#1107)

**`@noy-db/hub` does; no other package does.** This is a deliberate decision, recorded here because the previous state was a default nobody had chosen — and it was strong enough to mislead a release decision: `0.6.0-pre.19` was cut partly to get a corrected changelog "into a tarball", by three people, none of whom ran `npm pack`. It had never shipped in any package.

- **hub ships it** because hub is where a format break lands, and someone debugging one has `node_modules` open in front of them, not a browser. At ~500 KB against an already ~11 MB unpacked tarball it is a few percent, and it is the one package whose history is load-bearing.
- **Satellites do not**, because ~50 changelogs that are mostly `Updated dependencies` would be real weight for no debugging value.

If you add a package whose history a consumer would read at a breakpoint, add `CHANGELOG.md` to its `files` and say so here. **Verify with `npm pack` — `files` decides what ships, and reading the repo tells you nothing about the tarball.**

### 7. Releasing to npm

Releases are **manual and event-driven**. There is no automated "merge to main → publish" path. The procedure is:

1. **On a release branch** (e.g. `release/v0.X.0`), bump every changed package's `version` in its `package.json` to the target version.
   - If the release changes what a reader must compute to open an envelope (the AAD tuple, its encoding, or the scheme label), `NOYDB_ENVELOPE_GENERATION` must move with it (#1207). `__tests__/envelope-generation.test.ts` pins the generation to the emitted AAD bytes, so a scheme change without a generation decision fails CI — this line exists so the failure is met as a checklist item, not a surprise.
2. Generate per-package CHANGELOG entries from the `.changeset/*.md` files (or write them by hand — usually richer that way), then **delete the consumed changesets**.
3. Update [`ROADMAP.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/ROADMAP.md) (in `noy-db-docs`) to mark the version as shipped.
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
10. **Clear the ship gap** — every issue fixed on `main` since the last release carries `status: awaiting-release` (added at merge; it marks the closed-but-unpublished window that GitHub itself cannot express). Now that the fix is live on npm, remove the label from the issues this release shipped:
   ```bash
   # review what this release closes, then clear each
   gh issue list --repo vLannaAi/noy-db --state closed --label "status: awaiting-release" --json number,title
   gh issue edit <N> --repo vLannaAi/noy-db --remove-label "status: awaiting-release"
   ```
   A leftover `status: awaiting-release` on an already-published issue is the one way this label lies — clearing it here is what keeps it honest.

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

**Releases have repeatedly been bitten by bugs that only show up when you install the packed tarballs in a fresh directory.** The workspace's symlinked `node_modules` hides several classes of bug:

1. **Runtime deps declared as `devDependencies`.** Workspace symlinks make them resolve anyway; a real `npm install` can't find them.
2. **Missing files in the `files` list.** The workspace sees the source tree; the published tarball doesn't.
3. **A new subpath that resolves in-repo but not from the tarball** — an `exports` entry pointing at a path the `files` list never ships, or a build entry that was never added. The workspace resolves it through source; a consumer gets `ERR_PACKAGE_PATH_NOT_EXPORTED`.

> Note: satellites publishing an **exact** peer pin on `@noy-db/hub` is *intended* under lockstep, not one of these bugs — read **7b** below before "fixing" it.

The only defense that works is to reproduce the consumer's perspective before publishing. Before merging any release PR:

```bash
# 0. Build first — pnpm pack ships dist/, not src/.
pnpm turbo build

# 1. Pack the packages under test. ALWAYS include `attestation`: hub depends
#    on it via `workspace:*`, which publishes as an exact version, so a
#    pre-publish install fails with ETARGET (that version isn't on npm yet)
#    unless you hand npm the tarball too.
mkdir -p /tmp/release-smoke/tgz
for pkg in hub attestation to-memory to-file; do
  (cd packages/$pkg && pnpm pack --pack-destination /tmp/release-smoke/tgz)
done

# 2. Install them together in a fresh directory, with npm — not pnpm, and not
#    the workspace. This is the whole point: reproduce a consumer's resolver.
cd /tmp/release-smoke && npm init -y
npm install ./tgz/*.tgz

# 3. Run an end-to-end smoke test. Exercise whatever this release actually
#    changed — a new subpath especially, since the exports map + `files` list
#    are exactly what the workspace hides.
cat > smoke.mjs <<'EOF'
import { createNoydb } from '@noy-db/hub'
import { toMemory } from '@noy-db/to-memory'

const db = await createNoydb({ store: toMemory(), user: 'smoke', secret: 'smoke-pw-long-enough' })
const v = await db.openVault('demo')
await v.collection('x').put('1', { id: '1', total: 120 })
console.log('round-trip:', (await v.collection('x').get('1'))?.total === 120)
db.close()
EOF
node smoke.mjs
```

If the install fails, if an import is missing, if a symbol is `undefined`, or if a feature throws on first use — **fix it and re-pack before merging the release PR**. Every past release that skipped this step needed a patch release within hours.

### 7b. `workspace:*` vs `workspace:^` — and why this repo uses `workspace:*`

How each spec expands when pnpm publishes:

| Spec | Expands on publish to |
|---|---|
| `workspace:*` | The **exact** current version (`"0.4.1"`) |
| `workspace:^` | A caret range (`"^0.4.1"`) |
| `workspace:~` | A tilde range (`"~0.4.1"`) |

**The rule here: every satellite declares `peerDependencies['@noy-db/hub'] = "workspace:*"` — never `workspace:^`, and never in `dependencies`.** This is not a style preference; `scripts/check-architecture.mjs`'s `peer-deps` check fails the build on anything else, so a "fix" to `workspace:^` will not merge.

**Why, given the general advice says the opposite.** In a typical monorepo `workspace:^` is right for peer deps, because an exact pin stops a consumer from taking a newer compatible version. That advice assumes a repo whose packages version independently. This one does not:

- **`workspace:^` trips the changesets pre-1.0 dep-propagation heuristic**, forcing unintended major bumps on every dependent (the reason recorded on the guard itself). Changesets misbehaves on `0.x` lines here in more than one way — `scripts/release.mjs` exists to undo a sibling symptom, where a normal `changeset version` run tries to jump all 51 packages to `1.0.0`.
- **Releases are lockstep.** All 51 `@noy-db/*` packages ship at one version, together, from one release. There is no supported install that mixes `@noy-db/to-memory@0.4.0-pre.12` with a different hub version, so a range would advertise flexibility the release line does not actually offer.

**The consequence, stated plainly.** Satellites publish an exact pin. Verified on `0.4.0-pre.12`:

```jsonc
// node_modules/@noy-db/to-memory/package.json, installed from npm
"peerDependencies": { "@noy-db/hub": "0.4.0-pre.12" }
```

So a consumer who bumps `@noy-db/hub` without bumping its satellites hits `ERESOLVE`. **That is the intended signal, not a defect** — under lockstep, a hub upgrade *is* a whole-family upgrade. Upgrade them together.

**When to revisit:** at `1.0`, where the changesets pre-1.0 heuristic no longer applies. If the family ever moves off lockstep to independent version lines, `workspace:^` becomes correct and the guard should change with it. Until then, the guard and this section agree, and both override the generic advice.

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
