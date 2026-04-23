/**
 * Store middleware — composable interceptors for NoydbStore (v0.12 #164 E4).
 *
 * ```ts
 * const resilient = wrapStore(
 *   dynamo({ table: 'myapp' }),
 *   withRetry({ maxRetries: 3 }),
 *   withLogging({ level: 'debug' }),
 *   withCache({ ttlMs: 60_000 }),
 * )
 * ```
 *
 * Each middleware is `(next: NoydbStore) => NoydbStore`. They compose
 * left-to-right: first middleware is outermost (processes requests first,
 * responses last).
 *
 * @module
 */

import type { NoydbStore, EncryptedEnvelope } from '../types.js'

// ─── Core composition ───────────────────────────────────────────────────

/**
 * A store middleware function.
 *
 * Takes the next store in the chain and returns a wrapped store. Middlewares
 * compose left-to-right via `wrapStore()`: the first argument is outermost
 * (first to intercept requests, last to process responses).
 *
 * ```ts
 * const mw: StoreMiddleware = (next) => ({
 *   ...next,
 *   async get(vault, collection, id) {
 *     console.log('get', id)
 *     return next.get(vault, collection, id)
 *   },
 * })
 * ```
 */
export type StoreMiddleware = (next: NoydbStore) => NoydbStore

/**
 * Wrap a store with one or more middlewares. Middlewares compose left-to-right.
 */
export function wrapStore(store: NoydbStore, ...middlewares: StoreMiddleware[]): NoydbStore {
  let result = store
  // Apply right-to-left so the first middleware is the outermost wrapper
  for (let i = middlewares.length - 1; i >= 0; i--) {
    result = middlewares[i]!(result)
  }
  return result
}

// ─── withRetry ──────────────────────────────────────────────────────────

/** Options for `withRetry()`. */
export interface RetryOptions {
  /** Maximum retry attempts. Default: 3. */
  maxRetries?: number
  /** Base backoff delay in ms. Default: 500. */
  backoffMs?: number
  /** Jitter factor (0-1). Adds random delay up to `backoffMs * jitter`. Default: 0.3. */
  jitter?: number
  /** Only retry on these error codes. Default: retry all errors. */
  retryOn?: string[]
}

/**
 * Middleware that retries failed store operations with exponential backoff
 * and optional jitter. Useful for transient network errors on DynamoDB/S3.
 *
 * ```ts
 * wrapStore(dynamo({ table: 'myapp' }), withRetry({ maxRetries: 5, retryOn: ['NETWORK_ERROR'] }))
 * ```
 */
export function withRetry(opts: RetryOptions = {}): StoreMiddleware {
  const maxRetries = opts.maxRetries ?? 3
  const backoffMs = opts.backoffMs ?? 500
  const jitter = opts.jitter ?? 0.3
  const retryOn = opts.retryOn ? new Set(opts.retryOn) : null

  function shouldRetry(err: unknown): boolean {
    if (!retryOn) return true
    if (err && typeof err === 'object' && 'code' in err) {
      return retryOn.has((err as { code: string }).code)
    }
    return true
  }

  async function retryable<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn()
      } catch (err) {
        lastError = err
        if (attempt >= maxRetries || !shouldRetry(err)) throw err
        const delay = backoffMs * Math.pow(2, attempt) * (1 + Math.random() * jitter)
        await new Promise(r => setTimeout(r, delay))
      }
    }
    throw lastError
  }

  return (next) => ({
    ...next,
    name: next.name ? `retry(${next.name})` : 'retry',
    get: (v, c, id) => retryable(() => next.get(v, c, id)),
    put: (v, c, id, env, ev) => retryable(() => next.put(v, c, id, env, ev)),
    delete: (v, c, id) => retryable(() => next.delete(v, c, id)),
    list: (v, c) => retryable(() => next.list(v, c)),
    loadAll: (v) => retryable(() => next.loadAll(v)),
    saveAll: (v, d) => retryable(() => next.saveAll(v, d)),
  })
}

// ─── withLogging ────────────────────────────────────────────────────────

/** Log level for `withLogging()`. Maps to standard console method names. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Options for `withLogging()`. */
export interface LoggingOptions {
  /** Minimum log level. Default: 'info'. */
  level?: LogLevel
  /** Custom logger. Default: console. */
  logger?: {
    debug(msg: string, ...args: unknown[]): void
    info(msg: string, ...args: unknown[]): void
    warn(msg: string, ...args: unknown[]): void
    error(msg: string, ...args: unknown[]): void
  }
  /** Log the data payload (envelope contents). Default: false (privacy). */
  logData?: boolean
}

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/**
 * Middleware that logs every store operation with its method name, arguments,
 * and elapsed duration. Privacy-safe by default: envelope payloads are not
 * logged unless `logData: true` is set.
 */
