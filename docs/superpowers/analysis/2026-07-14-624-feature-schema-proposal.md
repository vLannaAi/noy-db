# #624 — `feature-schema.json` / `features.yaml` proposal

> Milestone #26, Task 4, deliverable (b). This is a **proposal for `noy-db-docs`** — nothing here
> is applied to `registry/feature-schema.json` or `registry/features.yaml` by this document; the
> noy-db-docs maintainer implements it (see the migration checklist,
> `docs/superpowers/analysis/2026-07-14-624-498-migration-checklist.md`, for the applying steps).
> Every field name, enum value, and example below is grounded in the real schema/registry read at
> `noy-db-docs`'s `docs-presentation-polish` branch and the gap analysis
> (`docs/superpowers/analysis/2026-07-14-624-taxonomy-gap-analysis.md`) — each addition below is
> labelled with which gap-analysis item(s) it resolves.

## Current schema baseline (for reference)

`feature-schema.json`'s `$defs.baseEntry` today has: `id, name, package, status, experimental,
showcases, recipes, playground_pages, diagrams, invariants, related`. `$defs.feature` adds
`cluster, spec, subsystem_doc, factory`. None of `layer`, `kind`, `title`, `subtitle`, `nav_alias`,
an order list, a summary-format spec, family-package IA, a slug map, or a `source` join key exist
today. This proposal adds all of them, additively — `additionalProperties: false` blocks mean each
new property must be explicitly added to every relevant `$defs` entry, not just `baseEntry`.

---

## 1. `layer` + `kind` fields (resolves gap-analysis #1, #6)

Add two new fields to `baseEntry` (so every entry kind — feature, adapter, framework, auth, export,
transport, sealer — can carry them):

```jsonc
"layer": {
  "enum": ["lookup", "shape", "formula", "commit", "audit", "party", "fork", "store", "pod", "cargo"],
  "description": "The physical with-<layer> folder in packages/hub/src this entry's implementation lives in (or is taught under, for via-port fields displayed inside a with-* nav group — see `source.layer` for the ground-truth physical folder when they differ). Null/absent for entries outside the with-* catalog (core, families, recipes)."
},
"kind": {
  "enum": ["reference", "core", "service", "seam", "planned"],
  "description": "reference = concept page, no API of its own. core = always-on, no with*() opt-in. service = a real opt-in with<X>() kernel extension. seam = a frozen cross-repo orchestration/container contract (with-cargo, with-pod) — NOT an ordinary opt-in capability, do not render with the service icon. planned = reserved slot, not implemented."
}
```

Example — `joins` corrected to be unambiguous about both axes (today it only has `cluster:
read-and-query`, which conflates "taught in the Read & Query band" with "is a with-lookup service,"
neither of which layer/kind now needs to guess at):

```yaml
- id: joins
  name: Intra-vault joins on declared ref() fields
  cluster: read-and-query      # existing field, kept — conceptual teaching band
  layer: lookup                # taught inside the with-lookup nav group (services/joins.md)
  kind: core                    # NOT a service — always-on, no with*() factory, no dedicated subpath
  spec: docs/services/joins.md#joins
  subsystem_doc: docs/services/joins.md
  package: '@noy-db/hub'        # unchanged: ships inside the barrel/query subpath, not its own
  factory: null
  status: stable
```

Example — `with-cargo`'s orchestration seam, once it gets a features.yaml entry (it currently has
none — cargo is documented only in `SERVICES.md`/`CLAUDE.md` prose):

```yaml
- id: cargo
  name: Cargo orchestration seam (@noy-db/hub/cargo)
  cluster: operations
  layer: cargo
  kind: seam
  spec: docs/architecture/2.ports/cargo.md#cargo
  subsystem_doc: docs/architecture/2.ports/cargo.md
  package: '@noy-db/hub/cargo'
  factory: null
  status: stable
