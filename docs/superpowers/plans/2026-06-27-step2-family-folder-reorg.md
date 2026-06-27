# Step 2 — Family-folder reorg of noy-db (`packages/<family>/<pkg>`)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Reorganize the now-stable noy-db monorepo so each satellite lives under a family folder — `packages/to/`, `in/`, `on/`, `as/`, `by/`, `at/` — while package NAMES stay flat (`@noy-db/to-memory`, etc.). This is the original "P1", deferred to last so it runs over a *stable* package set (post store-extraction). Pure filesystem + reference reorganization; no behavior change.

**Architecture:** Tooling is made two-level-aware first (backward-compatible), then all 47 prefixed packages are `git mv`'d into family folders and every path reference is fixed. The 4 non-prefixed packages (`hub`, `cli`, `create-noy-db`, `attestation`) stay at `packages/` root. Toolchain keys on package *names* (pnpm workspace glob, turbo, changesets), so the moves are mostly transparent — the work is in the handful of *path*-bearing references.

**Tech Stack:** pnpm + turbo, vitest, tsup, TypeScript strict, ESM-only, Node ≥22.

**Parent spec:** `docs/superpowers/specs/2026-06-27-extract-stores-to-noy-db-to-design.md` (decision D2 — folder convention).

## Global Constraints

- No Claude/Anthropic attribution; no client/company name (grep before commit). Never publish.
- ESM-only, Node ≥22. Build hub with `NODE_OPTIONS=--max-old-space-size=8192` (DTS OOM).
- **Branch:** `feat/family-folders` in `/Users/vicio/lanna-db/noy-db` (already created off post-extraction `main`).
- **Directory basename == package short name** (`to/to-memory`, `in/in-react`). Family grouping folder ONLY for multi-package families (noy-db is multi-family).
- **The 47 packages that MOVE** (by family):
  - `to/` (5): to-browser-idb, to-file, to-memory, to-meter, to-probe
  - `in/` (15): in-ai, in-devtools, in-devtools-tui, in-nextjs, in-nuxt, in-pinia, in-react, in-rest, in-solid, in-svelte, in-tanstack-query, in-tanstack-table, in-vue, in-yjs, in-zustand
  - `on/` (10): on-email-otp, on-magic-link, on-oidc, on-password, on-pin, on-recovery, on-shamir, on-threat, on-totp, on-webauthn
  - `as/` (10): as-aws-s3, as-blob, as-csv, as-json, as-ndjson, as-noydb, as-sql, as-xlsx, as-xml, as-zip
  - `by/` (2): by-peer, by-tabs
  - `at/` (5): at-aws-kms, at-azure-keyvault, at-env, at-gcp-kms, at-macos-keychain
- **STAY at `packages/` root** (do NOT move): `hub`, `cli`, `create-noy-db`, `attestation`. (`lobby/` is an untracked stub — ignore.)
- Verify before claiming done.

---

### Task 1: Make the tooling two-level-aware (backward-compatible)

These changes support BOTH the current flat layout AND `packages/<family>/<pkg>`, so the repo stays green before any move. **Files:** `pnpm-workspace.yaml`, `vitest.config.ts`, `scripts/check-architecture.mjs`, `scripts/release.mjs`, `scripts/strip-version-comments.mjs`.

- [ ] **Step 1: `pnpm-workspace.yaml`** — add `packages/*/*` alongside `packages/*`:
```yaml
packages:
  - "packages/*"
  - "packages/*/*"
  - "test-harnesses/*"
  - "playground"
  - "playground/cli"
  - "playground/nuxt"
  - "showcases"
  - "recipes/*"
```

- [ ] **Step 2: `vitest.config.ts`** — add the two-level project glob:
```typescript
    projects: [
      'packages/*/vitest.config.ts',
      'packages/*/*/vitest.config.ts',
      'test-harnesses/*/vitest.config.ts',
      'recipes/*/vitest.config.ts',
    ],
```

