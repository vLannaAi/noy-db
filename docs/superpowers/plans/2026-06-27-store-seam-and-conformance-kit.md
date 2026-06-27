# Store-Adapter Seam + Conformance Kit (P0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carve a stable published `@noy-db/hub/adapter` subpath (the ciphertext store contract) and promote the existing conformance harness to a publishable package, so a future `noy-db-to` repo can build storage adapters against a versioned seam — exactly as `klum-db` binds to `@noy-db/hub/kernel`.

**Architecture:** Add one named-re-export barrel (`src/adapter/index.ts`) wired into the hub's existing multi-entry tsup build and `exports` map, mirroring the `./kernel` precedent. Migrate the three essential in-repo stores (`to-memory`, `to-file`, `to-browser-idb`) to import the contract from the new subpath. Promote `@noy-db/test-adapter-conformance` from a private/source-only/`0.0.0` workspace tool to a built, publishable package peering `@noy-db/hub` at a range, with a single narrow exemption from architecture-guard rule #1.

**Tech Stack:** pnpm 9 + turbo, tsup (ESM+CJS+DTS), vitest, TypeScript strict.

**Parent spec:** `docs/superpowers/specs/2026-06-27-extract-stores-to-noy-db-to-design.md` (phase P0).

## Global Constraints

- **No Claude/Anthropic attribution** in commits, PRs, docs, or CHANGELOGs. Commit messages end with no `Co-Authored-By: Claude` / "Generated with Claude" footer.
- **Never reference the private pilot client by name** — grep the diff before every commit.
- **Never publish** (or run a publish-adjacent command) without explicit user confirmation. This plan does **not** publish anything.
- **Crypto:** zero npm crypto deps (guard #2); `crypto.subtle` only. The seam exposes no crypto primitives.
- **Peer-dep convention (guard #1):** every `@noy-db/*` satellite keeps `peerDependencies['@noy-db/hub'] = "workspace:*"`. The **only** package exempted by this plan is `@noy-db/test-adapter-conformance` (test tooling that must peer a range).
- **Stores import only the ciphertext surface (guard #4):** no crypto named-imports from `@noy-db/hub`.
- **Work on a branch.** The repo's default branch is `main`; create `feat/store-adapter-seam` before Task 1 (`git checkout -b feat/store-adapter-seam`). Commit after every task.
- **Verify before claiming done:** every "run" step must actually be run and its output observed.

---

### Task 1: The `@noy-db/hub/adapter` seam barrel

**Files:**
- Create: `packages/hub/src/adapter/index.ts`
- Modify: `packages/hub/tsup.config.ts` (add one entry to the `ENTRIES` object)
- Modify: `packages/hub/package.json` (add `./adapter` to `exports`, after the `./kernel` block)
- Test: `packages/hub/__tests__/adapter-seam.test.ts`

**Interfaces:**
- Consumes: `NoydbStore`, `EncryptedEnvelope`, `VaultSnapshot`, `TxOp`, `StoreCapabilities`, `StoreTime`, `ListPageResult` from `packages/hub/src/types.ts`; `ConflictError`, `NetworkError`, `StoreCapabilityError` (error classes — see Step 1 grep to confirm their file).
- Produces: a new public subpath `@noy-db/hub/adapter` re-exporting those symbols. Tasks 2 and 3 import from it.

- [ ] **Step 1: Confirm the error classes' source file**

The contract types are confirmed in `packages/hub/src/types.ts`. Confirm where the three error classes are *defined* (so the barrel imports from the right file):

```bash
cd /Users/vicio/lanna-db/noy-db
grep -rn "export class ConflictError\|export class NetworkError\|export class StoreCapabilityError" packages/hub/src/
```
Expected: `ConflictError` and `NetworkError` in `packages/hub/src/errors.ts`. If `StoreCapabilityError` is reported in a different file (e.g. `src/store/index.ts`), use that path in Step 3's `export { StoreCapabilityError } from '...'` line instead of `../errors.js`.

- [ ] **Step 2: Write the failing test**

```typescript
// packages/hub/__tests__/adapter-seam.test.ts
import { describe, it, expect } from 'vitest'
import { ConflictError, NetworkError, StoreCapabilityError } from '@noy-db/hub/adapter'
import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  TxOp,
  StoreCapabilities,
  StoreTime,
  ListPageResult,
} from '@noy-db/hub/adapter'

describe('@noy-db/hub/adapter seam', () => {
  it('re-exports the store-facing error classes as constructable runtime values', () => {
    const conflict = new ConflictError(7)
    expect(conflict).toBeInstanceOf(ConflictError)
    expect(conflict.version).toBe(7)
    expect(new NetworkError()).toBeInstanceOf(NetworkError)
    expect(new StoreCapabilityError('listVaults')).toBeInstanceOf(StoreCapabilityError)
  })

  it('re-exports the store contract types (compile-time only)', () => {
    // type-only smoke: these must resolve at typecheck; runtime is a no-op
    const env = null as EncryptedEnvelope | null
    const store = null as unknown as NoydbStore
    const snap = null as unknown as VaultSnapshot
    const ops = null as unknown as readonly TxOp[]
    const caps = null as unknown as StoreCapabilities
    const time = null as unknown as StoreTime
    const page = null as unknown as ListPageResult
    expect([env, store, snap, ops, caps, time, page].every(v => v === null)).toBe(true)
  })
})
```

(If `StoreCapabilityError`'s constructor signature differs from `(method: string)`, adjust the call — confirm with `grep -n "class StoreCapabilityError" -A4 packages/hub/src/*.ts`.)

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm --filter @noy-db/hub build   # build current state (no /adapter yet)
pnpm --filter @noy-db/hub test -- adapter-seam
```
Expected: FAIL — `ERR_PACKAGE_PATH_NOT_EXPORTED` / "Package subpath './adapter' is not defined by 'exports'".

- [ ] **Step 4: Create the seam barrel**

```typescript
// packages/hub/src/adapter/index.ts
/**
 * @noy-db/hub/adapter — the stable store-adapter contract.
 *
 * A storage backend (a `to-*` package) binds ONLY to this subpath: the
 * ciphertext-facing slice of the hub. It carries the 6-method `NoydbStore`
 * contract (plus its optional extension methods), the envelope / snapshot / op
 * types a store passes through, and the store-facing error classes. Mirrors the
 * `@noy-db/hub/kernel` seam used by klum-db and the `by-*` transports.
 *
 * Named re-exports only (no `export *`) so the published surface is explicit and
 * tsup's per-entry bundling keeps class identity stable across subpaths.
 */
export type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  TxOp,
  StoreCapabilities,
  StoreTime,
  ListPageResult,
} from '../types.js'

export { ConflictError, NetworkError, StoreCapabilityError } from '../errors.js'
```

(If Step 1 showed `StoreCapabilityError` lives elsewhere, split it into a second `export { StoreCapabilityError } from '<its-path>.js'` line.)

- [ ] **Step 5: Wire the build entry**

In `packages/hub/tsup.config.ts`, add the entry to the `ENTRIES` object, immediately after the `'kernel/index': 'src/kernel/index.ts',` line:

```typescript
  'kernel/index': 'src/kernel/index.ts',
  'adapter/index': 'src/adapter/index.ts',
}
```

- [ ] **Step 6: Add the `exports` entry**

In `packages/hub/package.json`, the `./kernel` block is the last entry in `exports`. Add a comma after its closing brace and append `./adapter`:

```json
    "./kernel": {
      "import": {
        "types": "./dist/kernel/index.d.ts",
        "default": "./dist/kernel/index.js"
      },
      "require": {
        "types": "./dist/kernel/index.d.cts",
        "default": "./dist/kernel/index.cjs"
      }
    },
    "./adapter": {
      "import": {
        "types": "./dist/adapter/index.d.ts",
        "default": "./dist/adapter/index.js"
      },
      "require": {
        "types": "./dist/adapter/index.d.cts",
        "default": "./dist/adapter/index.cjs"
      }
    }
```

- [ ] **Step 7: Rebuild and run the test to verify it passes**

```bash
pnpm --filter @noy-db/hub build
pnpm --filter @noy-db/hub test -- adapter-seam
pnpm --filter @noy-db/hub typecheck
```
Expected: build emits `dist/adapter/index.{js,cjs,d.ts,d.cts}`; the test PASSES; typecheck clean.

- [ ] **Step 8: Confirm guards still pass**

```bash
pnpm check:architecture
```
Expected: all checks pass (the new subpath exposes no crypto; `kernel-surface` ratchet untouched).

- [ ] **Step 9: Commit**

```bash
git add packages/hub/src/adapter/index.ts packages/hub/tsup.config.ts packages/hub/package.json packages/hub/__tests__/adapter-seam.test.ts
git commit -m "feat(hub): add @noy-db/hub/adapter store-contract subpath"
```

---

### Task 2: Migrate the essential stores to the seam

**Files (per store — repeat the cycle for each):**
- Modify: `packages/to-memory/src/index.ts` (lines ~30–31)
- Modify: `packages/to-file/src/index.ts` (the `@noy-db/hub` contract import)
- Modify: `packages/to-browser-idb/src/index.ts` (the `@noy-db/hub` contract import)
- Test: existing `packages/to-*/__tests__/conformance.test.ts` (no new test; these prove the seam works end-to-end)

**Interfaces:**
- Consumes: `@noy-db/hub/adapter` (from Task 1).
- Produces: three essential stores importing the contract from the seam instead of the barrel. (The 15 stores destined for `noy-db-to` are migrated later, at relocation time, in plan P3.)

- [ ] **Step 1: Inspect the current contract imports**

```bash
cd /Users/vicio/lanna-db/noy-db
grep -n "from '@noy-db/hub'" packages/to-memory/src/index.ts packages/to-file/src/index.ts packages/to-browser-idb/src/index.ts
```
Expected (to-memory): `import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, TxOp } from '@noy-db/hub'` and `import { ConflictError } from '@noy-db/hub'`. Note the exact symbol list per file (to-file / to-browser-idb may differ slightly).

- [ ] **Step 2: Repoint `to-memory`'s contract imports to the seam**

In `packages/to-memory/src/index.ts`, change the two import lines from `'@noy-db/hub'` to `'@noy-db/hub/adapter'`:

```typescript
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, TxOp } from '@noy-db/hub/adapter'
import { ConflictError } from '@noy-db/hub/adapter'
```

Leave any non-contract imports (if present) pointing at their current subpaths. Only the contract symbols (`NoydbStore`, `EncryptedEnvelope`, `VaultSnapshot`, `TxOp`, `StoreCapabilities`, `StoreTime`, `ListPageResult`, `ConflictError`, `NetworkError`, `StoreCapabilityError`) move.

- [ ] **Step 3: Build + test + typecheck `to-memory`**

```bash
pnpm --filter @noy-db/to-memory build
pnpm --filter @noy-db/to-memory test
pnpm --filter @noy-db/to-memory typecheck
```
Expected: build OK; the conformance suite (`runStoreConformanceTests('memory', …)`) PASSES against the seam; typecheck clean.

- [ ] **Step 4: Repeat Steps 2–3 for `to-file`**

Repoint the contract symbols in `packages/to-file/src/index.ts` to `'@noy-db/hub/adapter'` (use the exact symbol list Step 1 reported for this file), then:

```bash
pnpm --filter @noy-db/to-file build
pnpm --filter @noy-db/to-file test
pnpm --filter @noy-db/to-file typecheck
```
Expected: all pass.

- [ ] **Step 5: Repeat Steps 2–3 for `to-browser-idb`**

Repoint the contract symbols in `packages/to-browser-idb/src/index.ts` to `'@noy-db/hub/adapter'`, then:

```bash
pnpm --filter @noy-db/to-browser-idb build
pnpm --filter @noy-db/to-browser-idb test
pnpm --filter @noy-db/to-browser-idb typecheck
```
Expected: all pass.

- [ ] **Step 6: Confirm guards still pass**

```bash
pnpm check:architecture
```
Expected: pass. Rule #4 (`stores-ciphertext-only`) regexes `@noy-db/hub` *and its subpaths*, so it still inspects the new `@noy-db/hub/adapter` imports — and the seam exposes no banned crypto names, so the three stores remain clean.

- [ ] **Step 7: Commit**

```bash
git add packages/to-memory/src/index.ts packages/to-file/src/index.ts packages/to-browser-idb/src/index.ts
git commit -m "refactor(stores): bind essential stores to @noy-db/hub/adapter seam"
```

---

### Task 3: Promote `@noy-db/test-adapter-conformance` to a publishable package

**Files:**
- Modify: `test-harnesses/adapter-conformance/package.json`
- Create: `test-harnesses/adapter-conformance/tsup.config.ts`
- Modify: `test-harnesses/adapter-conformance/src/index.ts` (repoint the `NoydbStore` type import)
- Modify: `scripts/check-architecture.mjs` (one-line guard-#1 exemption)

**Interfaces:**
- Consumes: `@noy-db/hub/adapter` (from Task 1) for the `NoydbStore` type; `vitest` (peer).
- Produces: a built, publishable `@noy-db/test-adapter-conformance` that peers `@noy-db/hub` at a range — consumable by the future `noy-db-to` repo. Public API unchanged: `runStoreConformanceTests(name, factory, cleanup?)`.

- [ ] **Step 1: Repoint the contract import in the harness source**

```bash
cd /Users/vicio/lanna-db/noy-db
grep -n "from '@noy-db/hub'" test-harnesses/adapter-conformance/src/index.ts
```
Change the `NoydbStore` type import in `test-harnesses/adapter-conformance/src/index.ts` from `'@noy-db/hub'` to `'@noy-db/hub/adapter'`. For example:

```typescript
import type { NoydbStore } from '@noy-db/hub/adapter'
```
(Keep any other imports as-is; only the contract type moves.)

- [ ] **Step 2: Add the build config**

```typescript
// test-harnesses/adapter-conformance/tsup.config.ts
import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'es2022',
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    target: 'es2022',
  },
])
```

- [ ] **Step 3: Make the package.json publishable**

Replace `test-harnesses/adapter-conformance/package.json` with:

```json
{
  "name": "@noy-db/test-adapter-conformance",
  "version": "0.2.0-pre.30",
  "description": "Parameterized adapter contract tests for noy-db storage backends",
  "license": "MIT",
  "author": "vLannaAi <vicio@lanna.ai>",
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs"
      }
    }
  },
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsup",
    "test": "vitest run --passWithNoTests",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@noy-db/hub": "workspace:^",
    "vitest": "^3.0.0"
  },
  "devDependencies": {
    "@noy-db/hub": "workspace:*",
    "vitest": "^3.0.0"
  },
  "publishConfig": {
    "access": "public",
    "tag": "latest"
  }
}
```

Notes:
- `private: true` is **removed** — the package now joins the publish set.
- `version` matches the current lockstep line (`0.2.0-pre.30`); the release normalizer keeps it aligned.
- `@noy-db/hub` is a **peer** at `workspace:^` (pnpm publishes this as `^0.2.0-pre.30`, a range) and a **dev** at `workspace:*` (for local build/typecheck).

- [ ] **Step 4: Exempt the kit from architecture-guard rule #1**

In `scripts/check-architecture.mjs`, inside `checkPeerDeps()`, add the exemption immediately after the existing hub skip:

```javascript
    if (pj.name === '@noy-db/hub') continue
    // Test tooling: must peer @noy-db/hub at a RANGE so external repos (noy-db-to)
    // can consume it. Exempt from the workspace:* convention. (Not a satellite.)
    if (pj.name === '@noy-db/test-adapter-conformance') continue
