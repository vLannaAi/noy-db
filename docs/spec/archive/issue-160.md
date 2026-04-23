# Issue #160 — feat(tooling): store-probe — multi-backend topology health and suitability

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-10
- **Closed:** 2026-04-21
- **Milestone:** v0.13.0 — Developer tools (P1)
- **Labels:** type: feature, priority: medium, area: core, area: adapters

---

Extends `@noy-db/store-probe` to understand multi-backend topologies — both at setup time and at runtime.

Builds on #153 (setup-time probe) and #154 (runtime monitor). Depends on the core `SyncTarget[]` API from #158.

## Setup-time: `probeTopology()`

Probes all stores in a topology and produces a combined suitability report:

```ts
import { probeTopology } from '@noy-db/store-probe'

const report = await probeTopology({
  store: browserIdbStore({ prefix: 'myapp' }),
  sync: [
    { store: dynamoStore({ table: 'live' }), role: 'sync-peer' },
    { store: s3Store({ bucket: 'archive' }), role: 'backup' },
  ],
})
```

### What it checks per target

- Runs the individual `runStoreProbe()` for each store independently.
- Adds topology-level checks:

| Check | Condition | Severity |
|---|---|---|
| `bundle-as-sync-peer` | Bundle store (drive, git, webdav) used as `sync-peer` | warn — recommend `backup` or `archive` instead |
| `no-atomic-cas-sync-peer` | `casAtomic: false` store used as `sync-peer` with `expectedUsers > 1` | error |
| `primary-slower-than-peer` | Primary p99 > sync-peer p99 × 2 | warn — unusual topology |
| `archive-pull-configured` | `archive` target has a pull policy | error — archive is push-only |

### Report shape

```ts
interface TopologyProbeReport {
  primary:     StoreProbeReport
  targets:     Array<StoreProbeReport & { role: SyncTarget['role']; label: string }>
  topology:    TopologyRisk[]
  recommended: boolean   // true if no error-severity risks across the whole topology
}
```

## Runtime monitor: multi-target tracking

Extends `db.monitor()` (#154) to track health per target:

```ts
const monitor = db.monitor({ interval: 60_000 })

// Per-target events
db.on('store:degraded', (e) => {
  // e.store — store name/label
  // e.role  — 'primary' | 'sync-peer' | 'backup' | 'archive'
})
```

`useSync().storeHealth` (Vue integration) becomes a `Map<label, HealthStatus>` covering primary + all targets, not just the primary.

## Acceptance

- [ ] `probeTopology(options)` returns `TopologyProbeReport`
- [ ] All four topology-level risk checks implemented
- [ ] `bundle-as-sync-peer` warn does not block — `acknowledgeRisks` can suppress it
- [ ] `db.monitor()` emits `store:degraded` / `store:restored` with `role` field
- [ ] `useSync().storeHealth` covers all targets
- [ ] Changeset for `@noy-db/store-probe`

## Related

- #153 — setup-time single-store probe (this extends it)
- #154 — runtime single-store monitor (this extends it)
- #158 — core `SyncTarget[]` API
- Discussion #137 — topology design
