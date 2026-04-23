# Discussion #138 — Adapter probe: simulation-based suitability test for guiding backend role selection

- **Category:** Ideas
- **Author:** @vLannaAi
- **Created:** 2026-04-09
- **State:** open
- **Comments:** 0
- **URL:** https://github.com/vLannaAi/noy-db/discussions/138

---

## Motivation

The adapter docs and the companion topology discussion (#137) give developers a table of *expected* characteristics per adapter category — latency tiers, multi-user safety, suitable roles. But "expected" is not the same as "measured against your actual backend, your actual network, your actual record sizes."

A developer in a constrained environment — slow connection, limited cloud options, forced to use iCloud Drive or an SMB share as primary — cannot look up their situation in a guidance table. They need to **measure** their situation and get a recommendation grounded in that measurement.

This discussion proposes **`runAdapterProbe()`**: a simulation-based suitability test that any adapter can be run through, producing a structured report with measured values and an advisory role recommendation.

This is an extension of the existing adapter conformance test suite (22 correctness tests in `@noy-db/test-adapter-conformance`). Conformance tests answer "does it work?" The probe answers "how well does it work, and what is it good for?"

---

## What the probe measures

### Workload battery

The probe runs six synthetic workloads, configurable by the caller:

| Workload | What it measures |
|---|---|
| **Single-record latency** | p50 / p95 / p99 of `put` and `get` on a 1 KB record (100 iterations) |
| **Small collection throughput** | Time to `put` 100 × 1 KB records, then `loadAll` | 
| **Large collection throughput** | Time to `put` 1 000 × 1 KB records, then `loadAll` |
| **Large record** | `put` + `get` on a single 1 MB record — flags adapters that serialize/deserialize slowly |
| **Concurrent write conflict** | 10 parallel `put()` calls with the same `expectedVersion` — measures how many succeed vs. throw `ConflictError`, characterizing per-record CAS safety |
| **Sync round-trip** | `saveAll` → `loadAll` → verify integrity — characterizes bundle adapter overhead |

### Context input

The probe accepts a **deployment context** so its recommendations are specific:

```ts
const report = await runAdapterProbe(adapter, {
  context: {
    expectedUsers:         1,          // 'single' | number — affects conflict-risk weighting
    expectedCollectionSize: 500,       // record count — affects bundle-overhead warning
    expectedRecordSizeKb:  2,          // average record size — affects large-record warning
    networkCondition:      'slow',     // 'fast' | 'normal' | 'slow' | 'measured'
    connectivity:          'intermittent', // 'always-on' | 'intermittent' | 'offline-first'
  },
})
```

---

## Report shape

```ts
interface AdapterProbeReport {
  adapter:   string                    // adapter.name
  timestamp: string                    // ISO 8601
  context:   ProbeContext

  measurements: {
    singleRecordPutP50Ms:  number
    singleRecordPutP99Ms:  number
    singleRecordGetP50Ms:  number
    singleRecordGetP99Ms:  number
    smallCollectionPutMs:  number      // total for 100 records
    smallCollectionLoadMs: number
    largeCollectionPutMs:  number      // total for 1 000 records
    largeCollectionLoadMs: number
    largeRecordPutMs:      number
    largeRecordGetMs:      number
    concurrentWriteSuccesses: number   // out of 10
    concurrentWriteConflicts: number
    syncRoundTripMs:       number
  }

  suitability: {
    recommended:    AdapterRole[]      // ['primary', 'sync-peer', 'backup']
    notRecommended: AdapterRole[]
    risks:          ProbeRisk[]
  }

  /**
   * Explicit override — consumer acknowledges the risks and proceeds anyway.
   * When set, the probe does not throw or warn at setup time, and records
   * the acknowledgement in the audit log.
   */
  acknowledgedRisks?: ProbeRisk[]
}

type AdapterRole = 'primary' | 'sync-peer' | 'backup' | 'archive'

interface ProbeRisk {
  code:        string   // e.g. 'slow-write-latency', 'low-concurrent-cas-safety'
  severity:    'warn' | 'error'
  message:     string
  measuredValue?: number
  threshold?:  number
}
```

---

## Risk thresholds and recommendations

The probe applies a set of heuristic rules to the measurements + context:

| Risk code | Condition | Severity | Effect on recommendation |
|---|---|---|---|
| `slow-write-p99` | put p99 > 500ms | warn | downgrade from primary → sync-peer |
| `very-slow-write-p99` | put p99 > 3 000ms | error | downgrade from primary → backup only |
| `low-cas-safety` | concurrent successes > 1 (i.e., CAS not atomic) | warn | downgrade from sync-peer (multi-user) |
| `no-cas-safety` | concurrent successes = 10 (all succeed, no CAS at all) | error | exclude sync-peer for multi-user |
| `large-collection-slow` | largeCollectionLoadMs > 10 000ms | warn | recommend scan() over loadAll(), flag bundle risk |
| `large-record-slow` | largeRecordPutMs > 5 000ms | warn | note in report |
| `high-sync-round-trip` | syncRoundTripMs > 30 000ms | warn | recommend larger sync intervals |

**Recommendations are context-weighted.** `low-cas-safety` is severity `warn` for `expectedUsers: 1` and severity `error` for `expectedUsers: >1`. The same measured behavior produces different guidance depending on how the adapter will actually be used.

---

## The iCloud / constrained-environment use case

A developer who has no cloud service available and is voluntarily choosing iCloud Drive as primary for a single-user, small-collection deployment runs:

```ts
import { runAdapterProbe } from '@noy-db/test-adapter-conformance'
import { jsonFile } from '@noy-db/file'

const report = await runAdapterProbe(
  jsonFile({ dir: '/Users/alice/Library/Mobile Documents/com~apple~CloudDocs/myapp' }),
  {
    context: {
      expectedUsers: 1,
      expectedCollectionSize: 500,
      expectedRecordSizeKb: 2,
      connectivity: 'intermittent',
    },
  }
)
```

The probe might measure:
- put p99: 420ms (iCloud sync delay is included if the dir is actively syncing)
- concurrent CAS successes: 10/10 (file adapter has no CAS — all writes succeed)
- syncRoundTripMs: 1 200ms

And produce:

```
recommended:    ['backup', 'sync-peer (single-user only)']
notRecommended: ['primary (multi-user)']
risks: [
  { code: 'slow-write-p99', severity: 'warn', measuredValue: 420, threshold: 500 },
  { code: 'no-cas-safety', severity: 'warn',   // downgraded to warn because expectedUsers: 1
    message: 'File adapter has no per-record CAS. Safe for single-user; risky if multiple writers access the same directory.' },
]
```

The developer reads the report, sees that their specific context (single user, 500 records, iCloud) produces only `warn`-level risks — no `error` — and proceeds. If they run the same probe with `expectedUsers: 3`, the `no-cas-safety` risk would escalate to `error` and `primary` would be excluded from recommendations.

If the developer disagrees with a `warn` and wants to use it as primary anyway, they pass:

```ts
const db = await createNoydb({
  adapter: jsonFile({ dir: '…/iCloudDocs/myapp' }),
  acknowledgeAdapterRisks: ['slow-write-p99'],
})
```

The acknowledgement is recorded in the first audit log entry. No warning is emitted at runtime.

---

## Where does the probe live?

**Option A — extend `@noy-db/test-adapter-conformance`.** One package for all adapter testing (correctness + performance). Cons: the probe needs a network-connected adapter to be meaningful; running it in CI without a real backend produces misleading latency numbers. The conformance suite is designed to run in isolation with mocks.

**Option B — new `@noy-db/adapter-probe` package.** Clean separation: conformance = correctness (CI-safe), probe = performance (run manually against real backends). Cons: another package.

**Lean Option B.** The probe is a developer tool, not a CI tool. It makes sense as a standalone package or as part of `@noy-db/testing` (planned for v0.10).

---

## Open questions

1. **Where in the release timeline?** v0.10 ships `@noy-db/testing` with `createTestDb()`, `seed()`, `snapshot()`. The probe fits naturally there. Alternatively, ship a lean v1 alongside v0.11 (adapter expansion) so each new adapter ships with a probe result in its README.
2. **Probe results in adapter READMEs.** Should each `@noy-db/*` adapter package include a "probe results" section in its README — measured against a typical deployment? This would set honest expectations without forcing every consumer to run the probe themselves.
3. **CLI integration.** In v0.10, `noydb probe --adapter file --dir ./data` could run the probe and print a human-readable report. Low-effort given the programmatic API already exists.
4. **Threshold calibration.** The thresholds above are first guesses. They should be validated against the first consumer's real deployment (USB stick workflow on file adapter, DynamoDB in ap-southeast-1) before being published as defaults.
5. **`acknowledgeAdapterRisks` in `createNoydb()` vs. in the probe call.** The example above puts the acknowledgement in `createNoydb()`. Should it instead live on `SyncTarget.acknowledgeRisks` (see #137)? Probably both — primary adapter risks in `createNoydb()`, sync-target risks on the target.


