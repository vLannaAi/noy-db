# Milestone #33 — Via follow-ups 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close milestone #33 — #678 (ViaGraph `_in` single-slot kind overwrite hides a derivation edge from `assertAcyclic`) and #677 (lazy-mode `PersistedCollectionIndex` never canonicalizes or probes money index keys — the lazy twin of #672's eager fix).

**Architecture:** Ground truth is `.superpowers/sdd/m33-seam-map.md` — every call site, line, and excerpt. #678 is contained in `kernel/via/graph.ts` (unbudgeted). #677 spans `with-lookup/indexing/persisted-indexes.ts` + `lazy-builder.ts` + one registration line in `kernel/collection.ts` (at its EXACT zero-slack ceiling).

**Tech Stack:** TypeScript ESM, vitest, packages/hub.

## Global Constraints

- **Ceilings (metric = `split('\n').length`):** `kernel/collection.ts` **4472/4472 — ZERO slack**; `vault.ts` 3939; `noydb.ts` 2385. #677 must add ≥1 line to collection.ts — offset by genuine in-file compression (shrink-first). If shrink-first genuinely can't cover it, a ceiling re-ratchet in `scripts/check-architecture.mjs` is sanctioned by the checker's own fail-message *only with written justification in the report* — prefer shrink-first. `graph.ts` (#678) is unbudgeted.
- **Check 14 (via-layering), EMPTY allowlist:** no `kernel/**` file imports `src/via/**`. Both fixes route through the existing `kernel/via/{index,pipeline}.ts` port (`ViaPipeline`/`ViaBinding` generic folds) exactly as the eager precedent does — no direct `via/money/*` import from kernel or with-lookup.
- **Behavior lock:** full existing suite green except tests a task deliberately updates. TDD per task. No Claude attribution; changeset LOCAL only; conventional commits ending `(#678)` / `(#677)`.

---

### Task 1: #678 — edge-carried kind on `_out` (Option A)

**Seam map:** §B. Self-contained in `packages/hub/src/kernel/via/graph.ts`.

**Files:**
- Modify: `packages/hub/src/kernel/via/graph.ts` — `_out` map type + its 4 touch sites
- Test: `packages/hub/__tests__/via/graph.test.ts` (add the dual-role regression pin)

**The fix (Option A):** change `private _out = new Map<string, FieldRef[]>()` → `Map<string, Array<{ target: FieldRef; kind: EdgeKind }>>`. Four mechanical sites (seam map §B3):
1. `registerDerived` (~:148-150): push `{ target, kind }` instead of bare `target`.
2. `assertAcyclic`'s `neighboursOf` (~:237-244): filter/map on the **edge-local** `kind` (`entry.kind !== 'ref'`) instead of dereferencing `this._in.get(nodeId(t))?.kind` — this is the actual bug fix: the filter now asks "what kind is THIS `source→target` edge" not "what is the target's current (possibly overwritten) registered kind". Return the `.target`s.
3. `assertAcyclic`'s outer `for (const id of this._out.keys())` loop (~:263): untouched (keys are still strings).
4. `referencingEdgesOf` (~:432-442): read `entry.kind === 'ref'` directly off the `_out` entry instead of re-deref'ing `_in` — this ALSO fixes the symmetric ref-vanishes hazard (a real ref edge silently dropped under reverse registration order) for free; note that in a code comment.

