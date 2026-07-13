# #624 — PR #498 migration checklist

> Milestone #26, Task 4, deliverable (d). Ordered steps to apply the schema proposal
> (`docs/superpowers/analysis/2026-07-14-624-feature-schema-proposal.md`) and reconcile the gaps
> found (`docs/superpowers/analysis/2026-07-14-624-taxonomy-gap-analysis.md`) so that `noy-db-docs`
> PR #498's content migration can proceed against a converged schema, not a moving target. Each
> step is tagged **[noy-db-docs]** or **[noy-db]** (this repo) so it's clear which repo actually
> changes. Nothing in this checklist is executed by this deliverable — it is the plan the user
> and/or the noy-db-docs maintainer works through next.

## Phase 1 — schema landing [noy-db-docs]

1. **[noy-db-docs]** Add the new `feature-schema.json` fields from the schema proposal §1–7:
   `layer`, `kind` (with the new `seam` value), `title`/`subtitle`/`nav_alias`, top-level
   `section_order`/`layer_order`, top-level `summary_formats`, `family`/`family_order` +
   `familyPackage` $def, top-level `slug_map`, and the `source` object. Bump `schemaVersion` per
   the schema's own rule ("bumped only when fields are added or renamed") — this qualifies.
2. **[noy-db-docs]** Run `pnpm validate:features` against the *old* `features.yaml` with the *new*
   schema to get a clean "what's missing" report (every entry will be missing the new optional
   fields — expected; the schema additions should be optional/non-required so this doesn't hard-fail
   CI mid-migration).

## Phase 2 — registry backfill [noy-db-docs]

3. **[noy-db-docs]** Backfill `layer` + `kind` on every existing `features[]` entry, cross-checked
   against a live noy-db checkout (`NOY_DB_ROOT=../noy-db`) the same way `validate-hierarchy.mjs`
   already does — this is mechanical for entries whose `package` already names a real `with-*`
   subpath, and requires the manual judgment call from ADR 0002 for the placement-vs-opt-in edge
   cases already itemized in the gap analysis (`joins`/`live`/`cross-join` → `kind: core`;
   `i18n`/`classified`/`blobs` → `layer: shape`, `source.path: via/…`; `with-cargo`/`with-pod`
   entries → `kind: seam`).
4. **[noy-db-docs]** Fix the `client-portability` split (gap #4): rename the surviving entry's `id`
   from `client-portability` to `portability` (matching its `subsystem_doc:
   docs/services/portability.md`), and add a new `id: withdrawal` entry pointing at
   `docs/services/withdrawal.md`. Add the corresponding `slug_map` entry (schema proposal §6):
   `{ from: /services/client-portability, to: [/services/portability, /services/withdrawal] }`.
   Also add `{ from: /core/refs, to: /services/foreign-refs }` (already-completed rename, currently
   unrecorded anywhere machine-readable).
5. **[noy-db-docs]** Register the missing `broker` entry (gap #5) in `features.yaml`'s
   `features[]`: `cluster: collaboration-and-auth`, `layer: party`, `kind: service`, `factory:
   withBroker` (confirm exact factory name against `packages/hub/src/with-party/broker/`), `source:
   { path: with-party/broker }`, `subsystem_doc: docs/services/broker.md` — note this doc page
   does not yet exist under `noy-db-docs/content/docs/`; content migration (Phase 4) needs to
   create it, sourced from this repo's `docs/subsystems/broker.md` (311 lines, already
   substantial).
6. **[noy-db-docs]** Add `section_order` and `layer_order` as the new top-level `features.yaml`
   arrays (schema proposal §3), then repoint `apps/docs/app/app.vue`'s `SECTION_ORDER`,
   `registry/render-llms.mjs`'s `SECTION_ORDER`, and `apps/docs/app/utils/service-layers.ts`'s
   `LAYER_ORDER` to read from the registry instead of carrying three independent hardcoded copies.
7. **[noy-db-docs]** Add `family_order: [to, in, on, as, by, at]` and populate
   `family_packages[]` — one entry per satellite package under `content/docs/families/<prefix>/`
   (47 packages across `to-/in-/on-/as-/by-/at-` in this noy-db checkout as of 2026-07-14: 5 `to-*`,
   15 `in-*`, 10 `on-*`, 10 `as-*`, 2 `by-*`, 5 `at-*` — the extended `to-*` family lives in the
   sibling `noy-db-to` repo and is out of scope for this checklist unless/until that repo's
   packages get their own family-docs pages).
8. **[noy-db-docs]** Add `summary_formats` (schema proposal §4) verbatim from the handoff §7 table.

## Phase 3 — generator + validator updates [noy-db-docs]

9. **[noy-db-docs]** Update `render-llms.mjs` to read `section_order` from `features.yaml` (drop
   the hardcoded const).
10. **[noy-db-docs]** Extend `validate-features.mjs`'s phase-1 checks (it already does path
    round-trip + cross-reference resolution) to also: (a) resolve every `slug_map[].to` target
    against real `content/docs/` pages; (b) resolve every `source.path` against
    `NOY_DB_ROOT/packages/hub/src/<path>` existing as a real folder, using the same
    `resolveRegistryPath`-style fallback `validate-features.mjs` already has for noy-db-side paths.
