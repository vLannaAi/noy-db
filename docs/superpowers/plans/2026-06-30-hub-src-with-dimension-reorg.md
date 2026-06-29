# Hub `src/` `with-*` reorg — Implementation Plan

> **For agentic workers:** execute via superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Relocate the hub's 36 optional subsystems into 7 `with-*` dimension folders, leaving the kernel + plumbing at `src/` top level, with byte-identical public output.

**Architecture:** Pure source relocation + import rewrite. No renames, no decomposition, no `exports` change. Re-derived on current `main` from the `f6127e62` mapping; the bare names become `with-` prefixed.

**Tech Stack:** TypeScript (ESM `.js` specifiers), tsup multi-entry, vitest, pnpm. Repo: `/Users/vicio/lanna-db/noy-db`.

## Global Constraints

- **Public API frozen:** all 28 `package.json` `exports` subpath targets and the `dist/` top-level layout must be **byte-identical** after the move. Only `src/` source paths change.
- **Kernel-surface ratchet untouched:** `collection.ts`/`vault.ts` do not move and are not edited beyond import-path rewrites.
- **Authoritative file list:** the reorg-readiness inventory (`scratchpad/review/reorg-readiness.md`) is the source of truth for which current-`main` folders map where — including any added since `f6127e62`. Reconcile against it before Task 1; any UNMAPPED folder is a STOP-and-confirm.
- **Commit into a worktree immediately** (durability — the prior attempt was lost as uncommitted worktree state).
- No Claude attribution in commits.

## Prerequisite — consolidate crypto BEFORE the move (from the 2026-06-30 review)

The refactoring + architecture reviews found the envelope-build / encrypt-decrypt / CEK / #306 sealed dual-read logic **copy-pasted** across `collection.ts`, `vault.ts`, `record-keys/sealing.ts`, and ~12 subsystem files (the envelope literal ~30×; the security-critical dual-read in 2–3 drifting copies). **Reorging first scatters these copies into 7 folders.** So, before Task 1:

- **Extract `record-codec.ts`** (envelope build + encrypt/decrypt/CEK; `collection.ts` ~4980–5160, 5485–5660) — also the named "encryption-in-the-hub" module the architecture review wants, and the seed of edge-crypto Plan B P2.
- **Dedupe the sealed-slot `iv:data` parse + #306 dual-read** into `record-keys/sealing.ts` (`collection.ts:5559–5579` ↔ `sealing.ts:154–165`).
- **Add `buildEnvelope()`** to kill the ~30× literal.
- **Land the H-1 / M-1 `forget()` security fixes** (review §🔴) in the same consolidated path while it's a single copy.

These are their own commits/PR, before the reorg. See `docs/superpowers/2026-06-30-REVIEW-PACKAGE.md`.

