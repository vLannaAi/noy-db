# Dimension 11 — Hub / core uncategorised (catch-all)

## Purpose

Capture ideas that don't (yet) cleanly fit a single dimension above. Every entry here is either small enough to live without its own dimension or large enough that it might *graduate* into a new dimension once it accretes related ideas. Treat this as the staging area: items here will either ship as small enhancements, get promoted to their own file, or get rejected.

## Current state

The hub at v0.1.0-pre.2 exposes subpath modules: `i18n`, `store`, `team`, `session`, `history`, `query`. The 6-method `NoydbStore` contract, the envelope format, the keyring layer, and `withTransactions` are stable. The 1.0 gate is the focus for everything currently scheduled.

## Candidate ideas (no commitment, no order)

### Scale / structural

**Vault-of-vaults / sharding.** noy-db's stated ceiling is 1K–50K records per vault. Apps that brush against this ceiling want vault sharding (group records by partition key into N sub-vaults). A small primitive — `withSharding({ keyOf, vaults })` — could route reads/writes transparently. Open: how cross-shard queries work; how lazy-mode interacts; whether `withPeriods` already covers the common case.

**Streaming and pagination.** `Collection.scan()` is the streaming primitive today. Cursor-based pagination (resumable scans across sessions) would help apps with huge bundles. Open: what's the durable cursor format?

**Compaction / garbage-collection.** History-heavy collections grow unbounded. Compaction primitive: collapse history older than `cutoff` into a single squashed entry, optionally with a Merkle root anchored on-chain (Dimension 01's anchor-only mode). Shares lifecycle infrastructure with Dimension 14's cache expiry — both are forms of bounded retention.

### Privacy / regulatory

**Right-to-be-forgotten in encrypted-by-default world.** GDPR compels deletion; encrypted ciphertext is hard to "delete" definitively when copies exist. A primitive `withForgetCascade(predicate)` shreds DEKs for matching records, rendering ciphertext permanently unrecoverable across all stores. Open: how to express "all records of subject X" portably; how this composes with `withHistory`.

**Privacy-tier classification on collections.** `tier: 'public' | 'internal' | 'sensitive' | 'restricted'` flag drives default permissions, default export gating, and default audit-log verbosity.

**Data-residency enforcement.** Annotate collections with `region: 'eu' | 'us' | ...` and refuse to write to backends whose `region` capability metadata mismatches. Couples to Dimension 01's region capability work.

### Operational

**Migrations primitives.** Schema evolution across versions (rename field, add field with default, change validator) — partially achievable today via `vault.diff` + manual scripts, but no formal `withMigration({ from, to, transform })` primitive. Open: what's the migration DSL, how it composes with `withHistory` (do migrations get logged?).

**Cross-vault joins.** Explicit, permission-checked queries that span two vaults. Today the keyring layer prevents implicit cross-vault data flow; cross-vault join would require explicit grant. Use case: a dashboard querying multiple SME vaults with explicit consent.

### Ecosystem

**Plugin manifest.** Registry shape for third-party `to-*` / `on-*` / `in-*` / `as-*` packages outside the monorepo. Today, `features.yaml` registers monorepo-internal packages; an external registry shape (with conformance-test commitment, capability declaration, audit-log) would let third parties extend the family without forking. Open: how validation / conformance is enforced for packages we don't ship.

**Test harness templates.** Reusable Vitest suites for third-party adapters; today `runStoreConformanceTests` exists but isn't packaged for outside-monorepo use. Bundle the suite as `@noy-db/test-store-conformance`.

**`create-noy-db` scaffolder breadth.** Currently scaffolds a minimal app; could template per-recipe (accounting, notebook, analytics, etc.) and per-target-deployment (Cloudflare Pages, Vercel, GitHub Pages, Tauri, Electron).

**`@noy-db/cli` feature-parity expansion.** The CLI today has a limited surface (`open`, `dump`, basic vault ops). Full parity would let it drive every `with*()` strategy, every `as-*` export, every `on-*` unlock — making CLI usable as a non-developer-friendly admin tool and as a CI/CD primitive. Open: how to expose unlock interactively (passphrase prompt, magic-link redirect, etc.) without leaking material to shell history.

### Developer ergonomics

**Schema-first generation.** From a TypeScript schema, generate SQL DDL (for `to-postgres` / `to-mysql` / `to-sqlite` initial migration), GraphQL SDL (for consumer APIs), JSON Schema (for `in-ai`), Zod/Valibot validators. Couples to Dimension 04's UX components.

**Time-travel queries.** `Collection.query().asOf(timestamp)` — read the collection state as it was at `timestamp`. Built atop `withHistory`. Open: cost of materialising historical state at arbitrary timestamps.

**Soft-delete defaults.** `withSoftDelete()` strategy that flags rather than removes; pairs with right-to-be-forgotten cascade for hard-delete escalation.

## Promotion criteria

An idea here graduates to its own dimension file when:
- 3+ related ideas accrete around it (signal: it's a real axis, not a one-off)
- A pilot application requests it as blocking
- The 1.0 gate ships and post-1.0 priorities are reordered

Until then, items live here as a deliberate staging area.

## Cross-references

- `features.yaml` → mostly hub `features` section; one-offs may justify new sections case by case
- Related: every other dimension — items here may move into them as scope clarifies
- Spec anchor: `SPEC.md` (most ideas are spec-shape changes)

## Open questions

- **What graduates first?** Right-to-be-forgotten cascade is regulatorily urgent; sharding is scale-urgent; migrations are dev-experience urgent.
- **Plugin manifest format.** JSON Schema, YAML, or a TypeScript declaration consumed at build time?
- **Promotion threshold.** Is "3 related ideas" the right gate, or does the project benefit from earlier dimension splits?