11. **[noy-db-docs]** Decide whether `validate-coverage.mjs`'s live `with-*` folder scan should
    additionally cross-check each scanned service's `source.path` (if the entry now has one) to
    catch the folder-vs-registry drift in the other direction — optional hardening, not required
    for #498 to proceed.
12. **[noy-db-docs]** Re-run the full green-gate command set from the handoff §6: `pnpm
    validate:frontmatter && pnpm validate:coverage && pnpm validate:hierarchy && pnpm
    validate:features && node registry/render-llms.mjs --check && pnpm build`.

## Phase 4 — content migration (PR #498 proper) [noy-db-docs, some noy-db source]

13. **[noy-db-docs]** With the schema + registry converged, proceed with #498's actual content
    migration, keyed off each entry's `(subsystem_doc, source.path)` pair rather than re-deriving
    placement by hand.
14. **[noy-db-docs]** Create the missing `content/docs/services/broker.md`, sourced from this
    repo's `docs/subsystems/broker.md` (Phase 2 step 5's registration makes this trackable —
    without an entry, this gap would stay invisible).
15. **[noy-db]** Decide the fate of this repo's `docs/subsystems/` (gap #3): once every service it
    covers (`broker`, `periods`, the 5 `via-*` files) has a converged, superior page in
    `noy-db-docs`, either (a) retire `docs/subsystems/` entirely and repoint `CLAUDE.md`'s "a doc
    page at `docs/subsystems/<name>.md`" language to point at `noy-db-docs` instead, or (b)
    explicitly re-scope these 9 files as "pre-migration technical design notes, not the rendered
    doc" (add a one-line banner to each) if they carry implementation detail worth keeping
    separate from the polished reader-facing page. This is a `noy-db`-side decision independent of
    #498's noy-db-docs-side work and can happen on its own timeline — flagged here so it isn't
    forgotten once #498 lands and the temptation to treat both copies as equally authoritative
    reappears.

## Phase 5 — source-side corrections [noy-db]

16. **[noy-db]** Correct `SERVICES.md`'s Cluster A table per ADR 0002's consequence: either
    footnote `joins`/`live`/`cross-join` as "ships inside `@noy-db/hub/query`, not independently
    tree-shaken" or move them out of the numbered/subpath-bearing rows into prose alongside the
    core query-basics description.
17. **[noy-db]** Refresh `SERVICES.md`'s stale LOC rollup (gap #8: "~28,000"/"~6,500" → current
    measured ~83,200/~30,600) — either a manual one-time fix or (preferred, ties to ADR 0001's
    consequence) a small script under this repo mirroring `validate-hierarchy.mjs`'s live-checkout
    read pattern, so the number can't go stale silently again.
18. **[noy-db]** Once `noy-db-docs` Phase 3 lands its `source.path`-resolution check (step 10b),
    confirm it passes against this repo's current tree with `NOY_DB_ROOT=../noy-db` (no code
    change expected here — this is a verification step, not a source change).

## Sequencing note

Phases 1–3 are pure `noy-db-docs` work and can proceed independently of anything in this repo
(this deliverable's analysis is read-only input, already complete). Phase 4 is the actual #498
content migration and is the reason Phases 1–3 exist. Phase 5 is `noy-db`-side documentation
hygiene that PR #498 depends on for the `broker` page (step 14) but that otherwise can land on its
own schedule — it does not block #498, but should not be forgotten once #498 closes and attention
moves elsewhere (per the milestone-#26 prep map's sequencing note: pre.11 publish → noy-db-docs
doc-sync → llms regeneration → noy-db-ui → pilots).
