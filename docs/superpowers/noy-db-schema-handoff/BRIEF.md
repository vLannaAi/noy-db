# Schema layer — design brief

Decisions already made. Don't relitigate; if you want the rationale, see
`RATIONALE.md`.

## Package

- **Name:** `@noy-db/schema`
- **Location:** `packages/schema/`
- **Runtime deps:** zero. Peer deps on `yaml`, `zod`, `ajv` if used.
- **Public API (v0.1):**
  - `parseSchema(input: string | object): VaultSchema`
  - `validateSchema(schema: VaultSchema): ValidationResult`
  - `serializeSchema(schema: VaultSchema, format: 'yaml' | 'json'): string`
  - `introspect(db: NoyDb, vault: string, opts?: { withStats?: boolean }): Promise<VaultSchema>`
  - TypeScript types for every node in the schema tree

## Format

- **Human-edited source of truth:** YAML (`vault.noydb.yaml`)
- **Machine-emitted equivalent:** JSON (`vault.noydb.json`)
- **Validation:** one JSON Schema (`noydb-schema.schema.json`) validates both
- **YAML parser:** `yaml` npm package by Eemeli Aro (preserves comments on round-trip). Not `js-yaml`.
- **Editor integration:** `# yaml-language-server: $schema=...` header at top of every YAML file.

## In scope (v0.1)

- Collection declarations
- Field declarations with embedded validation (Zod / JSON Schema)
- Indexes
- FK references — declared field-local, never positional
- Materialized views (with refresh-key declarations)
- Overlay views
- Aggregates (sum, avg, count, groupBy)
- Derivations
- ACLs (5 known roles: owner / admin / operator / viewer / client)
- i18n field annotations (BCP-47 language tags)
- Tier classification
- Subsystem opt-in flags (whether `withHistory()` etc. are active)

## Out of scope (v0.1)

These are **runtime configuration**, not schema:

- Storage backend selection (`to-*` packages)
- Unlock method (`on-*` packages)
- Framework binding (`in-*` packages)
- Transport (`by-*` packages)
- Export format selection (`as-*` packages)
- Refresh-strategy implementation choices (which scheduler, which queue)

## Non-goals

- A custom DSL with its own grammar (tree-sitter, parser combinators). Reconsider post-v0.1 if YAML proves insufficient.
- A visual editor. Tracked in a separate milestone; depends on this one.
- Mermaid / DBML / drawio emitter. Tracked in a separate milestone; depends on this one.
- Migration tooling for existing implicit schemas. v0.1 is additive; users opt in.

## Zod embedding strategy (pending ADR — issue #2)

Three options were considered:

- **A)** JSON Schema as primary; Zod generated at codegen time. Loses refinements/transforms.
- **B)** Zod as primary; convert to JSON Schema for the YAML form. Requires Zod source files alongside YAML.
- **C)** Hybrid: simple types and constraints in YAML; complex validations reference a Zod schema by path (e.g. `validate: "./schemas/invoice.ts#InvoiceSchema"`).

**Tentative recommendation:** C. Most fields are scalar with simple constraints; YAML stays readable. Complex cases escape to TS. ADR to be written before implementation (issue #2).

## Branching

- **Branch:** `feat/schema` (long-running)
- **Strategy:** vertical slices per issue. Each PR independently mergeable into `feat/schema`.
- **Promotion:** merge `feat/schema` → `main` when milestone closes, or earlier if a slice is genuinely independent (e.g. the JSON Schema file from issue #1 can land on `main` immediately as docs).
- **Subsystem development on `main` continues uninterrupted.** The schema layer is read-only with respect to existing code.

## Issue ordering and dependencies

```
#1 Format design + JSON Schema      ──┬──→ #3 Package scaffold ──┬──→ #4 Semantic validator ──→ #6 CLI ──┐
#2 Zod embedding ADR                ──┘                          ├──→ #5 Introspection ────────────────┤
                                                                 └──→ #7 Codegen                       │
                                                                                                       └──→ #8 Docs
```

## Naming conventions inside the codebase

- `VaultSchema` — noy-db's schema definition (this package)
- `JsonSchema` — the JSON Schema spec (used to validate `VaultSchema`)
- `ZodSchema` — a Zod schema (used to validate individual records)

Never just "Schema" in type names — too ambiguous given the three meanings.

## Error codes

Semantic validation errors have stable codes: `NOYDB_SCHEMA_E001`, etc.
Each error includes file path, line, column, human-readable message, and
suggested fix where possible.

## What the YAML must read like

- References are field-local and **named**, never positional:
  ```yaml
  fields:
    client_id:
      type: string
      references: clients.id   # right here, next to the field
  ```
- Stable IDs (the YAML key) separate from display labels.
- No "relationships:" section at the bottom of the file.
- Comments preserved on round-trip.

The design rule: **the YAML must be readable without the diagram.**
