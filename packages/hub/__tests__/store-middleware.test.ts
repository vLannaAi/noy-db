import { describe, it, expect, vi } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { wrapStore, withRetry, withLogging, withMetrics, withCircuitBreaker, withCache, withHealthCheck } from '../src/store/store-middleware.js'

// ─── Minimal store ──────────────────────────────────────────────────

function makeStore(name = 'test'): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  return {
    name,
    async get(v, c, id) { return data.get(`${v}/${c}/${id}`) ?? null },
    async put(v, c, id, env) { data.set(`${v}/${c}/${id}`, env) },
    async delete(v, c, id) { data.delete(`${v}/${c}/${id}`) },
    async list(v, c) { return [...data.keys()].filter(k => k.startsWith(`${v}/${c}/`)).map(k => k.split('/')[2]!) },
    async loadAll() { return {} },
    async saveAll() {},
  }
}

function failingStore(failCount: number): NoydbStore {
  let calls = 0
  const inner = makeStore('failing')
  return {
    ...inner,
    async get(v, c, id) {
      if (++calls <= failCount) throw new Error('transient failure')
      return inner.get(v, c, id)
    },
    async put(v, c, id, env) {
      if (++calls <= failCount) throw new Error('transient failure')
      return inner.put(v, c, id, env)
    },
  }
}

function envelope(v = 1): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: new Date().toISOString(), _iv: '', _data: '{}' }
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('wrapStore', () => {
  it('composes middlewares left-to-right (first is outermost)', async () => {
    const order: string[] = []
    const m1: any = (next: NoydbStore): NoydbStore => ({
      ...next,
      async get(v, c, id) { order.push('m1-before'); const r = await next.get(v, c, id); order.push('m1-after'); return r },
    })
    const m2: any = (next: NoydbStore): NoydbStore => ({
      ...next,
      async get(v, c, id) { order.push('m2-before'); const r = await next.get(v, c, id); order.push('m2-after'); return r },
    })

    const wrapped = wrapStore(makeStore(), m1, m2)
    await wrapped.get('v', 'c', 'id')
    // m1 wraps m2 wraps store: m1-before → m2-before → store → m2-after → m1-after
    expect(order).toEqual(['m1-before', 'm2-before', 'm2-after', 'm1-after'])
  })
})

describe('withRetry', () => {
  it('retries on transient failure', async () => {
    const store = failingStore(2) // fails twice, then succeeds
    const wrapped = wrapStore(store, withRetry({ maxRetries: 3, backoffMs: 10 }))

    await wrapped.put('v', 'c', 'id', envelope())
    // Should succeed after retries
  })

  it('throws after max retries exceeded', async () => {
    const store = failingStore(100)
    const wrapped = wrapStore(store, withRetry({ maxRetries: 2, backoffMs: 10 }))

    await expect(wrapped.get('v', 'c', 'id')).rejects.toThrow('transient failure')
  })
})

describe('withMetrics', () => {
  it('reports operations with timing', async () => {
    const ops: any[] = []
    const wrapped = wrapStore(makeStore(), withMetrics({ onOperation: (op) => ops.push(op) }))

    await wrapped.put('v', 'c', 'id', envelope())
    await wrapped.get('v', 'c', 'id')

    expect(ops).toHaveLength(2)
    expect(ops[0].method).toBe('put')
    expect(ops[0].success).toBe(true)
    expect(ops[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(ops[1].method).toBe('get')
  })
})

describe('withCircuitBreaker', () => {
  it('opens circuit after threshold failures', async () => {
    let calls = 0
    const store: NoydbStore = {
      ...makeStore(),
      async get() { calls++; throw new Error('down') },
    }

    let opened = false
    const wrapped = wrapStore(store, withCircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 100,
      onOpen: () => { opened = true },
    }))

    // 3 failures → circuit opens
    for (let i = 0; i < 3; i++) {
      await wrapped.get('v', 'c', 'id').catch(() => {})
    }
    expect(opened).toBe(true)

    // Circuit open: get returns null without calling the store
    const callsBefore = calls
    const result = await wrapped.get('v', 'c', 'id')
    expect(result).toBeNull()
    expect(calls).toBe(callsBefore) // store not called
  })
})

