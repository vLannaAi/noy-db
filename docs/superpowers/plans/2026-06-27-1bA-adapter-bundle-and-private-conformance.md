# Step 1b-A — Extend `/adapter` seam (bundle contract) + re-private the conformance kit

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Prepare noy-db for the store extraction: (1) extend the `@noy-db/hub/adapter` seam to also re-export the *bundle*-store contract (`NoydbBundleStore` + `BundleVersionConflictError`) so the departing `to-drive`/`to-icloud` bundle stores can bind `/adapter` and pass the noy-db-to guard; (2) revert `@noy-db/test-adapter-conformance` to a **private, internal, source-only** harness (undo P0 Task 3) since the conformance suite will NOT be published — each repo keeps its own private copy.

**Architecture:** Two additive/revert changes, both keeping noy-db green. Ships in the user's step-2 `@noy-db` release (so the published `/adapter` includes the bundle contract). No package moves here.

**Tech Stack:** pnpm + tsup + vitest, TypeScript strict, ESM-only, Node ≥22.

**Parent spec:** `docs/superpowers/specs/2026-06-27-extract-stores-to-noy-db-to-design.md` (Step 1 / D3, D6). Roadmap reordered to extract-first; this is the noy-db-side prep.

## Global Constraints

- No Claude/Anthropic attribution in commits/PRs/docs (no `Co-Authored-By: Claude` footer).
- Never reference the private pilot client by name — grep the diff before committing.
- This plan does NOT publish anything.
- ESM-only, Node ≥22. crypto.subtle only; the seam exposes no crypto primitives.
- **Work on a branch.** noy-db default branch is `main`; create `feat/adapter-bundle-and-reprivate-conformance` before Task 1. Commit per task.
- The conformance kit lives at `test-harnesses/adapter-conformance/` (NOT under `packages/`), so `check-architecture.mjs` does not scan it — removing its guard exemption is safe.
- Verify before claiming done: every "run" step must actually run.
- Build hub with `NODE_OPTIONS=--max-old-space-size=8192` (its DTS pass OOMs on the default heap — pre-existing).

---

### Task 1: Extend the `@noy-db/hub/adapter` seam with the bundle-store contract

**Files:**
- Modify: `packages/hub/src/adapter/index.ts`
- Modify: `packages/hub/__tests__/adapter-seam.test.ts`

**Interfaces:**
- Consumes: `NoydbBundleStore` (a type) and `BundleVersionConflictError` (a runtime error class) from the hub source — Step 1 grep confirms their files.
- Produces: `@noy-db/hub/adapter` additionally re-exports `NoydbBundleStore` + `BundleVersionConflictError`, so bundle stores (`to-drive`, `to-icloud`) can bind only `/adapter`.

- [ ] **Step 1: Confirm the bundle-contract symbols' source files + the error ctor signature**

```bash
cd /Users/vicio/lanna-db/noy-db
grep -rn "NoydbBundleStore\b" packages/hub/src/types.ts | head
grep -rn "export class BundleVersionConflictError" packages/hub/src/
grep -n "class BundleVersionConflictError" -A6 packages/hub/src/errors.ts
```
Expected: `NoydbBundleStore` is an `export interface`/`export type` in `packages/hub/src/types.ts`; `BundleVersionConflictError` is an `export class` in `packages/hub/src/errors.ts`. Note its constructor parameters for the test in Step 2 (if it differs from the assumed `(version: number)`, adjust the test call accordingly).

- [ ] **Step 2: Extend the seam test (failing — symbols not on `/adapter` yet)**

Add to `packages/hub/__tests__/adapter-seam.test.ts`. In the error-classes `import { … } from '@noy-db/hub/adapter'`, add `BundleVersionConflictError`; in the `import type { … } from '@noy-db/hub/adapter'`, add `NoydbBundleStore`. Then add a test:

```typescript
  it('re-exports the bundle-store contract (drive/icloud)', () => {
    expect(typeof BundleVersionConflictError).toBe('function')
    const e = new BundleVersionConflictError(2)   // adjust args per Step 1 if signature differs
    expect(e).toBeInstanceOf(BundleVersionConflictError)
    const bundleStore = null as unknown as NoydbBundleStore
    expect(bundleStore).toBeNull()
  })
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
NODE_OPTIONS="--max-old-space-size=8192" pnpm --filter @noy-db/hub build
pnpm --filter @noy-db/hub test -- adapter-seam
```
Expected: FAIL — `BundleVersionConflictError`/`NoydbBundleStore` are not exported by `@noy-db/hub/adapter` (or the build's dts surface lacks them).

- [ ] **Step 4: Add the exports to the seam barrel**

In `packages/hub/src/adapter/index.ts`, add `NoydbBundleStore` to the `export type { … } from '../types.js'` block and `BundleVersionConflictError` to the `export { … } from '../errors.js'` block. Update the docblock's "It carries…" sentence to mention the bundle-store contract. (If Step 1 found either symbol in a different file, import it from that file's `.js` specifier instead.)

- [ ] **Step 5: Rebuild and verify pass + gates**

