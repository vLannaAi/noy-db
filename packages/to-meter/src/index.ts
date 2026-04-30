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
 * ## Relation to `to-probe`
 *
 * - `to-probe` runs **synthetic** benchmarks on an empty store —
 *   answers "should I adopt this store?".
 * - `to-meter` observes **real traffic** through the live store —
 *   answers "how is this store performing right now?".
 *
 * Composable: `toMeter(probe-recommended-store)` after a probe pass
 * validates adoption.
 *
 * @packageDocumentation
 */
import type { NoydbStore } from '@noy-db/hub'
import { ConflictError, wrapStore, withMetrics } from '@noy-db/hub'

// ── Types ───────────────────────────────────────────────────────────────

export type MethodName = 'get' | 'put' | 'delete' | 'list' | 'loadAll' | 'saveAll'

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

export interface ToMeterResult {
  readonly store: NoydbStore
  readonly meter: MeterHandle
}

// ── Implementation ──────────────────────────────────────────────────────

const METHODS: readonly MethodName[] = ['get', 'put', 'delete', 'list', 'loadAll', 'saveAll']

/**
 * Wrap a store so every call is timed + counted. Returns the wrapped
 * store and a handle for inspecting the aggregate.
 *
 * The wrapped store is a drop-in replacement for the inner store —
 * same 6 methods, same types, same behaviour on success and error. The
 * meter adds zero semantic changes: errors still throw, conflicts
 * still surface as {@link ConflictError}.
 */
export function toMeter(inner: NoydbStore, options: MeterOptions = {}): ToMeterResult {
  const sampleLimit = options.sampleLimit ?? 1024
  const degradedMs = options.degradedMs ?? 500

  const samples: Record<MethodName, number[]> = {
    get: [], put: [], delete: [], list: [], loadAll: [], saveAll: [],
  }
  const counts: Record<MethodName, number> = {
    get: 0, put: 0, delete: 0, list: 0, loadAll: 0, saveAll: 0,
  }
  const errors: Record<MethodName, number> = {
    get: 0, put: 0, delete: 0, list: 0, loadAll: 0, saveAll: 0,
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
    inner,
    withMetrics({
      onOperation(op) {
        recordOp(op.method, op.durationMs, op.success, op.error)
      },
    }),
  )

  // Optional synthetic liveness timer
  const livenessTimer = options.liveness
    ? startLiveness(inner, options.liveness, transition)
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
  const renamed: NoydbStore = {
    ...metrics,
    name: inner.name ? `meter(${inner.name})` : 'meter',
  }

  return { store: renamed, meter: handle }
}

// ── Internals ───────────────────────────────────────────────────────────

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
