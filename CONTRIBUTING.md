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
- **Release planning** → maintainers open an `epic` issue (e.g., the v0.3 release tracker)

Comment on an issue to claim it before starting work. Maintainers will assign it to you.

### 2. Branch from the right base

| Type of work                     | Base branch     | Branch name                          |
|----------------------------------|-----------------|--------------------------------------|
| Bug fix that ships now           | `main`          | `fix/<short-name>`                   |
| v0.3 feature work                | `v0.3-dev`      | `feat/<short-name>`                  |
| Future-release work              | `<vX.Y>-dev`    | `feat/<short-name>`                  |
| Documentation only               | `main`          | `docs/<short-name>`                  |
| Tooling / CI / refactor          | `main`          | `chore/<short-name>` or `refactor/…` |

```bash
git checkout v0.3-dev && git pull
git checkout -b feat/pinia-store
```

Branch names are kebab-case, scoped by type, descriptive but short. Never use personal names.

### 3. Open a PR against the same base branch

- Target the same base you branched from (don't accidentally PR into `main` from a v0.3-dev branch).
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
