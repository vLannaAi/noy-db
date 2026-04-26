/**
 * **@noy-db/to-probe** — diagnostic companion for the `@noy-db/to-*`
 * store family. **Not itself a storage backend** — it exercises other
 * stores and reports on their suitability.
 *
 * Two surfaces:
 *
 * ```ts
 * import { runStoreProbe, probeTopology } from '@noy-db/to-probe'
 *
 * // Single-store pre-flight check
 * const report = await runStoreProbe(myStore, { capabilities: { casAtomic: true, ... } })
 * if (!report.suitability.recommended.includes('primary')) {
 *   // Surface risks to user, or acknowledge and continue
 * }
 *
 * // Multi-store topology check — primary + sync targets as one report
 * const topology = await probeTopology({
 *   store: browserIdb({ prefix: 'app' }),
 *   sync: [
 *     { store: dynamo({ table: 'live' }),   role: 'sync-peer', label: 'live'    },
 *     { store: s3({ bucket: 'archive' }),   role: 'backup',    label: 'backup'  },
 *   ],
 *   expectedUsers: 3,
 * })
 * ```
 *
 * For runtime metrics on real traffic (not synthetic benchmarks),
 * compose with `@noy-db/to-meter` — the meter wraps a store as a
 * pass-through adapter and tracks live op latency/errors.
 *
 * @packageDocumentation
 */

export { runStoreProbe } from './probe.js'
export { probeTopology } from './topology.js'

export type {
  ProbeOptions,
  ProbeRisk,
  ProbeRiskCode,
  ProbeRole,
  StoreProbeReport,
  SuitabilityScore,
  LatencyStats,
  WriteAxis,
  CasAxis,
  HydrationAxis,
  SyncAxis,
  NetworkAxis,
  TopologyProbeOptions,
  TopologyProbeReport,
  TopologyRisk,
  TopologyTargetReport,
} from './types.js'
