# Step 1b-B (pilot) — relocate `to-turso` into noy-db-to + set up the relocation harness

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Prove the store-relocation chain end-to-end with one lightweight pilot (`to-turso`): set up the temporary local-link bridge + the vendored private conformance harness in `noy-db-to`, then relocate `to-turso` (import → `@noy-db/hub/adapter`, peer `@noy-db/hub` at a published **range**, its own tests green via the link, the sibling guard passing). Once this is green, a follow-up plan batches the other 15 stores + the `to-nfs` rewrite.

**Architecture:** Work on a `feat/relocate-stores` branch in `noy-db-to`. Because the `@noy-db/hub` version carrying the extended `/adapter` isn't published yet, dev resolves `@noy-db/hub` via a **temporary pnpm `overrides: link:` to `../noy-db/packages/hub`** (the local working tree is on the 1b-A branch, which has the extended `/adapter`). Each store's `package.json` still *declares* the real published peer-range; the link is a dev-only override removed at finalization (post step-2 publish). The branch is NOT pushed/merged until then.

**Tech Stack:** pnpm 9.15.4, vitest, tsup (ESM-only), TypeScript strict, Node ≥22.

**Parent spec:** `docs/superpowers/specs/2026-06-27-extract-stores-to-noy-db-to-design.md` (Step 1 extraction). Depends on 1b-A (extended `/adapter` + private conformance) being present in the local `../noy-db` working tree.

## Global Constraints

