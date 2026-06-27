# Step 1b-C — Remove the 16 departing stores from noy-db + clean all references

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Delete the 16 departing storage adapters from the noy-db monorepo (they now live in `noy-db-to`) and clean every reference so noy-db stays fully green — `features.yaml` (adapters + topologies + showcase entries), the 21 cloud showcases, typedoc/tsconfig configs, CONTRIBUTING, README, and the store docs. The cloud showcases + topologies are DROPPED (per user decision), not moved.

**Architecture:** Branch `feat/extract-stores` in `/Users/vicio/lanna-db/noy-db` (stacked on the 1b-A branch). The publish set, pnpm workspace, turbo, knip are all dynamic (glob-driven), so deleting dirs auto-removes packages from publishing — no hardcoded package list to edit. The storage-capability-matrix doc is GENERATED from `features.yaml` — regenerate it, don't hand-edit.

**Tech Stack:** pnpm + turbo, vitest, tsup, TypeScript strict, ESM-only, Node ≥22.

**Parent spec:** `docs/superpowers/specs/2026-06-27-extract-stores-to-noy-db-to-design.md` (Step 1). The relocation side (noy-db-to) is done (Step 1b-B).

## Global Constraints

- No Claude/Anthropic attribution; no client/company name (grep before commit). Never publish.
- ESM-only, Node ≥22. Build hub with `NODE_OPTIONS=--max-old-space-size=8192` (DTS OOM).
- **The 16 departing stores** (delete these `packages/` dirs): `to-aws-dynamo`, `to-aws-s3`, `to-browser-local`, `to-cloudflare-d1`, `to-cloudflare-r2`, `to-drive`, `to-icloud`, `to-mysql`, `to-nfs`, `to-postgres`, `to-smb`, `to-sqlite`, `to-ssh`, `to-supabase`, `to-turso`, `to-webdav`.
- **The 5 essentials STAY** (do NOT touch): `to-memory`, `to-file`, `to-browser-idb`, `to-probe`, `to-meter`.
- **npm names are unchanged** — the moved stores keep `@noy-db/to-*` names (published from noy-db-to). So any *generated* import-string referencing them (e.g. in `cli/src/commands/config.ts`) stays VALID and needs NO change. Only fix things that BREAK (dead file paths, dead workspace deps, broken doc links) or that recommend a now-departed store as a noy-db default.
- Verify before claiming done.

---

### Task 1: Delete the 16 store packages + remove the cloud showcases

**Files:**
- Delete: the 16 `packages/to-X/` dirs (list above).
- Delete: the 21 cloud showcase test files + the `_d1-sdk.ts` helper (and any now-orphaned helpers).
- Modify: `showcases/package.json` (remove the 14 departing workspace deps).

**Interfaces:** Produces a noy-db with only the 5 essential `to-*` stores; remaining showcases/code have no dangling imports of departing stores.

- [ ] **Step 1: Delete the 16 store directories**

```bash
cd /Users/vicio/lanna-db/noy-db
for s in to-aws-dynamo to-aws-s3 to-browser-local to-cloudflare-d1 to-cloudflare-r2 to-drive to-icloud to-mysql to-nfs to-postgres to-smb to-sqlite to-ssh to-supabase to-turso to-webdav; do git rm -r "packages/$s"; done
ls -d packages/to-*/ | tr '\n' ' '   # expect exactly: to-browser-idb to-file to-memory to-meter to-probe
```

- [ ] **Step 2: Delete the cloud showcase test files + helper**

```bash
cd /Users/vicio/lanna-db/noy-db/showcases/src
git rm 04-storage-cloud.showcase.test.ts 53-storage-browser-local.showcase.test.ts 54-storage-sqlite.showcase.test.ts 57-storage-aws-s3.showcase.test.ts 58-storage-postgres.showcase.test.ts 59-topology-aws-offline-online.showcase.test.ts 60-storage-cloudflare-r2.showcase.test.ts 61-storage-cloudflare-d1.showcase.test.ts 62-topology-cloudflare-offline-online.showcase.test.ts 63-topology-cloudflare-bindings.workers.test.ts 64-storage-supabase.showcase.test.ts 65-topology-supabase-records-blobs.showcase.test.ts 66-topology-supabase-offline-online.showcase.test.ts 67-storage-turso.showcase.test.ts 68-storage-webdav.showcase.test.ts 69-topology-webdav-blobs.showcase.test.ts 73-storage-mysql.showcase.test.ts 74-storage-ssh.showcase.test.ts 75-storage-smb.showcase.test.ts 76-storage-nfs.showcase.test.ts 97-snapshots-s3-bundle.showcase.test.ts _d1-sdk.ts
```

