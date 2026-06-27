# Step 1b-B (batch) — relocate the remaining 15 stores into noy-db-to

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Relocate the remaining 15 departing stores into `noy-db-to` using the recipe proven by the `to-turso` pilot — 12 envelope stores, 2 bundle stores, and `to-nfs` (a minimal self-contained sever of `@noy-db/to-file`). After this, all 16 departing stores live in `noy-db-to` (branch `feat/relocate-stores`), verified locally via the link bridge. Finalization (drop the link, switch to the published range, push, CI) happens in a separate step after the user's step-2 `@noy-db` publish.

**Architecture:** Same as the pilot — `feat/relocate-stores` branch in `/Users/vicio/lanna-db/noy-db-to`; `@noy-db/hub` resolves via the temporary pnpm `overrides: link:` to `../noy-db/packages/hub` (1b-A branch, extended `/adapter`). Each store declares peer `@noy-db/hub` at `^0.2.0-pre.31`. Branch NOT pushed.

**Tech Stack:** pnpm 9.15.4, vitest, tsup (ESM-only), TypeScript strict, Node ≥22.

**Parent spec/pilot:** `docs/superpowers/specs/2026-06-27-extract-stores-to-noy-db-to-design.md`; pilot plan `2026-06-27-1bB-pilot-relocate-turso.md`.

## Global Constraints

- No Claude/Anthropic attribution; no client/company name (grep before commit). Never push the branch. Never publish.
- ESM-only, Node ≥22. Stores see ciphertext only — no crypto deps.
- Build the local hub with `NODE_OPTIONS=--max-old-space-size=8192` if a rebuild is needed (DTS OOM).
- Guard (`pnpm check:architecture`) must pass after each task: every store peers `@noy-db/hub` at the range and imports `@noy-db/hub` only via `/adapter`.

## THE PER-STORE RECIPE (proven by the to-turso pilot — apply to every store)

For store `to-X` (run from `/Users/vicio/lanna-db/noy-db-to`):
1. `cp -R ../noy-db/packages/to-X ./to-X` then `rm -rf to-X/node_modules to-X/dist to-X/.turbo`.
2. **`src/index.ts`**: grep `from '@noy-db/hub'`; repoint ONLY the contract symbols to `from '@noy-db/hub/adapter'`. (Envelope stores: `NoydbStore`/`EncryptedEnvelope`/`VaultSnapshot`/`TxOp`/`ListPageResult` + `ConflictError`, whichever the file uses. Bundle stores: `NoydbBundleStore` + `BundleVersionConflictError`.) Leave non-contract imports (intra-store, SDK, node:) untouched.
3. **`package.json`**:
   - `peerDependencies["@noy-db/hub"]` and `devDependencies["@noy-db/hub"]`: `"workspace:*"` → `"^0.2.0-pre.31"`.
   - `repository.url` → `git+https://github.com/vLannaAi/noy-db-to.git`; REMOVE `repository.directory`.
   - `homepage` → `https://github.com/vLannaAi/noy-db-to/tree/main/to-X#readme`.
   - `bugs.url` → `https://github.com/vLannaAi/noy-db-to/issues`.
   - Leave SDK peers, intra-store `@noy-db/to-*` workspace deps, `@types/node`, `peerDependenciesMeta`, etc. unchanged.
   - Ensure the file ends with a trailing newline.
4. **`tsconfig.json`**: `"extends": "../../tsconfig.base.json"` → `"../tsconfig.base.json"`.
5. **`README.md`** (if present): update the "Source"/"Issues" links from noy-db to noy-db-to (`tree/main/to-X`, `/issues`). A "Spec"/main-repo link may stay pointing at noy-db.
6. Leave `__tests__/**` as-is (test code may import bare `@noy-db/hub`; the guard does not scan tests).

