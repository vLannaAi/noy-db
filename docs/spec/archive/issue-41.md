# Issue #41 — v0.4 — Integrity & trust (tracking epic)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **Closed:** 2026-04-07
- **Milestone:** v0.4.0
- **Labels:** type: feature, release: v0.4, area: core, epic

---

# v0.4 — Integrity & trust

Umbrella tracking issue for the v0.4 release. Follows the same pattern as #6 (v0.3 epic).

## Goal

Make noy-db data **tamper-evident and self-validating**. After v0.3, consumers have a reactive Pinia layer and a query DSL; after v0.4, they also have:

- **Schema-validated records** — bad data fails fast at the store boundary
- **A hash-chained audit log** — tampering is detectable without a third party
- **Delta history** — storage scales with change size, not record size
- **Soft FK references** — orphan detection without a rigid schema migration
- **Verifiable backups** — `restore()` refuses modified tarballs

## Guiding principles (unchanged from v0.3)

1. Zero-knowledge stays zero-knowledge — no plaintext on the adapter
2. Zero runtime crypto deps — Web Crypto API only
3. Memory-first is the default; streaming/lazy paths are opt-in
4. Six-method adapter contract is sacred
5. Every feature ships with a `playground/` example before it's documented as stable

## Deliverables

| # | Deliverable | Package | Sub-issue |
|---|---|---|---|
| 1 | Schema validation via Standard Schema v1 | `@noy-db/core` + `@noy-db/pinia` | (tbd) |
| 2 | Hash-chained audit log | `@noy-db/core` | (tbd) |
| 3 | Delta history (RFC 6902 JSON Patch) | `@noy-db/core` | (tbd) |
| 4 | Foreign-key references via `ref()` | `@noy-db/core` | (tbd) |
| 5 | Verifiable backups (`dump()`/`restore()`) | `@noy-db/core` | (tbd) |

Plus docs sweep + release PR at the end, matching the v0.3 rhythm.

## Order

1. **Schema validation** — self-contained, smallest, unblocks FK field typing
2. **Hash-chained ledger + delta history** — paired (same storage format)
3. **FK refs** — soft dep on schema validation
4. **Verifiable backups** — depends on the ledger
5. **Docs sweep + release**

## Out of scope for v0.4

- Blockchain anchoring (user code only — we publish the ledger head, users can anchor it wherever they want)
- Cross-compartment refs (pushed to v0.5+)
- CRDT merging (v0.6)
- Ledger-based devtools panel (v0.7)
- Schema codegen CLI (v0.7)

## Acceptance criteria (epic-level)

- [ ] All 5 deliverable sub-issues closed and merged into `v0.4-dev`
- [ ] Reference accounting demo in `playground/nuxt/` uses schema validation + ledger verification + ref() — evidence of end-to-end composition
- [ ] Docs sweep: `docs/reference/architecture.md` documents the ledger, `docs/guides/end-user-features.md` has a runnable snippet per feature
- [ ] Release PR merges `v0.4-dev` → `main`
- [ ] `@noy-db/core` bumped to `0.4.0` (other packages stay at `0.3.x` unless they actually change)
- [ ] GitHub Release `v0.4.0` published; Flow B publishes to npm with provenance
- [ ] Post-release dogfood against fresh npm install (lesson from #111)

## Related

- ROADMAP.md §v0.4
- Predecessor epic: #6 (v0.3)
