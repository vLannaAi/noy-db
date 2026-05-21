#!/usr/bin/env bash
#
# Creates the "Schema: declarative vault definition language" milestone
# and 8 associated issues on vLannaAi/noy-db.
#
# Requirements:
#   - gh CLI installed and authenticated (`gh auth status`)
#   - Token has `repo` scope (write access to issues + milestones)
#
# Usage:
#   bash create-schema-milestone.sh             # create everything
#   bash create-schema-milestone.sh --dry-run   # print what would be created
#
# Safe to re-run: it checks for an existing milestone with the same title
# and reuses it; existing issues with the same title are skipped.

set -euo pipefail

REPO="vLannaAi/noy-db"
MILESTONE_TITLE="Schema: declarative vault definition language"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "DRY RUN — no changes will be made"
  echo
fi

run() {
  if $DRY_RUN; then
    echo "would run: $*"
  else
    "$@"
  fi
}

# --- Milestone ---------------------------------------------------------------

MILESTONE_DESC=$(cat <<'EOF'
Establish a declarative format for describing the shape of a noy-db vault:
collections, fields with embedded validation, FK references, indexes,
materialized views, overlay views, aggregates, ACLs, and i18n annotations.

Goal: enable introspection, diagram generation, static consistency checks,
and (eventually) round-trip editing via external tools — without coupling
to any single storage backend, framework, or unlock method.

Tracked in a long-running branch (`feat/schema`) so subsystem development
on `main` is not blocked. Mergeable in vertical slices: format spec first,
then introspector, then emitters, then validators.

**Scope decisions (v0.1):**
- Format: YAML as human-edited source of truth; JSON as machine-emitted equivalent. Both validated against the same JSON Schema.
- Package: `@noy-db/schema` — parser, validator, type definitions, introspection API.
- **IN SCOPE:** collection/field declarations, Zod/JSON Schema validation, indexes, FK references, MVs, overlay views, aggregates, derivations, ACLs, i18n annotations, tier classification, subsystem opt-in flags.
- **OUT OF SCOPE for v0.1:** storage backend selection (`to-*`), unlock method (`on-*`), framework binding (`in-*`), transport (`by-*`), export format selection (`as-*`). These remain runtime configuration.

**Non-goals:**
- A custom DSL with its own grammar (tree-sitter, parser combinators). Reconsider post-v0.1 if the YAML form proves insufficient.
- A visual editor. Tracked separately; depends on this milestone.
- Round-trip with drawio/Mermaid. Tracked separately; depends on this milestone.

**Branching:**
- Branch: `feat/schema` (long-running)
- Merge strategy: vertical slices per issue, each PR independently mergeable into `feat/schema`. Merge `feat/schema` → `main` when milestone closes, or earlier if a slice is genuinely independent.
- Subsystem development on `main` continues uninterrupted. The schema layer is read-only with respect to existing code in v0.1.
EOF
)

echo "Looking up milestone..."
MILESTONE_NUMBER=$(gh api "repos/$REPO/milestones?state=open" --jq \
  ".[] | select(.title == \"$MILESTONE_TITLE\") | .number" || true)

if [[ -n "$MILESTONE_NUMBER" ]]; then
  echo "Milestone already exists: #$MILESTONE_NUMBER"
else
  echo "Creating milestone..."
  if $DRY_RUN; then
    echo "would create milestone: $MILESTONE_TITLE"
    MILESTONE_NUMBER="DRY_RUN"
  else
    MILESTONE_NUMBER=$(gh api "repos/$REPO/milestones" \
      -f title="$MILESTONE_TITLE" \
      -f description="$MILESTONE_DESC" \
      -f state="open" \
      --jq '.number')
    echo "Created milestone #$MILESTONE_NUMBER"
  fi
fi

# --- Helper: create issue if title doesn't already exist ---------------------

