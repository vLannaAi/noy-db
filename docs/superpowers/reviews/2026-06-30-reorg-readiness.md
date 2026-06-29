# Hub Reorg-Readiness Inventory

Target: `/Users/vicio/lanna-db/noy-db/packages/hub`
Checked-out branch at audit time: `docs/hub-reorg-and-edge-crypto-specs` (working tree, post-#306). Read-only audit.
Plan: re-derive prior commit `f6127e62`'s 7-dimension grouping on current main, with a `with-` prefix on each dimension folder.

> NOTE on branch: the working copy is NOT `main` and NOT `f6127e62` — it is `docs/hub-reorg-and-edge-crypto-specs`. `git ls-tree f6127e62` was not reachable from this checkout, so the "new since f6127e62" diff could not be computed against that SHA. The structural inventory below reflects the current working tree, which is what the reorg will actually run against.

---

## 1. Folder inventory → target dimension

`src/` holds **46 subdirectories** + 20 top-level `.ts` files. Every one of the 46 folders maps cleanly:

**MOVED (36 folders → 7 dimensions):**

| Dimension | Folders |
|---|---|
| `with-lookup` | aggregate, embeddings, indexing, search |
| `with-commit` | crdt, history, numbering, sequence, tx |
| `with-formula` | computed, derivations, materialized-views, overlay-views |
| `with-shape` | blobs, i18n, introspection, links, money, persisted-schemas, schema-update |
| `with-audit` | attestation, consent, forget, guards, periods, sealed-record |
| `with-fork` | archive, bundle, shadow, snapshots |
| `with-party` | auth-introspection, custody, directory, session, sync, team |

**STAYS at `src/` top (kernel/plumbing, 10 folders):**
query, meta, record-keys, adapter, store, cache, kernel, coordination, policy, util

**Top-level `.ts` files (stay):** collection.ts, constants.ts, crypto.ts, debug.ts, env-check.ts, errors.ts, events.ts, index.ts, noydb.ts, refs.ts, schema.ts, subsystem-bus.ts, tab-coordination.ts, tab-write-relay.ts, types.ts, validation.ts, vault-diff.ts, vault.ts, write-hooks.ts, write-queue.ts

### UNMAPPED folders: **NONE.**
Programmatic check: `folders-on-disk (46) == mapped (46)`, set-difference both directions = empty. The plan's mapping is **complete and exact** against the current tree. In particular the two #306-adjacent dirs the prompt flagged as risks — `sealed-record` (→ with-audit) and `record-keys` (→ stays) — already exist and are already in the mapping. No new orphan folder to assign a target to.

---

## 2. Cross-subsystem internal imports (codemod must rewrite)

These are sibling imports today (`../<sub>/...`, depth 1). After the move, depth changes and many cross a dimension boundary. The codemod must **recompute relative depth from each file's new location** — not just string-swap a prefix — because subsystems contain nested files (e.g. `guards/*`) whose imports are already `../../`.

### A. CROSS-DIMENSION moved→moved (become `../../with-Y/...` from a top-level subsystem file):
```
aggregate (lookup)        -> i18n (shape)            [1]
aggregate (lookup)        -> money (shape)           [4]
attestation (audit)       -> bundle (fork)           [1]
bundle (fork)             -> history (commit)        [6]
bundle (fork)             -> persisted-schemas (shape)[1]
bundle (fork)             -> team (party)            [8]
consent (audit)           -> bundle (fork)           [1]
custody (party)           -> bundle (fork)           [2]
derivations (formula)     -> guards (audit)          [2]
derivations (formula)     -> tx (commit)             [1]
embeddings (lookup)       -> i18n (shape)            [1]
forget (audit)            -> history (commit)        [1]
guards (audit)            -> i18n (shape)            [1]
i18n (shape)              -> history (commit)        [3]
i18n (shape)              -> team (party)            [3]
introspection (shape)     -> computed (formula)      [1]
introspection (shape)     -> team (party)            [1]
materialized-views(form.) -> aggregate (lookup)      [4]
materialized-views(form.) -> i18n (shape)            [2]
materialized-views(form.) -> money (shape)           [1]
materialized-views(form.) -> tx (commit)             [2]
money (shape)             -> aggregate (lookup)       [2]
periods (audit)           -> history (commit)         [3]
search (lookup)           -> i18n (shape)             [3]
session (party)           -> bundle (fork)            [1]
team (party)              -> bundle (fork)            [1]
tx (commit)               -> bundle (fork)            [1]
tx (commit)               -> guards (audit)           [4]
```

### B. SAME-DIMENSION moved→moved (stay siblings under the same `with-X/`, path unchanged for top-level files but still re-derived for nested ones):
```
auth-introspection -> team               (party)
custody            -> team               (party)
indexing           -> aggregate          (lookup)
introspection      -> i18n               (shape)
introspection      -> money              (shape)
introspection      -> persisted-schemas  (shape)
materialized-views -> derivations        (formula)
overlay-views      -> materialized-views  (formula)
persisted-schemas  -> schema-update      (shape)
schema-update      -> persisted-schemas  (shape)
session            -> team               (party)
snapshots          -> bundle             (fork)
sync               -> team               (party)
team               -> directory          (party)
tx                 -> history            (commit)
```

### C. moved→KERNEL-STAYS (become `../../<stays>/...`):
```
aggregate->query[2]  auth-introspection->policy[2]  blobs->record-keys[1]
bundle->meta[3]      bundle->record-keys[2]         custody->policy[2]
guards->query[2]     indexing->query[4]             materialized-views->query[6]
money->query[2]      schema-update->coordination[2] search->query[1]
shadow->query[1]     team->meta[1]  team->policy[1] team->store[3]
```

### D. KERNEL-STAYS dir → moved subsystem (become `../with-X/...`):
```
query  -> aggregate[14], money[8], indexing[3], i18n[1]
kernel -> aggregate[3], search[3], bundle[1], indexing[1], introspection[1]
record-keys -> sealed-record[1], team[1]
coordination -> schema-update[2]
```
(`kernel/index.ts` is the FROZEN seam — additive only. Re-pointing its internal imports to `../with-X/` is fine since the seam is its *exports*, not its import paths; verify no export *path string* leaks.)

### E. TOP-LEVEL `src/*.ts` → moved subsystem (become `./with-X/<sub>/...`):
High-volume — these dominate the in-source codemod surface (`./<sub>/` → `./with-X/<sub>/`):
```
team 60, i18n 22, bundle 19, blobs 17, history 16, introspection 15,
session 11, tx 11, search 11, guards 11, schema-update 10, indexing 10,
derivations 10, materialized-views 9, crdt 8, money 6, overlay-views 6,
archive 6, numbering 6, custody 6, forget 5, computed 5, persisted-schemas 5,
consent 5, periods 5, snapshots 4, shadow 4, directory 3, embeddings 3,
aggregate 3, sequence 3, links 3, auth-introspection 2, attestation 2
```
(driven mostly by `collection.ts` / `vault.ts` / `noydb.ts` call-sites — which themselves do NOT move).

---

## 3. Mechanics the plan must cover

- **package.json `exports`: 28 entries** (`.` + 27 subpaths). Targets are `./dist/<name>/index.{js,d.ts}` — the **public subpath names DO NOT change** (`./i18n`, `./team`, `./kernel`, …). The dist layout is driven by the tsup output key, so exports can stay byte-identical **if** the tsup output keys are kept (see next). No `typesVersions`, no `files` override surprises. Of the 46 folders, only **27 have a subpath export**; the other ~19 moved folders (computed, links, money, numbering, sequence, archive, custody, directory, auth-introspection, embeddings, search, introspection, persisted-schemas, schema-update, …) are barrel-only, so moving them touches **internal imports only**, not exports.
- **tsup `tsup.config.ts` ENTRIES: 28 entries**, each maps an output key → **source path** e.g. `'i18n/index': 'src/i18n/index.ts'`. **These source paths DO change** → must become `'src/with-shape/i18n/index.ts'`, etc. KEEP the output key (`'i18n/index'`) unchanged so `dist/i18n/index.js` and the public subpath stay stable. This is the single most important config edit: **rewrite the RHS of all 27 subsystem ENTRIES; leave the LHS keys alone.** (`index: 'src/index.ts'` is unaffected.)
- **tsconfig.json:** trivial — `extends: ../../tsconfig.base.json`, `rootDir: src`, `include: [src]`, `outDir: dist`. No per-subsystem path mapping, no `paths` aliases. **No change needed.** Extra folder nesting depth (src → src/with-X/sub) is irrelevant to rootDir/include.
- **architecture `kernel-surface` ratchet** (`scripts/check-architecture.mjs`): line-count ceilings keyed ONLY on `packages/hub/src/collection.ts` (5740), `packages/hub/src/vault.ts` (4677), `packages/hub/src/noydb.ts` (3140). All three are **top-level files that STAY** → ratchet keys unaffected. No other check in `check-architecture.mjs` keys on a moving folder path (verified: no `src/<subsystem>/` path logic, only comments). Safe.
- **No other config references subsystem source paths** — no vitest.config / knip config / eslintrc references to `src/<sub>`.

---

## 4. Landmines

1. **`git mv` under zsh word-splitting (prior failure a).** Do NOT loop `for d in $list; git mv src/$d src/with-X/$d` in zsh — zsh doesn't word-split unquoted vars by default, so a space-joined list becomes one token and the mv mis-fires. Use an explicit per-folder `git mv` list, or `print -l`/arrays, or run the loop under `bash`, not interactive zsh. Recommend: generate one `git mv` line per folder (46 lines) and execute as a script with `set -e`.
2. **Test-import second pass (prior failure b).** In-source codemod and test-import codemod are SEPARATE passes; the prior attempt missed the test corpus on the first run. Current scale is **LARGER than the prior 438 refs / 224 files**: see §5.
3. **Relative-depth recompute, not prefix-swap.** Subsystems have nested files whose imports are already `../../`. A naive `s|../|../../|` is wrong. The codemod must resolve each import to an absolute module then re-emit the correct relative path from the file's NEW location. Cross-dimension imports (§2A) go from `../` to `../../with-Y/`; same-dimension nested imports may stay `../../`.
4. **`kernel/index.ts` frozen seam.** Re-pointing kernel's *internal* imports (§2D) is fine, but confirm no exported value/type path string changes shape; the seam contract is the export set, which is preserved.
5. **Keep tsup output keys = public subpaths.** If someone "tidies" the ENTRIES keys to `with-shape/i18n/index` while editing, every published `@noy-db/hub/i18n` subpath breaks and the exports map silently points at a non-existent dist file. Edit RHS only.
6. **`.js` extension imports.** All imports use explicit `.js` (ESM, e.g. `from '../i18n/policy.js'`). The codemod regex must include the `.js` and the nested sub-path, not just the folder.
7. **Barrel-only folders still need import rewrites** even though they have no export entry (§2 covers them) — don't scope the codemod to only the 27 exported subsystems.

---

## 5. Test-import-rewrite scale (current tree)

- Total test files under `__tests__/`: **333** `.test.ts` (340 `.ts` incl. helpers).
- Test files importing a subsystem via relative `../src/<sub>/…`: **260 files**.
- Total such import-path references: **471**.
- Of those, references into a **MOVED** subsystem (need rewrite): **~404** (471 minus ~67 into stays-dirs: query 22, policy 20, coordination 7, store 6, meta 5, util 3, record-keys 2, cache 2).
- Heaviest test targets: i18n 53, history 46, bundle 39, team 38, aggregate 36, schema-update 26, money 20, tx 18, blobs 18, guards 14, search 12, persisted-schemas 11, derivations 11.
- **This exceeds the prior attempt's 438 refs / 224 files** (growth since f6127e62), so budget the test codemod pass for ~471 refs across 260 files and re-run `pnpm --filter @noy-db/hub test` + `pnpm typecheck` after.

NOTE: tests that import via the PUBLISHED subpath (`@noy-db/hub/i18n`) need NO change — public subpaths are preserved. Only relative `../src/<sub>/` deep-imports are affected.
