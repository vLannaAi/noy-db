# Roadmap

> **Starting point:** v0.21. This document looks forward only — prior
> trunk history (v0.3 → v0.20) is in `git log` if you need it.
>
> **Pre-1.0 stance.** The core privacy model, envelope format,
> keyrings, permissions, and query DSL are implemented and tested in
> production pilot deployments. Public APIs may still change based on
> adopter feedback before 1.0. Data-format migrations and
> security-critical changes will be documented explicitly at release.
> No third-party cryptographic audit yet — that is a v1.0 target.

The roadmap has a **trunk** — sequential, numbered releases — and
three **parallel forks** — always-open families (`@noy-db/to-*` /
`in-*` / `on-*` / `as-*`) that ship on their own cadence and don't
block the trunk.

Related docs:

- [README](./README.md) — mental model in one page
- [SUBSYSTEMS.md](./SUBSYSTEMS.md) — the 17-subsystem catalog (canonical surface index)
- [Core](./docs/core/) — 6 always-on areas
- [Subsystems](./docs/subsystems/) — 17 opt-in capabilities
- [Recipes](./docs/recipes/) — 4 starter applications
- [Package catalog](./docs/packages/to-stores.md) — `to-*` (stores), [`in-*` (integrations)](./docs/packages/in-integrations.md), [`on-*` (auth)](./docs/packages/on-auth.md), [`as-*` (exports)](./docs/packages/as-exports.md)
- [SPEC](./SPEC.md) — placeholder skeleton; full spec rewrite deferred to post-pre-release per #289

---

## The trunk

| Release | Status | Theme |
|---|---|---|
| **v0.21.0** | 🎯 in progress | **Pilot-2 feedback batch.** Cross-user KEK delegation ([#257](https://github.com/vLannaAi/noy-db/issues/257)), `vault.exportBlobs()` bulk primitive ([#262](https://github.com/vLannaAi/noy-db/issues/262)), per-collection blob TTL ([#263](https://github.com/vLannaAi/noy-db/issues/263)), `useDictLabel` Pinia composable ([#264](https://github.com/vLannaAi/noy-db/issues/264)). |
| **v0.22.0** | 🟡 foundation only | **Lazy-mode index foundation shipped.** Typed errors, `_idx/<field>/<recordId>` id helpers, `PersistedCollectionIndex` mirror class, constructor support for `prefetch:false + indexes`. Write-path maintenance, query dispatch, reconcile/rebuild, and benchmark harness are **deferred** — milestone closed; see follow-up issues under milestone [v0.23.0](https://github.com/vLannaAi/noy-db/milestone/30) (#275–#278). |
| **v0.23.0** | 🟢 phases A+B+C+bench shipped | **Lazy-mode indexes — complete bar FTS.** Phases A–C: write-path ([#266](https://github.com/vLannaAi/noy-db/issues/266)), equality + orderBy dispatch ([#267](https://github.com/vLannaAi/noy-db/issues/267), [#268](https://github.com/vLannaAi/noy-db/issues/268)), rebuild/reconcile ([#269](https://github.com/vLannaAi/noy-db/issues/269)), range predicates ([#275](https://github.com/vLannaAi/noy-db/issues/275)) with typed-value comparison, composite indexes ([#276](https://github.com/vLannaAi/noy-db/issues/276)), `reconcileOnOpen: 'auto' \| 'dry-run'` ([#278](https://github.com/vLannaAi/noy-db/issues/278)). Bench: 1K smoke gate asserts 250ms p95 on `to-browser-idb` via `fake-indexeddb` ([#270](https://github.com/vLannaAi/noy-db/issues/270) — CI-ready, opt-in via `NOYDB_BENCH=1`); 50K × native Chromium gate is Playwright follow-up. FTS ([#277](https://github.com/vLannaAi/noy-db/issues/277)) is the only v0.23 milestone item still open. |
| **v1.0.0** | 🔭 target | Stability + LTS — API freeze, third-party audit, perf benchmarks, migration tooling |
| v1.x | 🔭 vision | Federation, multi-instance bridging |
| v2.0+ | 🔭 vision | Verifiable credentials, advanced ZK applications |

The foundation epoch (v0.3 → v0.20) shipped the core privacy + pluggable
store architecture. v0.21 opens the adopter-feedback epoch — each release
lands what real production workloads actually need.

### What lives outside the trunk

- **Domain schemas** — noy-db is schema-agnostic. Standard Schema v1 is
  the extension point, community publishes formats (ETDA CII, Peppol
  UBL, HL7 FHIR, …) under their own npm scopes. See
  [`docs/core/05-schema-and-refs.md`](./docs/core/05-schema-and-refs.md).

---

## Parallel forks

These milestones stay **open indefinitely** — new packages land inside
them without coordinating against trunk releases.

### Fork · Stores (`@noy-db/to-*`)

Where ciphertext goes. 20 packages shipped; remaining open:

- `to-ipfs` — content-addressed bundle store
- `to-git` — vault as git repo, history as commits
- `to-qr` — scannable QR sequence for air-gap transfer
- `to-stego` — steganographic hiding in JPEG/PNG/PDF

See [stores.md](./docs/packages/to-stores.md) for the full catalog.

### Fork · Integrations (`@noy-db/in-*`)

Framework bindings. 10 shipped; remaining open:

- `in-solid` — SolidJS signals
- `in-qwik` — resumable queries

See [integrations.md](./docs/packages/in-integrations.md).

### Fork · On (`@noy-db/on-*`)

Unlock / auth primitives. 9 shipped; remaining open:

- Cross-user KEK delegation (follow-up to v0.18 delegation tokens)

See [auth.md](./docs/packages/on-auth.md).

### Fork · As (`@noy-db/as-*`)

Portable-artefact exports. 9 shipped (CSV / XLSX / JSON / NDJSON /
XML / SQL / blob / ZIP + encrypted `.noydb` bundle). Always-open
lane for additional format requests.

See [exports.md](./docs/packages/as-exports.md).

---

## How new work gets queued

1. File a GitHub issue against the relevant Fork milestone.
2. For trunk work, open a discussion first to confirm the scope fits
   the current release's theme.

No versioned release notes in this repo — changesets drive that at
publish time via `pnpm changeset version`.