create_issue() {
  local title="$1"
  local body="$2"
  shift 2
  local labels=("$@")

  local existing
  existing=$(gh issue list --repo "$REPO" --state all --search "in:title \"$title\"" --json title,number \
    --jq ".[] | select(.title == \"$title\") | .number" || true)

  if [[ -n "$existing" ]]; then
    echo "  skip (exists as #$existing): $title"
    return
  fi

  if $DRY_RUN; then
    echo "  would create: $title  [labels: ${labels[*]}]"
    return
  fi

  local label_args=()
  for l in "${labels[@]}"; do
    label_args+=(--label "$l")
  done

  gh issue create --repo "$REPO" \
    --title "$title" \
    --body "$body" \
    --milestone "$MILESTONE_TITLE" \
    "${label_args[@]}" >/dev/null
  echo "  created: $title"
}

# --- Issues -----------------------------------------------------------------

echo
echo "Creating issues..."

create_issue "schema: design YAML/JSON format and publish JSON Schema" "$(cat <<'EOF'
Define the canonical shape of a vault schema document. Produce:

- `vault.noydb.yaml` example covering all in-scope constructs
- `vault.noydb.json` equivalent (machine-emitted form)
- `noydb-schema.schema.json` JSON Schema that validates both
- ADR explaining why YAML + JSON, why not Prisma/TOML/custom DSL

**Design constraints:**
- References are field-local and named, never positional (e.g. `references: clients.id` next to the field, not in a separate relationships section). Goal: readable without the diagram.
- Stable IDs (the YAML key) separate from display labels.
- Comments preserved on round-trip (use `yaml` npm package, not `js-yaml`).
- Editor integration via `# yaml-language-server: $schema=...` header.

**Deliverable:** example file checks into `docs/schema/examples/` and renders correctly in VS Code with the YAML extension installed.

**Acceptance:**
- [ ] Accounting-app recipe expressed as `vault.noydb.yaml`
- [ ] Same recipe expressed as `vault.noydb.json`, byte-identical semantic content
- [ ] JSON Schema validates both, rejects 5+ malformed examples
- [ ] ADR in `docs/adr/` explains format choice

Part of #MILESTONE: $MILESTONE_TITLE
EOF
)" "schema" "design"

create_issue "schema: decide how Zod schemas are embedded in the schema format" "$(cat <<'EOF'
YAML cannot natively express Zod's full API (refinements, transforms, discriminated unions). Three options to evaluate:

**A)** JSON Schema as the schema language; Zod generated from JSON Schema via `json-schema-to-zod` at codegen time. Loses refinements/transforms.

**B)** Zod as primary; convert to JSON Schema via `zod-to-json-schema` for the YAML form. Requires Zod source files alongside YAML.

**C)** Hybrid: simple types and constraints in YAML (covers 80% of cases); complex validations reference a Zod schema by path (e.g. `validate: "./schemas/invoice.ts#InvoiceSchema"`).

**Recommendation to evaluate:** (C). Most fields are scalar with simple constraints; the YAML stays readable. Complex cases escape to TS.

**Acceptance:**
- [ ] ADR comparing the three approaches
- [ ] Chosen approach prototyped on 3 field types: simple string, constrained number, complex discriminated union
- [ ] Decision on whether `validate:` references are resolved at schema-load time or codegen time

Depends on #1
EOF
)" "schema" "design" "validation"

create_issue "schema: scaffold @noy-db/schema package" "$(cat <<'EOF'
Create the package under `packages/schema/` following monorepo conventions. Zero runtime deps (peer-dep on `yaml`, `zod`, `ajv` if used for JSON Schema validation).

**Public API surface (v0.1):**
- `parseSchema(input: string | object): VaultSchema` — YAML or JSON in, typed object out
- `validateSchema(schema: VaultSchema): ValidationResult` — semantic checks beyond JSON Schema (FK targets exist, no circular MV dependencies, ACL roles are known, etc.)
- `serializeSchema(schema: VaultSchema, format: 'yaml' | 'json'): string`
- TypeScript types for every node in the schema tree

**Acceptance:**
- [ ] Package builds, exports types, passes type-check
- [ ] Round-trip: parse → serialize → parse produces identical AST
- [ ] Comments preserved on YAML round-trip
- [ ] Published shape documented in `docs/packages/schema.md`

Depends on #1, #2
EOF
)" "schema" "package"

create_issue "schema: implement semantic validation beyond JSON Schema" "$(cat <<'EOF'
JSON Schema covers structural validity. Semantic rules to implement:

