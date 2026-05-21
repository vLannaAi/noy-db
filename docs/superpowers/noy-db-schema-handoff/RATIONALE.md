# Schema layer — rationale

The decisions in `BRIEF.md` are settled. This file explains *why*, for
when someone asks. Skim or skip.

## Why YAML + JSON, not Prisma or a custom DSL

**YAML chosen for:** comments, multi-line strings, anchors/aliases (DRY
ACL blocks), no syntactic noise from braces/quotes, indentation matches
how humans think about nested structures. Editor support is excellent
via `yaml-language-server` with the JSON Schema header. Convergence with
dbt, Cube, OpenAPI, GitHub Actions, Kubernetes — adopters already know
the shape.

**JSON used as the machine-emitted equivalent:** every parser handles
it, diff tools cope cleanly, JSON Schema validation is native. Same
content as YAML, byte-shifted into a tool-friendly form.

**Prisma considered and rejected:** beautiful syntax for the relational
core, real ecosystem (GitHub highlighting, VS Code extension, formatter,
validator). But:

- Prisma's grammar is fixed. MVs, overlay views, vaults, derivations,
  CRDTs, history strategies have no place in the language. Smuggling
  them in as `@@` attributes works syntactically but reads as a hack
  and breaks `prisma validate`.
- The Prisma parser is Rust; the JS-side parser (`@mrleebo/prisma-ast`)
  is community-maintained and lags. noy-db would depend on either a
  third-party parser or shelling out to Prisma's CLI.
- Adopters arriving with Prisma muscle memory will assume `prisma generate`
  and `prisma migrate` apply. They don't. The syntactic familiarity
  creates a semantic mismatch — an adoption tax paid on every
  introduction.
- ~60-70% of what noy-db needs to express fits Prisma's model. The
  remaining 30-40% (MVs, overlays, vaults, derivations, subsystems)
  splits the schema across multiple files.

**Custom DSL (tree-sitter / parser combinators) considered and deferred:**
the most readable result possible, owns the grammar, supports MVs and
overlays as first-class block types. But: ~1 week of work for the parser,
grammar, formatter, LSP, syntax highlighting. Investment only pays off
if the schema file becomes a thing users spend serious time in.
Reconsider post-v0.1 once we know whether YAML is actually painful.

**TOML considered and rejected:** nice for flat config; awkward for
deeply nested structures. Forces either `[[table.array]]` verbosity or
inline tables (looks like JSON again). Schema is deeply nested.

## Why `@noy-db/schema` and not `@noy-db/ddl` or `@noy-db/strategy`

- `ddl` is technically accurate but carries SQL baggage. Users read it
  as "SQL is hiding in here somewhere". Fights noy-db's positioning.
- `strategy` collides with existing `with*Strategy()` seam pattern
  (`historyStrategy`, `aggregateStrategy`). Confuses the mental model.
- `schema` is what dbt, Prisma, Cube, Drizzle, OpenAPI, Kubernetes all
  call this layer. Convergent terminology. Risk: within the codebase,
  "Schema" is overloaded with JSON Schema and Zod schema. Mitigated by
  using `VaultSchema`, `JsonSchema`, `ZodSchema` as distinct type names.

## Why field-local FK references, not a separate relationships section

The Mermaid `erDiagram` failure mode: `||--o{` notation forces mental
decoding per relationship, and relationships are declared in a separate
section from the entities — so reading the file means cross-referencing.

Field-local references keep the FK next to the field it constrains.
The eye is already there when you're reading the field. The YAML reads
naturally without the diagram, which was the design goal.

## Why declarative shape only, not runtime configuration

The schema layer is a description of what exists. Runtime configuration
(which storage backend, which unlock method, which transport) is per-
deployment and per-environment. Same vault definition, different
backends across dev/staging/prod.

Mixing them in one file means the schema file becomes a god-config —
the dbt path that adopters often regret. Prisma's separation (schema
vs `prisma.config` vs env vars) is the better model.

The borderline case is subsystem opt-in. We put it in scope because it
affects what schema constructs are even legal (no `withHistory()` =
no time-machine queries to validate). A subsystem either lights up
schema constructs or it doesn't; that's a schema-time fact.

## Why hybrid Zod embedding (tentative)

JSON Schema can't express Zod's full API (refinements, transforms,
discriminated unions). Three options:

- Option A (JSON Schema primary): loses refinements/transforms entirely.
  Most adopters don't need them, but the ones who do can't escape.
- Option B (Zod primary): requires Zod source files alongside every YAML
  schema. Doubles the surface area; the YAML becomes a partial mirror.
- Option C (hybrid): YAML covers the 80% of simple cases (strings,
  numbers, constraints, enums). Complex cases reference a Zod schema
  by path. Both forms exist where they're each best.

The cost of C is one extra concept ("how do I write a custom
validation?"), paid only by the minority who need it. ADR to confirm in
issue #2.

## Why `feat/schema` long-running branch, not feature flags on main

Schema work touches packaging, types, CLI, and docs. Vertical slices
mean each PR can be reviewed independently, but landing them on main
piecemeal would expose half-built APIs to adopters. A long-running
branch keeps the surface clean until the slice is coherent.

Counter-argument: long-running branches accumulate drift. Mitigated by
the explicit "merge to main early if independent" clause — for example,
the JSON Schema file from issue #1 is just documentation and can land
on main immediately.

## Why eight issues, not one or two

The work is genuinely independent enough to parallelize after #1 and
#3 land:

- #4 (semantic validator) and #5 (introspection) share types from #3
  but don't share code.
- #6 (CLI) consumes #4 and #5 but adds no new logic.
- #7 (codegen) consumes #3 but is independent of #4/#5/#6.
- #8 (docs) consumes everything but lags one cycle.

One issue would block parallelization. Two would lump independent work
together. Eight matches the actual seams.

## Why drawio for round-trip editing (when that work starts later)

drawio's `.drawio` XML is parseable, supports arbitrary custom
attributes on every shape (so noy-db can stamp `noydb:collection-id`,
`noydb:kind="overlay-view"` etc.), has a free desktop app, web app,
VS Code extension, and GitHub-native preview. Positions survive saves.

DBML doesn't preserve positions; dbdiagram.io stores them server-side.
Mermaid has no manual positioning at all. drawio is the only format
that does all three things round-tripping needs.

This is documented here because it informs how stable collection IDs
need to be in the v0.1 schema — they're the join key between YAML and
diagram XML.

## What we explicitly chose not to think about yet

- Schema versioning and migration between schema versions. Real concern
  at v1.0. Not at v0.1.
- Multi-vault references (cross-vault FK). Out of scope; `queryAcross`
  remains explicit.
- Permissions on the schema file itself (who can edit which collections
  in a multi-tenant setup). Not a v0.1 concern; the file is a git
  artifact, not a runtime object.
- Streaming / progressive validation for very large schemas. Premature.
  Most vaults will have <50 collections.
