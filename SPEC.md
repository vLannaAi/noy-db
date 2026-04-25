# NOYDB Specification

> **Status: v0.25 reorganization (DRAFT, #285).** This is the new outline that mirrors the [SUBSYSTEMS.md](./SUBSYSTEMS.md) catalog. The legacy monolithic spec lives at [docs/reference/spec-legacy.md](./docs/reference/spec-legacy.md) until per-section migration is complete. Each heading below either links to its authoritative doc page or is marked `[TODO]` with the legacy section to be ported.

---

## Part 0 — Why NOYDB

> Origin, problem statement, design principles, high-level architecture.

- **Origin & problem statement** — *[TODO: port from `docs/reference/spec-legacy.md` § Origin Story / Problem Statement]*
- **Design principles** — *[TODO: port from spec-legacy § Design Principles]*
- **Architecture overview** — see [docs/reference/architecture.md](./docs/reference/architecture.md)
- **Threat model** — see [docs/reference/threat-model.md](./docs/reference/threat-model.md)

---

## Part I — Core

The always-on minimum (~6,500 LOC). Six areas every consumer pays for. See [docs/core/](./docs/core/) for the reader-facing pages; this part holds the formal spec text.

### 1. Vault & Collection model

- *Page:* [docs/core/01-vault-and-collections.md](./docs/core/01-vault-and-collections.md)
- *Spec text:* *[TODO: port from spec-legacy § Core Concepts]*
- *Surface:* `Noydb`, `Vault`, `Collection<T>`, lifecycle, reserved collection names

### 2. Encryption

- *Page:* [docs/core/02-encryption.md](./docs/core/02-encryption.md)
- *Spec text:* *[TODO: port from spec-legacy § Encryption Model]*
- *Critical invariants:* AES-256-GCM, PBKDF2-SHA256 (600K), AES-KW, KEK never persisted, fresh IV per op
- *Envelope format:* *[TODO: extract to `docs/reference/envelope-format.md`]*

### 3. Stores

- *Page:* [docs/core/03-stores.md](./docs/core/03-stores.md)
- *Spec text:* *[TODO: port from spec-legacy § Stores]* (note: routing/middleware portion moves to Cluster G — Operations)
- *Conformance:* see [docs/reference/store-conformance.md](./docs/reference/store-conformance.md)
- *Catalog:* [docs/packages-stores.md](./docs/packages-stores.md) (20 built-in stores)

### 4. Permissions & Keyring

- *Page:* [docs/core/04-permissions-and-keyring.md](./docs/core/04-permissions-and-keyring.md)
- *Spec text:* *[TODO: port from spec-legacy § Multi-User Access Control]* (note: grant/revoke/rotate/magic-link/delegation/tiers move to Cluster F — `team` subsystem)
- *Catalog:* [docs/packages-auth.md](./docs/packages-auth.md) (`on-*` unlock methods)

### 5. Schema & Refs

- *Page:* [docs/core/05-schema-and-refs.md](./docs/core/05-schema-and-refs.md)
- *Spec text:* *[TODO: extract from spec-legacy § API Specification — Schema and Refs subsections]*

### 6. Query basics

- *Page:* [docs/core/06-query-basics.md](./docs/core/06-query-basics.md)
- *Spec text:* *[TODO: extract `where` / `orderBy` / `limit` / `scan` from spec-legacy § API Specification]*
- *Note:* joins / aggregate / live move to Cluster A subsystems

---

## Part II — Subsystems

The 17 opt-in capabilities. Each entry has a one-pager under [docs/subsystems/](./docs/subsystems/) and a strategy seam in `@noy-db/hub/<name>`. Spec text is currently in [docs/reference/spec-legacy.md](./docs/reference/spec-legacy.md) and will migrate to per-subsystem sections here.

### Cluster A — Read & Query

| # | Subsystem | Page | Strategy | Spec |
|---|---|---|---|---|
| 1 | indexing | [→](./docs/subsystems/indexing.md) | `withIndexing()` | *[TODO]* |
| 2 | joins *(planned extraction)* | [→](./docs/subsystems/joins.md) | `withJoins()` *(planned)* | *[TODO]* |
| 3 | aggregate | [→](./docs/subsystems/aggregate.md) | `withAggregate()` | *[TODO]* |
| 4 | live *(planned extraction)* | [→](./docs/subsystems/live.md) | `withLive()` *(planned)* | *[TODO]* |

### Cluster B — Write & Mutate

| # | Subsystem | Page | Strategy | Spec |
|---|---|---|---|---|
| 5 | history | [→](./docs/subsystems/history.md) | `withHistory()` | *[TODO]* |
| 6 | transactions | [→](./docs/subsystems/transactions.md) | `withTransactions()` | *[TODO]* |
| 7 | crdt | [→](./docs/subsystems/crdt.md) | `withCrdt()` | *[TODO: port from spec-legacy § Sync Engine — CRDT mode subsection]* |

### Cluster C — Data Shape

| # | Subsystem | Page | Strategy | Spec |
|---|---|---|---|---|
| 8 | blobs | [→](./docs/subsystems/blobs.md) | `withBlobs()` | *[TODO]* |
| 9 | i18n | [→](./docs/subsystems/i18n.md) | `withI18n()` | *[TODO]* |

### Cluster D — Time & Audit

| # | Subsystem | Page | Strategy | Spec |
|---|---|---|---|---|
| 10 | periods | [→](./docs/subsystems/periods.md) | `withPeriods()` | *[TODO]* |
| 11 | consent | [→](./docs/subsystems/consent.md) | `withConsent()` | *[TODO]* |

### Cluster E — Snapshot & Portability

| # | Subsystem | Page | Strategy | Spec |
|---|---|---|---|---|
| 12 | shadow | [→](./docs/subsystems/shadow.md) | `withShadow()` | *[TODO]* |
| 13 | bundle | [→](./docs/subsystems/bundle.md) | (direct named imports) | *[TODO: port from spec-legacy § Data Formats — `.noydb` Container]* |

### Cluster F — Collaboration & Auth

| # | Subsystem | Page | Strategy | Spec |
|---|---|---|---|---|
| 14 | sync | [→](./docs/subsystems/sync.md) | `withSync()` | *[TODO: port from spec-legacy § Sync Engine — replication subsections]* |
| 15 | team | [→](./docs/subsystems/team.md) | `withTeam()` *(planned strategy gate; today the surface is on `Noydb` directly)* | *[TODO: port multi-user portion from spec-legacy § Multi-User Access Control]* |
| 16 | session | [→](./docs/subsystems/session.md) | `withSession()` | *[TODO]* |

### Cluster G — Operations

| # | Subsystem | Page | Strategy | Spec |
|---|---|---|---|---|
| 17 | routing *(planned extraction)* | [→](./docs/subsystems/routing.md) | `withRouting()` *(planned)* | *[TODO: port store-routing / middleware / sync-policy from spec-legacy § Stores and § Implementation Notes]* |

---

## Part III — Reserved future slots

Reserved names in the catalog. Each is a placeholder for a future subsystem; adding one to NOYDB is additive (minor bump) — renaming an existing slot is breaking (major bump).

| Reserved | Intended scope | Earliest target |
|---|---|---|
| `partitioning` | Time-range / region / tenant partition awareness for query execution | v0.11+ |
| `migrations` | Schema migrations / collection renames / field rename + backfill | TBD |
| `metrics` | Hub-level observability beyond the per-store `to-meter` wrapper | TBD |
| `validation` | Richer runtime validators beyond Standard Schema | TBD |

---

## Cross-cutting reference

These live outside the core / subsystem split because they describe contracts that span multiple areas.

- [Architecture overview](./docs/reference/architecture.md)
- [Threat model](./docs/reference/threat-model.md)
- [Store conformance](./docs/reference/store-conformance.md)
- *[TODO: error-codes.md — every public error class + its `code: string` discriminant]*
- *[TODO: api-stability.md — frozen-vs-mutable surface, semver policy, deprecation flow]* (#289 — v0.26 milestone)
- *[TODO: envelope-format.md — formal `_noydb` / `_v` / `_iv` / `_data` spec]*
- *[TODO: migration-guides/ — upgrade paths between minor versions]*

---

## Migration plan

Tracked in [#285](https://github.com/vLannaAi/noy-db/issues/285):

1. **Phase 1 (this PR):** new outline structure published; legacy content preserved at `docs/reference/spec-legacy.md`. Per-doc-page reader-facing content already exists under `docs/core/` and `docs/subsystems/`.
2. **Phase 2:** for each `[TODO]` marker above, port the legacy section's content into either (a) a new section under that heading in this file, or (b) the corresponding doc page if the prose belongs at the reader level. Prefer (b) for tutorial / how-to text; prefer (a) for invariants / formal contracts.
3. **Phase 3:** delete `docs/reference/spec-legacy.md` once every section has been migrated. Update SPEC.md to remove `[TODO]` markers.

Cross-references in `CLAUDE.md`, `README.md`, `ROADMAP.md` updated as part of Phase 2 sweeps.