- [ ] **Step 3: `scripts/check-architecture.mjs` — `listPackageDirs()` recurses one level into family folders.** Replace the function so it returns root-level packages (have `package.json`) AND packages nested one level inside family folders. Skip `node_modules`/`dist`:
```javascript
function listPackageDirs() {
  const out = []
  for (const entry of readdirSync(PACKAGES_DIR)) {
    if (entry === 'node_modules') continue
    const p = join(PACKAGES_DIR, entry)
    if (!statSync(p).isDirectory()) continue
    if (existsSync(join(p, 'package.json'))) { out.push(p); continue }       // root-level pkg (hub, cli, …)
    for (const child of readdirSync(p)) {                                     // family folder → its members
      if (child === 'node_modules' || child === 'dist') continue
      const cp = join(p, child)
      if (statSync(cp).isDirectory() && existsSync(join(cp, 'package.json'))) out.push(cp)
    }
  }
  return out
}
```
Leave the hardcoded `packages/hub/...` paths (KERNEL_SURFACE_BUDGET, STRATEGY_OPT_IN_EXEMPT) as-is — hub stays at root.

- [ ] **Step 4: `scripts/release.mjs`** — its `readdirSync(packagesDir)` walk (around lines 67–71) is one-level. Make it recurse one level into family folders the same way (a dir without a `package.json` is a family folder → include its children). Mirror the `listPackageDirs` recursion; keep the existing exclusions (`typescript-config`, `test-adapter-conformance`) and the hardcoded `packages/hub/package.json` read (hub stays root). Read the file and adapt the discovery to emit the full package dir paths.

- [ ] **Step 5: `scripts/strip-version-comments.mjs`** — broaden the find glob `-path 'packages/*/src'` to also match `packages/*/*/src`:
```javascript
`find packages -type d -name node_modules -prune -o \\( -path 'packages/*/src' -o -path 'packages/*/*/src' \\) -prune -print`
```

- [ ] **Step 6: Verify the FLAT layout still works (nothing moved yet)**
```bash
cd /Users/vicio/lanna-db/noy-db
pnpm install
pnpm check:architecture          # must still find all packages + pass (flat)
node -e "const {execSync}=require('node:child_process'); process.exit(0)"   # (release.mjs sanity is exercised post-move in T2)
```
Expected: install clean; `check:architecture` green over the current flat layout (the recursion is backward-compatible — every flat package has a `package.json`, so the family-folder branch never triggers yet).

- [ ] **Step 7: Commit**
```bash
git add pnpm-workspace.yaml vitest.config.ts scripts/check-architecture.mjs scripts/release.mjs scripts/strip-version-comments.mjs
git commit -m "chore(reorg): make tooling two-level-aware (packages/*/* support) — backward-compatible"
```

---

### Task 2: Move the 47 packages into family folders + fix all path references

This is the reorg itself — a coordinated, mechanical change. After it, the repo builds green in the new layout. **Files:** 47 package dirs (moved), their `package.json` + `tsconfig*.json`, 24 hub test files, `typedoc.json`, `tsconfig.typedoc.json`, `.github/workflows/ci.yml`.

- [ ] **Step 1: Move each family's packages into its folder + fix per-package metadata + tsconfig depth**
```bash
cd /Users/vicio/lanna-db/noy-db
for fam in to in on as by at; do
  mkdir -p "packages/$fam"
  for d in packages/$fam-*; do
    [ -d "$d" ] || continue
    pkg=$(basename "$d")                       # e.g. to-memory
    git mv "$d" "packages/$fam/$pkg"
    f="packages/$fam/$pkg"
    # repository.directory + homepage: packages/<pkg> -> packages/<fam>/<pkg>
    sed -i '' "s|packages/$pkg|packages/$fam/$pkg|g" "$f/package.json"
    # tsconfig extends depth: ../../ -> ../../../ (now one level deeper)
    for tc in "$f"/tsconfig*.json; do [ -f "$tc" ] && sed -i '' 's|"\.\./\.\./|"../../../|g' "$tc"; done
  done
done
echo "moved:"; ls -d packages/*/ | tr '\n' ' '; echo
```
(BSD/macOS `sed -i ''`. After this: `packages/{to,in,on,as,by,at}/` folders + the 4 root packages.)

- [ ] **Step 2: Fix the 24 `hub → to-memory` relative test imports**
`to-memory` moved to `packages/to/to-memory`, so hub tests importing `…/to-memory/src` need `…/to/to-memory/src`. The `../` prefix is unchanged (hub stayed put); only the target gained a `/to/` segment:
```bash
cd /Users/vicio/lanna-db/noy-db
git grep -lE "from '(\.\./)+to-memory/" -- 'packages/hub/__tests__/**' | while read -r f; do
  sed -i '' 's|/to-memory/|/to/to-memory/|g' "$f"
done
# verify none remain pointing at the old path:
git grep -nE "from '(\.\./)+to-memory/" -- 'packages/hub/**' && echo "STILL STALE" || echo "relative imports fixed ✓"
```
(If any hub test imports another *essential* store by relative path — e.g. `to-file` — apply the same `/to-file/ → /to/to-file/` fix. Grep `from '(\.\./)+to-(file|browser-idb|probe|meter)/` to be sure.)

