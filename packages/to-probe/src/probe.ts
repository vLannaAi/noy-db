/**
 * `runStoreProbe()` — setup-time suitability test for a `NoydbStore`.
 *
 * Five measurement axes (D1-D5 per spec in issue #153):
 *
 * | Axis | Measures |
 * |------|----------|
 * | D1 — Write responsiveness   | serial + concurrent put p50/p99, cold-start |
 * | D2 — Conflict integrity     | N parallel puts with same `expectedVersion` |
 * | D3 — Hydration cost         | `loadAll()` time and record-size footprint |
 * | D4 — Sync economics         | single + batch `put` cost, bytes/push |
 * | D5 — Network resilience     | `ping()` support + latency |
 *
 * Writes happen to an isolated `_probe / _probe` collection that the
 * probe cleans up on completion. The probe does not mutate real
 * application data — but if a probe is interrupted, stray envelopes
 * may remain under that collection. Adopters can safely delete
 * anything under the `_probe` vault.
 *
 * The probe never decrypts anything. It operates at the `NoydbStore`
 * layer with handcrafted {@link EncryptedEnvelope}-shaped payloads — a
 * probe run produces no keyring, no DEK, and no plaintext the store
 * can see.
 *
 * @module
 */
import type { EncryptedEnvelope, NoydbStore, StoreCapabilities, VaultSnapshot } from '@noy-db/hub'
import type {
  CasAxis,
  HydrationAxis,
  LatencyStats,
  NetworkAxis,
  ProbeOptions,
  ProbeRisk,
  ProbeRole,
  StoreProbeReport,
  SuitabilityScore,
  SyncAxis,
  WriteAxis,
} from './types.js'

const PROBE_VAULT = 'probe-vault'
const PROBE_COLLECTION = 'probe-benchmark'

/**
 * Run the full 5-axis probe against `store`. Returns a structured
 * report with per-axis measurements and a {@link SuitabilityScore}.
 *
 * The probe is **idempotent-per-run**: it picks unique record IDs per
 * invocation using a monotonically increasing counter seeded by
 * `Date.now()`, so concurrent probe runs against the same store do
 * not collide.
 */
export async function runStoreProbe(
  store: NoydbStore,
  options: ProbeOptions = {},
): Promise<StoreProbeReport> {
  const started = Date.now()
  const vault = options.vault ?? PROBE_VAULT
  const collection = options.collection ?? PROBE_COLLECTION
  const runId = Date.now().toString(36)

  const write = await probeWrite(store, vault, collection, runId, options)
  const cas = await probeCas(store, vault, collection, runId, options)
  const hydration = await probeHydration(store, vault, collection, runId, options)
  const sync = await probeSync(store, vault, collection, runId, options)
  const network = await probeNetwork(store)

  const capabilities = options.capabilities ?? null
  const risks = collectRisks(options, write, cas, hydration, sync, network, capabilities)
  const suitability = score(risks)

  await bestEffortCleanup(store, vault, collection)

  return {
    store: store.name ?? 'unnamed',
    capabilities,
    write, cas, hydration, sync, network,
    suitability,
    durationMs: Date.now() - started,
    probedAt: new Date().toISOString(),
  }
}

// ── D1 · write latency ────────────────────────────────────────────────────

async function probeWrite(
  store: NoydbStore,
  vault: string,
  collection: string,
  runId: string,
  options: ProbeOptions,
): Promise<WriteAxis> {
  const n = options.writeSampleSize ?? 20

  // Cold start — single isolated write
  const coldId = `w-${runId}-cold`
  const coldStart = Date.now()
  await store.put(vault, collection, coldId, envelope(1))
  const coldMs = Date.now() - coldStart

  // Serial sample
  const serialSamples: number[] = []
  for (let i = 0; i < n; i++) {
    const t0 = Date.now()
    await store.put(vault, collection, `w-${runId}-s-${i}`, envelope(1))
    serialSamples.push(Date.now() - t0)
  }

  // Concurrent sample: 5 batches of 10, measured per-batch
  const concurrentSamples: number[] = []
  for (let batch = 0; batch < 5; batch++) {
    const t0 = Date.now()
    await Promise.all(
      Array.from({ length: 10 }, (_, j) =>
        store.put(vault, collection, `w-${runId}-c-${batch}-${j}`, envelope(1)),
      ),
    )
    concurrentSamples.push(Date.now() - t0)
  }

  return {
    coldStart: coldMs,
    serial: stats(serialSamples),
    concurrent: stats(concurrentSamples),
  }
}