Leave `_in` single-slot exactly as is — this task does NOT touch posture/taint folding (that's Option B's larger scope, out of #678's stated scope).

- [ ] **Step 1: failing test.** In `graph.test.ts`, construct a `ViaGraph` directly and reproduce the hazard without needing the (nonexistent) post-open re-validation trigger: register a dual-role target twice — first `registerDerived(T, [A], 'computed', 'record')` then `registerDerived(T, [B], 'ref', 'record', ...)` (mirroring the `vault.ts:1167→1168` order) — where a genuine derivation cycle exists through T's computed edge (A depends on T, T depends on A). Assert `assertAcyclic()` THROWS `DerivationCycleError` (today it wrongly does NOT — the ref-overwrite filters T out of the DFS). Add the companion: a legitimate mutual-FK ref cycle (two collections' ref edges only) still does NOT throw (the #671 behavior stays). Run → the cycle-detection test fails (no throw).
- [ ] **Step 2: implement** Option A per above. Run → both green.
- [ ] **Step 3:** run `pnpm vitest run packages/hub/__tests__/via/graph.test.ts packages/hub/__tests__/via/graph-edges.test.ts packages/hub/__tests__/via/reconcile-guard.test.ts packages/hub/__tests__/via/taint.test.ts` (the `_out`/`referencingEdgesOf`/posture consumers) + `pnpm check:architecture` + `pnpm --filter @noy-db/hub typecheck`. All green.
- [ ] **Step 4: commit** — `fix(hub): assertAcyclic keys the ref-edge filter on the edge, not the target — dual-role targets no longer hide derivation cycles (#678)`.

---

### Task 2: #677 — lazy-mode money index canonicalization + probe path

**Seam map:** §A. BOTH sub-fixes must land together (canonical buckets are useless if the probe doesn't canonicalize the lookup value): (i) bucket-write canonicalization in `PersistedCollectionIndex`, (ii) probe-value canonicalization in the lazy query path.

**Files:**
- Modify: `packages/hub/src/with-lookup/indexing/persisted-indexes.ts` — add `canonicalize?` field + `setCanonicalizer()` (mirror `CollectionIndexes`), thread through `addToState`/`removeFromState` and the `lookupEqual`/`lookupIn`/`lookupRange` probe side
- Modify: `packages/hub/src/with-lookup/indexing/lazy-builder.ts` — thread a `via`/probe reference into `LazyQuerySource<T>` and consult `ViaPipeline` in `resolveCandidateIds()`
- Modify: `packages/hub/src/kernel/collection.ts` — register the canonicalizer on `persistedIndexes` (sibling of the eager line ~:867) + wire `via` into the `lazyQuery()` `LazyQuerySource` literal (~:4287); **ceiling shrink-first required**
- Test: `packages/hub/__tests__/via/money-index-canonical-lazy.test.ts` (new)

**Interfaces:**
- `PersistedCollectionIndex.setCanonicalizer(fn: (field: string, value: unknown) => string | undefined): void` — same shape as `CollectionIndexes`.
- `LazyQuerySource<T>` gains an optional probe seam — either `via?: ViaPipeline` or a narrow `canonicalizeIndexKey?: (field, value) => string | undefined` closure (prefer the narrow closure: `resolveCandidateIds` only needs to canonicalize the `==`/`in`/range lookup value, mirroring how the eager `candidateRecords` resolves the probe value before `lookupEqual`). Keep the kernel→with-lookup seam narrow; do NOT hand `LazyQuerySource` the whole pipeline if a closure suffices.

- [ ] **Step 1: confirm the runtime gap first (seam map §A3 flagged it unconfirmed).** Write a probe test: lazy-mode collection (`prefetch: false`) + a fixed-mode `money()` field + an eager-declared index on it; put a record via the money write path (scaled bucket, e.g. `'100'`); `where('amount','==', 1)` on the lazy path. Observe today's behavior — does it scan-miss, return empty, or throw `IndexRequiredError`? Record it in the report; that determines the exact assertion shape. Then write the FULL failing test: mixed-era fixture (a legacy `'0100'` record written before the money declaration + a canonical `'100'` record), assert `where('amount','==',1)` returns BOTH via the lazy index fast path (spy the `persistedIndexes.lookupEqual` to prove the index path was taken, not a scan), plus the scan-parity property (fast-path ≡ forced-scan for `==`/`in`, unparseable consistently no-match). Run → fails.
- [ ] **Step 2: bucket canonicalization.** In `persisted-indexes.ts`: add the `canonicalize` field + `setCanonicalizer`; thread it into `addToState`/`removeFromState` (add the param, `canonicalize?.(field, value) ?? stringifyKey(value)` at the bucket site — mirror eager's `addToIndex`); apply at EVERY mutation site (`ingest` bulk-load, `upsert`, `remove`) so buckets are symmetric. Also canonicalize the incoming probe value in `lookupEqual`/`lookupIn`/`lookupRange` (the lazy probe path hands raw values — unlike eager, where `candidateRecords` pre-canonicalizes; here the index method must, OR the lazy-builder must before calling — pick ONE site and be consistent; document which).
- [ ] **Step 3: probe threading.** In `lazy-builder.ts`: add the narrow canonicalizer seam to `LazyQuerySource<T>`; in `resolveCandidateIds()`, canonicalize `clause.value` for `==`/`in`/range before `idx.lookupEqual`/`lookupIn`/`lookupRange` (if you chose to canonicalize in lazy-builder rather than inside the index in Step 2 — do NOT double-canonicalize; one site). `collection.ts`: register `this.persistedIndexes?.setCanonicalizer((f,v) => this.via?.canonicalizeIndexKey(f,v))` and pass the same closure into the `lazyQuery()` `LazyQuerySource` literal.
- [ ] **Step 4: ceiling.** collection.ts is at 4472/4472. Count the net lines you added; offset each by a genuine in-file compression (report before/after). If truly impossible, re-ratchet `KERNEL_SURFACE_BUDGET` in `check-architecture.mjs` with a written justification (new lazy-canonicalization functionality is genuinely core) — but try shrink-first first. `pnpm check:architecture` must pass.
- [ ] **Step 5:** run the new test + the #672 eager tests (`pnpm vitest run packages/hub/__tests__/via/money-index-canonical.test.ts`) to confirm no eager regression + `pnpm vitest run packages/hub/__tests__ -t lazy` sweep + `pnpm check:architecture` + typecheck. All green.
- [ ] **Step 6: docs.** Update `docs/subsystems/via-money.md`'s Indexing section + the `builder.ts:1132-1142` / `moneyIndexProbe` comments that call the lazy gap "out of scope" — flip them to describe the now-closed guarantee (eager AND lazy canonicalize; #677).
- [ ] **Step 7: commit** — `fix(hub): lazy-mode PersistedCollectionIndex canonicalizes + probes money index keys (#677)`.

---

### Task 3: docs, changeset, gauntlet

- [ ] **Step 1:** sweep `docs/subsystems/via*.md` for stale "lazy … out of scope" / mixed-era caveats invalidated by #677; update. Confirm #678's latent-hazard note is documented where the graph/cycle behavior is described.
- [ ] **Step 2:** author `.changeset/m33-via-followups-3.md` LOCAL (`@noy-db/hub: patch` — both are internal correctness fixes, no public API surface change; if #677's `LazyQuerySource` seam is considered public, bump to minor and justify). Do NOT git add.
- [ ] **Step 3:** full gauntlet from repo root — `pnpm --filter @noy-db/hub test`, typecheck, lint, `pnpm check:architecture`, build + bundle-check. Report ceilings + counts. Grep the diff for attribution/client-name (zero hits).
- [ ] **Step 4: commit** — `docs(hub): via-money lazy-indexing + graph dual-role notes (#677 #678)`.

## Self-review notes
- #678 → T1 (edge-carried kind, regression pins the cycle-detection fix directly against ViaGraph); #677 → T2 (both bucket + probe canonicalization together, ceiling shrink-first); docs/changeset → T3.
- Ceiling exposure is T2-only (collection.ts registration lines) — shrink-first mandated, ceiling-bump only with written justification.
- Check 14: both fixes stay on the `kernel/via/{index,pipeline}.ts` port; no direct `via/money/*` import from kernel/with-lookup.
