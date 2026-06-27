/**
 * Shared types for `@noy-db/to-probe`.
 *
 * Both `runStoreProbe()` and `probeTopology()` produce structured
 * reports with the same vocabulary: a fixed set of per-axis measurement
 * blocks, a `ProbeRisk[]` list with severity and a machine-readable
 * `code`, and a `SuitabilityScore` triple (primary / sync-peer / backup)
 * summarising whether the store is safe to use in that role.
 *
 * The `code` strings are the identifiers adopters pass to
 * `createNoydb({ acknowledgeRisks: [...] })` to silence a known risk.
 *
 * @module
 */
import type { NoydbStore, SyncTargetRole, StoreCapabilities } from '@noy-db/hub'

/** Role a store is being considered for. */
export type ProbeRole = 'primary' | 'sync-peer' | 'backup' | 'archive'

/** Machine-readable risk identifiers. Keep this list closed — adopters
 *  pass these exact strings to `acknowledgeRisks`. */
export type ProbeRiskCode =
  | 'slow-write-p99'
  | 'slow-hydration'
  | 'slow-sync'
  | 'cas-mismatch'
  | 'cas-unsupported'
  | 'no-ping'
  | 'hydration-blocked'
  | 'bundle-as-sync-peer'
  | 'no-atomic-cas-sync-peer'
  | 'primary-slower-than-peer'
  | 'archive-pull-configured'

export interface ProbeRisk {
  readonly code: ProbeRiskCode
  readonly severity: 'warn' | 'error'
  readonly message: string
}

/** Per-axis latency measurement — all numbers in milliseconds. */
export interface LatencyStats {
  readonly count: number
  readonly p50: number
  readonly p99: number
  readonly max: number
}

export interface WriteAxis {
  readonly serial:     LatencyStats
  readonly concurrent: LatencyStats
  readonly coldStart:  number
}

export interface CasAxis {
  readonly concurrent: number
  readonly successes:  number
  readonly rejections: number
  readonly expected:   'exactly-one' | 'multiple-ok'
}

export interface HydrationAxis {
  readonly records: number
  readonly loadAllMs: number
  readonly perRecordBytes: number
  readonly totalBytes: number
}

export interface SyncAxis {
  readonly singlePushMs: number
  readonly batchPushMs: number
  readonly batchSize: number
  readonly bytesPerPush: number
}

export interface NetworkAxis {
  readonly pingSupported: boolean
  readonly pingMs: number | null
}

/** Suitability decision per role. */
export interface SuitabilityScore {
  /** Roles the store passes (no error-severity risks apply). */
  readonly recommended: readonly ProbeRole[]
  /** Risks that caller may choose to acknowledge. */
  readonly risks: readonly ProbeRisk[]
}

/** Full report produced by `runStoreProbe()`. */
export interface StoreProbeReport {
  readonly store: string
  readonly capabilities: StoreCapabilities | null
  readonly write: WriteAxis
  readonly cas: CasAxis
  readonly hydration: HydrationAxis
  readonly sync: SyncAxis
  readonly network: NetworkAxis
  readonly suitability: SuitabilityScore
  readonly durationMs: number
  readonly probedAt: string
}

/** Options for `runStoreProbe()`. */
export interface ProbeOptions {
  /**
   * Probe vault name. Isolated from real data — cleaned up at the
   * end of the probe. Default `'probe-vault'`. Avoid `_`-prefixed
   * values: several stores hide `_`-collections from `loadAll`,
   * which would make D3 (hydration) measure zero records.
   */
  readonly vault?: string
  /**
   * Collection used for probe writes. Default `'probe-benchmark'`.
   * Leftover envelopes may persist if the probe is interrupted —
   * adopters can safely delete anything under this name.
   */
  readonly collection?: string
  /**
   * Declared capabilities of the store (for `casAtomic` verification).
   * Stores in this codebase don't attach capabilities to the `NoydbStore`
   * object itself — pass them explicitly so the probe can compare
   * declared vs. measured behaviour.
   */
  readonly capabilities?: StoreCapabilities
  /** Number of serial writes in the D1 latency sample. Default 20. */
  readonly writeSampleSize?: number
  /** Number of parallel writers in the D2 CAS test. Default 10. */
  readonly casConcurrency?: number
  /** Records to populate before measuring loadAll. Default 100. */
  readonly hydrationRecords?: number
  /** Batch size for D4 sync economics. Default 50. */
  readonly syncBatchSize?: number
  /** p99 write-latency threshold (ms). Above this → `slow-write-p99`. Default 100. */
  readonly slowWriteMs?: number
  /** loadAll threshold (ms). Above this → `slow-hydration`. Default 500. */
  readonly slowHydrationMs?: number
  /** Single-record push threshold (ms). Above this → `slow-sync`. Default 250. */
  readonly slowSyncMs?: number
}

/** Input for `probeTopology()`. */
export interface TopologyProbeOptions extends ProbeOptions {
  readonly store: NoydbStore
  readonly sync?: ReadonlyArray<{
    readonly store: NoydbStore
    readonly role: SyncTargetRole
    readonly label?: string
    readonly hasPullPolicy?: boolean
  }>
  /** Expected number of concurrent human users. Default 1. */
  readonly expectedUsers?: number
}

export interface TopologyRisk extends ProbeRisk {
  /** Target label (or 'primary'). */
  readonly target: string
}

export interface TopologyTargetReport extends StoreProbeReport {
  readonly role: SyncTargetRole
  readonly label: string
}

export interface TopologyProbeReport {
  readonly primary: StoreProbeReport
  readonly targets: readonly TopologyTargetReport[]
  readonly topology: readonly TopologyRisk[]
  /** `true` iff there are no error-severity risks across primary + targets + topology. */
  readonly recommended: boolean
  readonly durationMs: number
  readonly probedAt: string
}
