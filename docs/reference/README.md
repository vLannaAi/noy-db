# Reference

> Cross-cutting reference material. Less hand-holding than the core / subsystems / recipes pages — these are the precise contracts.

## Pages

| Page | What it covers |
|---|---|
| [architecture](./architecture.md) | High-level architecture overview — the data flow, the trust boundary, the package families |
| [threat-model](./threat-model.md) (draft) | What NOYDB defends against and what it explicitly does not |
| [store-conformance](./store-conformance.md) (draft) | The `NoydbStore` contract that every `to-*` package implements |

## Future additions

Tracked under #285 (SPEC reorg) and #289 (LTS lock):

- `error-codes.md` — every public error class + its `code: string` discriminant
- `api-stability.md` — frozen-vs-mutable surface; semver policy; deprecation flow
- `envelope-format.md` — the `_noydb` / `_v` / `_iv` / `_data` envelope, formally
- `migration-guides/` — upgrade paths between minor versions

## See also

- [SPEC.md](../../SPEC.md) — formal specification (target structure tracked in #285)
- [SECURITY.md](../../SECURITY.md) — disclosure policy
