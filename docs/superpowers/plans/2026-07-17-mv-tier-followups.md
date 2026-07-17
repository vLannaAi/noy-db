# Derived/MV Tier Follow-ups (#736 + #737 + #740) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the lazy/manual materialized-view residue (#736 — a persisted output row keeps an elevated/forgotten source's plaintext at rest and serves it to cold sessions), make the tier-move derived-decode gate source-grained (#737), and refuse the incoherent `tiers × encrypted:false` composition at construction (#740).

**Architecture (#736, the substantive task):** invalidation from the delete/forget/elevate path (`dispatchMaterializedViewsOnDelete`, `collection.ts:~2934`) must, for `lazy` AND `manual` MVs, do BOTH halves: (a) **delete the MV's persisted output rows** (the at-rest law — a stale mark alone leaves plaintext at rest) and (b) for `lazy`, **persist the stale mark** in a reserved `_mv_stale` store collection so a COLD session recomputes on first read instead of serving an empty MV (`stale.ts`'s WeakMap is in-memory only — its own doc admits "Persistence across vault close is NOT implemented"). `manual` gets rows deleted only (empty-until-`refreshView()` is the documented manual contract; erasure/invisibility wins over staleness). This fixes the SAME gap for `forget()` and `elevate()` at once — they share the dispatcher.

**Tech Stack:** TypeScript ESM, vitest, `crypto.subtle` only.

## Global Constraints

- `collection.ts` ceiling 4549 (file at 4548) and `vault.ts` ceiling 3959 (file at exact ceiling) — additions there must be funded or land in `with-formula/materialized-views/*` (no ceiling). Prefer putting ALL new logic in `stale.ts`/a sibling and calling it from the dispatcher with minimal lines.
- Never add Claude attribution. Hub portable. TDD.
- Branch: `fix/736-740-mv-tier-followups` off main AFTER PR #760 merges.
- Reserved collection name: `_mv_stale` (leading `_` = excluded from queries/list like other internals). Marker rows must be CONTENT-FREE (key = MV name is the only payload; staleness is low-sensitivity metadata — mirror an existing reserved-collection marker's envelope shape; find precedent via `grep -rn "_ts: now, _iv: ''" packages/hub/src` or how the subject index / sync markers write envelopes).

---

### Task 1: #736 — lazy/manual MV invalidation purges rows at rest + persists the lazy stale mark

**Files:**
- Modify: `packages/hub/src/with-formula/materialized-views/stale.ts` (new: `invalidateMVAtRest` helper, persisted-marker hydrate/clear)
- Modify: `packages/hub/src/kernel/collection.ts` (`dispatchMaterializedViewsOnDelete` lazy/manual arms — keep the delta tiny, ceiling)
- Modify: wherever `vault.refreshView` completes (clear the persisted marker alongside `clearMVStale` — find it)
- Test: new `packages/hub/__tests__/mv-tier-staleness.test.ts`

**Design points (fixed):**
1. New `stale.ts` export, e.g. `invalidateMVAtRest(accessor-ish, reg, mode)`: enumerates the MV's `outputCollection` rows via the adapter, deletes each through the output collection's `_internalDelete` (tombstone semantics consistent with the eager path — check what `executor.refresh`'s delete leg uses and mirror; if `_internalDelete` needs the Collection, thread `getCollection` like the dispatcher already does). If multiple MVs share the output collection (registry supports it "in theory"), re-mark every OTHER lazy MV writing there stale too (they lost their rows) — enumerate via `registry.all()` filter.
2. Persisted lazy marker: on `markMVStale` from the DELETE dispatcher only (not ordinary source writes — cheap writes must stay cheap; ordinary lazy staleness keeps today's in-memory-only behavior and its documented cold-session freshness caveat — the LEAK is what we're fixing, and after row-deletion there is no leak; the marker exists so the cold session recomputes instead of serving empty), write `_mv_stale/{mvName}` marker row. `resolveStaleMVOnRead` gains a once-per-registry hydrate: first call checks a `WeakMap<Registry, true>` flag; if unhydrated, `adapter.list(vault, '_mv_stale')` and folds names into the pending set (needs adapter+vault on the accessor — extend `MVStaleAccessor` minimally or thread via the existing query context; implementer's call, guard-clean). After a successful refresh, delete the marker row (and `clearMVStale`).
3. `vault.refreshView()` completion also deletes the marker row.
4. `manual` arm in the dispatcher: call the row-purge only. Document on the dispatcher doc comment: manual MV serves empty until `refreshView()` after a source forget/elevate — erasure wins.

**Tests (TDD — RED first for 1 and 2):**
1. THE LEAK (lazy): source collection + `refresh:'lazy'` MV, materialize (read once), elevate a source record → assert the MV's persisted output rows are GONE from the store (adapter-level check) and `_mv_stale/{name}` exists → close → reopen (cold) → read MV → recomputed WITHOUT the elevated record's contribution; marker row gone after the read.
2. Same for `forget()` (the shared-dispatcher claim — one test, same assertions).
3. Manual MV: elevate a source → rows gone at rest; read serves empty (no recompute); `vault.refreshView()` rebuilds without the elevated record.
4. Ordinary lazy source WRITE (no delete/elevate): no `_mv_stale` row written (the cheap-path guarantee), in-memory behavior unchanged (reuse `isMVStale`).
5. Eager MV regression: unchanged behavior (suite pass suffices).

- [ ] Steps: failing tests → implement → focused suites (`mv`/`materialized`/`derivation` test files + `forget.test.ts` + `tiers-blobs.test.ts`) → commit `fix(hub): lazy/manual MV invalidation purges persisted rows + persists the lazy stale mark — cold sessions can't serve an elevated/forgotten source's plaintext (#736)`.

---

### Task 2: #737 — hasDerivedOutputs becomes source-grained

> **CORRECTION (2026-07-17, shipped design):** the predicate below ("`spec.source === this.name`")
> was too narrow — it would have missed triggerBy/sibling/rollup-child relations and silently
> regressed #722. The implementation instead reuses the exact registry lookups the write
> dispatchers use (`registry.strategiesForSource(this.name)` / `registry.mvsForSource(this.name)`,
> both backed by the same `_bySource` maps dispatch reads), so the gate is provably in lock-step
> with dispatch for every relation kind. Additionally, the whole-branch review found the plan's
> Task-1 full-wipe purge destroys USER records for same-collection partition MVs — fixed by
> scoping deletion to `_materializedFrom`-stamped rows (see the fix-wave commit).

**Files:** `packages/hub/src/kernel/collection.ts` (the `TiersContext` build, ~4513 — `hasDerivedOutputs`), possibly a tiny helper on the registries.

Currently `materializedViewSource !== undefined || derivationSource !== undefined` (vault-grained). Change to: this COLLECTION is a registered source — `registry.mvsForSource(this.name).length > 0` OR the derivation registry has a strategy with `spec.source === this.name` (find the exact derivation-registry lookup; a `mvsForSource` analogue may exist). Compute at ctx-build time per tier op (cheap filter; do NOT cache — registries late-attach).

Test: the codebase's established no-decode observable — a vault with a derivation on collection B; tiered collection A with NO derivations; corrupt A's record envelope body at the store so any decode would throw `TamperedError`; `elevate()` on A succeeds (proves the pre-move decode was skipped). Plus positive: a tiered SOURCE collection still decodes (existing #722 tests cover — name the file in your report). Ceiling: the predicate swap should be ~line-neutral in collection.ts; fund by joining if needed.

- [ ] Steps: RED (corrupt-envelope test fails today only if... verify: today the vault-grained gate makes elevate DECODE on A → throws on corrupt → RED is "elevate throws"; post-fix GREEN "elevate succeeds") → implement → suites → commit `perf(hub): hasDerivedOutputs is source-grained — tier moves on derivation-free collections skip the pre-move decode (#737)`.

---

### Task 3: #740 — refuse tiers × encrypted:false + changeset + close-out

**Files:** `packages/hub/src/kernel/collection-config.ts` (beside the existing tiers mandates, ~913-944), test in `packages/hub/__tests__/tier-composition-guard.test.ts`.

Guard: `tiers` declared AND `encrypted: false` → `UnsupportedTierCompositionError('plaintext', ...)` — message: tiers are per-tier ENCRYPTION keys; a plaintext collection has nothing to re-key, `putAtTier`/`elevate` would encrypt/decrypt incoherently; use an encrypted collection. Tests: refusal fires at construction; `encrypted:false` without tiers unaffected; tiers + encrypted (default) unaffected. Confirm first no existing test combines them (`grep -rn "encrypted: false" packages/hub/__tests__ | grep -l tiers` style — if one exists, STOP and report).

Changeset `.changeset/mv-tier-followups.md` (hub patch):

```md
---
"@noy-db/hub": patch
---

Derived-output tier/erasure completeness (#736, #737, #740). Invalidating a lazy or manual materialized view from `forget()` or a tier move now DELETES the MV's persisted output rows at rest (previously the pre-elevation/pre-forget plaintext row survived until an in-session refresh — and a cold session served it as fresh), and for lazy MVs persists the stale mark in the reserved `_mv_stale` collection so a cold session recomputes on first read instead of serving an empty view; a manual MV serves empty until `vault.refreshView()` (erasure wins over manual staleness). Ordinary source writes keep the cheap in-memory-only stale path. The tier-move pre-move decode gate is now source-grained (#737) — a tiered collection with no derivations of its own no longer decodes on elevate/demote when an unrelated derivation exists in the vault. And `tiers` on an `encrypted: false` collection is now refused at construction (`UnsupportedTierCompositionError`, #740) — per-record clearance IS per-tier encryption; a plaintext collection cannot honor it.
```

Full verification: hub test/typecheck/lint/check:architecture; ceilings intact.

- [ ] Commit `fix(hub): refuse tiers on encrypted:false collections at construction (#740) + changeset`.

## Self-Review Notes

- #736's split (rows deleted ALWAYS on the delete/elevate dispatcher; marker ONLY for lazy; ordinary writes untouched) keeps the hot write path free of new store I/O while making the leak class impossible at rest.
- The `_mv_stale` hydrate is once-per-registry-per-session — one `list()` on first MV read, zero when no MVs registered.
- Shared-output-collection re-marking prevents a sibling lazy MV from silently losing rows without a stale bit.
