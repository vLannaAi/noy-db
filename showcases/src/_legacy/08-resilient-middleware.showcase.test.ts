/**
 * Showcase 08 — "Resilient Middleware Stack"
 * GitHub issue: https://github.com/vLannaAi/noy-db/issues/173
 *
 * Framework: Node.js (pure hub, no framework)
 * Store:     `wrapStore(flaky, withRetry, withCircuitBreaker, withMetrics, withLogging)`
 * Pattern:   Production resilience via composable middleware
 * Dimension: Production resilience, middleware composition
 *
 * What this proves:
 *   1. A single `wrapStore()` composition turns a raw unreliable store
 *      into one that transparently retries transient failures, fast-fails
 *      when the backend is genuinely down (circuit breaker), emits
 *      per-operation metrics, and logs structured events — without any
 *      application-level try/catch or observability code.
 *   2. Retries: a transient failure that succeeds before `maxRetries` is
 *      invisible to the caller. The metrics stream shows the extra
 *      attempts so SRE dashboards still see the work.
 *   3. Circuit breaker: when the backend stays broken, the breaker opens
 *      after `failureThreshold` consecutive failures. Reads fast-fail to
 *      `null` instead of blocking or throwing — the application degrades
 *      gracefully. Writes also fast-fail (no-op) without propagating errors.
 *   4. Recovery: after `resetTimeoutMs`, the breaker half-opens, probes
 *      the store, and closes on success. Traffic resumes normally.
 *
 * The "flaky" store is a thin proxy around `memory()` with a controllable
 * fault mode — `mode` flips from 'ok' to 'fail' and back to simulate a
 * backend outage and subsequent recovery. The proxy forwards every method
 * call into the underlying memory store on success; the outer middleware
 * stack only ever sees the `NoydbStore` contract methods, so it composes
 * identically with any backend.
 */

import { describe, it, expect } from 'vitest'
import {
  createNoydb,
  wrapStore,
  withRetry,
  withCircuitBreaker,
  withMetrics,
  withLogging,
  type NoydbStore,
  type StoreOperation,
} from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

import {
  type Invoice,
  sampleClients,
  SHOWCASE_PASSPHRASE,
  sleep,
} from '../_fixtures.js'

const VAULT = 'firm-demo'

/**
 * Build a flaky store that wraps `memory()` and can be switched between
 * three modes:
 *   - 'ok'      — every call passes through to memory normally.
 *   - 'flaky-N' — the next N calls throw a synthetic NETWORK_ERROR, then
 *                 the store auto-heals back to 'ok'. Simulates a
 *                 transient outage that should be absorbed by withRetry.
 *   - 'fail'    — every call throws until flipped back. Simulates a hard
 *                 backend outage that should trip the circuit breaker.
 *
 * The flaky proxy reports its own `name` so middleware logs/metrics tag
 * the layer correctly. Capability introspection (`casAtomic` etc.) is
 * unused by the middlewares exercised here, so the proxy does not
 * forward it — adding it would make the showcase harder to follow
 * without demonstrating anything new.
 */
interface FlakyHandle {
  readonly store: NoydbStore
  readonly setMode: (mode: 'ok' | 'fail') => void
  readonly setFlakyFor: (count: number) => void
  readonly callCount: () => number
}

function flakyStore(): FlakyHandle {
  const inner = memory()
  let mode: 'ok' | 'fail' = 'ok'
  let flakyRemaining = 0
  let calls = 0

  function maybeThrow(): void {
    calls++
    if (mode === 'fail') {
      const err = new Error('backend unreachable') as Error & { code: string }
      err.code = 'NETWORK_ERROR'
      throw err
    }
    if (flakyRemaining > 0) {
      flakyRemaining--
      const err = new Error('transient network blip') as Error & { code: string }
      err.code = 'NETWORK_ERROR'
      throw err
    }
  }

  const proxy: NoydbStore = {
    name: 'flaky',
    async get(vault, collection, id) {
      maybeThrow()
      return inner.get(vault, collection, id)
    },
    async put(vault, collection, id, envelope, expectedVersion) {
      maybeThrow()
      return inner.put(vault, collection, id, envelope, expectedVersion)
    },
    async delete(vault, collection, id) {
      maybeThrow()
      return inner.delete(vault, collection, id)
    },
    async list(vault, collection) {
      maybeThrow()
      return inner.list(vault, collection)
    },
    async loadAll(vault) {
      maybeThrow()
      return inner.loadAll(vault)
    },
    async saveAll(vault, data) {
      maybeThrow()
      return inner.saveAll(vault, data)
    },
  }

  return {
    store: proxy,
    setMode: (next) => { mode = next },
    setFlakyFor: (count) => { flakyRemaining = count },
    callCount: () => calls,
  }
}

