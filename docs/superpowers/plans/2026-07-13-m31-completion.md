# Milestone #31 completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all 6 milestone-#31 issues (#666, #664, #639, #665, #661, #625) in one branch/PR.

**Architecture:** Spec `docs/superpowers/specs/2026-07-13-m31-completion-design.md`; ground truth `.superpowers/sdd/seam-map-m31.md` (probe-proven anchors — read the relevant section before each task). Order matters: #666 enables #664; the rest are independent.

**Tech Stack:** TypeScript, vitest, tsup; hub-portable; crypto.subtle only.

## Global Constraints

- Ceilings (split-metric): collection.ts ≤ 4472, vault.ts ≤ 3939, noydb.ts ≤ 2385 — zero slack; add ⇒ equal named shrink same task; BLOCKED over bump.
- No Claude attribution; pre-commit `git diff --cached | grep -in -E "accounting-firm|co-authored|generated with claude"` → empty.
- Zero-knowledge: via-features never receive keyring/raw DEKs; ViaGraph stays metadata-only; posture folding must not gain new inputs (#639's law: traversal-only).
- Behavior locks: full money/i18n/dict/lookup/MV/derivations/computed/query/classified suites unchanged except enumerated pin-flips. TDD: red first, every task.
- `pnpm check:architecture` green after every task. Goldens: only additive deltas a task explicitly names.
- ONE batch changeset in the final task (`.changeset/m31-completion.md`, hub minor — indexProbe + late-attach coverage are additive api).

## Tasks

### Task 1: #666 — `Collection._setVia` writer seam
**Files:** kernel/collection.ts (guarded: +4-5 lines, named shrinks: `get _ramCiphertext` :1371-1372 collapse or `_applyClassifiedFields` comment compaction), kernel/via-graph-wiring.ts (:319 cast + :337 write die; param typed against the getter/setter pair). Test: typecheck + `grep "coll as {" via-graph-wiring.ts` empty + existing taint/overlay suites + a `_setVia` contract test (assign + codec.setVia both observed).
**Produces:** `_setVia(pipeline: ViaPipeline | undefined): void` — Tasks 2-3 call it. Verify line accounting (before/after wc -l) in the report.

### Task 2: #664a — reconcile collision guard + i18n/dictKey reconcile + ladder collapse
**Files:** kernel/via-compose.ts (guard recipes a+b: re-run `guardCrossBindingFieldCollisions` on the late-attach merged view; existing×incoming via `coll._via` bindings `covers()`+`brand`→`VIA_FIELD_MAP_FAMILY`), NEW kernel/via-reconcile.ts (free functions `reconcileI18nFields`/`reconcileDictKeyFields` → `ViaPipeline.build` + `coll._setVia` + dictionary-handle wiring — seam-map §3 names the fresh-construct sources to mirror), kernel/vault.ts (5-branch `_apply*` ladder :852-869 collapses to ONE via-reconcile dispatch — net-NEGATIVE; guard call rides the freed lines). Tests: fable's probe recipes (a) money+blob late-attach refuses, (b) call-1 classified + call-2 money refuses; i18n + dictKey late-attach end-to-end (label dressing appears post-reconcile); existing money/computed/classified late-attach suites unchanged.
**Produces:** via-reconcile.ts dispatch signature Task 3 extends.

### Task 3: #664b — lookup reconcile (tier-scoped)
**Files:** kernel/via-reconcile.ts (`reconcileLookupFields`: enum/static clean; reserved tier updates vault registries [reservedLookupCollections vault.ts:394,1292-1300 — thin touches only, vault stays ≤3939]; matrix tier REFUSES `ValidationError` unless backing open prefetch-enabled — binding.ts:252-264 evidence), shape/via-lookup as needed for snapshot/membership closure builders (reuse fresh-construct builders — do not duplicate). Tests: enum/dict late-attach end-to-end (closed-vocab enforcement live post-attach, altKeys normalize); matrix-attach refusal message pinned; matrix attach WITH open prefetch backing works; graph ref edges present post-attach (referencingEdgesOf).

### Task 4: #639 — assertAcyclic containment expansion
**Files:** kernel/via-graph.ts (`assertAcyclic` ~:188-229: neighbours of real field `(C,f)` also expand `_out.get(C\0*)` — TRAVERSAL-LOCAL ONLY; no `_in`/`registerDerived` change; comment states the #642 separation law). Tests: mutual-rollup declare refusal (probe recipe from seam map); acyclic chain still passes (control); `foldWildcardSecurity`/taint suites byte-unchanged (the lock proving no posture bleed).

### Task 5: #665 — computed-first `_presentOrder`
**Files:** kernel/via-pipeline.ts (present() :109-113 folds over a `_presentOrder` — computed bindings first, others keep relative order; built once at construction). Tests: flip `computed/virtual.test.ts:258,302` (i18n statusLabel + lookup) to positive; money virtual pin STAYS KNOWN LIMITATION (:161 — value-shape, out of scope); money/i18n/lookup present-output suites unchanged (behavior lock — enumerate any legitimate diff).

### Task 6: #661 — bare-array element-wise, both hooks
**Files:** shape/via-lookup/binding.ts (Array.isArray branches: ingest :317-322, enforceWrite :345-348, mirroring [].-wildcard :296-315; share altIndex/membership). Tests: closed-vocab per-element refusal; altKey normalization per element; mixed + empty arrays; scalar byte-parity; #661's exact probe (['ZZZ','totally-bogus'] now refused).

### Task 7: #625 — indexProbe end-to-end
**Files:** kernel/via.ts (`indexProbe?(op, payload)`), kernel/via-pipeline.ts (brand dispatch mirroring `evaluateClause`), shape/via-money (fixed-mode == / in per issue), query/builder.ts (:1129 `if (clause.via) continue` → probe + `indexValue` slot; `candidateRecords()` lookupEqual/lookupIn). MUST first verify probe stored-form byte-matches index `stringifyKey` (seam-map §4 flag) — if mismatch, normalize at the probe, evidence in report. Tests: harden `__tests__/money/where-comparison.test.ts:184-203` with real `withIndexing()` + lookupEqual spy (fast path proven hit); `in` path; non-fixed-mode + range ops still scan; posture gate untouched.

### Task 8 (FINAL): docs + changeset + gauntlet
**Files:** docs/subsystems/via.md + via-lookup.md (late-attach coverage + tier limits, cycle refusal, present order, arrays, indexProbe — every example traced to a shipped test), `.changeset/m31-completion.md` (hub minor; honest per-issue bullets incl. matrix-refusal + money-virtual out-of-scope notes; local/gitignored). Gauntlet: full hub suite, typecheck, lint, check:architecture, build (env-free), bundle-check; ceilings reported. Wrap-up: file the money-virtual-quantize follow-up issue draft (report text; controller files it).

## Execution notes

Fresh implementer per task + task review (skill: superpowers:subagent-driven-development); opus review on Tasks 2-3 (guard + registry surface) and 7 (query hot path); whole-branch fable review at end; then PR → CI → merge → close milestone #31 → STOP (publish gated on user check-in).