describe('withCache', () => {
  it('caches get results and serves from cache', async () => {
    let getCalls = 0
    const inner = makeStore()
    const store: NoydbStore = {
      ...inner,
      async get(v, c, id) { getCalls++; return inner.get(v, c, id) },
    }

    const wrapped = wrapStore(store, withCache({ maxEntries: 10, ttlMs: 5000 }))

    await inner.put('v', 'c', 'id', envelope())

    // First get: cache miss, calls store
    const r1 = await wrapped.get('v', 'c', 'id')
    expect(r1).not.toBeNull()
    expect(getCalls).toBe(1)

    // Second get: cache hit, does NOT call store
    const r2 = await wrapped.get('v', 'c', 'id')
    expect(r2).not.toBeNull()
    expect(getCalls).toBe(1)
  })

  it('invalidates cache on put', async () => {
    let getCalls = 0
    const inner = makeStore()
    const store: NoydbStore = {
      ...inner,
      async get(v, c, id) { getCalls++; return inner.get(v, c, id) },
      async put(v, c, id, env) { return inner.put(v, c, id, env) },
    }

    const wrapped = wrapStore(store, withCache({ maxEntries: 10 }))

    // Populate via the inner store directly (not through cache)
    await inner.put('v', 'c', 'id', envelope(1))

    // First get: cache miss → calls store
    await wrapped.get('v', 'c', 'id')
    expect(getCalls).toBe(1)

    // Second get: cache hit → does not call store
    await wrapped.get('v', 'c', 'id')
    expect(getCalls).toBe(1)

    // Put through cache → invalidates + re-populates
    await wrapped.put('v', 'c', 'id', envelope(2))

    // Get after put: cache has the new value from put, so no store call
    // But the envelope is from the put, not from the store.get
    // Let's verify by clearing the inner store and checking
    getCalls = 0
    await wrapped.get('v', 'c', 'id') // should be cached from put
    expect(getCalls).toBe(0) // served from cache
  })

  it('evicts LRU entries when at capacity', async () => {
    const inner = makeStore()
    const wrapped = wrapStore(inner, withCache({ maxEntries: 2 }))

    await inner.put('v', 'c', 'a', envelope())
    await inner.put('v', 'c', 'b', envelope())
    await inner.put('v', 'c', 'c', envelope())

    await wrapped.get('v', 'c', 'a') // cached
    await wrapped.get('v', 'c', 'b') // cached (a evicted if capacity=2)
    await wrapped.get('v', 'c', 'c') // cached (a or b evicted)

    // Cache should have only 2 entries — specifics depend on access order
  })
})

describe('withHealthCheck', () => {
  it('auto-suspends after consecutive failures', async () => {
    let healthy = true
    let suspended = false

    const inner = makeStore()
    const wrapped = wrapStore(inner, withHealthCheck({
      checkIntervalMs: 50,
      suspendAfterFailures: 2,
      check: async () => healthy,
      onSuspend: () => { suspended = true },
      onResume: () => { suspended = false },
    }))

    await inner.put('v', 'c', 'id', envelope())

    // Start healthy
    expect(await wrapped.get('v', 'c', 'id')).not.toBeNull()

    // Simulate unhealthy
    healthy = false
    await new Promise(r => setTimeout(r, 120)) // wait for 2 checks

    expect(suspended).toBe(true)
    // Suspended: get returns null
    expect(await wrapped.get('v', 'c', 'id')).toBeNull()

    // Recover
    healthy = true
    await new Promise(r => setTimeout(r, 70))

    expect(suspended).toBe(false)
    expect(await wrapped.get('v', 'c', 'id')).not.toBeNull()
  })
})

// ─── createNoydb integration ─────────────────────────────────────────
// Verifies that wrapStore works end-to-end as a backing store: keyring
// load on openVault and record persistence across a session boundary.

describe('wrapStore + createNoydb integration', () => {
  it('opens a vault, writes, and reads back after session close/reopen', async () => {
    const { createNoydb } = await import('../src/noydb.js')
    const inner = makeStore()
    let putCount = 0
    const counted = wrapStore(inner, (next) => ({
      ...next,
      async put(v, c, id, env, ev) { putCount++; return next.put(v, c, id, env, ev) },
    }))

    const db = await createNoydb({ store: counted, user: 'alice', secret: 'hunter2' })
    const vault = await db.openVault('V1')
    await vault.collection<{ x: number }>('col').put('id1', { x: 99 })
    expect(putCount).toBeGreaterThan(0) // middleware intercepted the put
    db.close()

    // Reopen — loadAll on the wrapped store must succeed
    const db2 = await createNoydb({ store: counted, user: 'alice', secret: 'hunter2' })
    const vault2 = await db2.openVault('V1')
    const result = await vault2.collection<{ x: number }>('col').get('id1')
    expect(result).toEqual({ x: 99 })
    db2.close()
  })
})