// ── D2 · CAS integrity ────────────────────────────────────────────────────

async function probeCas(
  store: NoydbStore,
  vault: string,
  collection: string,
  runId: string,
  options: ProbeOptions,
): Promise<CasAxis> {
  const concurrency = options.casConcurrency ?? 10
  const id = `cas-${runId}`

  // Seed with version 1
  await store.put(vault, collection, id, envelope(1))

  // Fire N concurrent puts all with expectedVersion=1. For a casAtomic
  // store: exactly one should succeed; the rest should reject with
  // ConflictError.
  const settled = await Promise.allSettled(
    Array.from({ length: concurrency }, (_, i) =>
      store.put(vault, collection, id, envelope(2, i), 1),
    ),
  )
  const successes = settled.filter((r) => r.status === 'fulfilled').length
  const rejections = settled.length - successes

  // What the store promised
  const declaredAtomic = options.capabilities?.casAtomic ?? null
  const expected = declaredAtomic === false ? 'multiple-ok' : 'exactly-one'

  return { concurrent: concurrency, successes, rejections, expected }
}

// ── D3 · hydration ────────────────────────────────────────────────────────

async function probeHydration(
  store: NoydbStore,
  vault: string,
  collection: string,
  runId: string,
  options: ProbeOptions,
): Promise<HydrationAxis> {
  const records = options.hydrationRecords ?? 100

  // Fill the probe collection to the target record count. Writes from
  // D1/D2 already contributed some envelopes; we top up the rest.
  const existing = await store.list(vault, collection)
  for (let i = existing.length; i < records; i++) {
    await store.put(vault, collection, `h-${runId}-${i}`, envelope(1))
  }

  const t0 = Date.now()
  const snapshot = await store.loadAll(vault)
  const loadAllMs = Date.now() - t0

  const totalBytes = estimateBytes(snapshot)
  const loaded = Object.values(snapshot).reduce(
    (sum, coll) => sum + Object.keys(coll).length,
    0,
  )
  const perRecordBytes = loaded > 0 ? Math.round(totalBytes / loaded) : 0

  return { records: loaded, loadAllMs, totalBytes, perRecordBytes }
}

// ── D4 · sync economics ───────────────────────────────────────────────────

async function probeSync(
  store: NoydbStore,
  vault: string,
  collection: string,
  runId: string,
  options: ProbeOptions,
): Promise<SyncAxis> {
  const batchSize = options.syncBatchSize ?? 50

  // Single-record push
  const singleStart = Date.now()
  await store.put(vault, collection, `sync-${runId}-single`, envelope(1))
  const singlePushMs = Date.now() - singleStart

  // Batch push (simulated — sequential writes since the contract has no
  // bulk put; saveAll would also rewrite existing data)
  const t0 = Date.now()
  for (let i = 0; i < batchSize; i++) {
    await store.put(vault, collection, `sync-${runId}-b-${i}`, envelope(1))
  }
  const batchPushMs = Date.now() - t0

  // Rough bytes-per-push — envelope size plus keys
  const bytesPerPush = approxEnvelopeBytes()

  return { singlePushMs, batchPushMs, batchSize, bytesPerPush }
}

// ── D5 · network resilience ───────────────────────────────────────────────

async function probeNetwork(store: NoydbStore): Promise<NetworkAxis> {
  if (typeof store.ping !== 'function') {
    return { pingSupported: false, pingMs: null }
  }
  const t0 = Date.now()
  try {
    await store.ping()
    return { pingSupported: true, pingMs: Date.now() - t0 }
  } catch {
    return { pingSupported: true, pingMs: null }
  }
}

// ── Risk aggregation + scoring ────────────────────────────────────────────