describe('Showcase 08 — Resilient Middleware Stack (pure hub)', () => {
  it('step 1 — transient failure is absorbed by retry, metrics show attempts', async () => {
    const flaky = flakyStore()
    const metrics: StoreOperation[] = []

    const resilient = wrapStore(
      flaky.store,
      // Outermost — retries sit above the circuit breaker so transient
      // blips get absorbed before they trip it.
      withRetry({ maxRetries: 5, backoffMs: 1, jitter: 0 }),
      withCircuitBreaker({ failureThreshold: 10, resetTimeoutMs: 100 }),
      withMetrics({ onOperation: (op) => metrics.push(op) }),
      // Silent logger — we're not asserting log output, just proving
      // the middleware composes cleanly with a no-op sink.
      withLogging({ level: 'warn', logger: {
        debug() {}, info() {}, warn() {}, error() {},
      } }),
    )

    const db = await createNoydb({
      store: resilient,
      user: 'owner',
      secret: SHOWCASE_PASSPHRASE,
    })
    try {
      const vault = await db.openVault(VAULT)
      const invoices = vault.collection<Invoice>('invoices')

      // Inject 2 transient failures into the next store calls. withRetry
      // absorbs them and the put eventually succeeds. From the caller's
      // perspective the write just worked.
      metrics.length = 0
      flaky.setFlakyFor(2)

      await invoices.put('inv-retry', {
        id: 'inv-retry',
        clientId: sampleClients[0].id,
        amount: 7_500,
        currency: 'THB',
        status: 'draft',
        issueDate: '2026-04-10',
        dueDate: '2026-05-10',
        month: '2026-04',
      })

      // Caller sees success.
      const readBack = await invoices.get('inv-retry')
      expect(readBack?.amount).toBe(7_500)

      // Metrics were emitted — the shape is internal, we only assert that
      // entries exist and that some of them are failures (the retried
      // attempts). Exact counts depend on the hub's internal read/write
      // pattern (keyring loads etc.), so we stay shape-agnostic.
      expect(metrics.length).toBeGreaterThan(0)
      const failures = metrics.filter(m => !m.success)
      expect(failures.length).toBeGreaterThanOrEqual(2)
      // Every entry has the required telemetry shape regardless of method.
      for (const m of metrics) {
        expect(typeof m.method).toBe('string')
        expect(typeof m.durationMs).toBe('number')
        expect(typeof m.success).toBe('boolean')
      }
    } finally {
      await db.close()
    }
  })

  it('step 2 — permanent failure trips the circuit; reads fast-fail to null; recovery closes it', async () => {
    const flaky = flakyStore()
    const metrics: StoreOperation[] = []
    let circuitOpenedAt = 0
    let circuitClosedAt = 0

    const resilient = wrapStore(
      flaky.store,
      // Very small retry budget so a persistent failure reaches the
      // breaker quickly. maxRetries: 0 = no retries at all.
      withRetry({ maxRetries: 0, backoffMs: 1, jitter: 0, retryOn: ['NETWORK_ERROR'] }),
      withCircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 50,
        onOpen: () => { circuitOpenedAt = Date.now() },
        onClose: () => { circuitClosedAt = Date.now() },
      }),
      withMetrics({ onOperation: (op) => metrics.push(op) }),
      withLogging({ level: 'error', logger: {
        debug() {}, info() {}, warn() {}, error() {},
      } }),
    )

    // Seed a record while the store is healthy so later reads have
    // something observable to return (null when the breaker is open,
    // the real record when it's closed).
    const db = await createNoydb({
      store: resilient,
      user: 'owner',
      secret: SHOWCASE_PASSPHRASE,
    })
    try {
      const vault = await db.openVault(VAULT)
      const invoices = vault.collection<Invoice>('invoices')
      await invoices.put('inv-seed', {
        id: 'inv-seed',
        clientId: sampleClients[0].id,
        amount: 1_000,
        currency: 'THB',
        status: 'open',
        issueDate: '2026-04-01',
        dueDate: '2026-05-01',
        month: '2026-04',
      })
      expect((await invoices.get('inv-seed'))?.amount).toBe(1_000)

      // Backend goes hard-down — every call now throws.
      flaky.setMode('fail')

      // Drive enough direct store failures to trip the circuit. We use the
      // wrapped store directly (below the hub's read-through cache) so the
      // failures are unambiguous. Two failures at failureThreshold:2 opens
      // the breaker.
      for (let i = 0; i < 2; i++) {
        try { await resilient.get(VAULT, 'probe', `k-${i}`) }
        catch { /* expected — retry gives up and re-throws */ }
      }
      expect(circuitOpenedAt).toBeGreaterThan(0)

      // Breaker is open: reads fast-fail to `null` instead of throwing
      // or blocking. This is the "graceful degradation" path — the
      // application can render a stale/empty view instead of crashing.
      const nulled = await resilient.get(VAULT, 'probe', 'whatever')
      expect(nulled).toBeNull()

      // list() fast-fails to [] instead of throwing.
      const listed = await resilient.list(VAULT, 'probe')
      expect(listed).toEqual([])

      // put() during outage fast-fails silently (no throw, no persist).
      // The write simply does not happen; the underlying flaky store is
      // not touched. Subsequent reads once recovered show the original
      // seed unchanged.
      await expect(
        resilient.put(VAULT, 'invoices', 'inv-ghost', {
          _noydb: 1, _v: 1, _ts: new Date().toISOString(),
          _iv: '', _data: '',
        }),
      ).resolves.toBeUndefined()

      // Restore the backend and wait past the reset window so the breaker
      // enters half-open on the next probe.
      flaky.setMode('ok')
      await sleep(70)

      // A successful call now closes the circuit — onClose fires.
      const afterRecovery = await resilient.get(VAULT, 'probe', 'k-0')
      expect(afterRecovery).toBeNull() // no such record, but the call succeeded
      expect(circuitClosedAt).toBeGreaterThanOrEqual(circuitOpenedAt)

      // And the seed record is still readable through the wrapped store
      // (not via the hub's cached collection, which would short-circuit
      // through its in-memory map). This exercises the full resilience
      // stack end-to-end: wrapStore → retry → CB (closed) → metrics → log
      // → flaky (ok) → memory.
      const envelope = await resilient.get(VAULT, 'invoices', 'inv-seed')
      expect(envelope).toBeTruthy()
      expect(envelope!._v).toBe(1)

      // Metrics captured the outage: at least one failed op during the
      // bad window.
      const failures = metrics.filter(m => !m.success)
      expect(failures.length).toBeGreaterThan(0)
    } finally {
      await db.close()
    }
  })

  it('step 3 — recap: fully-composed stack, application sees a clean API', async () => {
    // Rebuild a fresh healthy stack and prove that under normal conditions
    // the middleware pipeline is invisible: a write + read go through
    // retry → breaker → metrics → log → store and return the exact record
    // the application wrote. This is the "zero-cost when healthy" promise
    // a production deployment needs from withRetry / withCircuitBreaker.
    const flaky = flakyStore()
    const metrics: StoreOperation[] = []

    const resilient = wrapStore(
      flaky.store,
      withRetry({ maxRetries: 3, backoffMs: 1, jitter: 0 }),
      withCircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 100 }),
      withMetrics({ onOperation: (op) => metrics.push(op) }),
      withLogging({ level: 'error', logger: {
        debug() {}, info() {}, warn() {}, error() {},
      } }),
    )

    const db = await createNoydb({
      store: resilient,
      user: 'owner',
      secret: SHOWCASE_PASSPHRASE,
    })
    try {
      const vault = await db.openVault(VAULT)
      const invoices = vault.collection<Invoice>('invoices')

      await invoices.put('inv-recap', {
        id: 'inv-recap',
        clientId: sampleClients[0].id,
        amount: 3_200,
        currency: 'THB',
        status: 'open',
        issueDate: '2026-04-20',
        dueDate: '2026-05-20',
        month: '2026-04',
      })

      const roundTrip = await invoices.get('inv-recap')
      expect(roundTrip?.amount).toBe(3_200)

      // Healthy path — every metric entry is a success.
      expect(metrics.length).toBeGreaterThan(0)
      expect(metrics.every(m => m.success)).toBe(true)
    } finally {
      await db.close()
    }
  })
})