```

---

## 2. `title` / `subtitle` / `nav_alias` + slug rules (new, per handoff §4)

Add to `baseEntry`:

```jsonc
"title": {
  "type": "string",
  "pattern": "^[a-z][a-z0-9 —-]*$",
  "description": "Lowercase slug-style display title per handoff §4.1 (e.g. 'search — full-text', 'sealing provider id'). Falls back to `name` when absent — most entries won't need this override."
},
"subtitle": {
  "type": "string",
  "minLength": 1,
  "description": "One-line descriptor shown under a short `title` in the page header when the title alone is ambiguous or jargon-y (handoff §4.2, tool 1: descriptor). Only meaningful alongside `title`."
},
"nav_alias": {
  "type": "string",
  "pattern": "^[a-z][a-z0-9-]*$",
  "description": "Sidebar-only short label when the page's own name must stay long/proper (handoff §4.2, tool 2: alias — e.g. page 'transferable partitions' -> sidebar 'partitions'). Distinct from `title`+`subtitle`: pick nav_alias when the full name is correct and only the sidebar needs shortening; pick title+subtitle when the descriptor itself should change."
}
```

Slug rule (documented, not schema-enforced beyond the `title` pattern above): sidebar labels budget
**≤ 20 characters** (handoff §4.2 — empirically truncates between 19 and 23 chars). A lint (not a
schema field) should flag any `nav_alias ?? title ?? name` over 20 chars.

Example — `sealing-pid-stability` (already renamed per handoff §5/§10):

```yaml
- id: sealing-pid-stability
  name: Sealing provider id (pid) stability
  title: sealing provider id
  subtitle: "the pid string, semver-frozen once a provider ships v1.x"
  layer: null
  kind: reference
```

Example — `transferable-partitions` (alias, not descriptor — the long name is correct, only the
sidebar needs shortening):

```yaml
- id: transferable-partitions
  name: Transferable partitions
  nav_alias: partitions
```

---

## 3. Explicit section + layer order lists (resolves gap-analysis #1)

Today `SECTION_ORDER` is hardcoded independently in **two** places (`apps/docs/app/app.vue` and
`registry/render-llms.mjs`, per the handoff's own "must stay in sync" comment) and `LAYER_ORDER`
lives only in `apps/docs/app/utils/service-layers.ts`. Promote both to schema-validated top-level
arrays in `features.yaml` itself, so there is exactly **one** source both the app and the generator
read:

```jsonc
// feature-schema.json — new top-level properties
"section_order": {
  "type": "array",
  "items": { "enum": ["start", "core", "services", "families", "recipes", "architecture", "glossary", "migration"] },
  "minItems": 8, "maxItems": 8, "uniqueItems": true
},
"layer_order": {
  "type": "array",
  "items": { "enum": ["lookup", "shape", "formula", "commit", "audit", "party", "fork", "store", "pod", "cargo"] },
  "minItems": 10, "maxItems": 10, "uniqueItems": true
}
```

```yaml
# features.yaml — top level, alongside schemaVersion
section_order: [start, core, services, families, recipes, architecture, glossary, migration]
layer_order:   [lookup, shape, formula, commit, audit, party, fork, store, pod, cargo]
```

`render-llms.mjs`'s `SECTION_ORDER` const and `app.vue`'s `SECTION_ORDER` both become "read from
`features.yaml`" instead of two hand-maintained literals; same for `service-layers.ts`'s
`LAYER_ORDER`. This is the direct fix for the "must stay in sync" risk the handoff calls out in §1.

---

## 4. Per-category summary format spec (resolves gap-analysis #8, generator-facing)

Encode the handoff §7 table as schema-consumable config rather than a prose table maintainers must
remember. Add a top-level `summary_formats` map:

```jsonc
"summary_formats": {
  "type": "object",
  "additionalProperties": {
    "type": "object",
    "properties": {
      "kind": { "enum": ["service-meta-table", "blockquote", "two-line-blockquote", "none"] },
      "fields": { "type": "array", "items": { "type": "string" } }
    }
  }
}
```

```yaml
summary_formats:
  services:      { kind: service-meta-table, fields: [Subpath, Factory, Layer, Kind] }
  core:          { kind: blockquote, fields: [status, source_of_truth] }
  architecture:  { kind: blockquote, fields: [framing_sentence, source_pointer] }
  families:      { kind: none }               # Overview + grouped catalog, not a per-page anchor block
  recipes:       { kind: two-line-blockquote, fields: [Audience, Bundle] }
  start:         { kind: none }
  migration:     { kind: blockquote, fields: [applies_to] }
  glossary:      { kind: none }
