/**
 * Showcase 56 — Storage: probe (5-axis suitability check)
 *
 * What you'll learn
 * ─────────────────
 * `@noy-db/to-probe` runs a 5-axis benchmark against any `NoydbStore`
 * and returns a structured `StoreProbeReport`: write latency, CAS
 * integrity, hydration cost, sync economics, and network reachability.
 * It then computes a `SuitabilityScore` listing the roles the store
 * passes (`primary | sync-peer | backup | archive`) plus a flat
 * `risks[]` list with machine-readable codes.
 *
 * Why it matters
 * ──────────────
 * Adopters mix and match storage backends — primary on DynamoDB, sync
 * peer on a USB stick, backup on R2 — and want a one-line answer to
 * "is this store fit for this role?" `runStoreProbe()` is that one
 * line. The risk codes (`slow-write-p99`, `cas-mismatch`, …) become
 * the strings adopters pass to `acknowledgeRisks` when they want to
 * proceed despite a known issue.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 01 (`to-memory` baseline).
 *
 * What to read next
 * ─────────────────
 *   - showcase 55-storage-meter (live observability companion)
 *   - docs/packages/stores.md → "to-probe" entry for the full risk-code list
 *
 * Spec mapping
 * ────────────
 * features.yaml → adapters → to-probe
 */

import { describe, expect, it } from 'vitest'
import { memory } from '@noy-db/to-memory'
import { runStoreProbe } from '@noy-db/to-probe'

describe('Showcase 56 — Storage: probe (5-axis suitability check)', () => {
  it('produces a structured report with all five axes filled in', async () => {
    const report = await runStoreProbe(memory(), {
      capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'implicit' } },
      // Smaller sample sizes keep the showcase fast — adopters use defaults.
      writeSampleSize: 5,
      hydrationRecords: 20,
      syncBatchSize: 10,
    })

    expect(report.store).toBe('memory')
    expect(report.write.serial.p50).toBeTypeOf('number')
    expect(report.cas.successes + report.cas.rejections).toBeGreaterThan(0)
    // Hydration count is at least the configured population — earlier probe
    // axes (write, CAS) leave their own records in the same probe collection.
    expect(report.hydration.records).toBeGreaterThanOrEqual(20)
    expect(report.sync.batchPushMs).toBeTypeOf('number')
    expect(report.network.pingSupported).toBeTypeOf('boolean')
  })

  it('memory store passes every role (no risks of error severity)', async () => {
    const report = await runStoreProbe(memory(), {
      capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'implicit' } },
      writeSampleSize: 5,
      hydrationRecords: 20,
      syncBatchSize: 10,
    })

    // Memory is the canonical "everything works" baseline — every role
    // is recommended. Real backends typically lose `archive` (no `ping`)
    // or `sync-peer` (no `casAtomic`) depending on their shape.
    expect(report.suitability.recommended).toContain('primary')
    expect(report.suitability.risks.every((r) => r.severity !== 'error')).toBe(true)
  })

  it('flags `cas-unsupported` when the store declares no atomic CAS', async () => {
    // A store with `casAtomic: false` is informative on its own — the probe
    // surfaces the limitation as a `cas-unsupported` risk so a caller
    // routing it as a sync-peer can decide whether to acknowledge or
    // pick a different backend.
    const report = await runStoreProbe(memory(), {
      capabilities: { casAtomic: false, auth: { kind: 'none', required: false, flow: 'implicit' } },
      writeSampleSize: 5,
      hydrationRecords: 20,
      syncBatchSize: 10,
    })

    const codes = report.suitability.risks.map((r) => r.code)
    expect(codes).toContain('cas-unsupported')
  })
})
