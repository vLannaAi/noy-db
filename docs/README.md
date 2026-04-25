# NOYDB Documentation

> The four-part doc tree mirrors the v0.25 catalog: **core** is what NOYDB is, **subsystems** are what NOYDB does, **recipes** show how to compose the two, **reference** holds the precise contracts.

## Navigation

### 🧱 Core — the always-on minimum

The ~6,500 LOC every consumer pays. Six pages.

→ **[docs/core/](./core/)** — vault & collections · encryption · stores · permissions · schema & refs · query basics

### 🧩 Subsystems — the 17 opt-in capabilities

Each one tree-shake-able behind a `with*()` strategy seam.

→ **[docs/subsystems/](./subsystems/)** — full catalog grouped by cluster (Read & Query · Write & Mutate · Data Shape · Time & Audit · Snapshot & Portability · Collaboration & Auth · Operations)

### 🍳 Recipes — copy-paste-ready starters

Each recipe is one doc page + one runnable test.

→ **[docs/recipes/](./recipes/)** — personal-notebook · accounting-app · realtime-crdt-app · analytics-app

### 📐 Reference — formal contracts

Architecture, threat model, store conformance, error codes (TODO), API stability (TODO).

→ **[docs/reference/](./reference/)**

## Top-level guides

| Page | Audience |
|---|---|
| [overview.md](./overview.md) | First look — what NOYDB does and doesn't do |
| [quickstart.md](./quickstart.md) | 5-minute "get something running" |
| [choose-your-path.md](./choose-your-path.md) | Pick the right starter based on your app |
| [topologies.md](./topologies.md) | Common deployment shapes (USB, single-cloud, p2p, ...) |
| [features.md](./features.md) | Feature inventory (slated for migration into core/subsystems) |

## Package catalogs

The hub plus four prefixed package families:

| Catalog | What's in it |
|---|---|
| [packages-stores.md](./packages-stores.md) | 20 `to-*` stores |
| [packages-integrations.md](./packages-integrations.md) | 10 `in-*` framework integrations |
| [packages-auth.md](./packages-auth.md) | 9 `on-*` auth/unlock methods |
| [packages-exports.md](./packages-exports.md) | 9 `as-*` export formats |

## Source-of-truth links

- [SUBSYSTEMS.md](../SUBSYSTEMS.md) — the catalog (canonical surface index)
- [SPEC.md](../SPEC.md) — formal specification (reorg per #285)
- [ROADMAP.md](../ROADMAP.md) — version timeline
- [CHANGELOG.md](../CHANGELOG.md) — release notes
- [SECURITY.md](../SECURITY.md) — disclosure policy
- [CLAUDE.md](../CLAUDE.md) — agent / contributor guide