- [ ] **Step 3: Fix `typedoc.json` + `tsconfig.typedoc.json` + `ci.yml` prefixed paths**
A single regex maps `packages/<fam>-` → `packages/<fam>/<fam>-` (leaves `packages/hub` untouched):
```bash
cd /Users/vicio/lanna-db/noy-db
for file in typedoc.json tsconfig.typedoc.json .github/workflows/ci.yml; do
  sed -i '' -E 's|packages/(to|in|on|as|by|at)-|packages/\1/\1-|g' "$file"
done
# sanity: ci.yml interop working-dir now packages/as/as-zip; typedoc entrypoints now under family folders
grep -n "as/as-zip" .github/workflows/ci.yml && node -e "console.log(require('./typedoc.json').entryPoints.join('\n'))"
```

- [ ] **Step 4: Reinstall + full verification in the new layout**
```bash
cd /Users/vicio/lanna-db/noy-db
pnpm install
pnpm check:architecture                       # must find all packages at the 2-level paths + pass
NODE_OPTIONS="--max-old-space-size=8192" pnpm turbo build typecheck --concurrency=1 2>&1 | tail -15
pnpm turbo lint 2>&1 | tail -5
pnpm validate:features                         # unaffected (no source paths) — confirm still 0 dangling
pnpm render:storage-matrix -- --check
pnpm knip 2>&1 | tail -15
pnpm --filter @noy-db/hub test 2>&1 | grep -iE "Test Files|Tests " | tail -2   # the 24 relative-import fixes exercised here
```
Expected: ALL green. The hub test run proves the relative-import fixes; build/typecheck proves tsconfig depth + workspace resolution; check:architecture proves the two-level discovery; knip proves no path breakage.

- [ ] **Step 5: Confirm the layout + no stale flat paths**
```bash
cd /Users/vicio/lanna-db/noy-db
echo "family folders:" && ls -d packages/*/ | tr '\n' ' '; echo
echo "root packages (expect hub cli create-noy-db attestation):" && for p in hub cli create-noy-db attestation; do [ -f "packages/$p/package.json" ] && echo -n "$p "; done; echo
# no tracked reference to a moved package at its OLD flat path:
git grep -nE "packages/(to|in|on|as|by|at)-[a-z0-9-]+/" -- ':!docs/superpowers/**' ':!*.md' 2>/dev/null || echo "no stale flat package paths in code/config ✓"
```
Expected: 6 family folders + 4 root packages; no stale `packages/<fam>-<x>/` path references outside archival docs.

- [ ] **Step 6: Grep client name + commit**
```bash
git add -A
git diff --staged --name-only | head
git status --short | grep -i "<pilot-client-name>" ; echo "(client-name check above; expect empty)"
git commit -m "refactor(reorg): move satellites into family folders (packages/<family>/<pkg>); names unchanged"
```

---

## Self-review (against decision D2 + the blast-radius map)

- 47 prefixed packages foldered; 4 root packages untouched; names unchanged. ✓
- Tooling two-level-aware (workspace, vitest, check-architecture, release.mjs, strip-version-comments). ✓
- tsconfig depth, 24 hub→to-memory relative imports, typedoc/tsconfig.typedoc/ci.yml paths all fixed. ✓
- features.yaml/turbo.json/knip.json need no edits (name/glob-driven). ✓
- Full suite (build/typecheck/lint/arch/validate:features/knip/hub tests) green in the new layout; full matrix → CI on the PR. ✓

## Open / notes
- `to-probe`/`to-meter` kept in `to/` (spec O1 default). Revisit to a `dev/` folder later if desired.
- This is a single coherent reorg; if Task 2's verification reveals a missed path reference, fix it in T2 and note it.

## Next
- PR for `feat/family-folders` → user merge. After it, the noy-db family-folder layout is in place and the whole restructuring (extraction + reorg) is complete.