```

- [ ] **Step 5: Build the kit and verify a store's conformance run still passes against it**

```bash
pnpm install            # re-link workspace graph after manifest changes
pnpm --filter @noy-db/test-adapter-conformance build
pnpm --filter @noy-db/test-adapter-conformance typecheck
pnpm --filter @noy-db/to-memory test
```
Expected: the kit emits `dist/index.{js,cjs,d.ts,d.cts}`; typecheck clean; `to-memory`'s conformance test (which imports `@noy-db/test-adapter-conformance`) still PASSES — now resolving the kit's built dist instead of source.

- [ ] **Step 6: Confirm guards pass with the exemption**

```bash
pnpm check:architecture
```
Expected: pass — the kit is outside the `packages/` scan (it lives in `test-harnesses/`), so
rule #1 is satisfied without the exemption firing. The exemption is pre-emptive: it becomes
load-bearing in P1 when the scan is broadened or packages move under `packages/*/*`. Every other
`@noy-db/*` package still must be `workspace:*`.

- [ ] **Step 7: Full-graph sanity (guards + build + a representative test)**

```bash
pnpm turbo build --filter @noy-db/hub --filter @noy-db/test-adapter-conformance --filter @noy-db/to-memory --filter @noy-db/to-file --filter @noy-db/to-browser-idb
pnpm turbo test  --filter @noy-db/to-memory --filter @noy-db/to-file --filter @noy-db/to-browser-idb
```
Expected: all green.

- [ ] **Step 8: Grep the diff for the client name, then commit**

```bash
git diff --staged | grep -i "<pilot-client-name>" && echo "STOP: client name present" || echo "clean"
git add test-harnesses/adapter-conformance/package.json test-harnesses/adapter-conformance/tsup.config.ts test-harnesses/adapter-conformance/src/index.ts scripts/check-architecture.mjs
git commit -m "feat(conformance): make adapter-conformance kit publishable on the adapter seam"
```
(Replace `<pilot-client-name>` with the actual name to grep for; do not write it into any committed file.)

---

## Self-review (performed against the spec)

- **D3 (the seam):** Task 1 creates `@noy-db/hub/adapter` exporting the contract types + store errors. ✓
- **D3 (conformance kit):** Task 3 promotes `@noy-db/test-adapter-conformance` to publishable, peering hub at a range. ✓
- **D6 (guard exemption):** Task 3 Step 4 adds the narrow rule-#1 exemption. ✓
  Note: as of P0 the exemption is pre-emptive — `check:architecture` is green because the kit
  lives in `test-harnesses/` and is outside the `packages/` scan, not because the exemption fired.
  The exemption becomes active in P1.
- **P0 "essential stores build against the subpath":** Task 2 migrates `to-memory`, `to-file`, `to-browser-idb`. ✓
- **Naming collision (`/store` taken):** seam named `/adapter`. ✓
- **Deferred (correctly out of P0):** the 15 moving stores migrate in P3; `noy-db-to` scaffold is P2; folder reorg is P1. Not in this plan.
- **Type consistency:** the symbol set (`NoydbStore`, `EncryptedEnvelope`, `VaultSnapshot`, `TxOp`, `StoreCapabilities`, `StoreTime`, `ListPageResult`, `ConflictError`, `NetworkError`, `StoreCapabilityError`) is identical in Task 1's barrel, Task 1's test, and Task 2's migration. ✓

---

## Plan roadmap (subsequent phases — separate plans)

Each becomes its own plan once the prior one is merged (later phases bind to earlier phases' concrete output):

- **P1 — Folder reorg in `noy-db`.** Move packages into `packages/<family>/<pkg>` (basename == package short name); update `pnpm-workspace.yaml` (`packages/*` → also `packages/*/*`). Names unchanged; turbo/changesets are path-agnostic. Verify: full build/test/typecheck + `check:architecture` green.
- **P2 — Scaffold `noy-db-to`.** New repo: pnpm workspace (`to-*` at root, flat), tsup/vitest/eslint configs, sibling architecture guard (range-peer + adapter-subpath-only), CI calling the shared reusable workflow, `release.yml` (provenance + explicit-confirm), devDep on the published `@noy-db/test-adapter-conformance`, ranged peer on `@noy-db/hub`.
- **P3 — Relocate the 15 stores in batches.** Per package: copy to `noy-db-to`, migrate contract imports to `@noy-db/hub/adapter`, convert peer to a range, run conformance against published hub; delete from `noy-db`; drop from release set, changesets, `features.yaml`, storage matrix, docs.
- **P4 — Rebuild `to-nfs` standalone** (sever `to-file`) so `noy-db-to` has zero inbound deps to noy-db's stores.
- **P5 — First `noy-db-to` release** (explicit user confirmation) + confirm `noy-db` no longer publishes the moved packages (klum-db split precedent).
- **P6 — (Optional) uniform CI** reusable workflow adopted across `klum-db`, `nit-db`, `noy-db`, `noy-db-to`.
