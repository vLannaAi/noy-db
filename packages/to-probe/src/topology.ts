/**
 * `probeTopology()` — multi-backend health + suitability check.
 *
 * Runs {@link runStoreProbe} independently on the primary store and
 * every sync target, then layers topology-level rules that only make
 * sense across the whole graph:
 *
 * | Rule | Condition | Severity |
 * |------|-----------|----------|
 * | `bundle-as-sync-peer`        | Bundle-shaped store used as `sync-peer`                    | warn  |
 * | `no-atomic-cas-sync-peer`    | Non-atomic-CAS store used as `sync-peer` with >1 user      | error |
 * | `primary-slower-than-peer`   | Primary p99 > sync-peer p99 × 2                            | warn  |
 * | `archive-pull-configured`    | `archive` target declared with a pull policy               | error |
 *
 * Only one probe pass per store — if two targets happen to point at
 * the same backend, both get probed (the target identifies the
 * configuration, not the backend instance).
 *
 * @module
 */
import type { NoydbStore } from '@noy-db/hub'
import { runStoreProbe } from './probe.js'
import type {
  StoreProbeReport,
  TopologyProbeOptions,
  TopologyProbeReport,
  TopologyRisk,
  TopologyTargetReport,
} from './types.js'

export async function probeTopology(
  options: TopologyProbeOptions,
): Promise<TopologyProbeReport> {
  const started = Date.now()
  const expectedUsers = options.expectedUsers ?? 1

  const primary = await runStoreProbe(options.store, options)
  const targets: TopologyTargetReport[] = []

  for (const t of options.sync ?? []) {
    const label = t.label ?? t.store.name ?? t.role
    const report = await runStoreProbe(t.store, { ...options, vault: `_probe-${label}` })
    targets.push({ ...report, role: t.role, label })
  }

  const topology = evaluateTopology(options.store, primary, targets, options.sync, expectedUsers)
  const allErrors = [
    ...primary.suitability.risks,
    ...targets.flatMap((t) => t.suitability.risks),
    ...topology,
  ].filter((r) => r.severity === 'error')

  return {
    primary, targets, topology,
    recommended: allErrors.length === 0,
    durationMs: Date.now() - started,
    probedAt: new Date().toISOString(),
  }
}

function evaluateTopology(
  _primaryStore: NoydbStore,
  primary: StoreProbeReport,
  targets: readonly TopologyTargetReport[],
  syncTargets: TopologyProbeOptions['sync'] = [],
  expectedUsers: number,
): TopologyRisk[] {
  const risks: TopologyRisk[] = []

  targets.forEach((target, i) => {
    const input = syncTargets[i]
    const label = target.label

    // Bundle-shaped stores (drive/webdav/git) don't have atomic CAS
    // and surface as sync-peer-unsuitable. For we detect by
    // name heuristics; future hub work can annotate StoreCapabilities
    // with a `shape: 'kv' | 'bundle'` field.
    if (target.role === 'sync-peer' && looksLikeBundleStore(target.store)) {
      risks.push({
        target: label,
        code: 'bundle-as-sync-peer',
        severity: 'warn',
        message: `"${label}" looks bundle-shaped — use role 'backup' or 'archive' for push-only semantics`,
      })
    }

    if (
      target.role === 'sync-peer' &&
      expectedUsers > 1 &&
      target.capabilities?.casAtomic === false
    ) {
      risks.push({
        target: label,
        code: 'no-atomic-cas-sync-peer',
        severity: 'error',
        message: `"${label}" has casAtomic:false — unsafe as sync-peer for ${expectedUsers} concurrent users`,
      })
    }

    if (target.role === 'sync-peer' && primary.write.serial.p99 > target.write.serial.p99 * 2) {
      risks.push({
        target: label,
        code: 'primary-slower-than-peer',
        severity: 'warn',
        message: `Primary p99 ${primary.write.serial.p99}ms is >2× peer "${label}" p99 ${target.write.serial.p99}ms — unusual topology`,
      })
    }

    if (target.role === 'archive' && input?.hasPullPolicy === true) {
      risks.push({
        target: label,
        code: 'archive-pull-configured',
        severity: 'error',
        message: `"${label}" is an archive target but has a pull policy — archives are push-only`,
      })
    }
  })

  return risks
}

/** Heuristic bundle detection: name includes 'drive' / 'webdav' / 'git'
 *  / 'bundle'. Adopters who wrap a bundle store under a custom name
 *  can silence this via `acknowledgeRisks: ['bundle-as-sync-peer']`. */
function looksLikeBundleStore(name: string): boolean {
  const n = name.toLowerCase()
  return /drive|webdav|git|bundle/.test(n)
}