- [ ] **Step 3: Remove the 14 departing workspace deps from `showcases/package.json`**

Remove these lines from `dependencies`: `@noy-db/to-aws-dynamo`, `@noy-db/to-aws-s3`, `@noy-db/to-browser-local`, `@noy-db/to-cloudflare-d1`, `@noy-db/to-cloudflare-r2`, `@noy-db/to-mysql`, `@noy-db/to-nfs`, `@noy-db/to-postgres`, `@noy-db/to-smb`, `@noy-db/to-sqlite`, `@noy-db/to-ssh`, `@noy-db/to-supabase`, `@noy-db/to-turso`, `@noy-db/to-webdav`. (`to-drive`/`to-icloud` were not in showcases/package.json.) Keep essentials (`to-memory`, `to-meter`, etc.).

- [ ] **Step 4: Find + remove now-orphaned showcase helpers**

```bash
cd /Users/vicio/lanna-db/noy-db
# helpers that were only used by deleted showcases (no remaining importer):
for h in showcases/src/_r2-binding-store.ts showcases/src/_supabase-storage-store.ts showcases/src/_docker.ts; do
  [ -f "$h" ] && { grep -rln "$(basename "$h" .ts)" showcases/src --include='*.ts' | grep -v "$(basename "$h")" || git rm "$h"; }
done
# then scan for ANY remaining import of a departing store in non-test, non-deleted code:
grep -rEn "@noy-db/(to-aws-dynamo|to-aws-s3|to-browser-local|to-cloudflare-d1|to-cloudflare-r2|to-drive|to-icloud|to-mysql|to-nfs|to-postgres|to-smb|to-sqlite|to-ssh|to-supabase|to-turso|to-webdav)" showcases/src packages/*/src packages/*/__tests__ recipes playground 2>/dev/null | grep -v "JSDoc\|^\s*\*\|//" || echo "no live imports of departing stores remain"
```
Remove any orphaned helper the first loop flags; investigate any live-import hit from the second grep (a remaining showcase importing a deleted helper must be removed or fixed).

- [ ] **Step 5: Verify (workspace + remaining showcases compile)**

