# NOYDB Specification

> **Status: v0.25 placeholder.** This file is a structural skeleton. The complete spec will be rewritten from scratch against the catalog once a pre-release version stabilizes (v0.25.0-rc.1+) and pilot feedback has shaped the surface. Until then, the [SUBSYSTEMS.md](./SUBSYSTEMS.md) catalog and the per-page documentation under [`docs/core/`](./docs/core/) and [`docs/subsystems/`](./docs/subsystems/) are the authoritative descriptions.

---

## Part 0 — Why NOYDB

> Origin, problem statement, design principles, high-level architecture.

*(To be written post-pre-release. See [README.md](./README.md) for the current short-form.)*

---

## Part I — Core

The always-on minimum (~6,500 LOC). Authoritative pages live under [`docs/core/`](./docs/core/):

| # | Section | Page |
|---|---|---|
| 1 | Vault & Collection model | [docs/core/01-vault-and-collections.md](./docs/core/01-vault-and-collections.md) |
| 2 | Encryption | [docs/core/02-encryption.md](./docs/core/02-encryption.md) |
| 3 | Stores | [docs/core/03-stores.md](./docs/core/03-stores.md) |
| 4 | Permissions & Keyring | [docs/core/04-permissions-and-keyring.md](./docs/core/04-permissions-and-keyring.md) |
| 5 | Schema & Refs | [docs/core/05-schema-and-refs.md](./docs/core/05-schema-and-refs.md) |
| 6 | Query basics | [docs/core/06-query-basics.md](./docs/core/06-query-basics.md) |

---

## Part II — Subsystems

The 17 opt-in capabilities. Authoritative pages live under [`docs/subsystems/`](./docs/subsystems/); each carries a `with*()` strategy seam at `@noy-db/hub/<name>`.

| Cluster | Subsystems |
|---|---|
| **A — Read & Query** | [indexing](./docs/subsystems/indexing.md) · [joins](./docs/subsystems/joins.md) · [aggregate](./docs/subsystems/aggregate.md) · [live](./docs/subsystems/live.md) |
| **B — Write & Mutate** | [history](./docs/subsystems/history.md) · [transactions](./docs/subsystems/transactions.md) · [crdt](./docs/subsystems/crdt.md) |
| **C — Data Shape** | [blobs](./docs/subsystems/blobs.md) · [i18n](./docs/subsystems/i18n.md) |
| **D — Time & Audit** | [periods](./docs/subsystems/periods.md) · [consent](./docs/subsystems/consent.md) |
| **E — Snapshot & Portability** | [shadow](./docs/subsystems/shadow.md) · [bundle](./docs/subsystems/bundle.md) |
| **F — Collaboration & Auth** | [sync](./docs/subsystems/sync.md) · [team](./docs/subsystems/team.md) · [session](./docs/subsystems/session.md) |
| **G — Operations** | [routing](./docs/subsystems/routing.md) |

---

## Part III — Reserved future slots

Reserved names in the catalog. Adding one to NOYDB is additive (minor bump); renaming an existing slot is breaking (major bump).

| Reserved | Intended scope |
|---|---|
| `partitioning` | Time-range / region / tenant partition awareness for query execution |
| `migrations` | Schema migrations / collection renames / field rename + backfill |
| `metrics` | Hub-level observability beyond the per-store `to-meter` wrapper |
| `validation` | Richer runtime validators beyond Standard Schema |

---

## When this gets rewritten

The full formal spec — invariants, error codes, envelope format, semver policy, threat model, store conformance — will be authored from scratch as part of the v0.26 LTS API lock work (#289). Writing it now would freeze decisions that pilots haven't yet had a chance to push back on.

In the interim, source-of-truth is:

- **What the surface IS** → [SUBSYSTEMS.md](./SUBSYSTEMS.md) + [docs/core/](./docs/core/) + [docs/subsystems/](./docs/subsystems/)
- **How to use it** → [docs/recipes/](./docs/recipes/) (4 runnable starter recipes)
- **What's around it** → [docs/packages/](./docs/packages/) (4 prefix family catalogs)
- **What's frozen / mutable today** → [SUBSYSTEMS.md § What's frozen vs mutable](./SUBSYSTEMS.md)
- **What it's becoming** → [ROADMAP.md](./ROADMAP.md) and [#289](https://github.com/vLannaAi/noy-db/issues/289) (LTS lock)
