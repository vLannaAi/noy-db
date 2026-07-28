/**
 * **@noy-db/to-meter** — pass-through meter for `@noy-db/to-*` stores.
 *
 * Wraps any `NoydbStore` and returns a new store that behaves
 * identically but records per-method timing, error rates, byte
 * counts, and (optionally) periodic liveness status. The meter is
 * itself a `NoydbStore`, so it slots anywhere a store fits:
 *
 * ```ts
 * import { toMeter } from '@noy-db/to-meter'
 * import { awsDynamoStore } from '@noy-db/to-aws-dynamo'
 *
 * const dynamo = awsDynamoStore({ table: 'live' })
 * const { store, meter } = toMeter(dynamo, {
 *   liveness:    { interval: 60_000 },    // optional synthetic pings
 *   degradedMs:  200,                     // p99 threshold for `degraded` event
 *   onDegraded:  (e) => console.warn(e),
 * })
 *
 * const db = await createNoydb({ store })
 *
 * // at any time
 * console.log(meter.snapshot())
 * // {
 * //   byMethod: {
 * //     get:  { count: 142, p50: 3, p99: 28, errors: 0 },
 * //     put:  { count:  43, p50: 11, p99: 92, errors: 1 },
 * //     ...
 * //   },
 * //   status: 'ok' | 'degraded' | 'unreachable',
 * //   casConflicts: 2,
 * //   totalCalls: 230,
 * //   windowMs: 45_280,
 * // }
 * ```
 *
 * ## Relation to `withMetrics`
 *
 * This package **uses** hub's `withMetrics` middleware internally —
 * don't think of it as a replacement. `withMetrics` is the raw event
 * stream (one callback per op); `toMeter` is the aggregator that
 * bucketises events into percentiles + a health verdict.
 *
 * ## Two modes, one package (#845)
 *
 * - `runStoreProbe()` / `probeTopology()` run **synthetic** benchmarks on an
 *   empty store — they answer "should I adopt this store?". Absorbed here from
 *   the retired `@noy-db/to-probe`, which exported no store and so never fitted
 *   the `to<Backend>()` store-factory contract.
 * - `toMeter()` observes **real traffic** through the live store — it answers
 *   "how is this store performing right now?".
 *
 * Composable: probe first to choose, then `toMeter(chosen)` to keep watching.
 *
 * @packageDocumentation
 */
import type { NoydbStore } from '@noy-db/hub'
import { ConflictError, wrapStore, withMetrics, memoryStore } from '@noy-db/hub'

// ── Types ───────────────────────────────────────────────────────────────

export type MethodName =
  | 'get' | 'put' | 'delete' | 'list' | 'loadAll' | 'saveAll'
  // #845 — the optional surface is where the time usually goes (`listPage`
  // paginates, `tx` batches), so it is metered too. Absent on a given inner
  // store simply means the counter stays at zero.
  | 'listPage' | 'getStoreTime' | 'tx'
  // #889 — `listVaults` is a full enumeration on a remote store, and `ping`
  // isolates round-trip time from work, so both are worth timing.
  | 'listVaults' | 'ping'

export type MeterStatus = 'ok' | 'degraded' | 'unreachable'

/** Latency + counts for a single store method. */
export interface MethodStats {
  readonly count: number
  readonly errors: number
  readonly p50: number
  readonly p90: number
  readonly p99: number
  readonly max: number
  readonly avg: number
}

/** Full snapshot of meter state at one moment. */
export interface MeterSnapshot {
  readonly byMethod: Record<MethodName, MethodStats>
  readonly status: MeterStatus
  readonly casConflicts: number
  readonly totalCalls: number
  readonly windowMs: number
  readonly collectedAt: string
}

/** Degraded/restored event. */
export interface MeterEvent {
  readonly type: 'degraded' | 'restored'
  readonly status: MeterStatus
  readonly method?: MethodName
  readonly p99?: number
  readonly reason: string
  readonly at: string
}

