# noy-db docs

Landing page for the in-repo documentation. The repository root keeps its
mandatory files (`README.md`, `SPEC.md`, `ROADMAP.md`, `LICENSE`,
`SECURITY.md`, `CONTRIBUTING.md`, `CLAUDE.md`); everything else lives
here, grouped by purpose.

## Guides — how to do things

Onboarding, tutorials, and decision guides.

| Doc | What it's for |
|---|---|
| [`guides/START_HERE.md`](./guides/START_HERE.md) | First orientation — choose a path based on your app |
| [`guides/START_HERE.th.md`](./guides/START_HERE.th.md) | Thai version of the above |
| [`guides/getting-started.md`](./guides/getting-started.md) | Copy-paste Nuxt 4 + Pinia walkthrough |
| [`guides/topology-matrix.md`](./guides/topology-matrix.md) | Pick a deployment topology |
| [`guides/deployment-profiles.md`](./guides/deployment-profiles.md) | Profiles for common deploy targets |
| [`guides/end-user-features.md`](./guides/end-user-features.md) | Feature-by-feature runnable snippets |
| [`guides/oidc-providers.md`](./guides/oidc-providers.md) | Plug into Google / Apple / Auth0 / Keycloak / … |
| [`guides/noydb-for-ai.md`](./guides/noydb-for-ai.md) | LLM tool-calling integration guide |

## Reference — technical authority

| Doc | What it's for |
|---|---|
| [`reference/architecture.md`](./reference/architecture.md) | Data flow, key hierarchy, threat model |
| [`reference/package-overview-infographic.md`](./reference/package-overview-infographic.md) | Visual overview of the four package families |

## Package catalogs

One page per family. Each catalog lists every published package, its role,
maturity, and install snippet.

| Family | Catalog |
|---|---|
| `to-*` — storage destinations | [`packages/stores.md`](./packages/stores.md) |
| `in-*` — framework integrations | [`packages/integrations.md`](./packages/integrations.md) |
| `on-*` — unlock / auth primitives | [`packages/auth.md`](./packages/auth.md) |
| `as-*` — portable-artefact exports | [`packages/exports.md`](./packages/exports.md) |

## Patterns

Short design-pattern notes for recurring topics.

- [`patterns/as-exports.md`](./patterns/as-exports.md) — two-tier export authorization
- [`patterns/conflict-resolution.md`](./patterns/conflict-resolution.md) — CAS + version reconciliation
- [`patterns/email-archive.md`](./patterns/email-archive.md) — archiving email bodies + attachments
- [`patterns/i18n-boundaries.md`](./patterns/i18n-boundaries.md) — where locale-aware code may live
- [`patterns/schemas.md`](./patterns/schemas.md) — schema-agnostic design with Standard Schema v1
- [`patterns/schema-validation.md`](./patterns/schema-validation.md) — pre-encrypt validation

## Specification archive

Institutional memory — every shipped feature's rationale preserved as
markdown so GitHub can be pruned without losing the *why*.

- [`spec/INDEX.md`](./spec/INDEX.md) — entry point
- `spec/archive/` — issue bodies
- `spec/prs/` — merge-rationale PR bodies
- `spec/discussions/` — discussion threads
- `spec/milestones/` — milestone-level writeups

## Generated API reference

[`api/`](./api/) — full typedoc output (types, classes, interfaces,
functions, modules). Regenerated from source.

## Project artifacts

- [`HANDOVER.md`](./HANDOVER.md) — session-to-session notes for contributors
- [`AGENTS.md`](./AGENTS.md) — AI agent configuration
- [`superpowers/specs/`](./superpowers/specs/) — brainstormed design specs
- [`superpowers/plans/`](./superpowers/plans/) — implementation plans (TDD-ready)

## Assets

[`assets/`](./assets/) — SVG diagrams (architecture, envelope format, key
hierarchy, deployment profiles).