Per-store verification (after copying a task's stores, run once for install + arch, then per store):
```
pnpm install
pnpm check:architecture
pnpm --filter @noy-db/to-X build && pnpm --filter @noy-db/to-X test && pnpm --filter @noy-db/to-X typecheck && pnpm --filter @noy-db/to-X lint
```

---

### Task 1: Plain envelope stores (7) + to-turso consistency pass

**Stores (no intra-deps, no SDK, no harness):** `to-postgres`, `to-mysql`, `to-sqlite`, `to-cloudflare-d1`, `to-smb`, `to-ssh`, `to-webdav`.
**Also:** apply recipe addenda (3: bugs.url, 5: README links, 3-newline) to the already-relocated `to-turso` so the pilot matches the batch.

**Note:** `to-ssh` has a quirk — `peerDependenciesMeta.ssh2` exists with NO matching `peerDependencies.ssh2` entry. Preserve exactly as-is (do not "fix" it).

- [ ] **Step 1: Relocate the 7 stores** via the recipe (steps 1–6 each). Grep each `src/index.ts` to confirm its contract symbols before repointing.
- [ ] **Step 2: to-turso addenda** — in `to-turso/package.json` set `bugs.url` → `https://github.com/vLannaAi/noy-db-to/issues` + ensure trailing newline; in `to-turso/README.md` update Source/Issues links to noy-db-to.
- [ ] **Step 3: Install + guard**

```bash
cd /Users/vicio/lanna-db/noy-db-to && pnpm install && pnpm check:architecture
```
Expected: install resolves all (link bridges hub); guard OK (8 stores now: turso + 7).
- [ ] **Step 4: Per-store gates** — for each of the 7: `pnpm --filter @noy-db/to-X build && test && typecheck && lint`. All green. Record each store's test count.
- [ ] **Step 5: Grep client name + commit**

```bash
git diff --staged | grep -i "<pilot-client-name>" && echo STOP || echo clean
git add -A && git commit -m "feat(relocate): batch 1 — postgres, mysql, sqlite, cloudflare-d1, smb, ssh, webdav (+ to-turso addenda)"
```

---

### Task 2: SDK + intra-dependency stores (4)

**Stores:** `to-aws-s3` (SDK `@aws-sdk/client-s3`), `to-aws-dynamo` (SDK dynamodb+lib-dynamodb), `to-cloudflare-r2` (SDK s3 + **intra-dep `@noy-db/to-aws-s3`**), `to-supabase` (**intra-dep `@noy-db/to-postgres`**).

**Ordering matters:** relocate `to-aws-s3` BEFORE `to-cloudflare-r2` (r2 imports `s3` from it). `to-postgres` is already present from Task 1 (supabase needs it). Keep the intra-store deps as `@noy-db/to-aws-s3`/`@noy-db/to-postgres: "workspace:*"` (both live in noy-db-to — resolve in-workspace).

- [ ] **Step 1: Relocate `to-aws-s3` then `to-aws-dynamo`** via the recipe. Their `src` import `ConflictError`+types from `@noy-db/hub` → `/adapter`. SDK peers (`@aws-sdk/*`) stay untouched.
- [ ] **Step 2: Relocate `to-cloudflare-r2`** via the recipe. Its `src` imports `NoydbStore` (type) from `@noy-db/hub` → `/adapter`, AND `import { s3 } from '@noy-db/to-aws-s3'` (leave — intra-repo); keep `@noy-db/to-aws-s3: "workspace:*"` in peer+dev.
- [ ] **Step 3: Relocate `to-supabase`** via the recipe. Its `src` imports `NoydbStore` (type) from `@noy-db/hub` → `/adapter`, AND `postgres`/types from `@noy-db/to-postgres` (leave); keep `@noy-db/to-postgres: "workspace:*"`.
- [ ] **Step 4: Install + guard + per-store gates**

```bash
cd /Users/vicio/lanna-db/noy-db-to && pnpm install && pnpm check:architecture
```
Then per store (`to-aws-s3`, `to-aws-dynamo`, `to-cloudflare-r2`, `to-supabase`): `build && test && typecheck && lint`. Confirm intra-deps resolve (r2 sees s3, supabase sees postgres).
- [ ] **Step 5: Grep + commit**

```bash
git diff --staged | grep -i "<pilot-client-name>" && echo STOP || echo clean
git add -A && git commit -m "feat(relocate): batch 2 — aws-s3, aws-dynamo, cloudflare-r2 (→s3), supabase (→postgres)"
```

---

### Task 3: Bundle stores + browser-local (3)

**Stores:** `to-drive` (bundle), `to-icloud` (bundle), `to-browser-local` (envelope; uses the vendored harness + `happy-dom`).

- [ ] **Step 1: Relocate `to-drive` and `to-icloud`** via the recipe. CRITICAL: their `src` imports the BUNDLE contract — `import type { NoydbBundleStore } from '@noy-db/hub'` + `import { BundleVersionConflictError } from '@noy-db/hub'` — repoint BOTH to `'@noy-db/hub/adapter'` (those symbols are on `/adapter` as of 1b-A). These two have no intra-deps and no SDK.
- [ ] **Step 2: Relocate `to-browser-local`** via the recipe. Its `src` imports `NoydbStore`/`EncryptedEnvelope`/`VaultSnapshot` + `ConflictError` → `/adapter`. Its `devDependencies` already include `@noy-db/test-adapter-conformance: "workspace:*"` (resolves to the vendored `test-support/` harness — LEAVE unchanged) and `happy-dom` (leave). Its two test files (`__tests__/conformance.test.ts`, `__tests__/obfuscate.test.ts`) import `runStoreConformanceTests` from `@noy-db/test-adapter-conformance` — leave as-is.
- [ ] **Step 3: Install + guard + per-store gates**

```bash
cd /Users/vicio/lanna-db/noy-db-to && pnpm install && pnpm check:architecture
```
Then per store: `build && test && typecheck && lint`. For `to-browser-local`, confirm the conformance suite runs against the vendored harness (resolves `@noy-db/hub/adapter` via the link) and passes.
- [ ] **Step 4: Grep + commit**

```bash
git diff --staged | grep -i "<pilot-client-name>" && echo STOP || echo clean
git add -A && git commit -m "feat(relocate): batch 3 — drive, icloud (bundle contract via /adapter), browser-local (vendored conformance)"
```

---

### Task 4: `to-nfs` — minimal self-contained sever of `@noy-db/to-file`

**Goal:** Relocate `to-nfs` and remove its `@noy-db/to-file` dependency (to-file stays in noy-db). MINIMAL sever — same behaviour, self-contained. NFS-native optimizations are tracked separately at https://github.com/vLannaAi/noy-db-to/issues/1 (do NOT implement them here).

**Approach:** `to-nfs` currently does `import { jsonFile } from '@noy-db/to-file'` and wraps it over an NFS mount path (plus `runMountDiagnostics`). To sever: inline the file-based `NoydbStore` implementation `to-file` provides into `to-nfs` as a private internal module, so `to-nfs` no longer imports `@noy-db/to-file`.

- [ ] **Step 1: Relocate `to-nfs`** via the recipe steps 1, 3–6 (NOT step 2 yet). In `package.json`, ALSO remove `@noy-db/to-file` from BOTH `peerDependencies` and `devDependencies` (it's being severed).
- [ ] **Step 2: Inline the file store**

Read `../noy-db/packages/to-file/src/index.ts` to find the implementation behind `jsonFile` (the file-backed `NoydbStore`). Copy the minimal necessary implementation into a new private module, e.g. `to-nfs/src/internal-file-store.ts`, adjusting its hub contract imports to `@noy-db/hub/adapter`. Keep it to what `to-nfs` actually uses (the `jsonFile` factory behaviour over a directory path). Do NOT add NFS-native features.
- [ ] **Step 3: Rewire `to-nfs/src/index.ts`**

Replace `import { jsonFile } from '@noy-db/to-file'` with an import of the inlined factory from `./internal-file-store.js`. Repoint the `@noy-db/hub` contract import (`NoydbStore`) to `@noy-db/hub/adapter`. Leave `runMountDiagnostics` and the NFS-mount logic as-is.
- [ ] **Step 4: Install + guard + gates**

```bash
cd /Users/vicio/lanna-db/noy-db-to && pnpm install && pnpm check:architecture
grep -rn "@noy-db/to-file" to-nfs/   # MUST be empty — dependency fully severed
pnpm --filter @noy-db/to-nfs build && pnpm --filter @noy-db/to-nfs test && pnpm --filter @noy-db/to-nfs typecheck && pnpm --filter @noy-db/to-nfs lint
```
Expected: no `@noy-db/to-file` reference anywhere in `to-nfs/`; guard OK; to-nfs's tests pass with the inlined store. (If its tests specifically asserted `to-file` integration, adapt them to the inlined module — keep coverage equivalent.)
- [ ] **Step 5: Grep + commit**

```bash
git diff --staged | grep -i "<pilot-client-name>" && echo STOP || echo clean
git add -A && git commit -m "feat(relocate): to-nfs — minimal sever of @noy-db/to-file (inlined file store); NFS-native tracked in #1"
```

---

## Self-review (against decisions)

- All 16 departing stores relocated (turso pilot + 15 here); each peers the range + imports only `/adapter`; guard green. ✓
- Intra-deps preserved in-workspace (r2→s3, supabase→postgres); SDK peers untouched. ✓
- Bundle stores (drive/icloud) bind the bundle contract via `/adapter` (1b-A). ✓
- `to-browser-local` uses the vendored private harness (no edit to its devDep). ✓
- `to-nfs` severs `to-file` (minimal, self-contained); NFS-native → issue #1. ✓
- Recipe addenda (bugs.url, README, newline) applied to all incl. to-turso. ✓
- Branch not pushed; finalization (drop link, published range, push, CI) is the next step, gated on the step-2 `@noy-db` publish. ✓

## Next

- **1b-B finalization (post step-2 publish):** remove the `pnpm.overrides` link; `pnpm install` against the published `@noy-db/hub@^0.2.0-pre.31`; align store versions to the noy-db-to lockstep line; push `feat/relocate-stores`; confirm CI green; ready to merge.
- **1b-C (noy-db):** delete the 16 store dirs + cleanup (features.yaml 16 adapters + 9 topologies, 21 showcases + showcases/package.json + `_d1-sdk.ts`, typedoc/tsconfig.typedoc, cli config.ts scaffolding, CONTRIBUTING:135, README, docs).
