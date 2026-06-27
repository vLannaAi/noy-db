# `noy-db-to` Scaffold (Step 1a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Create a new sibling repo `/Users/vicio/lanna-db/noy-db-to` — a verifiable, empty-of-stores skeleton that establishes the conventions for the 16 non-essential storage adapters that will land in it: flat `to-*` layout, `@noy-db/hub` bound as a published **peer range** (the klum-db model), a sibling architecture guard enforcing the seam, and a gated multi-package release workflow.

**Architecture:** A pnpm workspace (`packages: ['to-*']`) using recursive pnpm scripts (no turbo). Per-store packages will peer `@noy-db/hub` at `^0.2.x` and import the contract only from `@noy-db/hub/adapter`. Mirrors `klum-db`'s gated `release.yml` (adapted to `pnpm -r publish`), `.npmrc`, `eslint`/`tsconfig`/`tsup`/`vitest` conventions. This plan creates **no stores** — Step 1b (a separate plan) relocates them.

**Tech Stack:** pnpm 9.15.4, vitest, tsup, TypeScript strict, ESM-only, Node `>=22`.

**Parent spec:** `docs/superpowers/specs/2026-06-27-extract-stores-to-noy-db-to-design.md` (Step 1, extraction).

## Global Constraints

- **No Claude/Anthropic attribution** in commits, PRs, docs, CHANGELOGs (no `Co-Authored-By: Claude` / "Generated with Claude" footer).
- **Never reference the private pilot client by name** — grep the diff before every commit.
- **Never publish** without explicit user confirmation. This plan does NOT publish; `release.yml` is only authored, never run.
- **ESM-only, Node `>=22`.** Match the family's completed ESM/Node-22 upgrade. CI matrix `['22','24']`.
- **The repo is `/Users/vicio/lanna-db/noy-db-to`** — a NEW git repo (sibling of noy-db, klum-db), git-init'd in Task 1. It is OUTSIDE the noy-db repo. All work happens there.
- **Cross-repo seam:** every store (later) peers `@noy-db/hub` at a **range** (never `workspace:*`) and imports only `@noy-db/hub/adapter`. The guard enforces this.
- **Verify before claiming done:** every "run" step must actually run and its output be observed.
- **Templates live in siblings:** copy from `/Users/vicio/lanna-db/klum-db/...` where indicated, then apply the listed edits.

---

### Task 1: Repo skeleton + root configs

**Files (all under `/Users/vicio/lanna-db/noy-db-to/`):**
- Create: `.gitignore`, `.npmrc`, `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `eslint.config.mjs`, `vitest.config.ts`
- Action: `git init`

**Interfaces:**
- Produces: a pnpm workspace skeleton with `build`/`test`/`lint`/`typecheck`/`check:architecture` scripts. Tasks 2–3 add the guard and workflows.

- [ ] **Step 1: Create the repo and directory**

```bash
mkdir -p /Users/vicio/lanna-db/noy-db-to
cd /Users/vicio/lanna-db/noy-db-to
git init
git checkout -b main 2>/dev/null || git branch -M main
```

- [ ] **Step 2: `.gitignore`**

```
node_modules
dist
.turbo
*.log
.DS_Store
.superpowers/sdd
```

- [ ] **Step 3: `.npmrc`** (verbatim from klum-db — required for prerelease peer resolution)

```
engine-strict=true
auto-install-peers=true
strict-peer-dependencies=false
```

- [ ] **Step 4: `pnpm-workspace.yaml`**

```yaml
packages:
  - "to-*"
