# Subsystems — the catalog

The 17 opt-in capabilities that compose with the always-on core. Each entry is a tree-shake-able module behind a `with*()` strategy seam — when you don't import the factory, none of the subsystem's code reaches your bundle.

See [SUBSYSTEMS.md](../../SUBSYSTEMS.md) for the catalog overview, dependency graph, starter recipes, and CI invariants.

## Cluster A — Read & Query

| Page | What it adds |
|---|---|
| [indexing](./indexing.md) | Eager + lazy persisted indexes (equality + orderBy dispatch) |
| [joins](./joins.md) | Multi-FK eager joins (indexed nested-loop / hash strategy) |
| [aggregate](./aggregate.md) | `count` / `sum` / `avg` / `min` / `max` + `groupBy` |
| [live](./live.md) | Reactive subscriptions (`.live()`, `.subscribe()`) |

## Cluster B — Write & Mutate

| Page | What it adds |
|---|---|
| [history](./history.md) | Versioning, diff, revert, time-machine, audit ledger |
| [transactions](./transactions.md) | Multi-record atomic writes |
| [crdt](./crdt.md) | LWW-Map / RGA / Yjs interop |

## Cluster C — Data Shape

| Page | What it adds |
|---|---|
| [blobs](./blobs.md) | Binary attachments + compaction + MIME-magic |
| [i18n](./i18n.md) | Multi-locale records + dict-key resolution + auto-translate |

## Cluster D — Time & Audit

| Page | What it adds |
|---|---|
| [periods](./periods.md) | Accounting periods + closed-period write guard |
| [consent](./consent.md) | Consent audit log (GDPR/PIPL-friendly) |

## Cluster E — Snapshot & Portability

| Page | What it adds |
|---|---|
| [shadow](./shadow.md) | Read-only `vault.frame()` views |
| [bundle](./bundle.md) | `.noydb` encrypted container format |

## Cluster F — Collaboration & Auth

| Page | What it adds |
|---|---|
| [sync](./sync.md) | P2P replication engine + presence |
| [team](./team.md) | Multi-user grant/revoke + magic-link + delegation + tiers |
| [session](./session.md) | Token sessions, dev-unlock, policy enforcement |

## Cluster G — Operations

| Page | What it adds |
|---|---|
| [routing](./routing.md) | Multi-store routing, middleware, sync-policy, lazy-mode + LRU cache |

## Doc page template

Every entry follows the same shape — see [_template.md](./_template.md). If you're adding a new subsystem, copy the template and fill it out top-to-bottom.

## Reserved future slots

Reserved names so spec/docs/issues can reference them ahead of implementation. These are NOT shipped today.

| Reserved | Intended scope | Earliest target |
|---|---|---|
| `partitioning` | Time-range / region / tenant partition awareness for query execution | TBD |
| `migrations` | Schema migrations / collection renames / field rename + backfill | TBD |
| `metrics` | Hub-level observability beyond the per-store `to-meter` wrapper | TBD |
| `validation` | Richer runtime validators beyond Standard Schema | TBD |

## Related

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md) — the catalog
- [docs/recipes/](../recipes/) — 4 starter recipes that compose subsystems
- [SPEC.md](../../SPEC.md) — full specification (TODO: reorganize per #285)