```

Note the `Layer`/`Kind` row values in the `services` `service-meta-table` format read directly off
the new `layer`/`kind` fields (§1 above) instead of being retyped by hand on every page — this is
also where `SERVICES.md`'s stale LOC rollup (gap #8) gets a real fix path: a `loc_saved` numeric
field (not proposed here as schema, since it's a generated/measured value, not authored — flagged
for `noy-db-docs` to decide whether it belongs in the registry or purely in a generator that reads
real file trees, mirroring `validate-hierarchy.mjs`'s existing approach of reading a live noy-db
checkout rather than hand-typed numbers).

---

## 5. Family per-package IA + the `to → in → on → as → by → at` order (resolves gap-analysis #7)

New `$defs.familyPackage` type + a `family_order` top-level array, and a `family` field added to
`baseEntry` restricted to the six satellite prefixes — explicitly **not** reusable for hub's
internal `port/<letter>` folders (gap #7's naming-collision risk):

```jsonc
"family_order": {
  "type": "array",
  "items": { "enum": ["to", "in", "on", "as", "by", "at"] },
  "const": ["to", "in", "on", "as", "by", "at"]
},
"$defs": {
  "familyPackage": {
    "type": "object",
    "additionalProperties": false,
    "required": ["id", "family", "package", "status"],
    "properties": {
      "id":      { "$ref": "#/$defs/id" },
      "family":  { "enum": ["to", "in", "on", "as", "by", "at"], "description": "The satellite package prefix family. NEVER set for a hub-internal packages/hub/src/port/<letter> entry — those are strategy-port contracts, not families, and have no doc page under content/docs/families/." },
      "package": { "type": "string", "pattern": "^@noy-db/(to|in|on|as|by|at)-[a-z][a-z0-9-]*$" },
      "status":  { "$ref": "#/$defs/status" },
      "subsystem_doc": { "type": "string", "pattern": "^docs/families/(to|in|on|as|by|at)/.+\\.md$" }
    }
  }
}
```

```yaml
family_order: [to, in, on, as, by, at]
```

Example — one page-per-package entry:

```yaml
family_packages:
  - id: to-file
    family: to
    package: '@noy-db/to-file'
    status: stable
    subsystem_doc: docs/families/to/file.md
```

The existing `adapters[]` array (which already models `to-*` stores with `capabilities:
{record,vault}`) is a different, narrower concept — a store's storage-shape capability — and
should **not** be merged with `family_packages[]`: an adapter entry describes what a `to-*` package
*does*; a `family_packages[]` entry describes *where its doc page lives in the families IA*. Both
can coexist per `to-*` package (cross-referenced by `package`), matching the existing pattern where
`adapters[]` and `features[]` already independently describe different facets of the same
`@noy-db/hub` package.

---

## 6. Old→new slug map (resolves gap-analysis #4)

New top-level `slug_map` array — a plain redirect table, schema-validated so a stale/duplicate
redirect fails CI instead of silently rotting:

```jsonc
"slug_map": {
  "type": "array",
  "items": {
    "type": "object",
    "additionalProperties": false,
    "required": ["from", "to"],
    "properties": {
      "from": { "type": "string", "pattern": "^/.*$" },
      "to":   {
        "oneOf": [
          { "type": "string", "pattern": "^/.*$" },
          { "type": "array", "items": { "type": "string", "pattern": "^/.*$" }, "minItems": 2 }
        ],
        "description": "A single string for a rename; an array of 2+ for a split (each target should carry a `split_note` cross-link on its own page, per handoff §5's 'two halves of one service' convention)."
      }
    }
  }
}
```

```yaml
slug_map:
  - from: /core/refs
    to: /services/foreign-refs
  - from: /services/client-portability
    to: [/services/portability, /services/withdrawal]
