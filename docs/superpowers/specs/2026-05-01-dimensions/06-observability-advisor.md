# Dimension 06 — Observability + advisor

## Purpose

Once the `to-*` family is broad (Dimension 01), users face a paralysing choice: which backend should I pick for *my* workload? This dimension answers that question with **runtime telemetry** (`to-meter` enhanced), **A/B comparison infrastructure** (`to-shadow`), and **automated recommendation** (`to-advisor`). The endgame: a developer can run their app on `to-memory` for a day, then ask the advisor "what's my best-fit free-tier backend, given my actual workload?" and get a defensible answer.

## Current state

- `to-meter` exists as a pass-through metrics wrapper (basic counters, no cost or latency capture).
- `to-probe` exists as a diagnostic companion (one-time pre-flight checks).
- No A/B or shadow-write capability.
- No advisor / recommender.

## Target state

A **workload profile** is captured at runtime: read/write counts, size histograms, CAS contention rate, R/W ratio, frequency, working-set size, blob-vs-record share, latency distribution, error rates. The profile is **portable** (JSON, exportable). The advisor compares the profile against a static **backend cost-and-capability catalog** (cost-per-op estimates, latency tiers, regional coverage, CAS support, blob/record specialisation) and recommends migrations or hybrid topologies. A/B is run live via `to-shadow` (parallel-write to two backends, reads served from the primary, divergence reported).

## Concrete additions

**Enhanced existing:**
- `to-meter` v2 — captures size histograms (request and response), latency percentiles, CAS retry counts, error categories, time-of-day buckets. Output to local file, in-memory ring buffer, or callback. Zero cost when disabled. Extended with: **sync-lag per replica** (ElectricSQL / PowerSync style), **CRDT conflict-rate** (Replicache / Yjs style), **LLM-specific signals** when paired with `in-ai` (token cost, model-route latency, retrieval recall — LangSmith / Helicone shape), **vector-recall-at-K** when paired with Dim 13.

**New packages:**
- `to-shadow` — wraps two `to-*` backends; writes to both, reads from primary. Surfaces divergence as events. Used for migration validation and live A/B.
- `to-advisor` — reads `to-meter` workload profiles + backend catalog (in-package, updateable) + user constraints (cost ceiling, region requirements, compliance tags). Emits a ranked migration plan as structured output (JSON) and human-readable narrative.
- `to-bench` — synthetic-workload generator for the conformance suite, parameterised by workload-shape archetypes (write-heavy, read-heavy, hot-key, large-blob, etc.).
- `to-cost-catalog` — data package containing the backend cost-and-capability catalog. Versioned independently from runtime packages so cost updates don't churn package versions.

**Capability extensions to existing `to-*`:**
- `costPerOp` capability metadata (read, write, storage-per-month, egress-per-GB)
- `latencyTier` capability metadata (`edge`, `regional`, `cross-region`, `archive`)
- `freeQuota` capability metadata (per backend's free-tier limits, with renewal cadence)

## Non-goals & tradeoffs

- **Building a SaaS observability platform.** Telemetry is local-first; it does not phone home. Users export profiles deliberately.
- **Real-time billing integration.** `to-cost-catalog` is *estimated* costs, not invoiced costs. Plug-in for live billing APIs is left to consumers.
- **Predicting future workloads.** The advisor recommends based on observed history, not forecasts. Forecasting is a separate dimension if/when it earns its place.
- **Replacing operational APM.** Datadog / New Relic / Grafana solve a different problem. `to-meter` is intentionally smaller-scope: workload profiling for backend selection, not full operational visibility.

## Dependencies / sequencing

- Capability metadata expansion in Dimension 01 (`costPerOp`, `latencyTier`, `freeQuota`) **must land first**. Without it, the advisor has nothing to read.
- `to-shadow` requires careful CAS-semantics handling: shadow writes must not corrupt the primary's atomicity guarantees.
- `to-bench` requires a stable conformance-suite contract.
- `to-advisor` uses a portable profile format that survives package versions — needs schema versioning from day one.

## Cross-references

- `features.yaml` → `adapters` (`to-meter`, `to-advisor`, `to-shadow`, `to-bench`); new section `cost_catalog`?
- Related: Dimension 01 (advisor consumes Dimension 01 capability metadata), Dimension 11 (advisor narrative output may use printable export from Dimension 03), Dimension 12 (stream-specific metering: events/sec, lag, retention), Dimension 13 (vector-specific metering: query latency at K, recall@K, index build time), Dimension 14 (derivation-cost metering: re-derivation latency, cache hit rate, eager-vs-lazy advisor recommendations)
- Spec anchor: new `SUBSYSTEMS.md#observability-and-advisor` section needed

## Open questions

- **Profile portability.** Is a workload profile a `.json` file, a noy-db collection (so multiple profiles can be diffed/aggregated), or both?
- **Advisor confidence.** How does the advisor express uncertainty when the workload is too short or too unrepresentative to recommend confidently?
- **Hybrid recommendations.** Today's `routeStore` allows splitting collections across backends. Should the advisor recommend hybrid topologies, or only single-backend swaps?
- **Cost catalog freshness.** Cloud pricing changes monthly. Is the catalog auto-fetched from vendor APIs, manually curated, or community-contributed?
- **Privacy of profiles.** Workload profiles can leak business shape (e.g., "you have ~10K records growing 200/day"). Should profiles be sharable as portable artefacts (Dimension 03) with access control?
