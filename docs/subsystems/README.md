# Subsystems — the catalog

The 21 opt-in capabilities that compose with the always-on core. Each entry is a tree-shake-able module behind a `with*()` strategy seam — when you don't import the factory, none of the subsystem's code reaches your bundle.

See [SUBSYSTEMS.md](../../SUBSYSTEMS.md) for the catalog overview, dependency graph, starter recipes, and CI invariants.

## Cluster A — Read & Query

| Page | What it adds |
|---|---|
| [indexing](./indexing.md) | Eager + lazy persisted indexes (equality + orderBy dispatch) |
| [joins](./joins.md) | Multi-FK eager joins (indexed nested-loop / hash strategy) |
| [cross-join](./cross-join.md) | Cartesian + lateral cross-join — `.crossJoin(target, { as })` with cost ceiling — Dim 11 v3 |
| [aggregate](./aggregate.md) | `count` / `sum` / `avg` / `min` / `max` + `groupBy` |
| [live](./live.md) | Reactive subscriptions (`.live()`, `.subscribe()`) |

## Cluster B — Write & Mutate

| Page | What it adds |
|---|---|
| [history](./history.md) | Versioning, diff, revert, time-machine, audit ledger |
| [transactions](./transactions.md) | Multi-record atomic writes |
| [crdt](./crdt.md) | LWW-Map / RGA / Yjs interop |

## Cluster C — Derived data

| Page | What it adds |
|---|---|
| [derivations](./derivations.md) | Deterministic derived data — source row → typed outputs (eager / lazy / strict-mode rollback) — Dim 14 v1 |
| [materialized-views](./derivations.md#materialized-views) | Query-level materialized views — `Query<T>` → output collection (eager / lazy / manual refresh; declared deterministic predicates) — Dim 14 v2 |
| [overlay-views](./derivations.md#overlay-views) | Read-shadow virtual collections — merges base + user-writable overlay via shadow predicate — Dim 14 v2 |

## Cluster D — Data Shape

| Page | What it adds |
|---|---|
| [blobs](./blobs.md) | Binary attachments + compaction + MIME-magic |
| [i18n](./i18n.md) | Multi-locale records + dict-key resolution + auto-translate |

## Cluster E — Time & Audit

| Page | What it adds |
|---|---|
| [periods](./periods.md) | Accounting periods + closed-period write guard |
| [consent](./consent.md) | Consent audit log (GDPR/PIPL-friendly) |
| [guards](./guards.md) | Record lock + field-level freeze + role-gated amendment invariant with ledger audit |

## Cluster F — Snapshot & Portability

| Page | What it adds |
|---|---|
| [shadow](./shadow.md) | Read-only `vault.frame()` views |
| [bundle](./bundle.md) | `.noydb` encrypted container format |
| [transferable-partitions](./transferable-partitions.md) | Extract a re-keyed sub-portfolio into a new independently-owned vault (extract → adopt → own) |
| [snapshots](./snapshots.md) | Vault checkpoint/restore — `db.snapshot()` / `listSnapshots()` / `restoreSnapshot()` with declarative retention + `ledgerHead` tamper-detection |

## Cluster G — Collaboration & Auth

| Page | What it adds |
|---|---|
| [sync](./sync.md) | P2P replication engine + presence |
| [team](./team.md) | Multi-user grant/revoke + magic-link + delegation + tiers |
| [session](./session.md) | Token sessions, dev-unlock, policy enforcement |

## Cluster H — Operations

| Page | What it adds |
|---|---|
| [routing](./routing.md) | Multi-store routing, middleware, sync-policy, lazy-mode + LRU cache |

## Schema-declared features (archetype ③) — no `with*()`

These are **not** opt-in `with*()` subsystems and so have no factory and no
`<name>Strategy` option. They are **declared on the collection itself** via
`collection({ … })` — the collection is their opt-in unit. There is nothing to
pass to `createNoydb`; a collection that doesn't declare the field simply
doesn't get the behavior. `check-architecture`'s `strategy-opt-in` check exempts
each of these (see `SCHEMA_DECLARED_OR_INFRA_EXEMPT`).

| Feature | Declared as | What it adds |
|---|---|---|
| computed | `collection({ computed: { … } })` | Per-record derived fields evaluated on read |
| money | `collection({ money: { … } })` | Fixed-point money field descriptors (quantize-on-write / decode-on-read) |
| links | `collection({ links: { … } })` (`link()` refs) | Typed cross-collection references + backlinks |
| introspection | always available on any typed collection | `collection.describe()` / `vault.dumpSchema()` read-only schema surface |
| schema-update | `collection({ schemaUpdate: … })` | Per-collection migration strategies (blind / additive / locked / coordinated) |

> **Follow-up (out of scope here):** unlike the `with*()` subsystems, these ③
> impls are currently **kernel-resident — eagerly imported into the floor** as
> inline write/read-path hooks (e.g. `with-shape/money/normalize`,
> `with-formula/computed`, `with-shape/links`, `with-shape/schema-update`,
> `with-shape/introspection/walk`). They are *not* lazy-imported from the schema
> declaration today, so they are not tree-shaken out when unused. Moving the
> heavy paths behind a schema-triggered `await import(...)` is tracked as a
> follow-up; it does not change the schema-declared opt-in model above.

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
- [SPEC.md](../../SPEC.md) — full specification (TODO: reorganize per )
