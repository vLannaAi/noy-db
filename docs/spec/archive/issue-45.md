# Issue #45 — Foreign-key references via ref()

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **Closed:** 2026-04-07
- **Milestone:** v0.4.0
- **Labels:** type: feature, release: v0.4, area: core

---

Part of #41 (v0.4 epic).

## Scope

Add a soft-FK mechanism: a field on a record can be marked as a reference to another collection's record via \`ref('collection')\`. Three modes: \`strict\` (put fails if the ref target is missing), \`warn\` (put succeeds but \`checkIntegrity()\` reports it), \`cascade\` (deleting the target removes or nulls the referencing records). Opt-in per-field.

## Why

The accounting domain has natural references: \`invoice.clientId\` → \`clients.id\`. Today this is enforced entirely in application code. With \`ref()\` we get orphan detection, cascade cleanup, and type-inferred relationship fields — without the rigidity of a full schema migration story.

## Technical design

- New \`ref(collection: string, options?: { mode?: 'strict' | 'warn' | 'cascade' })\` helper that returns a marker object. Intended to be used inside a Standard Schema validator via \`.refine\` or equivalent.
- At \`put()\` time, the core walks the validated value for ref markers and (depending on mode) checks the target collection. Strict: throws on missing target. Warn: records the violation on the store for later retrieval. Cascade: registers a dependency that \`delete()\` propagates.
- \`compartment.checkIntegrity()\` returns \`{ violations: [{ collection, id, field, refTo, refId }] }\` — a snapshot-in-time report of every broken reference.
- Cross-compartment refs are **explicitly out of scope** (too many edge cases for v0.4).
- Refs are evaluated against the in-memory cache in eager mode and via \`Collection.get\` in lazy mode. Warn mode for lazy is fine (no blocking reads); strict mode in lazy requires a read per ref, so we document the cost.

## Acceptance criteria

- [ ] \`ref()\` helper exported from \`@noy-db/core\`
- [ ] \`strict\` mode rejects put on missing target with \`RefIntegrityError\`
- [ ] \`warn\` mode records the violation and exposes it via \`checkIntegrity()\`
- [ ] \`cascade\` mode propagates delete to referencing records
- [ ] \`checkIntegrity()\` returns a list of all violations, not just the first
- [ ] At least 12 tests covering: happy path, strict rejection, warn accumulation, cascade on delete, circular refs, refs into empty collections
- [ ] Cross-compartment refs throw \`RefScopeError\`
- [ ] CHANGELOG entry
- [ ] Playground demo: invoice.clientId → clients

## Estimate

M

## Dependencies

- Soft dep on #(schema-validation sub-issue) — the ref marker is most naturally used inside a Standard Schema validator