export function withLogging(opts: LoggingOptions = {}): StoreMiddleware {
  const minLevel = LOG_LEVELS[opts.level ?? 'info']
  const logger = opts.logger ?? console
  const logData = opts.logData ?? false

  function log(level: LogLevel, method: string, args: Record<string, unknown>, durationMs?: number) {
    if (LOG_LEVELS[level] < minLevel) return
    const parts = [`[noydb:${method}]`, ...Object.entries(args).map(([k, v]) => `${k}=${String(v)}`)]
    if (durationMs !== undefined) parts.push(`${durationMs}ms`)
    logger[level](parts.join(' '))
  }

  function timed<T>(method: string, args: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const start = Date.now()
    return fn().then(
      (result) => {
        log('debug', method, args, Date.now() - start)
        return result
      },
      (err) => {
        log('error', method, { ...args, error: (err as Error).message }, Date.now() - start)
        throw err
      },
    )
  }

  return (next) => ({
    ...next,
    name: next.name ? `log(${next.name})` : 'log',
    get: (v, c, id) => timed('get', { vault: v, collection: c, id }, () => next.get(v, c, id)),
    put: (v, c, id, env, ev) => timed('put', {
      vault: v, collection: c, id, version: env._v,
      ...(logData ? { data: env._data.slice(0, 40) + '...' } : {}),
    }, () => next.put(v, c, id, env, ev)),
    delete: (v, c, id) => timed('delete', { vault: v, collection: c, id }, () => next.delete(v, c, id)),
    list: (v, c) => timed('list', { vault: v, collection: c }, () => next.list(v, c)),
    loadAll: (v) => timed('loadAll', { vault: v }, () => next.loadAll(v)),
    saveAll: (v, d) => timed('saveAll', { vault: v }, () => next.saveAll(v, d)),
  })
}

// ─── withMetrics ────────────────────────────────────────────────────────

/**
 * Data emitted to `MetricsOptions.onOperation` after every store call.
 *
 * Carries method name, vault/collection/id context, elapsed duration,
 * and success/failure status. Wire this into your metrics pipeline
 * (DataDog, Prometheus, CloudWatch) to get per-operation latency histograms.
 */
export interface StoreOperation {
  method: 'get' | 'put' | 'delete' | 'list' | 'loadAll' | 'saveAll'
  vault: string
  collection?: string
  id?: string
  durationMs: number
  success: boolean
  error?: Error
}

/** Options for `withMetrics()`. */
export interface MetricsOptions {
  /** Called after every store operation. */
  onOperation: (op: StoreOperation) => void
}

/**
 * Middleware that calls `onOperation` after every store method with timing
 * and success/failure data. Designed for low-overhead integration with
 * metrics systems — the callback is synchronous and fire-and-forget.
 */
export function withMetrics(opts: MetricsOptions): StoreMiddleware {
  function tracked<T>(
    method: StoreOperation['method'],
    vault: string,
    fn: () => Promise<T>,
    collection?: string,
    id?: string,
  ): Promise<T> {
    const start = Date.now()
    return fn().then(
      (result) => {
        opts.onOperation({
          method, vault,
          ...(collection !== undefined ? { collection } : {}),
          ...(id !== undefined ? { id } : {}),
          durationMs: Date.now() - start, success: true,
        })
        return result
      },
      (err) => {
        opts.onOperation({
          method, vault,
          ...(collection !== undefined ? { collection } : {}),
          ...(id !== undefined ? { id } : {}),
          durationMs: Date.now() - start, success: false, error: err as Error,
        })
        throw err
      },
    )
  }

  return (next) => ({
    ...next,
    name: next.name ? `metrics(${next.name})` : 'metrics',
    get: (v, c, id) => tracked('get', v, () => next.get(v, c, id), c, id),
    put: (v, c, id, env, ev) => tracked('put', v, () => next.put(v, c, id, env, ev), c, id),
    delete: (v, c, id) => tracked('delete', v, () => next.delete(v, c, id), c, id),
    list: (v, c) => tracked('list', v, () => next.list(v, c), c),
    loadAll: (v) => tracked('loadAll', v, () => next.loadAll(v)),
    saveAll: (v, d) => tracked('saveAll', v, () => next.saveAll(v, d)),
  })
}

// ─── withCircuitBreaker ─────────────────────────────────────────────────

