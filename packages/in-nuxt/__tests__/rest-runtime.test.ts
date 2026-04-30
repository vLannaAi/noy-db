import { describe, it, expect, vi } from 'vitest'

// Mock h3 so the runtime handler can be loaded in Node without a real Nitro.
vi.mock('h3', () => {
  return {
    defineEventHandler: <T>(fn: T) => fn,
    getRequestURL: (event: { path?: string }) => new URL(event.path ?? '/', 'http://localhost'),
    readBody: async (event: { _body?: unknown }) => event._body ?? null,
  }
})

interface FakeH3Event {
  method: string
  path: string
  headers: Headers
  context: Record<string, unknown>
  _body?: unknown
}

function makeEvent(opts: Partial<FakeH3Event> & { context?: Record<string, unknown> }): FakeH3Event {
  return {
    method: opts.method ?? 'GET',
    path: opts.path ?? '/sessions/current',
    headers: opts.headers ?? new Headers(),
    context: opts.context ?? {},
    _body: opts._body,
  }
}

describe('runtime/rest handler', () => {
  it('returns 500 noydb_store_not_configured when store is absent', async () => {
    const mod = await import('../src/runtime/rest.js')
    const handler = mod.default as (event: FakeH3Event) => Promise<Response>
    const event = makeEvent({ context: {} })
    const res = await handler(event)
    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('noydb_store_not_configured')
  })

  it('reads config from event.context.nitro.runtimeConfig (canonical Nitro path)', async () => {
    const mod = await import('../src/runtime/rest.js')
    const handler = mod.default as (event: FakeH3Event) => Promise<Response>

    const minimalStore = {
      name: 'memory',
      async get() { return null },
      async put() { /* no-op */ },
      async delete() { /* no-op */ },
      async list() { return [] },
      async loadAll() { return {} },
      async saveAll() { /* no-op */ },
    }

    const event = makeEvent({
      method: 'GET',
      path: '/sessions/current',
      context: {
        nitro: {
          runtimeConfig: {
            public: {
              noydb: {
                rest: { user: 'configured-user', ttlSeconds: 120, basePath: '/api/noydb' },
              },
            },
          },
        },
        noydbStore: minimalStore,
      },
    })
    const res = await handler(event)
    expect(res).toBeInstanceOf(Response)
    // GET /sessions/current always returns 200 with { active: boolean }.
    expect(res.status).toBe(200)
    const body = await res.json() as { active: boolean }
    expect(body.active).toBe(false)
  })

  it('falls back to event.context.runtimeConfig for alternate injection', async () => {
    const mod = await import('../src/runtime/rest.js')
    const handler = mod.default as (event: FakeH3Event) => Promise<Response>

    const minimalStore = {
      name: 'memory',
      async get() { return null },
      async put() { /* no-op */ },
      async delete() { /* no-op */ },
      async list() { return [] },
      async loadAll() { return {} },
      async saveAll() { /* no-op */ },
    }

    const event = makeEvent({
      method: 'GET',
      path: '/sessions/current',
      context: {
        runtimeConfig: {
          public: {
            noydb: {
              rest: { user: 'alt-user' },
            },
          },
        },
        noydbStore: minimalStore,
      },
    })
    const res = await handler(event)
    expect(res.status).toBe(200)
  })
})
