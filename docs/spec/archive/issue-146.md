# Issue #146 — feat(tooling): @noy-db/store-probe — setup-time suitability test and runtime reliability monitor for all attached stores

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-09
- **Closed:** 2026-04-10
- **Milestone:** v0.12.0
- **Labels:** type: feature, priority: medium, area: core, area: adapters

---

## Summary

A dual-mode utility that helps developers choose the right store configuration and monitors all attached stores at runtime.

**Setup-time probe** — run once before or during configuration. Measures latency, throughput, CAS behavior, sync economics, and network resilience. Outputs a structured suitability report with role recommendations.

**Runtime monitor** — runs continuously (or on demand) against all stores attached to a `Noydb` instance. Detects degradation, auth expiry, and connectivity loss before they silently affect users.

Spawned from discussion #138. Companion to `StoreCapabilities.casAtomic` (#141) and `StoreCapabilities.auth` (#143).

---

## Part 1 — Setup-time probe

### Usage

```ts
import { runStoreProbe } from '@noy-db/store-probe'
import { jsonFile } from '@noy-db/store-file'

const report = await runStoreProbe(
  jsonFile({ dir: '/Users/alice/Library/Mobile Documents/com~apple~CloudDocs/myapp' }),
  {
    context: {
      expectedUsers:          1,
      expectedCollectionSize: 500,
      expectedRecordSizeKb:   2,
      connectivity:           'intermittent',
    },
  }
)
```

### Five measurement axes

Each axis maps to one strategic decision:

