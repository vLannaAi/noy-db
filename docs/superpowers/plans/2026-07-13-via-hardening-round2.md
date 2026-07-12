# Via hardening round 2 — milestone #30 closure batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 9 remaining actionable milestone-#30 issues (#627, #631, #632, #634, #635, #641, #645, #646, #652) in one hardening batch; #639/#653 are deferred to design cycles (moved out with comments), #644 closes with rationale.

**Architecture:** Nine independent, small hardening fixes on top of the merged via-consolidation pass. Five are pre-spec'd by inline code comments left by prior implementers. Three touch ceiling-guarded kernel files at zero slack — those tasks are shrink-first-or-BLOCKED.

**Tech Stack:** TypeScript, vitest, tsup; hub-portable (no Node built-ins in `hub/src/**`), `crypto.subtle` only.

## Global Constraints

- Ceilings (checker metric = `split('\n').length`): `packages/hub/src/kernel/collection.ts` ≤ 4472, `kernel/vault.ts` ≤ 3939, `kernel/noydb.ts` ≤ 2385 — ALL AT ZERO SLACK. Any addition to these files requires an equal-or-greater same-task shrink; if impossible, report BLOCKED — never bump.
- Never add Claude attribution to commits/PRs/CHANGELOGs. Before every commit: `git diff --cached | grep -in -E "accounting|co-authored|generated with claude"` → must be empty (plan-doc meta references excepted).
- Zero-knowledge invariant: via-features never receive keyring/raw DEKs/enclave barrel; stores see ciphertext only. `pnpm check:architecture` green after every task.
- Behavior locks: full existing suites pass unchanged except pins that pin a fixed defect (enumerate per task).
- TDD: failing test first for every defect fix.
- The kernel-api golden may change ONLY where a task explicitly says so.
- Changeset: ONE batch changeset (`.changeset/via-hardening-r2.md`, hub patch) written in the final task — local/gitignored per repo convention.

## Task order

T1 #632 (scripts, isolated) → T2 #645 (graph memory) → T3 #631 (cross-binding validator) → T4 #652 (array ingest) → T5 #635 (tier>0 _sealed) → T6 #627 (vault.ts, guarded) → T7 #634 (collection.ts, guarded) → T8 #641 (collection.ts, guarded) → T9 #646 + changeset + gauntlet (final).

---

### Task 1: #632 — STATIC_IMPORT_FROM_RE misses side-effect/default imports

**Files:** Modify `scripts/check-architecture.mjs:1470-1471` (the regex). Add canary fixtures per the script's existing fire-proof pattern (see how via-layering/via-enclave-isolation guards are fire-proofed — `packages/hub/__tests__/`... locate `via-guards-empty.test.ts` for the subprocess-synthetic pattern).
**Requirements:** The static-import scanner must also match (a) side-effect imports `import './x.js'` and (b) default imports `import x from './x.js'`. Extend the regex (or add sibling regexes) and prove both forms are caught by a synthetic-violation canary (the guard must FIRE on a synthetic, then stay green on the real tree). Read issue #632 (`gh issue view 632`) for the exact gap statement.
**Verify:** `node scripts/check-architecture.mjs` green on real tree; canary test proves both new forms fire. Commit: `fix(scripts): static-import scanner catches side-effect and default imports (fixes #632)`.

### Task 2: #645 — reconcile computed-deps universe misses graph memory

**Files:** Modify `packages/hub/src/kernel/via-graph.ts` (add `knownFieldNames(collection): Set<string>` ~10-15 LOC, enumerating registered field nodes for a collection) and `kernel/via-graph-wiring.ts:205-213` (union `collectKnownFieldNames`'s options-derived set with the graph's memory — the inline comment at those lines cites this exact residual). Test: two-call scenario — open collection A with classified field, then a second `vault.collection()` call whose options alone don't name the field; computed-deps validation must still know it.
**Verify:** new test red→green; full via/taint suites unchanged. Commit: `fix(hub): reconcile computed-deps universe unions ViaGraph field memory (fixes #645)`.