/**
 * Options for `withCircuitBreaker()`.
 *
 * The circuit breaker moves through three states:
 * - `closed`: normal operation.
 * - `open`: store is failing; all calls return fallback values immediately.
 * - `half-open`: one probe call after `resetTimeoutMs` — success closes, failure re-opens.
 */
export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit. Default: 5. */
  failureThreshold?: number
  /** Time in ms before attempting to half-open the circuit. Default: 30_000. */
  resetTimeoutMs?: number
  /** Called when the circuit opens (store becomes unavailable). */
  onOpen?: () => void
  /** Called when the circuit closes (store recovers). */
  onClose?: () => void
}

type CircuitState = 'closed' | 'open' | 'half-open'

/**
 * Middleware that implements the circuit-breaker pattern.
 *
 * When the wrapped store fails `failureThreshold` consecutive times, the
 * circuit opens: subsequent calls return safe fallback values (`null`, `[]`,
 * `{}`) without hitting the store. After `resetTimeoutMs` the circuit
 * half-opens and allows one probe — success closes the circuit, failure
 * keeps it open. Pair with `withRetry` to handle transient errors before
 * they trip the circuit.
 */
export function withCircuitBreaker(opts: CircuitBreakerOptions = {}): StoreMiddleware {
  const threshold = opts.failureThreshold ?? 5
  const resetMs = opts.resetTimeoutMs ?? 30_000

  let state: CircuitState = 'closed'
  let failures = 0
  let lastFailureTime = 0

  function recordSuccess(): void {
    if (state === 'half-open') {
      state = 'closed'
      failures = 0
      opts.onClose?.()
    }
    failures = 0
  }

  function recordFailure(): void {
    failures++
    lastFailureTime = Date.now()
    if (failures >= threshold && state === 'closed') {
      state = 'open'
      opts.onOpen?.()
    }
  }

  function canAttempt(): boolean {
    if (state === 'closed') return true
    if (state === 'open') {
      if (Date.now() - lastFailureTime >= resetMs) {
        state = 'half-open'
        return true
      }
      return false
    }
    // half-open: allow one attempt
    return true
  }

  async function guarded<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    if (!canAttempt()) return fallback
    try {
      const result = await fn()
      recordSuccess()
      return result
    } catch (err) {
      recordFailure()
      throw err
    }
  }

  return (next) => ({
    ...next,
    name: next.name ? `cb(${next.name})` : 'cb',
    get: (v, c, id) => guarded(() => next.get(v, c, id), null),
    put: (v, c, id, env, ev) => guarded(() => next.put(v, c, id, env, ev), undefined),
    delete: (v, c, id) => guarded(() => next.delete(v, c, id), undefined),
    list: (v, c) => guarded(() => next.list(v, c), []),
    loadAll: (v) => guarded(() => next.loadAll(v), {}),
    saveAll: (v, d) => guarded(() => next.saveAll(v, d), undefined),
  })
}

// ─── withCache (read-through) ───────────────────────────────────────────

/**
 * Options for `withCache()`.
 *
 * The cache is a read-through LRU that caches individual record fetches
 * (`get`). Writes (`put`, `delete`) invalidate the relevant cache entry
 * immediately. `list`, `loadAll`, and `saveAll` bypass the cache.
 *
 * Named `StoreCacheOptions` to distinguish from `CacheOptions` in
 * `@noy-db/hub/collection`, which controls the in-memory decrypted-record LRU.
 */
export interface StoreCacheOptions {
  /** Maximum cached entries. Default: 500. */
  maxEntries?: number
  /** Cache TTL in ms. Default: 60_000 (1 minute). 0 = no expiry. */
  ttlMs?: number
}

interface CacheEntry {
  envelope: EncryptedEnvelope | null
  cachedAt: number
}

/**
 * Middleware that adds a read-through LRU cache for `get()` calls.
 *
 * Reduces latency for frequently-read records (e.g. lookup tables, user
 * profiles) by serving repeat reads from memory. Because NOYDB records are
 * encrypted at rest, caching envelopes is safe — the cache holds ciphertext,
 * not plaintext. For write-heavy workloads, the cache provides little benefit
 * and should be omitted to avoid the invalidation overhead.
 */
