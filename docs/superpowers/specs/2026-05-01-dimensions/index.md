# Roadmap dimensions — index (2026-05-01)

> Brainstorm artefact, not implementation spec. Each file below captures one *dimension* of the noy-db design space — an axis along which the project can grow. The collection answers the question **"how do we satisfy the long tail of common app patterns for single users / SMEs / small groups using only free or near-free serverless infrastructure, in full privacy and full independence?"** Each dimension will later be brainstormed into a proper implementation spec on its own cycle.

## Why "dimensions"

noy-db's architecture is already organised as a grid of orthogonal prefix families: storage destinations (`to-*`), authentication paths (`on-*`), portable export formats (`as-*`), framework integrations (`in-*`), and session-share transports (`by-*`). Each family has clear boundaries and an isolated surface area. **Maximising each existing dimension** (filling out the family) and **discovering new dimensions** (orthogonal axes of correctness, observability, defence, surfacing) is a structured way to grow the project without compromising the minimalist core.

## The dimensions

### Existing families to expand

| # | Dimension | File | Family | Status today |
|---|---|---|---|---|
| 1 | Storage backends | [01-to-storage.md](./01-to-storage.md) | `to-*` | 21 packages |
| 2 | Authentication paths | [02-on-auth.md](./02-on-auth.md) | `on-*` | 9 packages |
| 3 | Export formats | [03-as-export.md](./03-as-export.md) | `as-*` | 9 packages |
| 4 | Framework integrations | [04-in-framework.md](./04-in-framework.md) | `in-*` | 13 packages |
| 5 | Session-share transports | [05-by-transport.md](./05-by-transport.md) | `by-*` | 2 packages |

### New dimensions to define

| # | Dimension | File | Shape |
|---|---|---|---|
| 6 | Observability + advisor | [06-observability-advisor.md](./06-observability-advisor.md) | Enhanced `to-meter` + new `to-advisor` + `to-shadow` |
| 7 | Domain semantic primitives | [07-domain-primitives.md](./07-domain-primitives.md) | Hub `with*()` strategies for invariant-correctness |
| 8 | Tamper-evidence (reframed) | [08-tamper-evidence.md](./08-tamper-evidence.md) | Realistic post-decrypt observation telemetry + one-shot capabilities |
| 9 | Read-only viewer tools | [09-readonly-viewer.md](./09-readonly-viewer.md) | Browser extension + PWA for `.noydb` bundles |
| 10 | SQL surface | [10-sql-surface.md](./10-sql-surface.md) | `@noy-db/in-sql` parser→QueryPlan |

### Data shapes

These dimensions cut across every other dimension by introducing a new *kind* of data alongside records and blobs.

| # | Dimension | File | Shape |
|---|---|---|---|
| 12 | Stream data shape | [12-streams.md](./12-streams.md) | `StreamCollection<T>` + stream-shaped `to-stream-*` backends |
| 13 | Embedding data shape | [13-embeddings.md](./13-embeddings.md) | `withEmbeddings` + vector-shaped `to-vector-*` backends |

### Lifecycle and derivation (cross-cutting)

These dimensions are *axes that any data shape can carry*, not shapes themselves.

| # | Dimension | File | Shape |
|---|---|---|---|
| 14 | Derived data + materialized views | [14-derived-data.md](./14-derived-data.md) | `withDerivation` + `withMaterializedView` + `to-cache-*` backends |

### Identity and federation (cross-cutting)

| # | Dimension | File | Shape |
|---|---|---|---|
| 15 | Portable identity + federation | [15-portable-identity.md](./15-portable-identity.md) | `withIdentity` + `withSignedRecords` + `fed-*` federation transports |

### Survey artefact

[`competitors-feature-mining.md`](./competitors-feature-mining.md) — exhaustive survey of the offline-first / encrypted / sync / serverless / vector / decentralised landscape, with every notable feature mined and assigned to a dimension. Source artefact for new dimension 15 and several retrofits to dimensions 01–14.

### Catch-all

| # | Dimension | File |
|---|---|---|
| 11 | Hub/core uncategorised | [11-hub-core-misc.md](./11-hub-core-misc.md) |

## Reading order

If you only read one, read [01-to-storage.md](./01-to-storage.md) — the storage-breadth dimension is the largest single lever for the "free-tier-foundation" mission. After that, [06-observability-advisor.md](./06-observability-advisor.md) is the multiplier: once `to-*` is broad, `to-advisor` is what lets users actually pick the right backend.

For architectural seismic shifts, read [12-streams.md](./12-streams.md) and [13-embeddings.md](./13-embeddings.md). They introduce *new data shapes* alongside records and blobs and ripple into every other dimension.

For the cross-cutting axis that touches *every* shape, read [14-derived-data.md](./14-derived-data.md). One PDF blob produces metadata (record), preview (blob), text (record/stream), and embedding (vector) — Dimension 14 is the primitive that makes that single declaration. Embeddings (Dim 13) reframe as one specific application once 14 lands.

## What this isn't

- **Not a commitment.** Items here may be deferred indefinitely or rejected after deeper investigation.
- **Not a priority list.** Sequencing comes later, per dimension, after each is brainstormed into a proper spec.
- **Not a replacement for `ROADMAP.md`.** The 1.0 gate (audit, API stability, bundle CI, `by-server`/`by-room`) is unchanged. These dimensions are *post-1.0* unless explicitly hoisted.
- **Not a substitute for `features.yaml`.** When a dimension graduates to implementation, registry entries are mandatory before code lands.

## Cross-cutting concerns

Two principles apply to every dimension below:

1. **Free-tier first.** A dimension addition only earns its place if it serves the "no resources for paid SaaS" target. Paid-only services are deferred or rejected.
2. **Zero-knowledge invariant intact.** Every addition preserves "stores see only ciphertext" and "KEK never persisted." Any proposal that compromises these is reframed or rejected.