- No Claude/Anthropic attribution in commits/PRs/docs.
- Never reference the private pilot client by name — grep before committing.
- Never publish. This plan does not publish; the relocation branch is not even pushed.
- ESM-only, Node ≥22. Stores see ciphertext only — no crypto deps.
- **Repo:** `/Users/vicio/lanna-db/noy-db-to`, branch `feat/relocate-stores` (created in T1). The local sibling `/Users/vicio/lanna-db/noy-db` must be on the `feat/adapter-bundle-and-reprivate-conformance` branch (1b-A — has extended `/adapter`) — confirm in T1.
- **Seam discipline (enforced by `noy-db-to`'s guard):** every store peers `@noy-db/hub` at a published RANGE (never `workspace:*`) and imports `@noy-db/hub` only via `/adapter`.
- **Published-range floor:** use `"@noy-db/hub": "^0.2.0-pre.31"` (the step-2 release that will carry the extended `/adapter`). This is the declared peer; dev resolution uses the link. Finalization confirms it matches the actual published version.
- The link override is **temporary** — clearly commented, removed at finalization.
- Build the local hub with `NODE_OPTIONS=--max-old-space-size=8192` (DTS OOM on default heap).
- Verify before claiming done.

---

### Task 1: Relocation harness — branch, local-link bridge, vendored conformance harness

**Files (in `/Users/vicio/lanna-db/noy-db-to`):**
- Modify: `package.json` (add temporary `pnpm.overrides` link), `pnpm-workspace.yaml` (add `test-support`)
- Create: `test-support/package.json`, `test-support/src/index.ts` (vendored, private harness)

**Interfaces:**
- Produces: a `noy-db-to` workspace where `@noy-db/hub` resolves to the local 1b-A hub (so `/adapter` incl. the bundle contract is available), and a **private** `@noy-db/test-adapter-conformance` harness consumable by stores via `workspace:*`. T2+ rely on both.

- [ ] **Step 1: Confirm prerequisites + branch**

```bash
# the local noy-db must be on the 1b-A branch (extended /adapter present)
git -C /Users/vicio/lanna-db/noy-db rev-parse --abbrev-ref HEAD   # expect feat/adapter-bundle-and-reprivate-conformance
grep -c "NoydbBundleStore" /Users/vicio/lanna-db/noy-db/packages/hub/src/adapter/index.ts   # expect >=1
cd /Users/vicio/lanna-db/noy-db-to
git checkout -b feat/relocate-stores
```
If noy-db is NOT on the 1b-A branch (or `/adapter` lacks the bundle symbols), STOP and report — the link would resolve a hub without the extended seam.

- [ ] **Step 2: Build the local hub (so the link resolves `/adapter` incl. bundle symbols)**

```bash
NODE_OPTIONS="--max-old-space-size=8192" pnpm -C /Users/vicio/lanna-db/noy-db --filter @noy-db/hub build 2>&1 | tail -2
ls /Users/vicio/lanna-db/noy-db/packages/hub/dist/adapter/   # expect index.js + index.d.ts
```

- [ ] **Step 3: Add the temporary local-link override**

In `/Users/vicio/lanna-db/noy-db-to/package.json`, add a top-level `pnpm.overrides` block (root is `private`, so this is dev-only and never published):

```json
  "pnpm": {
    "overrides": {
      "@noy-db/hub": "link:../noy-db/packages/hub"
    }
  }
```
Add a `"//pnpm-overrides"` note field above it: `"TEMPORARY dev bridge until @noy-db/hub@^0.2.0-pre.31 is published (step-2). Remove at finalization so CI resolves the published package."`

- [ ] **Step 4: Workspace includes the harness**

In `pnpm-workspace.yaml`, add `test-support`:
```yaml
packages:
  - "to-*"
  - "test-support"
```

- [ ] **Step 5: Vendored private conformance harness**

`test-support/package.json` (private, source-only, same NAME as noy-db's so `to-browser-local`'s `workspace:*` devDep resolves here with no edit):
```json
{
  "name": "@noy-db/test-adapter-conformance",
  "version": "0.0.0",
  "private": true,
  "description": "Parameterized adapter contract tests (vendored, noy-db-to)",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run --passWithNoTests"
  },
  "devDependencies": {
    "@noy-db/hub": "^0.2.0-pre.31",
    "vitest": "^3.0.0"
  }
}
```
Then copy the harness source verbatim from the sibling:
```bash
mkdir -p /Users/vicio/lanna-db/noy-db-to/test-support/src
cp /Users/vicio/lanna-db/noy-db/test-harnesses/adapter-conformance/src/index.ts /Users/vicio/lanna-db/noy-db-to/test-support/src/index.ts
```
(Its imports already target `@noy-db/hub/adapter` — leave as-is.)

- [ ] **Step 6: Install + verify the bridge resolves**

```bash
cd /Users/vicio/lanna-db/noy-db-to
pnpm install
# confirm the link resolved and /adapter (with bundle contract) is reachable through it:
node --input-type=module -e "import('@noy-db/hub/adapter').then(m => { if(!m.ConflictError||!m.BundleVersionConflictError) throw new Error('seam missing'); console.log('link OK: ConflictError + BundleVersionConflictError reachable via /adapter') })"
pnpm check:architecture   # no to-* yet → trivially OK
```
Expected: install succeeds; the node check prints "link OK…" (proves the link resolves the extended `/adapter`); guard OK.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore(relocate): set up local-link bridge + vendored private conformance harness"
```

---

### Task 2: Pilot — relocate `to-turso`

**Files:**
- Create: `to-turso/` in `noy-db-to` (copied from `../noy-db/packages/to-turso/`), then edited
- Note: `to-turso` is lightweight — driver-based, no cloud SDK, no intra-store deps, hand-written tests (no conformance harness). Ideal first proof.

**Interfaces:**
- Consumes: `@noy-db/hub/adapter` (via the link), the noy-db-to guard, the workspace.
- Produces: `@noy-db/to-turso` living in `noy-db-to`, peering the published hub range, importing only `/adapter`, tests green. Establishes the per-store recipe for the batch.

- [ ] **Step 1: Copy the package**

```bash
cp -R /Users/vicio/lanna-db/noy-db/packages/to-turso /Users/vicio/lanna-db/noy-db-to/to-turso
rm -rf /Users/vicio/lanna-db/noy-db-to/to-turso/node_modules /Users/vicio/lanna-db/noy-db-to/to-turso/dist /Users/vicio/lanna-db/noy-db-to/to-turso/.turbo 2>/dev/null || true
```

- [ ] **Step 2: Repoint the contract import to `/adapter`**

In `to-turso/src/index.ts`, change the contract import (currently `from '@noy-db/hub'`) to `from '@noy-db/hub/adapter'`. Per the survey it is:
```typescript
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, TxOp, ListPageResult } from '@noy-db/hub/adapter'
import { ConflictError } from '@noy-db/hub/adapter'
```
(Grep the file first to confirm the exact symbol list; move only the contract symbols.)

- [ ] **Step 3: Fix the `package.json` for the new repo**

In `to-turso/package.json`:
- `peerDependencies["@noy-db/hub"]`: `"workspace:*"` → `"^0.2.0-pre.31"` (published range).
- `devDependencies["@noy-db/hub"]`: `"workspace:*"` → `"^0.2.0-pre.31"`.
- `repository`: change `url` to `git+https://github.com/vLannaAi/noy-db-to.git` and **remove** the `directory` field (the package is at the repo root now).
- `homepage`: → `https://github.com/vLannaAi/noy-db-to/tree/main/to-turso#readme`.
- Leave `@types/node` and all other fields as-is.