> **Reorg-readiness confirmed (review):** the mapping below is **exact** against current `main` — all 46 `src/` subfolders resolve (36 moved, 10 stay), **0 unmapped**. `tsconfig` needs no change; only the 28 tsup-entry **source paths** change (keys stay = subpaths). Codemod scale: **~404 test-import refs across 260 of 333 test files** (larger than the prototype's 438/224 — budget the second pass). ~75 cross-/same-dimension sibling-import edges; depth-recompute, don't prefix-swap.

## Catalog-drift fixes to fold in (architecture review)

While moving, reconcile catalog ↔ exports ↔ folders: `joins`/`live` (documented, no module/export), `routing` (claimed `@noy-db/hub/routing`, actually `./store`), `transactions` (docs say `/transactions`, export is `./tx`), `team`/`attestation`/`sealed-record` (subpath but no `with*()`). Update `SUBSYSTEMS.md` + `package.json` to match reality.

## Test layout decision (review)

Tests are in a flat `__tests__/` (contra CLAUDE.md "beside source"). The move orphans that from the new structure. **Decide in this pass:** mirror `__tests__/with-*/…` or co-locate. Also extract `__tests__/helpers/` fixtures (172/229 files inline `createNoydb(` with no shared helper) to cut churn during the move.

## The mapping (target)

| dimension | subsystem folders moved in |
|---|---|
| `with-lookup/` | aggregate · embeddings · indexing · search |
| `with-commit/` | crdt · history · numbering · sequence · tx |
| `with-formula/` | computed · derivations · materialized-views · overlay-views |
| `with-shape/` | blobs · i18n · introspection · links · money · persisted-schemas · schema-update |
| `with-audit/` | attestation · consent · forget · guards · periods · sealed-record |
| `with-fork/` | archive · bundle · shadow · snapshots |
| `with-party/` | auth-introspection · custody · directory · session · sync · team |
| **stays top-level** | (dirs) kernel · query · meta · record-keys · adapter · store · cache · coordination · policy · util — (files) collection · vault · noydb · crypto · schema · refs · types · errors · events · validation · subsystem-bus · write-hooks · write-queue · debug · env-check · constants · index · vault-diff · tab-coordination · tab-write-relay |

---

### Task 1: Worktree + reconcile mapping against current main

**Files:** none moved yet.

- [ ] **Step 1:** Create a worktree off current `main`: `git worktree add ../noy-db-reorg -b feat/with-dimension-reorg`. Work there.
- [ ] **Step 2:** Inventory: `ls -1 packages/hub/src/` (dirs only). Diff against the mapping table. For every dir, assert a target. If any dir is absent from the mapping (new since `f6127e62`), STOP and report — do not guess a dimension for a subsystem with security/crypto weight (e.g. anything CEK/sealing-related likely stays kernel-side under `record-keys`).
- [ ] **Step 3:** Commit a `REORG-MAP.md` scratch note in the worktree recording the final dir→target decision (durable record before any move).

### Task 2: Scripted, split-safe folder move

**Files:** all 36 subsystem dirs → `src/with-<dim>/<subsystem>/`.

- [ ] **Step 1:** Write the move as an explicit, split-safe loop (bash array of `"subsystem:dimension"` pairs; `git mv "src/$sub" "src/with-$dim/$sub"`), creating each `with-<dim>/` dir first. NOT a space-split word list (R1 landmine).
- [ ] **Step 2:** Run it. Then verify with an inventory diff: every moved subsystem is under exactly its target `with-*`, top-level kernel dirs untouched, count matches (36 moved).
- [ ] **Step 3:** Commit: `refactor(hub): move optional subsystems into with-* dimension folders (paths only)`. (Imports still broken at this commit — that's fine, next task fixes; keep it as a reviewable move-only commit.)

### Task 3: Rewrite imports across `src/` AND `__tests__/`

**Files:** every `.ts` under `src/` and `__tests__/` that imports a moved subsystem.

- [ ] **Step 1:** Build a codemod (ts-morph or a careful sed over relative specifiers) that rewrites `from '.../<subsystem>/...'` and `from '../src/<subsystem>/...'` to the new `with-<dim>/<subsystem>/` path, for all 36 subsystems. Handle BOTH intra-`src` relative imports and `__tests__` `../src/...` imports (R2 landmine — the prototype missed tests).
- [ ] **Step 2:** Run over `src/` then `__tests__/`. Include cross-dimension sibling imports (R3 — e.g. `with-audit/guards` → `with-commit/history`).
- [ ] **Step 3:** `pnpm --filter @noy-db/hub typecheck` — the `.test.ts` ratchet compile-checks every test file, so a missed import fails here. Expected: clean. Fix any stragglers, re-run.
- [ ] **Step 4:** Commit: `refactor(hub): rewrite imports for with-* dimension folders (src + tests)`.

### Task 4: tsup entries + any path-bearing tooling

**Files:** `packages/hub/tsup.config.*`, `tsconfig*.json`, any glob in build/test config.

- [ ] **Step 1:** Update the tsup multi-entry *source paths* (`src/indexing/index.ts` → `src/with-lookup/indexing/index.ts`) — entry **keys** unchanged (so `dist/` + `exports` stay identical). Check `tsconfig` `include`/path globs and any `vitest.config` source globs; prefix-prefixed folders are still matched by `src/**`, so most globs need no edit — verify.
- [ ] **Step 2:** `pnpm --filter @noy-db/hub build`. Then diff `dist/` top-level entries + every `exports` target against a pre-move build — must be byte-identical layout/keys.
- [ ] **Step 3:** Commit: `chore(hub): point tsup entries at with-* source paths (dist unchanged)`.

### Task 5: Full gate verification

- [ ] **Step 1:** `pnpm --filter @noy-db/hub typecheck` ✓ · `build` ✓ · `test` (same count as pre-move) ✓ · `node scripts/check-architecture.mjs` ✓ (kernel-surface ratchet still passes — collection.ts/vault.ts unmoved).
- [ ] **Step 2:** Sanity: import a couple of subsystems in a scratch consumer (`@noy-db/hub/indexing`, `@noy-db/hub/team`) and confirm they resolve.
- [ ] **Step 3:** Open PR to `main` (protected — needs CI). Title: `refactor(hub): group optional subsystems into 7 with-* dimension folders`. Body: link this plan + the spec; note "paths only, public API + dist byte-identical."

## Self-review checklist
- Every moved subsystem traces to its mapping row; nothing left unmapped or in the wrong dimension.
- `exports` targets + `dist/` keys diff = empty.
- `__tests__` imports rewritten (typecheck is the proof).
- `collection.ts`/`vault.ts` diff = import-path lines only.
