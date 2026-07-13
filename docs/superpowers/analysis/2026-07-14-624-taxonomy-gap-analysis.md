# #624 — Source structure ⇄ docs taxonomy: gap analysis

> Milestone #26, Task 4. Analysis-only deliverable — no source/config changed by this document.
> Ground truth read 2026-07-14: `noy-db` at this branch's base (`cce32c7b`), `noy-db-docs` at
> local branch `docs-presentation-polish` (upstream-taxonomy-handoff.md, 263 lines,
> `registry/features.yaml` 2617 lines, `registry/feature-schema.json` 250 lines, and the
> `registry/render-*.mjs` / `registry/validate-*.mjs` generators — all read directly from the
> sibling checkout, read-only).

## Method

Every divergence below was verified against the real files, not inferred from memory:
`packages/hub/tsup.entries.mjs` (the ground-truth subpath→source map), `packages/hub/package.json`
`exports`, `ls packages/hub/src/{kernel,with-*,via,port}`, `SERVICES.md`, `CLAUDE.md`, and
`noy-db-docs/registry/{features.yaml,feature-schema.json,validate-*.mjs,render-*.mjs}`, plus a
direct `wc -l` LOC count and a live `pnpm validate:features` run (against `NOY_DB_ROOT=../noy-db`)
to confirm claims rather than assert them.

Each item: **source reality** → **docs expectation** → **impact on doc-sync / llms generation**.

---

## 1. Two non-isomorphic service groupings already coexist

**Source reality:** `packages/hub/src` has exactly 10 `with-*` folders (the physical layer):
`with-audit, with-cargo, with-commit, with-fork, with-formula, with-lookup, with-party, with-pod,
with-shape, with-store`. `SERVICES.md`'s own catalog groups the 27 numbered services into **8
different** conceptual clusters — Cluster A "Read & Query" … Cluster H "Operations" — and
`noy-db-docs/registry/features.yaml`'s `cluster:` field mirrors those same 8 names in kebab-case
(`read-and-query`, `write-and-mutate`, `derived-data`, `data-shape`, `time-and-audit`,
`snapshot-and-portability`, `collaboration-and-auth`, `operations`, plus `core`/`service`/`meta`
for entries outside the numbered catalog).

**Docs expectation:** `upstream-taxonomy-handoff.md` §2 defines a *third*, different-again grouping
— `LAYER_ORDER` — used to build the `services/` sidebar: `with-lookup → with-shape → with-formula
→ with-commit → with-audit → with-party → with-fork → with-store → with-pod → with-cargo`. This is
literally the `with-*` folder names, so it *is* isomorphic to the physical layer — but neither
`SERVICES.md`'s clusters nor `features.yaml`'s `cluster:` field is isomorphic to it. Concrete
non-matches:
  - Cluster F "Snapshot & Portability" (`shadow`, `pod`, `snapshots`) straddles **two** `with-*`
    folders: `shadow`/`snapshots` live in `with-fork`, `pod`/`bundle` live in `with-pod`.
  - Cluster A "Read & Query" includes `joins`, `live`, `cross-join` — none of which are `with-lookup`
    folder services (see item 2).
  - Cluster D "Data Shape" includes `i18n`, `classified` — neither is a `with-shape` folder service
    (see item 3).

**Impact:** any generator that wants to derive the `services/` nav purely from `features.yaml`'s
existing `cluster` field would produce a *different* grouping than the one the docs site actually
renders (`LAYER_ORDER`). The schema needs a field that names the physical `with-*` folder
(`layer`) *separate from* the existing conceptual `cluster` field — they answer different
questions ("what folder is this in" vs. "what conceptual band is this taught in") and both are
legitimate, but today only the second is captured in the registry.

---

## 2. `joins` / `live` / `cross-join`: documented as opt-in services, shipped as always-on core

**Source reality:** `packages/hub/tsup.entries.mjs` and `packages/hub/package.json`'s `exports`
map have **no** `./joins` or `./live` subpath. The only related entry is `'query/index':
'src/kernel/query/index.ts'` (published as `@noy-db/hub/query`), which bundles `builder.ts`,
`join.ts`, `live.ts`, `predicate.ts`, and `scan-builder.ts` together — i.e. joins and live are not
separately tree-shakeable; they ship inside the one `query` subpath, whose home folder
(`kernel/query`) is core, not a `with-*` layer.