export function withCache(opts: StoreCacheOptions = {}): StoreMiddleware {
  const maxEntries = opts.maxEntries ?? 500
  const ttlMs = opts.ttlMs ?? 60_000

  // LRU cache: Map preserves insertion order, we delete+re-insert on access
  const cache = new Map<string, CacheEntry>()

  function cacheKey(vault: string, collection: string, id: string): string {
    return `${vault}\0${collection}\0${id}`
  }

  function getFromCache(key: string): EncryptedEnvelope | null | undefined {
    const entry = cache.get(key)
    if (!entry) return undefined
    if (ttlMs > 0 && Date.now() - entry.cachedAt > ttlMs) {
      cache.delete(key)
      return undefined
    }
    // LRU: move to end
    cache.delete(key)
    cache.set(key, entry)
    return entry.envelope
  }

  function setInCache(key: string, envelope: EncryptedEnvelope | null): void {
    // Evict oldest if at capacity
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, { envelope, cachedAt: Date.now() })
  }

  function invalidate(key: string): void {
    cache.delete(key)
  }

  return (next) => ({
    ...next,
    name: next.name ? `cache(${next.name})` : 'cache',

    async get(vault, collection, id) {
      const key = cacheKey(vault, collection, id)
      const cached = getFromCache(key)
      if (cached !== undefined) return cached
      const result = await next.get(vault, collection, id)
      setInCache(key, result)
      return result
    },

    async put(vault, collection, id, env, ev) {
      invalidate(cacheKey(vault, collection, id))
      await next.put(vault, collection, id, env, ev)
      setInCache(cacheKey(vault, collection, id), env)
    },

    async delete(vault, collection, id) {
      invalidate(cacheKey(vault, collection, id))
      await next.delete(vault, collection, id)
    },

    list: (v, c) => next.list(v, c),
    loadAll: (v) => next.loadAll(v),
    saveAll: (v, d) => next.saveAll(v, d),
  })
}

// ─── withHealthCheck ────────────────────────────────────────────────────

export interface HealthCheckOptions {
  /** Ping interval in ms. Default: 30_000. */
  checkIntervalMs?: number
  /** Suspend after N consecutive ping failures. Default: 3. */
  suspendAfterFailures?: number
  /** Resume after N consecutive ping successes. Default: 1. */
  resumeAfterSuccess?: number
  /** Called when the store is auto-suspended. */
  onSuspend?: () => void
  /** Called when the store is auto-resumed. */
  onResume?: () => void
  /**
   * Custom health check. Default: calls `store.ping()` if available,
   * otherwise attempts a `list()` on a sentinel collection.
   */
  check?: () => Promise<boolean>
}

/**
 * Auto-suspends a store when health checks fail, auto-resumes when they recover.
 *
 * When suspended, `get` returns null, `put`/`delete` are no-ops, `list` returns [].
 * This is identical to the `NullStore` behavior from `routeStore.suspend()`.
 */
export function withHealthCheck(opts: HealthCheckOptions = {}): StoreMiddleware {
  const intervalMs = opts.checkIntervalMs ?? 30_000
  const failThreshold = opts.suspendAfterFailures ?? 3
  const successThreshold = opts.resumeAfterSuccess ?? 1

  let isSuspended = false
  let consecutiveFailures = 0
  let consecutiveSuccesses = 0

  return (next) => {
    const checkFn = opts.check ?? (
      next.ping
        ? () => next.ping!()
        : async () => { await next.list('__health__', '__ping__'); return true }
    )

    async function doCheck(): Promise<void> {
      try {
        const ok = await checkFn()
        if (ok) {
          consecutiveFailures = 0
          consecutiveSuccesses++
          if (isSuspended && consecutiveSuccesses >= successThreshold) {
            isSuspended = false
            consecutiveSuccesses = 0
            opts.onResume?.()
          }
        } else {
          throw new Error('Health check returned false')
        }
      } catch {
        consecutiveSuccesses = 0
        consecutiveFailures++
        if (!isSuspended && consecutiveFailures >= failThreshold) {
          isSuspended = true
          consecutiveFailures = 0
          opts.onSuspend?.()
        }
      }
    }

    // Start checking
    setInterval(() => { void doCheck() }, intervalMs)

    const wrapped: NoydbStore = {
      ...next,
      name: next.name ? `health(${next.name})` : 'health',

      async get(v, c, id) { return isSuspended ? null : next.get(v, c, id) },
      async put(v, c, id, env, ev) { if (!isSuspended) await next.put(v, c, id, env, ev) },
      async delete(v, c, id) { if (!isSuspended) await next.delete(v, c, id) },
      async list(v, c) { return isSuspended ? [] : next.list(v, c) },
      async loadAll(v) { return isSuspended ? {} : next.loadAll(v) },
      async saveAll(v, d) { if (!isSuspended) await next.saveAll(v, d) },
    }

    return wrapped
  }
}