export interface LivenessOptions {
  /** Milliseconds between synthetic health checks. */
  readonly interval: number
  /** Vault to use for the liveness `put`/`delete` pair. Default `'probe-vault'`. */
  readonly vault?: string
  /** Collection to use. Default `'probe-liveness'`. Do NOT use a `_`-prefixed name. */
  readonly collection?: string
}

export interface MeterOptions {
  /**
   * Upper bound on retained latency samples per method. When the
   * sample array grows past this, oldest entries are dropped. Default
   * 1024 — keeps p50/p99 reasonably accurate with bounded memory.
   */
  readonly sampleLimit?: number
  /**
   * Optional periodic liveness ping. Uses the store's `ping()` if
   * available, otherwise falls back to a `put`/`delete` pair on a
   * dedicated collection.
   */
  readonly liveness?: LivenessOptions
  /**
   * p99 latency threshold (ms) for `put` — if crossed, emit a
   * `degraded` event. Default 500.
   */
  readonly degradedMs?: number
  /** Called when the meter transitions to `degraded`. */
  readonly onDegraded?: (event: MeterEvent) => void
  /** Called when the meter transitions back to `ok`. */
  readonly onRestored?: (event: MeterEvent) => void
}

/** Handle returned alongside the wrapped store. */
export interface MeterHandle {
  /** Current snapshot. Safe to call frequently — O(k log k) on sample sizes. */
  snapshot(): MeterSnapshot
  /** Reset all counters and drop samples. Handy for per-request metering. */
  reset(): void
  /** Subscribe to degraded/restored transitions. Returns an unsubscribe fn. */
  subscribe(listener: (event: MeterEvent) => void): () => void
  /** Stop the liveness timer (if any) and release resources. */
  close(): void
}

/**
 * What {@link toMeter} returns: a fully-conformant {@link NoydbStore} that also
 * carries its own {@link MeterHandle}.
 *
 * Shaped after `RoutedNoydbStore` (hub's `routeStore`), which is likewise a
 * store plus a control surface. Being a store rather than a `{ store, meter }`
 * tuple is what lets a meter sit anywhere a store can — including nested inside
 * `routeStore`, so each backend in a compound topology can be metered
 * independently:
 *
 * ```ts
 * const pg = toMeter(toPostgres({ … }))
 * const s3 = toMeter(toAwsS3({ … }))
 * const db = await createNoydb({ store: routeStore({ default: pg, blobs: s3 }) })
 * pg.meter.snapshot()   // per-backend timings, no extra plumbing
 * ```
 */
export interface MeteredNoydbStore extends NoydbStore {
  readonly meter: MeterHandle
}

// ── Implementation ──────────────────────────────────────────────────────

const METHODS: readonly MethodName[] = [
  'get', 'put', 'delete', 'list', 'loadAll', 'saveAll',
  'listPage', 'getStoreTime', 'tx', 'listVaults', 'ping',
]

/**
 * Wrap a store so every call is timed + counted. Returns the wrapped
 * store and a handle for inspecting the aggregate.
 *
 * The wrapped store is a drop-in replacement for the inner store —
 * same 6 methods, same types, same behaviour on success and error. The
 * meter adds zero semantic changes: errors still throw, conflicts
 * still surface as {@link ConflictError}.
 */