`noy-db-docs/registry/features.yaml` already gets this right: the `joins`, `cross-join`, and `live`
entries all carry `package: '@noy-db/hub'` and `factory: null` (no `with*()` factory) — correctly
recording them as always-on.

**Docs expectation / actual defect:** `SERVICES.md`'s own Cluster A table lists `@noy-db/hub/joins`
(service #2, "~470" LOC saved) and `@noy-db/hub/live` (service #4, "~210" LOC saved) as if they were
real, separately-imported, tree-shakeable subpaths with a bundle-size cost avoided by not opting in
— the same framing used for genuinely opt-in services in the same table (`indexing`, `aggregate`).
No such subpaths exist. `SERVICES.md` is the stale/inconsistent side here, not `features.yaml`.

**Impact:** a generator or reader trusting `SERVICES.md`'s per-service subpath column over
`features.yaml` would emit a broken import example (`import { withJoins } from
'@noy-db/hub/joins'` — doesn't resolve) into rendered docs or the `llms.txt` corpus. This is the
concrete case behind the "placement ≠ opt-in" ADR (see `docs/adr/`).

---

## 3. `docs/subsystems/<name>.md` (this repo) and `content/docs/services/<name>.md` (noy-db-docs) have near-zero overlap — the real premise shift behind #624

**Source reality:** `noy-db`'s own `docs/subsystems/` holds exactly **9** files: `broker.md,
periods.md, via-blob.md, via-classified.md, via-computed.md, via-i18n.md, via-lookup.md,
via-money.md, via.md`. `noy-db-docs/content/docs/services/` holds **65** files. Comparing
basenames, only 2 names overlap (`periods`, `via`) — and even those are *different documents*:
`docs/subsystems/periods.md` is 25 lines (a terse internal note); `content/docs/services/periods.md`
is 448 lines (the full rendered page with frontmatter, API reference, edge cases). `broker.md` is
311 lines in `noy-db`'s `docs/subsystems/` but **does not exist at all** under
`noy-db-docs/content/docs/`.

**Docs expectation:** both `CLAUDE.md` (repo root and `noy-db/CLAUDE.md`) and `SERVICES.md` state
that every service has "a doc page at `docs/subsystems/<name>.md`" (`noy-db/CLAUDE.md`'s hub-anatomy
section) — but `SERVICES.md`'s own service-catalog footer already links out to
`noy-db-docs/content/docs/services/<name>.md` instead, contradicting the promise made two sections
earlier in the same file.

**Impact:** this is the central premise-shift the milestone-#26 prep map flagged — the "encode a
`subsystem_doc` join key linking a feature to its `docs/subsystems/<name>.md`" instruction in the
original #624 filing is **stale**. The living per-service documentation has already fully migrated
to `noy-db-docs`'s `content/docs/services/`; `noy-db`'s own `docs/subsystems/` is a vestigial,
9-file subset (mostly the newer via-port features + two older stragglers) that will keep diverging
from the real docs unless it is either retired or explicitly scoped to "pre-migration technical
notes, not the rendered doc." The schema proposal (deliverable b) treats
`noy-db-docs/content/docs/services/<name>.md` (via the existing `subsystem_doc` field, already
correctly pointed there in `features.yaml`) as the one join key, and recommends this repo's
`docs/subsystems/` either be retired or re-scoped — see the migration checklist.

---

## 4. The `client-portability` → `portability` + `withdrawal` split was never reconciled in `features.yaml`

**Source reality / docs expectation:** `upstream-taxonomy-handoff.md` §5 and §10 record a completed
split: the old single page `client-portability` became **two** pages/workflows —
`services/portability.md` (export) and `services/withdrawal.md` (removal) — "two halves of one
service."

**Actual registry state:** `features.yaml` still has exactly **one** entry, `id: client-portability`
(old id, doesn't match either new slug), pointing at a single `subsystem_doc:
docs/services/portability.md`. There is no entry for `withdrawal` at all.

**Impact:** any doc-sync/llms generation keyed off `features.yaml` ids can never produce a
`withdrawal` reference (no id exists to point at it), and the surviving `client-portability` id
doesn't match the `portability` slug it points to — an id/slug mismatch that the proposed
old→new slug map (deliverable b) must record and that the migration checklist (deliverable d) must
fix as a concrete first step.

---

## 5. `broker` (SERVICES.md service #27) has no `features.yaml` entry at all

**Source reality:** `SERVICES.md` documents `@noy-db/hub/broker` as service #27 in Cluster G, and
`noy-db`'s own `docs/subsystems/broker.md` (311 lines) is a real, substantial doc.

**Registry state:** a live `pnpm validate:features` run (against this checkout via
`NOY_DB_ROOT=../noy-db`) passes cleanly and reports `features=73` with no failures — but grepping
`features.yaml` for `id: broker` returns nothing. Broker was added to `SERVICES.md` (and to this
repo's `docs/subsystems/`) but never registered in `noy-db-docs`'s registry.

**Impact:** broker is invisible to every generator that walks `features.yaml` (llms index, api-index,
storage-matrix are unaffected since broker isn't a store, but any future "feature completeness"
report would silently omit it). This is a coverage gap, not a structural taxonomy defect, but it's
concrete and itemizable, and the migration checklist should include "register broker" as a step.

---

## 6. `with-cargo` / `with-pod` are orchestration/container seams, not ordinary catalog entries, but the taxonomy has no `kind` slot for that

**Source reality:** `with-cargo` (`@noy-db/hub/cargo`) is the frozen, additive-only cross-repo
orchestration seam that `klum-db`'s lobby binds to (`__tests__/cargo-surface-golden.test.ts` locks
it); `with-pod` is the `.noydb` container-format seam (backup/transport). Neither is a normal
"opt-in capability a developer picks up for one app feature" the way `with-lookup/aggregate` or
`with-audit/consent` are.

**Docs expectation:** `upstream-taxonomy-handoff.md` §2's `LAYER_ORDER` places both at the tail of
the *same* list as the eight genuine capability layers, and its `kind` enum (§2:
`reference | core | service | planned`) has no value distinguishing "cross-repo seam." A reader
of the services nav has no signal that `with-cargo`/`with-pod` pages describe a different kind of
thing than `with-lookup/search` does.

**Impact:** the schema proposal adds a `seam` kind (deliverable b) so generators and nav icons can
render this honestly instead of overloading `service`.

---

## 7. `packages/hub/src/port/<letter>/` (the strategy-port contracts) and the docs' `families/<letter>/` (satellite npm packages) share names but are different things

**Source reality:** `packages/hub/src/port/` has 8 subfolders — `as, at, by, in, on, to, ui, with`
— each the internal strategy-port contract a satellite package of the matching prefix family binds
to (e.g. `port/to` is what `@noy-db/to-file` implements against). `noy-db-docs/content/docs/families/`
has folders `as, at, by, in, on, to` (6, matching the 6 prefix grammar families;
`ui`/`with` have no family-docs folder because they aren't satellite-package prefixes) — but these
document the **published npm packages** (`packages/to-file`, `packages/in-react`, …), not the hub
port contracts.

**Impact:** no field in `features.yaml`/`feature-schema.json` currently distinguishes "hub-internal
port subpath" from "satellite family package," even though both use identical one-letter prefixes.
A future generator that tries to auto-derive family pages from hub's `port/` folder names would
silently document the wrong thing (the contract, not the package catalog). Flagged as a naming
collision risk for the schema's family/package IA fields (deliverable b addresses this by scoping
family entries strictly to `packages: '@noy-db/<prefix>-*'`, never to hub subpaths).

---

## 8. `SERVICES.md`'s LOC rollup is stale by roughly 3×

**Source reality (measured 2026-07-14 via `wc -l` on `packages/hub/src`):**
- total hub `src/**/*.ts` (excl. `*.test.ts`): **83,203** lines
- `kernel/`: **30,574** lines
- `with-*/` (all 10 layers combined): **42,804** lines
- `via/`: **6,807** lines

These match `CLAUDE.md`'s current figures (~82,000 total / ~30,000 kernel / ~42,000 services /
~6,700 via) closely.

**Docs expectation / actual defect:** `SERVICES.md`'s own "minimalist core" section header says the
six core areas "total roughly 6,500 LOC out of the hub's **~28,000**" — off by roughly 3× against
the real, current total. The per-service "LOC saved" column entries may still be individually
roughly accurate at the leaf level (not reverified line-by-line here), but the rollup totals at the
bottom of the service catalog ("~17,440 LOC across all 27 services... a consumer opting into all 27
ships ~32,490 LOC") are computed against the stale ~28,000 baseline and are consequently wrong.

**Impact:** any per-category summary format (deliverable b) that echoes `SERVICES.md`'s rollup
prose verbatim would propagate stale numbers into the docs site and the `llms-full.txt` corpus.
The migration checklist recommends either regenerating these totals from a script (reading real
file trees, mirroring how `validate-hierarchy.mjs` already reads `packages/hub/src` from the
noy-db checkout) or, at minimum, a manual refresh before PR #498's content migration copies these
numbers forward.

---

## 9. `i18n`, `classified`, `blobs`: two source layers use the same name for different things

**Source reality:** `packages/hub/src/with-shape/` has folders `blobs, introspection, links,
persisted-schemas, satellites, schema-update` — `blobs` is a real `with-shape` folder. But the
**published** `@noy-db/hub/blobs`, `@noy-db/hub/i18n`, and `@noy-db/hub/classified` subpaths (per
`tsup.entries.mjs`'s ground-truth entry map) resolve to `src/via/blob/index.ts`,
`src/via/i18n/index.ts`, and `src/via/classified/index.ts` respectively — the **via-port**
field-feature layer, not `with-shape`. `with-shape/blobs` is a real folder but is not the public
entry point for the published `blobs` subpath.

**Docs expectation:** `SERVICES.md` Cluster D "Data Shape" lists `blobs`, `i18n`, `classified`
side-by-side with identical framing (numbered service, subpath, LOC-saved), implying all three are
ordinary `with-shape` catalog services. The docs handoff's `LAYER_ORDER` groups their doc pages
under the `with-shape` layer/section for teaching purposes, matching the ADR 2 pattern ("placement
≠ opt-in" — via-port fields taught inside a `with-*` layer page group while remaining a different
physical layer underneath) — this is a legitimate pedagogical choice, but today nothing in
`features.yaml`/`feature-schema.json` records the real source layer (`via/i18n` vs `with-shape/…`),
so the fact has to be re-derived by hand each time (as this analysis just did).

**Impact:** the schema proposal's new `source` object (deliverable b) gives generators a
machine-checkable field to assert against (mirroring `validate-hierarchy.mjs`'s existing
folder-token approach) instead of requiring a manual source-tree audit like this one.

---

## Summary table

| # | Divergence | Category | Doc-sync / llms impact |
|---|---|---|---|
| 1 | `cluster` (8-way, conceptual) vs `LAYER_ORDER` (10-way, `with-*` folder) are non-isomorphic | taxonomy | nav can't be derived from `features.yaml` alone today |
| 2 | `joins`/`live`/`cross-join` documented as opt-in subpaths that don't exist | placement≠opt-in | broken import examples if generated from `SERVICES.md` |
| 3 | `docs/subsystems/*.md` (9, noy-db) vs `content/docs/services/*.md` (65, noy-db-docs) | premise shift | `subsystem_doc` join key must target noy-db-docs, not noy-db |
| 4 | `client-portability` split not reflected in `features.yaml` | registry drift | `withdrawal` id doesn't exist; id/slug mismatch |
| 5 | `broker` has no `features.yaml` entry | registry coverage | invisible to any features.yaml-driven generator |
| 6 | `with-cargo`/`with-pod` are seams, not catalog services, but share `kind: service` | taxonomy | nav can't distinguish seam pages from capability pages |
| 7 | hub `port/<letter>` contracts vs docs `families/<letter>` packages share names | naming collision | a family generator reading hub's `port/` would document the wrong thing |
| 8 | `SERVICES.md` LOC rollup stale ~3× (28k vs real 83k) | doc currency | stale numbers would propagate into rendered docs/llms |
| 9 | `blobs`/`i18n`/`classified` taught under `with-shape` but implemented in `via/` | placement≠opt-in | source layer not machine-checkable without a new field |
