# ADR 0002: Placement ≠ opt-in

> **Status:** accepted (describes a decision already implicit in the docs handoff spec and now
> made explicit for the source repo). **Date:** 2026-07-14. Second ADR in this repository — see
> ADR 0001 for the MADR-lite convention note.

## Context

The taxonomy work for #624 (`docs/superpowers/analysis/2026-07-14-624-taxonomy-gap-analysis.md`)
repeatedly found the same shape of mistake: a capability's **folder placement** (which `with-*`,
`via/`, or `kernel/` directory its source lives in, and which docs-nav section/layer teaches it)
was being read as if it were evidence of the capability's **opt-in status** (whether it ships
behind a `with<Name>()` factory / its own tree-shaken subpath, or is always loaded). These are
independent axes, and conflating them produced concrete, verifiable defects:

- `joins`, `cross-join`, and `live` are catalogued in `SERVICES.md`'s Cluster A "Read & Query"
  table with numbered service entries, dedicated subpaths, and "LOC saved" bundle-cost figures —
  the exact same framing given to genuinely opt-in services like `indexing`/`aggregate` in the same
  table. But `packages/hub/package.json`'s `exports` map has no `./joins` or `./live` subpath at
  all; both ship inside the always-loaded `@noy-db/hub/query` subpath. Their *placement* in a
  services-catalog table implied *opt-in*, and it was wrong.
- `i18n`, `classified`, and `blobs` are taught inside the `with-shape` docs layer (and, for
  `blobs`, there is even a same-named `with-shape/blobs` folder that is a red herring) — but the
  actual published subpaths resolve (per `tsup.entries.mjs`, the ground-truth entry map) to
  `via/i18n`, `via/classified`, `via/blob`. Their *placement* in the `with-shape` nav layer implied
  they were `with-shape` services; they are via-port field-features, a different opt-in mechanism
  entirely (declared per-field, not per-vault).
- `with-cargo` and `with-pod` sit at the tail of the same `LAYER_ORDER` list (noy-db-docs handoff
  §2) as genuine capability layers like `with-lookup`/`with-audit`, with no `kind` value to signal
  that they are frozen cross-repo orchestration/container **seams**, not ordinary "opt into this
  for one app feature" services.

The noy-db-docs handoff spec already names half of this rule explicitly (§2: "a feature can be
displayed in a service layer while keeping the `core` (cpu) icon — icon = architectural truth;
placement = pedagogy. Keep those two axes independent" — citing `joins`/`cross-join`/`links` as the
`ALWAYS_ON_OPS` exception list). This ADR generalizes that observation from "core-vs-service icon
choice inside the docs nav" to the full statement needed on the source side: **a package or
subsystem's taxonomy/folder placement never entails, and is never entailed by, its opt-in
mechanism.**

## Decision

**Placement and opt-in status are two independent axes. Neither may be inferred from the other.**

1. **Placement** answers: *where does a reader find this, and where does its code physically
   live?* This includes: which `with-*`/`via`/`kernel` folder the implementation is in, and which
   docs-nav section/layer teaches it (which may legitimately differ from the folder — see ADR
   0001's `refs` → `foreign-refs` relocation example, a pedagogy-only move).
2. **Opt-in status** answers: *does using this require a `with<Name>()` factory / does not
   importing it save bundle size?* This is a binary, mechanically checkable fact: does a dedicated
   subpath exist in `package.json`'s `exports` map, and does `scripts/check-architecture.mjs`'s
   `strategy-opt-in` guard require a factory reference to use its API?

Consequences of treating them as independent, applied concretely:

- A capability may be **taught inside a services-nav layer while being always-on** (`joins`,
  `cross-join`, `links` — the docs handoff's own `ALWAYS_ON_OPS` list, and `user-envelope`, which
  `SERVICES.md` explicitly documents as "included in the always-on core because it has zero
  peer-dep cost"). These get `kind: core`, never `kind: service`, regardless of which `layer` they
  are grouped under for teaching purposes (schema proposal, `docs/superpowers/analysis/2026-07-14-624-feature-schema-proposal.md` §1).
- A capability may be **taught inside one `with-*` layer's nav folder while its real
  implementation is a different mechanism entirely** (`i18n`/`classified`/`blobs` taught under
  `with-shape`, implemented in `via/`). The new `source.path` field (schema proposal §7) records
  the physical truth independently of the `layer` field's pedagogical grouping, so this is
  machine-checkable instead of requiring a manual audit each time (as the gap analysis had to do).
- A capability may be **grouped in the same layer list as ordinary services while being a
  qualitatively different thing** — a frozen cross-repo seam (`with-cargo`, `with-pod`), not a
  pick-it-up-if-you-need-it capability. These get `kind: seam` (schema proposal §1), a value
  distinct from `service`, so nav rendering and generators can treat them honestly rather than
  overloading the service icon/framing.
- Conversely: **a real opt-in service's LOC-saved framing must be verified against the actual
  `exports` map, not asserted from its catalog-table position.** `SERVICES.md`'s Cluster A entries
  for `joins`/`live` are the concrete counter-example this ADR exists to prevent recurring — the
  table's mere existence and numbering scheme implied opt-in status that reality doesn't back.

## Consequences

- **`SERVICES.md`'s Cluster A table needs a correction** (tracked in the migration checklist,
  `docs/superpowers/analysis/2026-07-14-624-498-migration-checklist.md`): `joins`/`live`/`cross-join`
  should either be footnoted as "ships inside `@noy-db/hub/query`, not independently tree-shaken"
  or removed from the numbered/subpath-bearing rows entirely and described in prose alongside the
  core query-basics section instead.
- **Any future feature-catalog entry (`noy-db-docs`'s `features.yaml`) must set `layer` and `kind`
  independently** — a reviewer adding a new entry should not derive `kind` from `layer`, or
  vice versa; both are separately verified against the source tree and the `exports` map.
- **The taxonomy schema's `layer` field is descriptive of nav placement only** — it must never be
  read by a generator as "this entry is a with-*() opt-in service." That inference is exactly the
  bug pattern this ADR documents. `kind` is the field that answers the opt-in question; `layer`
  never does.
- **This axis-independence generalizes beyond services**: the same rule applies to the `families`
  section (a package's prefix-family placement, e.g. `to-*`, says nothing about which storage
  capability shape — `record`/`vault` — it implements; that's the separate `adapters[].capabilities`
  concept, already correctly kept as its own field in the existing schema) and to the via-port
  (a field-feature's presence in a `with-*` nav layer's page says nothing about whether it composes
  through the via pipeline or the with-strategy pipeline — two different opt-in mechanisms that
  happen to render in the same nav folder for a reader's convenience).