```bash
NODE_OPTIONS="--max-old-space-size=8192" pnpm --filter @noy-db/hub build
pnpm --filter @noy-db/hub test -- adapter-seam
pnpm --filter @noy-db/hub typecheck
pnpm --filter @noy-db/hub lint
pnpm check:architecture
```
Expected: build emits `dist/adapter/index.{js,d.ts}` including the new symbols; the seam test PASSES; typecheck/lint/arch clean.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/adapter/index.ts packages/hub/__tests__/adapter-seam.test.ts
git commit -m "feat(hub): extend @noy-db/hub/adapter with the bundle-store contract (NoydbBundleStore, BundleVersionConflictError)"
```

---

### Task 2: Re-private the conformance kit (undo P0 Task 3) + remove the guard exemption

**Files:**
- Modify: `test-harnesses/adapter-conformance/package.json`
- Delete: `test-harnesses/adapter-conformance/tsup.config.ts`
- Modify: `scripts/check-architecture.mjs` (remove the rule-#1 exemption)

**Interfaces:**
- Consumes: nothing new.
- Produces: `@noy-db/test-adapter-conformance` back to `private: true`, source-only (`exports: { ".": "./src/index.ts" }`), workspace-only — never published. Essential stores keep consuming it via `workspace:*` (vitest resolves the TS source).

- [ ] **Step 1: Revert `package.json` to the private/source form**

Replace `test-harnesses/adapter-conformance/package.json` with:

```json
{
  "name": "@noy-db/test-adapter-conformance",
  "version": "0.0.0",
  "private": true,
  "description": "Parameterized adapter contract tests",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run --passWithNoTests"
  },
  "devDependencies": {
    "@noy-db/hub": "workspace:*",
    "vitest": "^3.0.0"
  }
}
```
(This restores the exact pre-#492 form: `private: true`, `0.0.0`, source export, no build/publish infra, no `peerDependencies`/`publishConfig`/`engines`. The `src/index.ts` import of `@noy-db/hub/adapter` is LEFT as-is — it's a valid internal subpath and reverting it is needless churn.)

- [ ] **Step 2: Delete the kit's tsup config (no longer builds)**

```bash
rm test-harnesses/adapter-conformance/tsup.config.ts
```

- [ ] **Step 3: Remove the guard rule-#1 exemption**

In `scripts/check-architecture.mjs`, delete the `@noy-db/test-adapter-conformance` exemption inside `checkPeerDeps()` — the comment block plus the `if (pj.name === '@noy-db/test-adapter-conformance') continue` line (the ~8-line block added in #492, around lines 136–143). Leave the `@noy-db/hub` skip immediately above it intact.

```bash
grep -n "test-adapter-conformance" scripts/check-architecture.mjs   # confirm it's gone after the edit
```
Expected after edit: no match (the exemption is removed).

- [ ] **Step 4: Reinstall + verify essential-store conformance still passes and gates are green**

```bash
pnpm install
pnpm --filter @noy-db/to-memory test
pnpm --filter @noy-db/to-file test
pnpm --filter @noy-db/to-browser-idb test
pnpm check:architecture
```
Expected: all three essential stores' conformance suites still PASS (they consume the kit via `workspace:*`; vitest resolves `./src/index.ts` directly — no build needed). `check:architecture` passes (the kit is in `test-harnesses/`, outside the `packages/` scan, so removing the inert exemption changes nothing; no satellite regressed).

- [ ] **Step 5: Confirm the kit is not publishable**

```bash
node -e "const p=require('./test-harnesses/adapter-conformance/package.json'); if(!p.private) throw new Error('kit is not private!'); if(p.publishConfig) throw new Error('publishConfig present'); console.log('kit private:', p.private, '| version:', p.version, '| exports:', JSON.stringify(p.exports))"
```
Expected: `kit private: true | version: 0.0.0 | exports: {".":"./src/index.ts"}`.

- [ ] **Step 6: Grep for the client name, then commit**

```bash
git diff --staged | grep -i "<pilot-client-name>" && echo "STOP" || echo "clean"
git add test-harnesses/adapter-conformance/package.json scripts/check-architecture.mjs
git rm test-harnesses/adapter-conformance/tsup.config.ts
git commit -m "chore(conformance): keep @noy-db/test-adapter-conformance private/internal (not published)"
```

---

## Self-review (against decisions)

- **Bundle seam (drive/icloud):** Task 1 adds `NoydbBundleStore` + `BundleVersionConflictError` to `/adapter`. ✓
- **Conformance not published:** Task 2 restores `private: true` + source export + removes build/publish infra + the guard exemption. ✓
- **Essential stores keep working:** verified in Task 2 Step 4 (workspace:* → source). ✓
- **noy-db stays green:** seam test + typecheck + lint + arch in Task 1; essential conformance + arch in Task 2. ✓
- **Ships in step-2 release:** both changes are on `main` after merge; the published `/adapter` will carry the bundle contract; the kit won't publish (private). ✓

## Next

- **1b-B** (noy-db-to, branch): vendored private harness + relocate the 16 stores (→`/adapter`, peer-range, intra-deps, `to-nfs` rewritten), local-link verify, pilot-first. No showcases (dropped per user).
- **1b-C** (noy-db, branch): delete the 16 dirs + clean `features.yaml` (16 adapters + 9 topologies), the 21 showcase files + `showcases/package.json` deps + `_d1-sdk.ts`, `typedoc.json`/`tsconfig.typedoc.json` (3), `cli/src/commands/config.ts` scaffolding, `CONTRIBUTING.md:135`, `README.md`, docs.
- **Gate:** user cuts the `@noy-db` step-2 release (publishes hub with extended `/adapter`) → merge 1b-B/1b-C → `noy-db-to` release.
