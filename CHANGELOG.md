# Changelog

Workspace-level summary. Per-package CHANGELOGs in `packages/<name>/CHANGELOG.md` are the source of truth for release notes.

## Unreleased — v0.25.0-rc.1 (target)

### `@noy-db/hub` — the 17-subsystem catalog

Major restructuring of the public surface. The hub now ships a **minimalist core (~6,500 LOC)** plus **17 opt-in subsystems** behind `with*()` strategy seams. Apps that don't import a subsystem ship none of its code.

The catalog ([SUBSYSTEMS.md](./SUBSYSTEMS.md)) is the product surface — every entry is both a developer-facing feature and a tree-shake-able module:

- **Read & Query** — indexing · joins · aggregate · live
- **Write & Mutate** — history · transactions · crdt
- **Data Shape** — blobs · i18n
- **Time & Audit** — periods · consent
- **Snapshot & Portability** — shadow · bundle
- **Collaboration & Auth** — sync · team · session
- **Operations** — routing

Four subsystems were extracted in this cycle (history, i18n, session, sync); the other 13 ship from prior cycles. See `packages/hub/CHANGELOG.md` for the full migration guide.

### Bundle correctness fix

`tsup.config.ts` now emits ESM with code splitting enabled, fixing a cross-subpath `instanceof` bug introduced when subpaths were first added (#288). CJS retains the v0.24 single-bundle shape.

### Documentation

- 4 starter recipes under [docs/recipes/](./docs/recipes/) with runnable verification
- 17 subsystem one-pagers under [docs/subsystems/](./docs/subsystems/)
- [SUBSYSTEMS.md](./SUBSYSTEMS.md) catalog with cluster groupings, dependency graph, and CI invariants

### Deferred to v0.26

- LTS API lock (api-extractor, JSDoc tagging, error-code inventory, api-stability.md) — #289
- Joins / live / routing extraction (still always-core; planned for v0.26)
- Bundle-size CI gate (#286) — landing in v0.25.x

### Known issues

- #290 — `DictionaryHandle` empty `payloadHash` weakens `verifyBackupIntegrity()` for vaults using both history + i18n. Patch in v0.25.x.

## Prior releases

- **v0.24** — strategy seams batch 1: aggregate, blobs, consent, crdt, indexing, periods, shadow, tx
- **v0.23** — lazy-mode indexes (#265–#268)
- **v0.20** — p2p sync
- **v0.19** — deterministic encryption
- **v0.18** — hierarchical permission tiers
- **v0.17** — accounting periods
- **v0.16** — time-machine, shadow vaults, consent, bulk ops
- ...

For full history, see per-package CHANGELOGs:

- [packages/hub/CHANGELOG.md](./packages/hub/CHANGELOG.md)
- [packages/to-*/CHANGELOG.md](./packages/) (20 store packages)
- [packages/in-*/CHANGELOG.md](./packages/) (10 integration packages)
- [packages/on-*/CHANGELOG.md](./packages/) (9 auth/unlock packages)
- [packages/as-*/CHANGELOG.md](./packages/) (9 export-format packages)
