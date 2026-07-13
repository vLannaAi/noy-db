# Milestone #26 — Docs & release infrastructure Implementation Plan (DRAFT — fork-prepared; parent finalizes after #24/#27)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close milestone #26 (#600, #607, #624, #660, #667) before the 0.3.0-pre.11 publish, so the post-publish noy-db-docs rebuild (registry/llms regeneration — the LLM-consumable full-scope doc the user prioritizes) runs against a clean, mechanically-triggered pipeline. Ground truth: `.superpowers/sdd/m26-prep-map.md` (per-issue fix shapes, verified sites, and the cross-repo reality updates).

**Architecture:** Four in-repo tasks (one mechanical cycle break, one measured infra decision, one workflow step, one doc note) + one cross-repo design deliverable (#624 — analysis/schema/ADRs, acceptance is review not code). Changeset: hub PATCH unless #660 changes the shipped .d.ts layout (then minor).

## Global Constraints

- Ceilings unchanged (collection ≤4472, vault ≤3939, noydb ≤2385 — none of these tasks should touch the three files; if one must, shrink-first).
- Public type surface byte-compatible: #667's cycle break moves DEFINITIONS, never subpath exports — goldens + typecheck + `pnpm check:architecture` are the lock. CrdtStrategy and CrdtState STAY defined in kernel/types.ts (enclave self-containment, the C3 hoist rationale).
- #660's success metric: workflows' `--max-old-space-size` comes back DOWN from 12288, plus a loud CI guard for the next growth step.
- TDD where there is runtime surface; measurement-before-decision for #660. No Claude attribution; changeset LOCAL only.

---

### Task 1: #667 — break the CrdtStrategy export-graph cycle
Per prep map: complete the C3 hoist — move `LwwMapState`/`RgaState`/`YjsState` definitions into `kernel/types.ts`; `with-commit/crdt/crdt.ts` re-exports them from types.js (all its exports become leaf-ward). Verify first with madge/rollup-verbose that these are the actual cycle edges; verify after that the warning is GONE from a clean `pnpm --filter @noy-db/hub build` log (grep the build output — that IS the acceptance test) and no OTHER cycle warning appears. Goldens/typecheck/full suite green.

### Task 2: #660 — DTS memory: measure, pick, implement, guard
Step 1 MEASURE (before any decision): peak RSS for dts builds of (a) barrel-only, (b) all-but-barrel, (c) all entries (`/usr/bin/time -l`, three data points in the report). Step 2 PICK per the prep-map decision tree (barrel-dominant → direction 2 tsc-emitDeclarationOnly with exports-map `types` retargeting + `npm pack` smoke; sum-dominant → direction 3 batched tsup invocations). Step 3 implement + verify the published-surface parity (kernel-api golden, type-tests, pack smoke installing the tarball and importing 3 subpaths' types). Step 4 GUARD: CI step that fails with actionable guidance on OOM at the chosen budget; lower the workflow NODE_OPTIONS caps and the hub build script flag to the new ceiling. Report the before/after peak numbers.

### Task 3: #600 — release.yml doc-sync trigger + #607 doc note (bundled small task)
(a) Add the post-`Summarise` step to `.github/workflows/release.yml`: `gh issue create -R vLannaAi/noy-db-docs` titled `doc-sync needed: <version> @<channel>` with tag/channel/run-link/published-packages body, using `secrets.DOCS_SYNC_TOKEN`, `continue-on-error: true` (a docs-repo outage must not fail a publish). Document in the step comment that the secret is a fine-grained PAT (Issues:write on vLannaAi/noy-db-docs) — USER PROVISIONS IT before pre.11. Workflow-lint (actionlint if available) + a dry parse. (b) #607: JSDoc caveat on `ConflictPolicy<T>` (kernel/types.ts:1269) — custom-fn/CRDT policies cannot keep an edit over a delete marker (wrapper returns the non-null side first; delete-wins); manual/lww/fww CAN — mirrored in the sync/crdt subsystem doc.

### Task 4: #624 — taxonomy convergence: gap analysis + schema proposal + ADRs + #498 checklist
Inputs: `../noy-db-docs/docs/upstream-taxonomy-handoff.md` (branch docs-presentation-polish, 263 lines), `../noy-db-docs/registry/features.yaml` + `feature-schema.json` + the render-* generators, SERVICES.md, the packages/ layout. Deliverables (per the issue's own acceptance): (a) gap analysis doc; (b) proposed feature-schema.json additions with example entries (layer/kind, title/subtitle/nav_alias + slug rules, explicit section+layer order lists, per-category summary formats, family per-package IA + to→in→on→as→by→at order, old→new slug map, subsystem_doc join key, generator contracts); (c) TWO ADRs as new files in noy-db (minimal-kernel Core; placement ≠ opt-in); (d) the PR #498 migration checklist. The analysis lands in-repo under docs/ (ADRs) + the gap-analysis/schema-proposal as a doc the user reviews with the PR; the schema APPLICATION happens in noy-db-docs afterwards (recommended before the pre.11 doc-sync).

### Task 5: changeset + gauntlet + PR
Changeset LOCAL (`.changeset/m26-docs-release-infra.md`, hub patch-or-minor per Task 2's outcome). Full gauntlet. PR body carries plain `Closes #600`/`Closes #607`/`Closes #624`/`Closes #660`/`Closes #667` lines + the user-action list (DOCS_SYNC_TOKEN provisioning; docs-presentation-polish merge-order decision; post-publish doc-sync → llms regeneration → ui → pilots chain).
