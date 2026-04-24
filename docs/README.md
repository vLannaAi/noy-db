# noy-db docs

Landing page for the in-repo documentation. The repository root keeps
its mandatory files (`README.md`, `SPEC.md`, `ROADMAP.md`, `LICENSE`,
`SECURITY.md`, `CONTRIBUTING.md`); everything else lives here, flat
and grouped by purpose through naming prefixes rather than folders.

## Start

| Doc | What it's for |
|---|---|
| [`overview.md`](./overview.md) | 30-second pitch + visual overview of the four package families |
| [`choose-your-path.md`](./choose-your-path.md) | First orientation — which app shape fits your need |
| [`quickstart.md`](./quickstart.md) | Copy-paste tutorial (Nuxt 4 + Pinia) |
| [`topologies.md`](./topologies.md) | Pick a deployment topology — 9 recipes, matrix views, decision tree |

## Build

| Doc | What it's for |
|---|---|
| [`features.md`](./features.md) | Feature-by-feature runnable snippets |
| [`architecture.md`](./architecture.md) | Data flow · key hierarchy · threat model · schema validation · i18n boundaries · sync conflict resolution |
| [`recipes.md`](./recipes.md) | Domain-specific cookbooks for recurring patterns (email archive, …) |

## Packages

One catalog per family. Each lists every package, its role, maturity,
and install snippet.

| Family | Catalog |
|---|---|
| `to-*` — storage destinations | [`packages-stores.md`](./packages-stores.md) |
| `in-*` — framework integrations | [`packages-integrations.md`](./packages-integrations.md) |
| `on-*` — unlock / auth primitives | [`packages-auth.md`](./packages-auth.md) |
| `as-*` — portable-artefact exports | [`packages-exports.md`](./packages-exports.md) |

## Specific integrations

Deeper dives for integrations with substantial per-provider configuration.

| Doc | What it's for |
|---|---|
| [`integrations-oidc.md`](./integrations-oidc.md) | Plug into Google / Apple / LINE / Meta / Auth0 / Keycloak |
| [`integrations-ai.md`](./integrations-ai.md) | LLM tool-calling integration guide |

## Project artifacts

- [`AGENTS.md`](./AGENTS.md) — AI agent configuration for Codex

## Assets

[`assets/`](./assets/) — SVG diagrams (architecture, envelope format,
key hierarchy, package ecosystem).