### Task 3: #631 — cross-binding same-field collision guard

**Files:** Modify `packages/hub/src/kernel/collection-config.ts` (`compileViaBindings` vicinity; blobFields at :131, classifiedFields at :651-653) or extend `kernel/via-compose.ts:106-135` `mergeViaFields` — pick the seam that sees ALL families (money/i18n/dictKey/lookup/classified/blob/computed). ~30-60 LOC validator: the same field name claimed by two different binding families = declare-time `ValidationError` naming field + both families. Read issue #631 for the money+blob example that is unguarded today.
**Requirements:** existing legal combinations must keep working — the guard is same-field CROSS-family collision only; a family's own duplicate handling stays as-is. Enumerate the legal exceptions (if any exist in tests, e.g. computed-over-money composition via `via()`) BEFORE writing the guard: `via(computed(...), money(...))` composition on one field is the documented composition path and must NOT be refused — the guard targets conflicting field-map declarations (e.g. `moneyFields` + `blobFields` naming the same field), not `via()` pipeline composition.
**Verify:** new collision tests (at minimum money+blob, classified+lookup) red→green; full config/compose suites unchanged. Commit: `fix(hub): declare-time cross-binding same-field collision guard (fixes #631)`.

### Task 4: #652 — lookup ingest/enforceWrite array asymmetry (RATIFIED: option A)

**Files:** Modify `packages/hub/src/shape/via-lookup/binding.ts:288` (ingest bails on `values.length !== 1`) to normalize element-wise, matching enforceWrite's `:315` all-elements semantics. Both sites carry "no behavior change this wave" comments — remove those comments as part of the fix. ~15-25 LOC + tests.
**Requirements:** an array-valued lookup field (e.g. `tags: lookup('tags')` with `['a','b']`) gets EVERY element altKey-normalized on ingest, and closed-vocabulary enforcement continues to check every element (unchanged). Single-value behavior byte-identical. Read issue #652 for the filed example.
**Verify:** new array-normalization test red→green; alias/vocabulary/countries-matrix suites unchanged. Commit: `fix(hub): lookup ingest normalizes array fields element-wise, matching enforceWrite (fixes #652)`.

### Task 5: #635 — getAtTier tier>0 never processes `_sealed`

**Files:** Modify `packages/hub/src/with-audit/tiers/index.ts:189-196` (the tier>0 manual unwrap+JSON.parse leg) and `kernel/enclave/record-keys/record-codec.ts` (extract the `_sealed`-slot post-processing that `decryptRecord` applies at :683+ into a shared helper the tier leg can call with an ALREADY-DECRYPTED record — do NOT try to pass a tier DEK into `decryptRecord`; it resolves its own DEK internally, which is why the naive fix is wrong). Test: elevated-tier read of a record with sealed fields must surface `SealedHandle`s (or the tier-appropriate sealed representation), not raw plaintext-shaped JSON with `_sealed` internals leaking.
**Requirements:** tier 0 path byte-identical; the extraction must not change `decryptRecord`'s behavior (existing codec suites are the lock). Zero-knowledge: the shared helper takes decrypted-record + slot metadata, never key material.
**Verify:** new elevated-tier sealed test red→green; full codec + with-audit suites unchanged. Commit: `fix(hub): elevated-tier reads process _sealed slots via shared codec helper (fixes #635)`.

### Task 6: #627 — viaFields money skips late-attach reconcile [GUARDED: vault.ts]

