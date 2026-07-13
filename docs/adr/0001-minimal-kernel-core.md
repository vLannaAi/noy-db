# ADR 0001: Minimal-kernel core

> **Status:** accepted (describes a decision already load-bearing in the codebase; this ADR
> records it for the first time). **Date:** 2026-07-14.
>
> This is the first ADR in this repository. No prior ADR convention exists here (checked: no
> `docs/adr/`, no `ADR`/`architecture decision record`/MADR references anywhere in `noy-db`,
> `klum-db`, `noy-db-to`, `noy-db-ui`, or `nit-db`). This document establishes a lightweight
> **MADR-lite** shape (Context / Decision / Consequences) as the convention going forward — no
> heavier template is adopted; keep future ADRs to this same shape unless a real need for more
> ceremony shows up.

## Context

`@noy-db/hub` is ~83,000 lines of source (measured directly via `wc -l` on
`packages/hub/src/**/*.ts`, excluding tests, 2026-07-14). Of that:

- `kernel/` — **~30,600 LOC** — always loaded, regardless of what a consumer opts into.
- `with-*/` (the 10 opt-in service layers) — **~42,800 LOC** — tree-shaken out entirely unless a
  consumer imports the corresponding `with<Name>()` factory.
- `via/` (the per-field feature layer) — **~6,800 LOC** — tree-shaken per field-feature import.

These figures match `CLAUDE.md`'s stated split (~82,000 total / ~30,000 kernel / ~42,000 services)
closely. `SERVICES.md`'s own header, by contrast, states the hub is "~28,000" LOC with "~6,500" LOC
of core — a stale figure (documented as a separate finding in the gap analysis,
`docs/superpowers/analysis/2026-07-14-624-taxonomy-gap-analysis.md` #8) that this ADR does not
inherit; the numbers above are the current, directly-measured ground truth.

`SERVICES.md` itself defines the core's contents precisely (its "minimalist core" table, six
areas: vault/collection model, encryption, the 6-method store contract, keyring/permissions,
schema/refs, query basics) — this ADR does not restate that table; it records the *architectural
principle* behind why the line is drawn there, because the principle is what the taxonomy work
(#624) needs to reason about, not the current byte count.

The taxonomy work surfaced a recurring question: when a new capability is proposed (or an existing
one is being re-homed in the docs nav — e.g. `refs` moving from a "Core" folder to
`with-lookup/foreign-refs` per the noy-db-docs handoff spec, §3), where should it live — in the
kernel, or behind a `with*()` opt-in? Without a stated principle, that call gets re-litigated
per-feature.

## Decision

**Core is the smallest mental model that makes noy-db usable as a NoSQL-style document store.**
Concretely, a capability belongs in the kernel if and only if removing it would make the *basic*
vault/collection/query/encryption loop incoherent or unsafe — not merely "commonly used" or
"conceptually related to a core area."

This is why:

- **The 6-method `NoydbStore` contract, encryption, and the vault/collection model** are kernel:
  there is no usable document store without them.
- **Query basics** (`where`/`orderBy`/`limit`/`offset`/`toArray`/`first`/`count`/`scan`) are
  kernel: a document store that can't be queried at all isn't one.
- **Schema & refs** (foreign-key references, ref-mode dispatch) are kernel — but the *teaching*
  placement of the relational band (joins, cross-join, indexing, search) has moved into the
  `with-lookup` docs layer as a pedagogical grouping (noy-db-docs handoff §3) **without** those
  features becoming opt-in. `joins`/`cross-join` in particular ship inside the always-loaded
  `@noy-db/hub/query` subpath (verified: no `./joins` or `./live` entry exists in
  `packages/hub/package.json`'s `exports` map) — they are core today, with a `withJoins()` opt-in
  form only *planned*, not shipped. Placement in a services-nav folder is not evidence of opt-in
  status — see ADR 0002.
- **Everything else** — history, sync, team, blobs, derivations, materialized views, snapshots,
  the relational query extensions (aggregate, indexing, search), and so on — is a service: each is
  individually valuable, but a consumer can build a coherent single-user, single-collection app
  without any of them. Each ships behind its own `with<Name>()` factory and its own subpath
  (`@noy-db/hub/<name>`), so a consumer who doesn't import it pays zero bundle cost.
- The **via-port field-feature layer** (`via/money`, `via/i18n`, `via/classified`, `via/blob`,
  `via/computed`, `via/lookup`) is a *third*, orthogonal axis — capabilities declared per-field
  rather than per-vault, each independently tree-shaken. It is neither kernel nor a `with-*`
  service in the folder sense, even though several of its features (`i18n`, `classified`, `blobs`)
  are *taught* inside the `with-shape` services nav layer (gap-analysis #9). The via-port's
  existence is itself evidence that "always-on kernel," "opt-in with-service," and "opt-in
  per-field feature" are three distinct mechanisms, not two.

`scripts/check-architecture.mjs`'s `strategy-opt-in` and `kernel-surface` guards are the executable
enforcement of this decision today (using a service API requires referencing its `with*()`
factory; `collection.ts`/`vault.ts`/`noydb.ts` — the kernel's three central files — are held under
a ratcheted line ceiling). This ADR records the *why* behind those mechanical guards.

## Consequences

- **A feature request to "just add this to core because it's small" must be evaluated against the
  minimality test above, not against LOC count alone.** A 50-line feature that only matters to
  multi-user apps still belongs behind a `with*()` factory.
- **The kernel/services boundary is a stronger commitment than the docs-nav folder boundary.**
  Moving a page between `core/` and `services/` in the docs nav (as `refs` → `foreign-refs` did) is
  a *documentation* decision and must not, by itself, imply or require a source-code move across
  the `kernel/` / `with-*/` boundary — see ADR 0002 for the general form of this rule.
- **`SERVICES.md`'s LOC figures need periodic refresh** (or better, generation from a script that
  reads real file trees, mirroring `noy-db-docs/registry/validate-hierarchy.mjs`'s existing
  approach of reading a live checkout rather than hand-typed numbers) so the "core is minimal"
  claim stays falsifiable rather than aspirational. Tracked as a migration-checklist item (see
  `docs/superpowers/analysis/2026-07-14-624-498-migration-checklist.md`).
- **The taxonomy schema proposed for `noy-db-docs`** (`docs/superpowers/analysis/2026-07-14-624-feature-schema-proposal.md`)
  needs a `kind` field with a `core` value distinct from `service`, precisely so a page can be
  taught inside a services-nav layer while being honestly labelled always-on (the `cpu` icon
  convention the handoff spec already uses for `joins`/`cross-join`/`links`).