```

- [ ] **Step 5: Root `package.json`**

```json
{
  "name": "noy-db-to",
  "version": "0.2.0-pre.0",
  "private": true,
  "description": "Extended storage adapters for noy-db — the non-essential to-* family (cloud, server, remote-fs), bound to the published @noy-db/hub/adapter seam.",
  "license": "MIT",
  "author": "vLannaAi <vicio@lanna.ai>",
  "type": "module",
  "packageManager": "pnpm@9.15.4",
  "engines": {
    "node": ">=22.0.0"
  },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "check:architecture": "node scripts/check-architecture.mjs"
  },
  "devDependencies": {
    "@eslint/js": "^9.18.0",
    "@types/node": "^22.0.0",
    "eslint": "^9.18.0",
    "tsup": "^8.4.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.21.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 6: `tsconfig.base.json`** (copy noy-db's base; satellites will extend `../tsconfig.base.json`)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "resolveJsonModule": true
  }
}
```

- [ ] **Step 7: `eslint.config.mjs`** — copy klum-db's verbatim:

```bash
cp /Users/vicio/lanna-db/klum-db/eslint.config.mjs /Users/vicio/lanna-db/noy-db-to/eslint.config.mjs
```
Then change the leading comment's package name from `@klum-db/lobby` to `noy-db-to` (the rule set is identical and correct for store adapters). No rule changes.

- [ ] **Step 8: Root `vitest.config.ts`** (multi-package projects glob)

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['to-*/vitest.config.ts'],
  },
})
```

- [ ] **Step 9: Install and verify the empty workspace resolves**

```bash
cd /Users/vicio/lanna-db/noy-db-to
pnpm install
pnpm -r ls --depth -1   # zero workspace packages yet — must exit 0, no error
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('root package.json valid')"
```
Expected: `pnpm install` succeeds (creates lockfile); recursive ls runs cleanly with no packages.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: scaffold noy-db-to workspace skeleton (pnpm, eslint, tsconfig, vitest)"
```

---

### Task 2: Sibling architecture guard + self-test

**Files:**
- Create: `scripts/check-architecture.mjs`
- Create: `scripts/__tests__/check-architecture.test.ts`
- Create fixtures: `scripts/__tests__/fixtures/compliant/to-good/package.json`, `.../to-good/src/index.ts`; `scripts/__tests__/fixtures/violating/to-bad/package.json`, `.../to-bad/src/index.ts`
- Create: `scripts/__tests__/vitest.config.ts` (so the root `to-*` glob doesn't try to run this; see Step note)

**Interfaces:**
- Consumes: nothing external.
- Produces: `pnpm check:architecture` enforcing (1) `@noy-db/hub` is a peer **range** (not `workspace:*`, not in deps), (2) store src imports `@noy-db/hub` only via `/adapter`, (3) no npm crypto deps. The script honors an `ARCH_ROOT` env override so it can be tested against fixtures.

- [ ] **Step 1: Write the guard self-test (failing — script doesn't exist yet)**

```typescript
// scripts/__tests__/check-architecture.test.ts
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(here, '..', 'check-architecture.mjs')
const COMPLIANT = join(here, 'fixtures', 'compliant')
const VIOLATING = join(here, 'fixtures', 'violating')