**Files:** Modify `packages/hub/src/kernel/vault.ts:852-853`: the late-attach branch checks raw sugar key `options?.moneyFields` only; the merged `mergeViaFields` view (computed at :874 in the fresh-construct branch) must drive the late-attach reconcile too, so `viaFields: { price: money('EUR') }` late-attach behaves exactly like `moneyFields` late-attach. ~5-15 LOC.
**CEILING:** vault.ts is at exactly 3939. Find an equal shrink in the same task (collapse a nearby multiline construct) or report BLOCKED. Never bump.
**Verify:** new test (open collection WITHOUT money, re-open WITH `viaFields` money — reconcile must fire; mirror the existing moneyFields late-attach test) red→green; money/viaFields suites unchanged. Commit: `fix(hub): viaFields sugar participates in late-attach reconcile (fixes #627)`.

### Task 7: #634 — exportRedact `(coll as any).via` reach-in [GUARDED: collection.ts]

**Files:** Modify `packages/hub/src/kernel/via-pipeline.ts:331-336` (the cast site) and `kernel/collection.ts` (add a typed `@internal` accessor following the `_onViaErase` pattern at :4425). ~5-10 LOC.
**CEILING:** collection.ts at exactly 4472 — the accessor addition needs a same-task shrink of equal size. If no clean shrink exists, an acceptable alternative shape is typing the existing property via an exported internal interface in via-pipeline.ts WITHOUT touching collection.ts at all (interface-only fix) — prefer whichever keeps collection.ts untouched.
**Verify:** typecheck clean with the cast gone (`grep -n "coll as any" packages/hub/src/kernel/via-pipeline.ts` → empty); export/redact suites unchanged. Commit: `refactor(hub): typed internal via accessor replaces exportRedact any-cast (fixes #634)`.

### Task 8: #641 — lazy-MV resolve-on-read throws PeriodClosedError [GUARDED: collection.ts]

**Files:** Modify `packages/hub/src/with-formula/materialized-views/stale.ts:75-113` (`resolveStaleMVOnRead` gains a `dispatchCtx` param), `with-formula/materialized-views/executor.ts:305-310` (stop falling back to raw `outputColl.put()` when ctx present; the doc comment at :30-39 admits this exact gap — follow the `refreshView()` pattern at collection.ts:2763), and the two call sites `kernel/collection.ts:1406-1407` and `:2955-2956` (thread the ctx — sentinel origin `'resolve-on-read'`).
**CEILING:** collection.ts at 4472; the triage judged the call-site edits near-net-zero (param additions on existing calls). Confirm; shrink if it grows; BLOCKED if impossible.
**Requirements:** a lazy MV whose output row falls in a frozen period must resolve-on-read WITHOUT throwing `PeriodClosedError` — the frozen-output rule applies (skip + `derivation-skipped-frozen` event), exactly as live dispatch/`deriveAll()`/`refreshView()` already behave. Read issue #641.
**Verify:** new repro (lazy MV + `vault.freezePeriod` covering the output row + read) red→green; MV suites (15 files) unchanged. Commit: `fix(hub): lazy-MV resolve-on-read respects the frozen-output rule (fixes #641)`.

### Task 9 (FINAL): #646 — de-vacuous sync pins + cm23/cm15; batch changeset; gauntlet

**Files:** Test-only production-wise: retrofit `packages/hub/__tests__/via/mutation-choke-point.test.ts:176,182` and `__tests__/via/sync-dispatch.test.ts:152,157` to db2-only registration (copy the proven pattern from `__tests__/via/sync-delete-rollup.test.ts`); add the cm23/cm15 net-new tests exactly as issue #646 describes them (read the issue). Write `.changeset/via-hardening-r2.md` (hub patch — 9 fixes, one line each, honest framing; local/gitignored). Run the full gauntlet: `pnpm --filter @noy-db/hub test && pnpm --filter @noy-db/hub typecheck && pnpm --filter @noy-db/hub lint && pnpm check:architecture && pnpm --filter @noy-db/hub build`. Report ceilings measured by the checker.
**Verify:** retrofitted pins FAIL when the guard they pin is synthetically broken (spot-check one by reverting its production guard locally, then restore); full suite green. Commit: `test(hub): de-vacuous two-instance sync pins + cm23/cm15; round-2 changeset (fixes #646)`.