export function toMeter(inner?: NoydbStore, options: MeterOptions = {}): MeteredNoydbStore {
  // Omitting `inner` yields a self-contained metered in-memory store — the
  // test/debug case in one call, still composable for the real one.
  const target: NoydbStore = inner ?? memoryStore()
  const sampleLimit = options.sampleLimit ?? 1024
  const degradedMs = options.degradedMs ?? 500

  const samples: Record<MethodName, number[]> = {
    get: [], put: [], delete: [], list: [], loadAll: [], saveAll: [],
    listPage: [], getStoreTime: [], tx: [], listVaults: [], ping: [],
  }
  const counts: Record<MethodName, number> = {
    get: 0, put: 0, delete: 0, list: 0, loadAll: 0, saveAll: 0,
    listPage: 0, getStoreTime: 0, tx: 0, listVaults: 0, ping: 0,
  }
  const errors: Record<MethodName, number> = {
    get: 0, put: 0, delete: 0, list: 0, loadAll: 0, saveAll: 0,
    listPage: 0, getStoreTime: 0, tx: 0, listVaults: 0, ping: 0,
  }
  let casConflicts = 0
  let windowStart = Date.now()
  let currentStatus: MeterStatus = 'ok'
  const listeners = new Set<(e: MeterEvent) => void>()

  function recordOp(method: MethodName, durationMs: number, success: boolean, error?: Error): void {
    counts[method]++
    if (!success) {
      errors[method]++
      if (error instanceof ConflictError) casConflicts++
    }
    const arr = samples[method]
    arr.push(durationMs)
    if (arr.length > sampleLimit) {
      arr.splice(0, arr.length - sampleLimit)
    }
    // Status transition check — only for put-method degraded thresholds
    if (method === 'put' && counts.put >= 10) {
      const put = computeMethodStats(samples.put, counts.put, errors.put)
      const breached = put.p99 > degradedMs
      if (breached && currentStatus === 'ok') transition('degraded', method, put.p99, `put p99 ${put.p99}ms > ${degradedMs}ms`)
      else if (!breached && currentStatus === 'degraded') transition('ok', method, put.p99, `put p99 recovered to ${put.p99}ms`)
    }
  }

  function transition(next: MeterStatus, method?: MethodName, p99?: number, reason = ''): void {
    if (next === currentStatus) return
    const prior = currentStatus
    currentStatus = next
    const event: MeterEvent = {
      type: next === 'ok' ? 'restored' : 'degraded',
      status: next,
      ...(method !== undefined ? { method } : {}),
      ...(p99 !== undefined ? { p99 } : {}),
      reason, at: new Date().toISOString(),
    }
    for (const l of listeners) {
      try { l(event) } catch { /* isolate listener errors */ }
    }
    if (next === 'degraded' && prior !== 'degraded') options.onDegraded?.(event)
    if (next === 'ok' && prior !== 'ok') options.onRestored?.(event)
  }

  // Build the wrapped store via hub's withMetrics middleware (one event
  // per op, already includes success/error + duration).
  const metrics = wrapStore(
    target,
    withMetrics({
      onOperation(op) {
        recordOp(op.method, op.durationMs, op.success, op.error)
      },
    }),
  )

  // Optional synthetic liveness timer
  const livenessTimer = options.liveness
    ? startLiveness(target, options.liveness, transition)
    : null

  const handle: MeterHandle = {
    snapshot(): MeterSnapshot {
      const byMethod = {} as Record<MethodName, MethodStats>
      let total = 0
      for (const m of METHODS) {
        byMethod[m] = computeMethodStats(samples[m], counts[m], errors[m])
        total += counts[m]
      }
      return {
        byMethod,
        status: currentStatus,
        casConflicts,
        totalCalls: total,
        windowMs: Date.now() - windowStart,
        collectedAt: new Date().toISOString(),
      }
    },
    reset(): void {
      for (const m of METHODS) {
        samples[m].length = 0
        counts[m] = 0
        errors[m] = 0
      }
      casConflicts = 0
      windowStart = Date.now()
    },
    subscribe(listener): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    close(): void {
      if (livenessTimer) clearInterval(livenessTimer)
      listeners.clear()
    },
  }

  // Preserve the store name so routing/logging continues to identify
  // the underlying backend.
  return {
    ...metrics,
    ...meteredOptional(target, recordOp),
    // Preserve the inner name so routing/logging still identifies the backend.
    name: target.name ? `meter(${target.name})` : 'meter',
    meter: handle,
  }
}

// ── Internals ───────────────────────────────────────────────────────────

/**
 * Time the OPTIONAL store methods. `withMetrics` covers only the 6-method core,
 * so `listPage` / `getStoreTime` / `tx` previously passed through the wrap
 * unmeasured — invisible to a tool whose whole job is finding where time goes.
 *
 * Each is wrapped only when the inner store actually implements it, so an inner
 * store without `tx()` stays without `tx()` and its capability surface is
 * unchanged (a store must never gain a method by being metered).
 */