```

This directly fixes gap #4: once `slug_map` carries the split, the migration checklist can
mechanically derive that `features.yaml` needs a second `id: withdrawal` entry (today missing) and
that the surviving `id: client-portability` should be renamed `id: portability` to match its
`to:` slug.

---

## 7. `source` join key — the corrected replacement for the original "docs/subsystems/<name>.md" ask (resolves gap-analysis #3, #9)

The original #624 filing asked for a `subsystem_doc` join key linking a feature to its
`docs/subsystems/<name>.md` in **noy-db**. Gap-analysis item 3 found that convention is stale for
all but 9 of ~65 services — the real rendered doc lives in **noy-db-docs**'s
`content/docs/services/<name>.md`, which the existing `subsystem_doc` field (pattern
`^docs/.+\.md$`, resolved against `content/docs/` per `validate-features.mjs`) already correctly
points at. Rather than repointing `subsystem_doc` (it's already right), add a **new**, separate
field that names the real noy-db-side **source** folder — this is the missing half, and it is what
makes gap #9 (`i18n`/`classified`/`blobs` taught under `with-shape` but implemented in `via/`)
machine-checkable instead of requiring a manual audit:

```jsonc
"source": {
  "type": "object",
  "additionalProperties": false,
  "required": ["path"],
  "properties": {
    "path": {
      "type": "string",
      "pattern": "^(kernel|via|with-[a-z]+|port/[a-z]+)(/[a-z][a-z0-9-]*)*$",
      "description": "Repo-relative path under packages/hub/src/ (noy-db) where this entry's real implementation lives — the ground truth, independent of which nav layer teaches it. E.g. 'via/i18n', 'with-lookup/aggregate', 'kernel/query'."
    }
  }
}
```

Example — the `i18n` feature, resolving gap #9 explicitly:

```yaml
- id: i18n
  name: Multi-locale records
  layer: shape        # taught inside the with-shape nav group (services/i18n.md)
  kind: service
  source: { path: via/i18n }   # real implementation is via-port, NOT with-shape
  subsystem_doc: docs/services/i18n.md
```

A generator (extending `validate-hierarchy.mjs`'s existing pattern of reading a live noy-db
checkout via `NOY_DB_ROOT`) can now assert `source.path` resolves to a real folder — the same
mechanism that already backs `validate-coverage.mjs`/`validate-hierarchy.mjs`, just keyed per
entry instead of per bulk folder-scan.

---

## 8. Generator contracts — what each script consumes, updated for the new fields

| Generator | Consumes today | Consumes after this proposal |
|---|---|---|
| `render-llms.mjs` | hardcoded `SECTION_ORDER` const; page frontmatter (`title`, `description`) | `features.yaml`'s `section_order` (§3) instead of its own hardcoded const; unchanged otherwise |
| `render-api-index.mjs` | page `## API` headings only, no registry read | unchanged — out of scope for this proposal (it never reads `features.yaml`) |
| `render-storage-matrix.mjs` | `adapters[].capabilities` | unchanged — `capabilities` is untouched by this proposal |
| `validate-frontmatter.mjs` | per-page `tier`/`status`/`nest` frontmatter | unchanged directly, but could cross-check a page's `nest` against the owning entry's new `kind` (`seam` → `nest: cargo|pod`, per the existing `NESTS` set which already has `cargo`/`pod` values) |
| `validate-coverage.mjs` | live scan of `packages/hub/src/with-*/*` folder names vs `content/docs/services/*.md` | could additionally cross-check each scanned service's `source.path` (§7) against the folder it was scanned from, catching drift the other direction |
| `validate-hierarchy.mjs` | live scan of `kernel/<sub>`, `port/<name>`, `with-<layer>` tokens vs architecture docs prose | unchanged — already the model `source.path` (§7) borrows its checked-against-live-checkout approach from |
| `validate-features.mjs` | schema + path round-trip + cross-reference resolution (existing 6 phase-1 checks) | add: `slug_map` entries resolve to real `content/docs/` pages on the `to` side (§6); `source.path` (§7) resolves under `NOY_DB_ROOT/packages/hub/src/` the same way `SERVICES.md`-style noy-db paths already do |
| *(new, optional)* | — | a `validate-layer-order.mjs` (or folded into `validate-hierarchy.mjs`) asserting every `layer`-tagged entry's value is one of the 10 in `layer_order` (§3), and that `layer_order`/`section_order` in `features.yaml` are the only place these lists are hand-maintained (killing the two-file "must stay in sync" duplication the handoff flags in §1) |

---

## Summary of new fields

| Field | Scope | Resolves |
|---|---|---|
| `layer` | baseEntry | gap #1 |
| `kind` (incl. new `seam` value) | baseEntry | gap #1, #6 |
| `title` / `subtitle` / `nav_alias` | baseEntry | (new capability, handoff §4) |
| `section_order` / `layer_order` (top-level) | registry | gap #1 (kills two-file duplication) |
| `summary_formats` (top-level) | registry | gap #8 (LOC-rollup currency path) |
| `family` / `family_order` / `familyPackage` $def | registry | gap #7 |
| `slug_map` (top-level) | registry | gap #4 |
| `source` (path) | baseEntry | gap #3, #9 |
