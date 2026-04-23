# Issue #153 — feat(tooling): @noy-db/store-probe — setup-time suitability test

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-10
- **Closed:** 2026-04-21
- **Milestone:** v0.13.0 — Developer tools (P1)
- **Labels:** type: feature, priority: medium, area: core, area: adapters

---

Split from #146.

## Summary

`runStoreProbe(store, options?)` — run once before or during configuration to measure latency, throughput, CAS behavior, sync economics, and network resilience. Outputs a structured `StoreProbeReport` with role recommendations.

## Package

`@noy-db/store-probe` (peer dep: `@noy-db/hub`)

## Five measurement axes

| Axis | Measures | Decides |
|---|---|---|
| **D1 — Write responsiveness** | `put` p50/p99, p99 under 5 concurrent ops, cold-start | Can it be primary without blocking the UI? |
| **D2 — Conflict integrity** | Concurrent CAS (10 parallel puts, same expectedVersion) | Safe for multi-user? |
| **D3 — Hydration cost** | `loadAll` at 100/1K/5K records; memory footprint | Is startup acceptable? |
| **D4 — Sync economics** | Single dirty-record push; 100-record push; bytes/push; write amplification | How to schedule sync? |
| **D5 — Network resilience** | Error on connectivity loss; retry/backoff; auth-expiry | Offline-first viability |

## Suitability scoring

Three independent scorecards (primary / sync-peer / backup) with weighted axes. `suitability.recommended` lists roles that pass all risk thresholds; `suitability.risks` lists `ProbeRisk[]` with severity `warn | error`.

## acknowledgeRisks integration

```ts
const db = await createNoydb({
  store: myStore,
  acknowledgeRisks: ['slow-write-p99'],   // from StoreProbeReport
})
```

## Acceptance

- [ ] `runStoreProbe(store, context?)` returns `StoreProbeReport`
- [ ] All five axes measured with documented thresholds
- [ ] `cas-mismatch` risk emitted when `casAtomic: true` but concurrent test shows > 1 success
- [ ] Works against any `NoydbStore` — `to-memory`, `to-file`, `to-aws-dynamo`, etc.
- [ ] Changeset for `@noy-db/store-probe`

## Related

- #146 — original combined issue (closed, split here + runtime monitor issue)
- #141 — `StoreCapabilities.casAtomic` + `acknowledgeRisks`
- #143 — `StoreCapabilities.auth`
- Discussion #138 — original probe design