| Axis | Measures | Decides |
|---|---|---|
| **D1 — Write responsiveness** | `put` p50 / p99, p99 under 5 concurrent ops, cold-start latency | Can it be primary without blocking the UI? |
| **D2 — Conflict integrity** | Concurrent CAS behavior (10 parallel puts, same expectedVersion) | Safe for multi-user? — validation only; `casAtomic` is static (#141) |
| **D3 — Hydration cost** | `loadAll` time at 100 / 1K / 5K records; memory footprint | Is startup acceptable? |
| **D4 — Sync economics** | Single dirty-record push time; 100-record push; bytes per push; write amplification ratio | How to schedule sync? What is the cost per operation? |
| **D5 — Network resilience** | Error on connectivity loss; retry/backoff behavior; auth-expiry behavior | Offline-first viability |

D2 is validated (not measured) — if a store declares `casAtomic: true` but the concurrent test shows multiple successes, that is a bug report against the store, not a measurement result.

### Weights by role

The probe applies three independent scorecards — one per role — rather than a single blended score:

| | D1 | D3 | D4 | D5 |
|---|:---:|:---:|:---:|:---:|
| **Primary** | 45% | 30% | 5% | 20% |
| **Sync peer** | 20% | 10% | 35% | 35% |
| **Backup / archive** | 5% | 5% | 80% | 10% |

### Report shape

```ts
interface StoreProbeReport {
  store:     string               // store.name
  timestamp: string               // ISO 8601
  context:   ProbeContext

  measurements: {
    // D1
    writeP50Ms:               number
    writeP99Ms:               number
    writeP99ConcurrentMs:     number
    coldStartMs:              number
    durabilityOnAck:          boolean   // static claim from StoreCapabilities

    // D2 (validation)
    casAtomicClaimed:         boolean
    concurrentWriteSuccesses: number    // out of 10; should be 1 if casAtomic: true

    // D3
    loadAll100Ms:             number
    loadAll1kMs:              number
    loadAll5kMs:              number
    scalingShape:             'linear' | 'sublinear' | 'superlinear' | 'cliff'
    memoryFootprint5kMb:      number

    // D4
    singleDirtyPushMs:        number
    hundredDirtyPushMs:       number
    bytesPerPushKb:           number
    writeAmplificationRatio:  number    // bytes written / bytes changed

    // D5
    offlineRead:              boolean
    offlineWrite:             boolean
    errorOnLoss:              string    // error class name
    authExpiryBehavior:       'silent-refresh' | 'throws' | 'unknown'
  }

  suitability: {
    recommended:    StoreRole[]   // ['primary', 'sync-peer', 'backup']
    notRecommended: StoreRole[]
    risks:          ProbeRisk[]
  }
}

type StoreRole = 'primary' | 'sync-peer' | 'backup' | 'archive'

interface ProbeRisk {
  code:          string    // e.g. 'slow-write-p99', 'no-atomic-cas', 'high-write-amplification'
  severity:      'warn' | 'error'
  message:       string
  measuredValue?: number
  threshold?:    number
}
```

### Risk thresholds

| Code | Condition | Severity | Effect |
|---|---|---|---|
| `slow-write-p99` | p99 > 500ms | warn | Downgrade from primary |
| `very-slow-write-p99` | p99 > 3 000ms | error | Exclude primary |
| `cas-mismatch` | claimed `casAtomic: true` but concurrentSuccesses > 1 | error | Bug in store — report |
| `no-atomic-cas` | `casAtomic: false` + `expectedUsers > 1` | warn/error | Exclude sync-peer (multi-user) |
| `high-write-amplification` | amplification > 100× | warn | Recommend larger sync interval |
| `large-collection-slow` | loadAll 5K > 10 000ms | warn | Recommend `scan()` over `loadAll()` |
| `cold-start-high` | coldStartMs > 3× writeP50Ms | warn | Note in report; flag for OAuth stores |

Severity of `no-atomic-cas` is `warn` for `expectedUsers: 1` and `error` for `expectedUsers > 1`.

### acknowledgeRisks integration

```ts
// Developer reads the report, accepts warn-level risks, proceeds:
const db = await createNoydb({
  store: jsonFile({ dir: '…/iCloudDocs/myapp' }),
  acknowledgeRisks: ['slow-write-p99'],   // #141
})
```

---

## Part 2 — Runtime monitor

### Activation

```ts
// Attach to a running Noydb instance — monitors all stores (primary + all sync targets)
const monitor = db.monitor({
  interval:   60_000,      // probe every 60s (default)
  onDegraded: (event) => console.warn('store degraded', event),
  onRestored: (event) => console.info('store restored', event),
})

monitor.stop()             // detach
const snapshot = await monitor.check()   // one-shot manual check
```

### What it checks (lightweight — not the full setup probe)

Each interval run executes a minimal synthetic workload against each attached store:

| Check | Operation | Threshold |
|---|---|---|
| **Liveness** | `ping()` if available, else `list(compartment, '_probe')` | Fails if throws or > 5 000ms |
| **Write latency** | Single `put` + `delete` on a reserved `_probe` record | Emits `degraded` if p99 > 3× baseline (measured at startup) |
| **Auth validity** | Any auth-related error on the liveness check | Emits `auth-expired` event |
| **Sync lag** | Dirty record count on each sync target | Emits `sync-lagging` if dirty > configurable threshold |

### Events

```ts
type MonitorEvent =
  | { type: 'degraded';     store: string; reason: 'latency' | 'unreachable' | 'auth-expired' | 'sync-lagging'; detail: string }
  | { type: 'restored';     store: string }
  | { type: 'cas-conflict'; store: string; record: string }   // unexpected concurrent write detected

db.on('store:degraded',  (e: MonitorEvent) => { /* surface in UI */ })
db.on('store:restored',  (e: MonitorEvent) => { /* clear warning */ })
```

### Vue / Pinia integration

`useSync()` gains a `storeHealth` reactive field:

```ts
const { storeHealth } = useSync()
// storeHealth.value === Map<storeName, 'ok' | 'degraded' | 'unreachable' | 'auth-expired'>
```

---

## Package and release

**Package:** `@noy-db/store-probe`
**Depends on:** `@noy-db/core` (peer), `@noy-db/store-memory` (for synthetic workload isolation)
**Target release:** v0.10 (developer experience milestone) — alongside `@noy-db/testing` and the DevTools panel

The setup-time probe ships first (simpler, no runtime wiring). Runtime monitor ships in the same release but can be decoupled if needed.

---

## Related

- Discussion #138 — original probe design (this issue formalises it)
- #141 — `StoreCapabilities.casAtomic` + `acknowledgeRisks`
- #143 — `StoreCapabilities.auth`
- #137 — multi-backend topology (`SyncTarget[]`) — the monitor checks all targets
- #101 — `syncPolicy` scheduling — monitor's `sync-lagging` check complements the scheduler