- FK targets exist (`references: clients.id` requires `clients` collection with `id` field)
- No circular MV dependencies (overlay-of chains terminate)
- ACL roles match the 5 known roles (owner / admin / operator / viewer / client)
- Tier elevation references are well-formed
- i18n languages are valid BCP-47 tags
- Field names don't collide with reserved noy-db property names
- Index field references exist on the collection
- Aggregate measure fields exist and are of aggregatable types

Each rule has a stable error code (e.g. `NOYDB_SCHEMA_E001`), human-readable message, and source location (line/column in YAML).

**Acceptance:**
- [ ] 12+ rules implemented with unit tests
- [ ] Error messages include file path, line, column, and suggested fix where possible
- [ ] CLI command `noydb schema validate ./vault.noydb.yaml` exits non-zero on failure

Depends on #3
EOF
)" "schema" "validation"

create_issue "schema: introspect a live vault and emit its schema" "$(cat <<'EOF'
Given an opened vault, produce the schema document that describes its current shape. Powers the diagram tool and `noydb schema diff`.

**API:**
- `introspect(db: NoyDb, vault: string): Promise<VaultSchema>`
- Same shape as a hand-written schema, plus optional stats (recordCount per collection/view, sizeBytes) when called with `{ withStats: true }`.

**Implementation note:** introspection reads collection metadata and field shapes from existing records. Where Zod schemas are registered with the vault at runtime, they're emitted directly; where only data exists, a best-effort JSON Schema is inferred.

**Acceptance:**
- [ ] Introspect the accounting-app showcase vault, output matches hand-written schema (modulo statistics)
- [ ] `withStats: true` populates counter and size fields
- [ ] Documented limitations (inferred vs declared validation)

Depends on #3
EOF
)" "schema" "introspection"

create_issue "schema: CLI commands in @noy-db/cli" "$(cat <<'EOF'
Add the following commands to the existing CLI:

- `noydb schema validate <file>` — semantic + structural validation
- `noydb schema format <file>` — canonical YAML formatting
- `noydb schema introspect <vault-path>` — emit YAML from a live vault
- `noydb schema diff <file> <vault-path>` — show drift between declared schema and live vault
- `noydb schema convert <file> --to json|yaml` — format conversion

All commands respect `--format=json` for machine-readable output.

**Acceptance:**
- [ ] All 5 commands implemented with `--help`
- [ ] Exit codes documented (0 ok, 1 validation fail, 2 IO error)
- [ ] Integration tests in `test-harnesses/`

Depends on #4, #5
EOF
)" "schema" "cli"

create_issue "schema: generate TypeScript types from vault schema" "$(cat <<'EOF'
For TypeScript adopters, the schema should generate the same types they'd write by hand for `collection<T>()` calls.

**Output:** `vault.noydb.ts` with a type per collection, a discriminated union of all collection names, and (where applicable) generated Zod schemas.

- `noydb schema codegen <file> --out <path>`
- Watch mode: `--watch` regenerates on YAML save

**Acceptance:**
- [ ] Generated types compile with strict mode
- [ ] Accounting-app showcase migrates from hand-written types to generated ones without behavior change
- [ ] Watch mode integrates with `pnpm dev`

Depends on #3
EOF
)" "schema" "codegen" "dx"

create_issue "schema: documentation, examples, migration guide" "$(cat <<'EOF'
- `docs/schema/README.md` — overview, when to use, when not to
- `docs/schema/reference.md` — every field, attribute, and block
- `docs/schema/examples/` — one file per recipe (personal-notebook, accounting-app, realtime-crdt-app, analytics-app)
- `docs/schema/migration.md` — how to introduce a schema file to an existing noy-db app without breaking anything (schema is additive in v0.1; not enforced unless `noydb schema validate` is wired into CI)
- `SUBSYSTEMS.md` updated to reference the schema layer
- Top-level README mentions the schema in the catalog

**Acceptance:**
- [ ] All four recipe schemas check into `docs/schema/examples/`
- [ ] Reference docs auto-generated from JSON Schema where possible
- [ ] Migration guide tested against the accounting-app showcase

Depends on #6, #7
EOF
)" "schema" "docs"

echo
echo "Done."
if $DRY_RUN; then
  echo "(dry run — nothing was actually created)"
fi