function run(root: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', [SCRIPT], {
      env: { ...process.env, ARCH_ROOT: root },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe('noy-db-to architecture guard', () => {
  it('passes a compliant store (peer range + /adapter import)', () => {
    const { code } = run(COMPLIANT)
    expect(code).toBe(0)
  })

  it('fails a store that peers workspace:* and imports the main barrel', () => {
    const { code, out } = run(VIOLATING)
    expect(code).toBe(1)
    expect(out).toContain('hub-peer-range')
    expect(out).toContain('adapter-only')
  })
})
```

- [ ] **Step 2: Create fixtures**

`scripts/__tests__/fixtures/compliant/to-good/package.json`:
```json
{
  "name": "@noy-db/to-good",
  "version": "0.2.0-pre.0",
  "peerDependencies": { "@noy-db/hub": "^0.2.0-pre.31" }
}
```
`scripts/__tests__/fixtures/compliant/to-good/src/index.ts`:
```typescript
import type { NoydbStore } from '@noy-db/hub/adapter'
export const good = null as unknown as NoydbStore
```
`scripts/__tests__/fixtures/violating/to-bad/package.json`:
```json
{
  "name": "@noy-db/to-bad",
  "version": "0.2.0-pre.0",
  "peerDependencies": { "@noy-db/hub": "workspace:*" }
}
```
`scripts/__tests__/fixtures/violating/to-bad/src/index.ts`:
```typescript
import type { NoydbStore } from '@noy-db/hub'
export const bad = null as unknown as NoydbStore
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd /Users/vicio/lanna-db/noy-db-to
pnpm vitest run scripts/__tests__/check-architecture.test.ts
```
Expected: FAIL — `check-architecture.mjs` does not exist (`Cannot find module`).

- [ ] **Step 4: Write the guard**

```javascript
// scripts/check-architecture.mjs
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// ARCH_ROOT lets the self-test point the scan at a fixtures dir; default is
// the repo root (one level up from scripts/).
const ROOT = process.env.ARCH_ROOT
  ? resolve(process.env.ARCH_ROOT)
  : resolve(fileURLToPath(import.meta.url), '../..')

let failures = 0
function fail(rule, msg, where) {
  failures++
  console.error(`✗ [${rule}] ${msg}${where ? ` (${relative(ROOT, where)})` : ''}`)
}

// Stores are flat at the repo root: directories named `to-*` with a package.json.
function listStoreDirs() {
  if (!existsSync(ROOT)) return []
  return readdirSync(ROOT)
    .filter(name => name.startsWith('to-'))
    .map(name => join(ROOT, name))
    .filter(p => statSync(p).isDirectory())
    .filter(p => existsSync(join(p, 'package.json')))
}

function readPkg(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
}

function walkTs(dir, cb) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walkTs(p, cb)
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) cb(p, readFileSync(p, 'utf8'))
  }
}

// Rule 1 — hub-peer-range: @noy-db/hub must be a peerDependency at a published
// RANGE; never in dependencies, never a workspace: specifier.
function checkHubPeerRange() {
  for (const dir of listStoreDirs()) {
    const pj = readPkg(dir)
    const dep = pj.dependencies?.['@noy-db/hub']
    const peer = pj.peerDependencies?.['@noy-db/hub']
    if (dep !== undefined)
      fail('hub-peer-range', `${pj.name} has @noy-db/hub in dependencies; it must be a peerDependency range.`, dir)
    if (peer === undefined)
      fail('hub-peer-range', `${pj.name} is missing peerDependencies['@noy-db/hub'].`, dir)
    else if (peer.startsWith('workspace:'))
      fail('hub-peer-range', `${pj.name} peers @noy-db/hub as "${peer}"; cross-repo stores must use a published range (e.g. "^0.2.0-pre.31").`, dir)
    else if (!/^[\^~]?\d/.test(peer))
      fail('hub-peer-range', `${pj.name} peers @noy-db/hub as "${peer}"; expected a semver range.`, dir)
  }
}

// Rule 2 — adapter-only: store src may import @noy-db/hub ONLY via /adapter.
const HUB_IMPORT_RE = /from\s+['"]@noy-db\/hub(\/[^'"]*)?['"]/g
function checkAdapterOnly() {
  for (const dir of listStoreDirs()) {
    const pj = readPkg(dir)
    walkTs(join(dir, 'src'), (file, code) => {
      let m
      const re = new RegExp(HUB_IMPORT_RE.source, 'g')
      while ((m = re.exec(code)) !== null) {
        const sub = m[1] ?? ''
        if (sub !== '/adapter')
          fail('adapter-only', `${pj.name}: imports '@noy-db/hub${sub}' — stores must import only '@noy-db/hub/adapter'.`, file)
      }
    })
  }
}