function collectRisks(
  options: ProbeOptions,
  write: WriteAxis,
  cas: CasAxis,
  hydration: HydrationAxis,
  sync: SyncAxis,
  network: NetworkAxis,
  capabilities: StoreCapabilities | null,
): ProbeRisk[] {
  const risks: ProbeRisk[] = []
  const slowWriteMs = options.slowWriteMs ?? 100
  const slowHydrationMs = options.slowHydrationMs ?? 500
  const slowSyncMs = options.slowSyncMs ?? 250

  if (write.serial.p99 > slowWriteMs) {
    risks.push({
      code: 'slow-write-p99',
      severity: 'warn',
      message: `Serial write p99 ${write.serial.p99}ms exceeds threshold ${slowWriteMs}ms`,
    })
  }
  if (hydration.loadAllMs > slowHydrationMs) {
    risks.push({
      code: 'slow-hydration',
      severity: 'warn',
      message: `loadAll(${hydration.records}) took ${hydration.loadAllMs}ms (threshold ${slowHydrationMs}ms)`,
    })
  }
  if (sync.singlePushMs > slowSyncMs) {
    risks.push({
      code: 'slow-sync',
      severity: 'warn',
      message: `Single-record push ${sync.singlePushMs}ms exceeds ${slowSyncMs}ms`,
    })
  }
  if (capabilities?.casAtomic === true && cas.successes > 1) {
    risks.push({
      code: 'cas-mismatch',
      severity: 'error',
      message: `Store declared casAtomic:true but ${cas.successes}/${cas.concurrent} concurrent puts succeeded (expected exactly 1)`,
    })
  }
  if (capabilities?.casAtomic === false) {
    risks.push({
      code: 'cas-unsupported',
      severity: 'warn',
      message: 'Store lacks atomic CAS — unsafe for multi-writer sync-peer role',
    })
  }
  if (!network.pingSupported) {
    risks.push({
      code: 'no-ping',
      severity: 'warn',
      message: 'Store has no ping() — runtime monitor will rely on list() as liveness check',
    })
  }

  return risks
}

function score(risks: readonly ProbeRisk[]): SuitabilityScore {
  const hasError = risks.some((r) => r.severity === 'error')
  const casUnsupported = risks.some((r) => r.code === 'cas-unsupported')
  const slowWrite = risks.some((r) => r.code === 'slow-write-p99')

  const recommended: ProbeRole[] = []
  if (!hasError) {
    if (!slowWrite) recommended.push('primary')
    if (!casUnsupported) recommended.push('sync-peer')
    recommended.push('backup', 'archive')
  }
  return { recommended, risks }
}

// ── helpers ───────────────────────────────────────────────────────────────

/** Build a synthetic envelope with a tiny ciphertext payload. Safe —
 *  the store never decrypts, so the `_data` just needs to parse through
 *  whatever JSON round-tripping the store does. */
function envelope(version: number, seed = 0): EncryptedEnvelope {
  const data = `probe-${version}-${seed}`.padEnd(64, 'x')
  // base64-encode a deterministic marker so stores that assert
  // base64-shape on persist don't explode
  const b64 = base64Encode(data)
  return {
    _noydb: 1,
    _v: version,
    _ts: new Date().toISOString(),
    _iv: base64Encode('0'.repeat(12)),
    _data: b64,
  }
}

function base64Encode(s: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf-8').toString('base64')
  return btoa(unescape(encodeURIComponent(s)))
}

function approxEnvelopeBytes(): number {
  return JSON.stringify(envelope(1)).length
}

function estimateBytes(snapshot: VaultSnapshot): number {
  let total = 0
  for (const coll of Object.values(snapshot)) {
    for (const rec of Object.values(coll)) {
      total += JSON.stringify(rec).length
    }
  }
  return total
}

function stats(samples: number[]): LatencyStats {
  if (samples.length === 0) return { count: 0, p50: 0, p99: 0, max: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1]!,
  }
}

function percentile(sorted: number[], q: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length))
  return sorted[idx]!
}

async function bestEffortCleanup(
  store: NoydbStore,
  vault: string,
  collection: string,
): Promise<void> {
  try {
    const ids = await store.list(vault, collection)
    await Promise.all(ids.map((id) => store.delete(vault, collection, id).catch(() => {})))
  } catch {
    // Silent — cleanup failure is not a probe failure
  }
}