```bash
cd /Users/vicio/lanna-db/noy-db
pnpm install
pnpm check:architecture
pnpm --filter @noy-db/showcases typecheck 2>&1 | tail -20   # must have NO dangling import of a departing store
```
Expected: install clean; guard OK (now scans 5 essential to-* + other families); showcases typecheck clean (remaining showcases don't import departed stores/helpers). NOTE: `validate:features` will still FAIL here — features.yaml is cleaned in Task 2; that's expected.

- [ ] **Step 6: Grep client name + commit**

```bash
git diff --staged | grep -i "<pilot-client-name>" && echo STOP || echo clean
git add -A
git commit -m "refactor(extract): remove the 16 departing to-* stores + their cloud showcases from noy-db"
```

---

### Task 2: Clean `features.yaml` + regenerate the storage matrix

**Files:** Modify `features.yaml`; regenerate `docs/subsystems/storage-capability-matrix.md`.

**Interfaces:** Produces a `features.yaml` with no references to departing stores; `validate:features` reports 0 dangling.

- [ ] **Step 1: Remove the 16 departing ADAPTER entries** from `features.yaml` (the `adapters:` section), by id: `to-aws-dynamo`, `to-aws-s3`, `to-browser-local`, `to-cloudflare-r2`, `to-cloudflare-d1`, `to-supabase`, `to-postgres`, `to-mysql`, `to-sqlite`, `to-turso`, `to-webdav`, `to-ssh`, `to-smb`, `to-nfs`, `to-icloud`, `to-drive`. (Remove each entry block in full.)

- [ ] **Step 2: Remove the 9 cloud TOPOLOGY entries** (they `compose` departing adapters), by id: `accounting-stack`, `realtime-crdt-stack`, `analytics-stack`, `aws-offline-tablet`, `byo-blob-webdav`, `cloudflare-edge-team`, `supabase-team`, `cloudflare-worker-bindings`, `accounting-app`.

- [ ] **Step 3: Remove the SHOWCASE entries** for the 21 deleted showcase files (their `path:` no longer resolves). Find them:

```bash
cd /Users/vicio/lanna-db/noy-db
grep -nE "path: showcases/src/(04-storage-cloud|53-storage-browser-local|54-storage-sqlite|57-storage-aws-s3|58-storage-postgres|59-topology-aws-offline-online|60-storage-cloudflare-r2|61-storage-cloudflare-d1|62-topology-cloudflare-offline-online|63-topology-cloudflare-bindings|64-storage-supabase|65-topology-supabase-records-blobs|66-topology-supabase-offline-online|67-storage-turso|68-storage-webdav|69-topology-webdav-blobs|73-storage-mysql|74-storage-ssh|75-storage-smb|76-storage-nfs|97-snapshots-s3-bundle)" features.yaml
```
Remove each matching showcase entry block.

- [ ] **Step 4: Iterate to 0 dangling**

```bash
cd /Users/vicio/lanna-db/noy-db
pnpm validate:features
```
If it reports dangling cross-references (e.g. a surviving entry's `related:`/`composes.adapters:` still names a removed id, or a surviving showcase references a removed topology), fix each (remove the dangling reference or the now-empty entry) and re-run until it reports success / 0 dangling.

- [ ] **Step 5: Regenerate the storage-capability matrix doc**

```bash
cd /Users/vicio/lanna-db/noy-db
pnpm render:storage-matrix          # regenerates docs/subsystems/storage-capability-matrix.md from features.yaml
pnpm render:storage-matrix -- --check   # must pass (in sync)
pnpm render:diagrams                 # noop, but run for parity with CI spec-coverage
pnpm validate:features               # final: success / 0 dangling
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(extract): drop departing adapters/topologies/showcases from features.yaml + regenerate storage matrix"
```

---

### Task 3: Configs + docs

**Files:** `typedoc.json`, `tsconfig.typedoc.json`, `CONTRIBUTING.md`, `README.md`, `docs/packages/to-stores.md`, `docs/core/03-stores.md`, `docs/subsystems/snapshots.md`, `docs/packages/README.md`, `docs/packages/by-transports.md`, `docs/recipes/*.md`, `docs/th/README.md`.

**Interfaces:** No doc/config references a deleted `packages/to-X` path; cloud stores are pointed to the noy-db-to repo.

- [ ] **Step 1: `typedoc.json`** — remove the 3 departing `entryPoints`: `packages/to-browser-local/src/index.ts`, `packages/to-aws-dynamo/src/index.ts`, `packages/to-aws-s3/src/index.ts`. Keep `hub` + the essential/other entries.

- [ ] **Step 2: `tsconfig.typedoc.json`** — remove the 3 departing `paths` entries (`@noy-db/to-browser-local`, `@noy-db/to-aws-dynamo`, `@noy-db/to-aws-s3`) AND the 3 matching `include` globs (`packages/to-browser-local/src/**/*.ts`, `packages/to-aws-dynamo/src/**/*.ts`, `packages/to-aws-s3/src/**/*.ts`).

- [ ] **Step 3: `CONTRIBUTING.md`** — line ~135 has a post-release verification shell loop listing packages; remove `to-aws-dynamo` and `to-aws-s3` from it (keep `hub`, essentials, `in-nuxt`, etc.).

- [ ] **Step 4: `README.md`** — the moved stores keep their npm names (so `pnpm add @noy-db/to-aws-s3` still works), but README should not present a *departed* store as a noy-db default. Update the ~6 mentions: swap primary store examples to essentials where natural (`to-file`/`to-memory`/`to-browser-idb`), and add a brief pointer that the extended/cloud `to-*` adapters live in the `noy-db-to` repo. Keep it light — don't rewrite the README.

- [ ] **Step 5: `docs/packages/to-stores.md`** — this catalog lists all stores with links to `../../packages/to-*` (now dead for the 16). Rework: keep the 5 essentials (links valid), and replace the 16 departed entries with a short "Extended stores — now in [noy-db-to](https://github.com/vLannaAi/noy-db-to)" section (names + one-line each, linking to noy-db-to). No dead `packages/to-<departed>` links remain.

- [ ] **Step 6: Smaller doc mentions** — update departing-store references in `docs/core/03-stores.md`, `docs/subsystems/snapshots.md` (`to-aws-s3`/`s3Bundle` as snapshot backend → note it's in noy-db-to), `docs/packages/README.md`, `docs/packages/by-transports.md`, `docs/recipes/realtime-crdt-app.md`, `docs/recipes/accounting-app.md`, `docs/recipes/analytics-app.md`, `docs/th/README.md`. For each: if it's a dead `packages/to-<departed>` link, repoint to noy-db-to; if it's prose recommending a departed store, keep the npm-name usage (still valid) and/or note its new home. Don't over-edit.

- [ ] **Step 7: Verify no dead departing-store package links remain in docs/config**

```bash
cd /Users/vicio/lanna-db/noy-db
grep -rEn "packages/(to-aws-dynamo|to-aws-s3|to-browser-local|to-cloudflare-d1|to-cloudflare-r2|to-drive|to-icloud|to-mysql|to-nfs|to-postgres|to-smb|to-sqlite|to-ssh|to-supabase|to-turso|to-webdav)" docs/ README.md CONTRIBUTING.md typedoc.json tsconfig.typedoc.json 2>/dev/null || echo "no dead departing-store package paths remain"
```
Expected: no matches (every `packages/to-<departed>` path reference is gone).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "docs(extract): repoint cloud-store references to noy-db-to; drop dead typedoc/doc paths"
```

---

### Task 4: Final full verification

**Interfaces:** noy-db is green end-to-end after the extraction.

- [ ] **Step 1: Build + typecheck (heap) + lint + guards**

```bash
cd /Users/vicio/lanna-db/noy-db
pnpm install
NODE_OPTIONS="--max-old-space-size=8192" pnpm turbo build typecheck --concurrency=1 2>&1 | tail -15
pnpm turbo lint 2>&1 | tail -8
pnpm check:architecture
pnpm validate:features
pnpm render:storage-matrix -- --check
pnpm knip 2>&1 | tail -20    # no NEW dead code/exports from the removal (e.g. orphaned showcase helpers)
```
Expected: all green; knip reports nothing newly-orphaned by the removal (fix any orphan it flags — e.g. a helper only used by deleted showcases).

- [ ] **Step 2: Targeted tests (full suite runs in CI on the PR)**

```bash
cd /Users/vicio/lanna-db/noy-db
pnpm --filter @noy-db/hub test 2>&1 | grep -iE "Test Files|Tests |passed|failed" | tail -3
pnpm --filter @noy-db/to-memory --filter @noy-db/to-file --filter @noy-db/to-browser-idb test 2>&1 | grep -iE "Tests .*passed|failed" | tail -4
pnpm --filter @noy-db/showcases typecheck 2>&1 | tail -5
```
Expected: hub + the 5 essential stores green; showcases typecheck clean. (The full `pnpm test` matrix is left to CI on the PR — note this in the report.)

- [ ] **Step 3: Confirm the store set + commit any final fixes**

```bash
cd /Users/vicio/lanna-db/noy-db
ls -d packages/to-*/ | tr '\n' ' '   # expect exactly the 5 essentials
git status --short
```
If Steps 1–2 required fixes, commit them: `git commit -am "fix(extract): <what>"`. Otherwise no commit needed.

---

## Self-review (against the blast-radius map)

- 16 store dirs deleted; 5 essentials kept. ✓
- 21 showcases + helpers + 14 showcases/package.json deps removed. ✓
- features.yaml: 16 adapters + 9 topologies + 21 showcase entries removed; validate:features 0 dangling; storage-matrix regenerated. ✓
- typedoc.json (3) + tsconfig.typedoc.json (3 paths + 3 includes) + CONTRIBUTING:135 + README + docs repointed. ✓
- Dynamic publish set / pnpm-workspace / turbo / knip need no edits (glob-driven). ✓
- cli/config.ts NOT changed (generated npm-name strings stay valid; verify cli has no workspace dep on a departing store in Task 4). ✓
- Full test suite → CI on the PR. ✓

## Next

- **PR** for `feat/extract-stores` (stacked on #494) — user-gated.
- **Step-2 release:** after #494 + this merge, cut the `@noy-db` release (pre.31, extended `/adapter`, minus the 16).
- **1b-B finalization:** publish lands → remove noy-db-to's link override, bump store versions to pre.31, push `feat/relocate-stores`, CI green → release noy-db-to.