// Rule 3 — no-crypto-deps: zero npm crypto packages (stores see ciphertext only).
const BANNED = new Set(['crypto-js', 'node-forge', 'tweetnacl', 'bcryptjs', 'bcrypt'])
function checkNoCryptoDeps() {
  for (const dir of listStoreDirs()) {
    const pj = readPkg(dir)
    for (const block of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const name of Object.keys(pj[block] ?? {})) {
        if (BANNED.has(name) || name.startsWith('@noble/') || name.startsWith('@scure/'))
          fail('no-crypto-deps', `${pj.name} depends on crypto package "${name}"; stores see ciphertext only — use @noy-db/hub.`, dir)
      }
    }
  }
}

checkHubPeerRange()
checkAdapterOnly()
checkNoCryptoDeps()

if (failures > 0) {
  console.error(`\n✗ Architecture invariants FAILED (${failures})`)
  process.exit(1)
}
console.log('✓ Architecture invariants OK')
```

- [ ] **Step 5: Keep the fixtures out of the root vitest run**

The root `vitest.config.ts` globs `to-*/vitest.config.ts`, so it will NOT pick up the fixtures (they live under `scripts/__tests__/fixtures/`, not `to-*/`). But the guard test itself (`scripts/__tests__/check-architecture.test.ts`) must be runnable. Add `scripts` as a vitest project so `pnpm test` includes it. Update root `vitest.config.ts` to:

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'to-*/vitest.config.ts',
      {
        test: {
          name: 'scripts',
          root: './scripts',
          include: ['__tests__/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
})
```
(Note: the `scripts` project's `include` is scoped to `__tests__/**/*.test.ts`; the fixture `.ts` files are not test files and are ignored.)

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd /Users/vicio/lanna-db/noy-db-to
pnpm vitest run --project scripts
pnpm check:architecture   # runs against the real (store-less) root → trivially OK
```
Expected: both guard tests PASS; `check:architecture` prints `✓ Architecture invariants OK`.

- [ ] **Step 7: Lint + typecheck the script**

```bash
cd /Users/vicio/lanna-db/noy-db-to
pnpm exec eslint scripts/ || true   # .mjs is ignored by eslint config; expect no errors
pnpm exec tsc --noEmit -p tsconfig.base.json 2>/dev/null || echo "no root tsconfig include — ok (per-package typecheck covers src)"
```
Expected: no eslint errors on the test file.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(guard): sibling architecture guard — hub peer-range + adapter-only + no-crypto, with fixtures self-test"
```

---

### Task 3: CI + release workflows, CLAUDE.md, README; final verification

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- Create: `CLAUDE.md`, `README.md`, `LICENSE`

**Interfaces:**
- Produces: a gated, provenance-enabled multi-package release workflow and a CI workflow (Node 22/24) that runs `check:architecture` → lint/typecheck → build → test. CLAUDE.md documents the seam, peer-range, and hard constraints.

- [ ] **Step 1: `ci.yml`** — copy klum-db's and apply edits:

```bash
cp /Users/vicio/lanna-db/klum-db/.github/workflows/ci.yml /Users/vicio/lanna-db/noy-db-to/.github/workflows/ci.yml
```
Edits:
1. In the `quality` job, add a first step before Lint: a `check:architecture` run. Insert after the `Install` step:
   ```yaml
      - name: Architecture invariants
        run: pnpm check:architecture
   ```
2. Change the test matrix from `node: ['20', '22']` to `node: ['22', '24']` (the family's new floor).
3. Update the leading comment to describe noy-db-to (multi-package storage adapters) instead of the single-package lobby.

- [ ] **Step 2: `release.yml`** — copy klum-db's and apply edits:

```bash
cp /Users/vicio/lanna-db/klum-db/.github/workflows/release.yml /Users/vicio/lanna-db/noy-db-to/.github/workflows/release.yml
```
Edits (keep the entire gating/structure — `verify` gate, explicit `confirm: PUBLISH`, `--provenance`, dist-tag routing — unchanged):
1. Replace every `@klum-db/lobby` mention (comments, summary text) with `noy-db-to storage adapters`.
2. In the `verify` job's "Verify package.json version matches release tag" step, read the ROOT package.json version (it is the canonical lockstep version):
   ```yaml
          PKG_VERSION=$(node -p "require('./package.json').version")
   ```
   (unchanged from klum-db — root package.json is the version source.)
3. In the `publish` job, replace the single-package `pnpm publish ...` step with a **recursive** publish over the `@noy-db/*` stores:
   ```yaml
      - name: Publish stores
        run: |
          set -o pipefail
          echo "Publishing @noy-db/to-* with --tag ${{ steps.dist_tag.outputs.tag }}"
          pnpm -r publish \
            --access public \
            --tag '${{ steps.dist_tag.outputs.tag }}' \
            --no-git-checks \
            --provenance 2>&1 | tee /tmp/publish.log
          EXIT=${PIPESTATUS[0]}
          if [ "$EXIT" -ne 0 ]; then
            echo "### Publish failed" >> "$GITHUB_STEP_SUMMARY"
            echo '```' >> "$GITHUB_STEP_SUMMARY"; cat /tmp/publish.log >> "$GITHUB_STEP_SUMMARY"; echo '```' >> "$GITHUB_STEP_SUMMARY"
          fi
          exit "$EXIT"
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
   ```
4. Add a `Build` already exists in the publish job (keep it as `pnpm build`, which is `pnpm -r build`). Keep the `Resolve npm dist-tag` and `whoami` steps unchanged.
5. Change the matrix/Node in both jobs to `node-version: '22'`.

- [ ] **Step 3: Validate both workflow YAML files parse**

```bash
cd /Users/vicio/lanna-db/noy-db-to
node -e "const yaml=require('node:fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!yaml.includes('check:architecture')) throw new Error('ci missing arch step'); console.log('ci.yml ok')"
pnpm dlx js-yaml .github/workflows/ci.yml > /dev/null && echo "ci.yml valid YAML"
pnpm dlx js-yaml .github/workflows/release.yml > /dev/null && echo "release.yml valid YAML"
```
Expected: both parse; ci.yml contains the architecture step. (If `js-yaml` dlx is unavailable offline, fall back to: `node -e "require('node:fs').readFileSync('.github/workflows/release.yml','utf8')"` and a manual structural read.)

- [ ] **Step 4: `LICENSE`** — copy from klum-db (same MIT, same author):

```bash
cp /Users/vicio/lanna-db/klum-db/LICENSE /Users/vicio/lanna-db/noy-db-to/LICENSE
```

- [ ] **Step 5: `CLAUDE.md`** — model on klum-db's structure. Write:

```markdown
# CLAUDE.md — noy-db-to

> Part of the `lanna-db` working directory (a folder of independent repos, NOT a repo itself).
> The family-level `../CLAUDE.md` covers the cross-repo map. This file is everything you need
> for working inside `noy-db-to`.

## What this is

`noy-db-to` holds the **non-essential storage adapters** for noy-db — the cloud / server /
remote-filesystem `to-*` family extracted from the noy-db monorepo. The essential, default stores
(`to-memory`, `to-file`, `to-browser-idb`, `to-probe`, `to-meter`) stay in `noy-db`; everything
else lives here. Every adapter is a thin, ciphertext-only `NoydbStore` implementation.

## Architecture boundary — ONE WAY, via the published seam

Each store binds **only** to the published `@noy-db/hub/adapter` subpath (the `NoydbStore` contract +
envelope/snapshot/op types + store errors) — never hub internals, never the main barrel. `@noy-db/hub`
is a **peerDependency at a range** (`^0.2.x`), never a `workspace:*` link. A noy-db release only forces
a rebuild here when the adapter contract changes. `scripts/check-architecture.mjs` enforces this
mechanically (hub-peer-range, adapter-only, no-crypto-deps).

## Build / test

\`\`\`bash
pnpm install
pnpm build        # pnpm -r build (tsup, ESM-only)
pnpm test         # pnpm -r test (vitest) — runs the adapter-conformance kit against PUBLISHED @noy-db/hub
pnpm lint && pnpm typecheck
pnpm check:architecture
\`\`\`

Tests run against the **published** `@noy-db/hub` + `@noy-db/test-adapter-conformance` (peer range +
exact dev pin), validating the seam across the real published-package boundary — the klum-db model.

## Conventions

- **ESM-only, Node `>=22`.** TDD; each store passes the published `@noy-db/test-adapter-conformance` suite.
- **Independent versioning** from noy-db — this repo bumps its own `0.2.0-pre.N` (lockstep across its stores).
- **Stores see ciphertext only** — no crypto deps; the hub encrypts before any store is called.

## Publishing — THIS repo is the publish source for the moved `@noy-db/to-*`

Publishing runs via `.github/workflows/release.yml`: create a GitHub Release (or `workflow_dispatch`
with `confirm: PUBLISH`); the `verify` gate (install + arch + build + lint + typecheck + test +
version↔tag) must pass before `pnpm -r publish --provenance` runs. A plain push to `release.yml` runs
verify only — never publishes. Pre-release checkbox → `@next`; unmarked → `@latest`.

## Hard constraints (always)

- **Never** add Claude/Anthropic attribution to commits, PRs, release notes, or CHANGELOGs.
- **Never** reference the private pilot client by name; grep the diff before every commit/publish.
- **Never** publish (or run a publish-adjacent command) without explicit user confirmation.
```

- [ ] **Step 6: `README.md`** — short public intro:

```markdown
# noy-db-to

Extended storage adapters for [noy-db](https://github.com/vLannaAi/noy-db) — the non-essential
`to-*` family (cloud, server, remote filesystem). Each adapter is a thin, zero-knowledge
`NoydbStore` implementation bound to the published `@noy-db/hub/adapter` contract; the hub encrypts
before any adapter is called, so stores only ever see ciphertext.

The essential default stores (`to-memory`, `to-file`, `to-browser-idb`) ship from the `noy-db`
core repo. Install only the adapter you need, e.g. `pnpm add @noy-db/to-aws-s3 @noy-db/hub`.
```

- [ ] **Step 7: Grep for the client name, then final verification**

```bash
cd /Users/vicio/lanna-db/noy-db-to
grep -rni "<pilot-client-name>" . --exclude-dir=node_modules && echo "STOP: client name present" || echo "clean"
pnpm install
pnpm check:architecture
pnpm vitest run --project scripts
```
Expected: clean; `check:architecture` OK; guard tests pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "ci+docs: gated multi-package release.yml, CI (node 22/24), CLAUDE.md, README"
```

---

## Self-review (against the spec)

- **D3 (seam):** guard enforces `adapter-only` (imports only `@noy-db/hub/adapter`). ✓
- **D4 (versioning):** peer-range enforced by `hub-peer-range`; root carries the lockstep version; release.yml checks version↔tag. ✓
- **D6 (sibling guard):** `scripts/check-architecture.mjs` is the noy-db-to twin (range-peer + adapter-only + no-crypto). ✓
- **D7 (CI):** ci.yml runs arch → quality → build → test on Node 22/24. ✓
- **D8 (release):** klum-db's gated, provenance, user-confirmed model, adapted to `pnpm -r publish`. Never auto-publishes. ✓
- **Scope:** no stores created (that's Step 1b); skeleton is verifiable via the guard self-test. ✓
- **Deferred to Step 1b:** the published-`@noy-db/hub`-with-`/adapter` dependency only bites when stores land — noted as the Step-1b gate (needs a noy-db release after #492). Not required for this scaffold.

## Next (separate plans)

- **Step 1b — Relocate** the 16 non-essential stores into `noy-db-to` in batches (migrate imports to `@noy-db/hub/adapter`, peer range + dev pin, conformance against published hub), rewrite `to-nfs` fresh, drop them from noy-db's release set. **Gate:** a published `@noy-db/hub@^0.2.0-pre.31` (post-#492) that includes the `/adapter` subpath.
- **Step 2 — Reorg** noy-db into family folders (now over a stable package set).
