# Issue #234 — refactor(hub/ledger): group hash-chained ledger + diff + patch + bundle-format into packages/hub/src/ledger/

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.15.1 — Hub refactor (backward-compat)
- **Labels:** type: feature, area: core

---

Move `ledger.ts`, `diff.ts`, `patch.ts`, and the `.noydb` bundle-format primitives (`writeNoydbBundle` / `readNoydbBundle` / `readNoydbBundleHeader` + ULID helpers) into `packages/hub/src/ledger/`. Barrel re-exports preserved. Subpath entry `@noy-db/hub/ledger` added.

Rationale: apps that never read the hash-chained audit log or produce `.noydb` backups can avoid bundling ~3–4 KB of ledger + compression primitives via subpath import.