function meteredOptional(
  target: NoydbStore,
  record: (m: MethodName, ms: number, ok: boolean, err?: Error) => void,
): Partial<NoydbStore> {
  const time = async <T>(m: MethodName, fn: () => Promise<T>): Promise<T> => {
    const start = Date.now()
    try {
      const out = await fn()
      record(m, Date.now() - start, true)
      return out
    } catch (err) {
      record(m, Date.now() - start, false, err as Error)
      throw err
    }
  }
  const out: Record<string, unknown> = {}
  if (typeof target.listPage === 'function') {
    out.listPage = (v: string, c: string, cur?: string, lim?: number) =>
      time('listPage', () => target.listPage!(v, c, cur, lim))
  }
  if (typeof target.getStoreTime === 'function') {
    out.getStoreTime = () => time('getStoreTime', () => target.getStoreTime!())
  }
  if (typeof target.tx === 'function') {
    out.tx = (ops: Parameters<NonNullable<NoydbStore['tx']>>[0]) =>
      time('tx', () => target.tx!(ops))
  }
  if (typeof target.listVaults === 'function') {
    out.listVaults = () => time('listVaults', () => target.listVaults!())
  }
  if (typeof target.ping === 'function') {
    // NOTE: the synthetic `liveness` poller calls the INNER store directly
    // (see startLiveness), so these counters stay "what the app did" rather
    // than being inflated by our own health checks.
    out.ping = () => time('ping', () => target.ping!())
  }
  return out as Partial<NoydbStore>
}

function computeMethodStats(sorted: number[], count: number, errorCount: number): MethodStats {
  if (count === 0) {
    return { count: 0, errors: 0, p50: 0, p90: 0, p99: 0, max: 0, avg: 0 }
  }
  // Sort a copy so reads don't disturb the FIFO buffer
  const s = [...sorted].sort((a, b) => a - b)
  const pct = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))]!
  const sum = s.reduce((a, b) => a + b, 0)
  return {
    count,
    errors: errorCount,
    p50: pct(0.5),
    p90: pct(0.9),
    p99: pct(0.99),
    max: s[s.length - 1]!,
    avg: Math.round(sum / s.length),
  }
}

function startLiveness(
  inner: NoydbStore,
  opts: LivenessOptions,
  transition: (status: MeterStatus, method?: MethodName, p99?: number, reason?: string) => void,
): ReturnType<typeof setInterval> {
  const vault = opts.vault ?? 'probe-vault'
  const collection = opts.collection ?? 'probe-liveness'
  const pingId = 'liveness'

  const timer = setInterval(() => {
    void tick()
  }, opts.interval)

  async function tick(): Promise<void> {
    try {
      if (typeof inner.ping === 'function') {
        const ok = await inner.ping()
        if (!ok) return transition('unreachable', undefined, undefined, 'ping returned false')
      } else {
        // Fallback: put + delete — exercises the write path
        await inner.put(vault, collection, pingId, {
          _noydb: 1, _v: 1,
          _ts: new Date().toISOString(),
          _iv: 'AAAAAAAAAAAAAAAA',
          _data: 'cHJvYmU=',
        })
        await inner.delete(vault, collection, pingId)
      }
      // On a successful check, transition back to ok if we were unreachable
      transition('ok', undefined, undefined, 'liveness check succeeded')
    } catch (err) {
      transition('unreachable', undefined, undefined, `liveness error: ${(err as Error).message}`)
    }
  }

  return timer
}

// ── Store diagnostics (absorbed from @noy-db/to-probe, #845) ────────────
//
// `to-probe` exported no store — it was a diagnostic suite, so it never fit
// the `to<Backend>()` store-factory contract. Both packages answer the same
// question ("how is this store actually behaving?"), one live and one as a
// one-shot report, so they now ship together. `@noy-db/to-probe` is retired.

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
} from './probe-types.js'