- [ ] **Step 4: Fix the `tsconfig.json` extends depth**

In `to-turso/tsconfig.json`, change `"extends": "../../tsconfig.base.json"` → `"extends": "../tsconfig.base.json"` (the store is now one level below the repo root, not two).

- [ ] **Step 5: Install + verify the full chain**

```bash
cd /Users/vicio/lanna-db/noy-db-to
pnpm install
pnpm check:architecture                       # hub-peer-range (range ✓), adapter-only (/adapter ✓), no-crypto ✓
pnpm --filter @noy-db/to-turso build           # tsup ESM
pnpm --filter @noy-db/to-turso test            # its own hand-written tests, green via the linked hub
pnpm --filter @noy-db/to-turso typecheck
pnpm --filter @noy-db/to-turso lint
```
Expected: ALL green. Critically, `check:architecture` must PASS — proving the guard accepts a store that peers a range and imports `/adapter`. The store's tests pass resolving `@noy-db/hub` through the link.

- [ ] **Step 6: Confirm the guard would REJECT a regression (sanity)**

```bash
cd /Users/vicio/lanna-db/noy-db-to
# temporarily break it to confirm the guard bites, then restore:
node -e "const f='to-turso/package.json';const fs=require('fs');const p=JSON.parse(fs.readFileSync(f));p.peerDependencies['@noy-db/hub']='workspace:*';fs.writeFileSync(f,JSON.stringify(p,null,2))"
pnpm check:architecture; echo "exit=$?"      # expect FAIL (exit 1, hub-peer-range)
git checkout to-turso/package.json 2>/dev/null || node -e "const f='to-turso/package.json';const fs=require('fs');const p=JSON.parse(fs.readFileSync(f));p.peerDependencies['@noy-db/hub']='^0.2.0-pre.31';fs.writeFileSync(f,JSON.stringify(p,null,2))"
pnpm check:architecture; echo "exit=$?"      # expect OK (exit 0)
```
Expected: guard fails on `workspace:*`, passes once restored to the range. (This proves the guard is live for real stores, not just fixtures.) Ensure the file is restored to the range before committing.

- [ ] **Step 7: Grep for the client name, then commit**

```bash
git diff --staged | grep -i "<pilot-client-name>" && echo "STOP" || echo "clean"
git add -A
git commit -m "feat(relocate): pilot — relocate @noy-db/to-turso onto the published /adapter seam"
```

---

## Self-review (against decisions)

- **Local-link bridge** lets us verify before the step-2 publish; declared peer is the real published range. ✓
- **Vendored private harness** (same name, `workspace:*`) — no edit needed in `to-browser-local` later. ✓
- **Pilot proves the chain**: `/adapter` import, range peer, guard accept + reject, tests green. ✓
- **tsconfig depth** (`../../ → ../`) handled — the gotcha for every relocated store. ✓
- **Branch only, not pushed** — noy-db-to `main` stays green; finalization (post-publish) removes the link + pushes. ✓

## Next (follow-up plans, after this pilot is green)

- **1b-B batch:** relocate the other 14 envelope/bundle stores using this recipe — incl. intra-deps (`to-supabase`→`to-postgres`, `to-cloudflare-r2`→`to-aws-s3`, kept as workspace deps), SDK peers (`to-aws-s3`/`to-aws-dynamo`/`to-cloudflare-r2`), the bundle stores (`to-drive`/`to-icloud` import `NoydbBundleStore`+`BundleVersionConflictError` from `/adapter`), and `to-browser-local` (uses the vendored harness + `happy-dom`).
- **1b-B `to-nfs`:** fresh self-contained reimplementation of `NoydbStore` over an NFS mount — **sever the `@noy-db/to-file` dependency** (D5). Its own task (the one non-mechanical store).
- **1b-B finalization (post step-2 publish):** remove the link override, confirm the published `@noy-db/hub@^0.2.0-pre.31` range resolves, CI green, ready to merge.
- **1b-C (noy-db):** delete the 16 dirs + cleanup (features.yaml/showcases/typedoc/cli/docs).
