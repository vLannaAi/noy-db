import { describe, it, expect } from 'vitest'
import type { NoydbRestHandler, RestRequest, RestResponse } from '../src/index.js'

function stubHandler(response: RestResponse): NoydbRestHandler {
  return {
    handle(_req: RestRequest): Promise<RestResponse> {
      return Promise.resolve(response)
    },
  }
}

const okResponse: RestResponse = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"ok":true}',
}

// ── Nitro / H3 ────────────────────────────────────────────────────────

describe('nitroAdapter', () => {
  it('normalises an H3 event into a RestRequest and returns a Response', async () => {
    const { nitroAdapter } = await import('../src/adapters/nitro.js')
    let capturedReq: RestRequest | null = null
    const handler: NoydbRestHandler = {
      async handle(r) { capturedReq = r; return okResponse }
    }
    const eventHandler = nitroAdapter(handler)

    const mockEvent = {
      method: 'GET',
      path: '/sessions/current',
      headers: new Headers({ 'X-Test': '1' }),
      _body: null as unknown,
    }

    const res = await eventHandler(mockEvent)
    // Returns a Fetch Response — status and headers relayed by H3 to the HTTP layer.
    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)

    // Header case-normalization: RestRequest should see 'x-test' lowercase.
    expect(capturedReq).not.toBeNull()
    expect(capturedReq!.method).toBe('GET')
    expect(capturedReq!.pathname).toBe('/sessions/current')
    expect(capturedReq!.headers['x-test']).toBe('1')
  })

  it('normalizes lowercase header keys from plain-record event.headers', async () => {
    const { nitroAdapter } = await import('../src/adapters/nitro.js')
    let capturedReq: RestRequest | null = null
    const handler: NoydbRestHandler = {
      async handle(r) { capturedReq = r; return okResponse }
    }
    const eventHandler = nitroAdapter(handler)

    // Plain record with mixed-case keys — simulates a caller that passes
    // headers as an object rather than a Headers instance.
    const mockEvent = {
      method: 'GET',
      path: '/sessions/current',
      headers: { 'X-Test': '1', 'Authorization': 'Bearer abc' } as Record<string, string>,
      _body: null as unknown,
    }

    await eventHandler(mockEvent)
    expect(capturedReq!.headers['x-test']).toBe('1')
    expect(capturedReq!.headers['authorization']).toBe('Bearer abc')
  })
})

// ── Hono ─────────────────────────────────────────────────────────────

describe('honoAdapter', () => {
  it('creates a Hono instance with a catch-all route that forwards to the handler', async () => {
    const { honoAdapter } = await import('../src/adapters/hono.js')
    const handler = stubHandler(okResponse)
    const app = honoAdapter(handler)

    const response = await app.request('/sessions/current', {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
    })

    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })
})

// ── Express ───────────────────────────────────────────────────────────

describe('expressAdapter', () => {
  it('returns a Router; handle() is invoked for incoming requests', async () => {
    const { expressAdapter } = await import('../src/adapters/express.js')
    let capturedReq: RestRequest | null = null
    const handler: NoydbRestHandler = {
      async handle(r) { capturedReq = r; return okResponse }
    }
    const router = expressAdapter(handler)
    expect(typeof router).toBe('function')

    let resolvePromise!: () => void
    const done = new Promise<void>((resolve) => { resolvePromise = resolve })

    const mockReq = {
      method: 'GET',
      path: '/sessions/current',
      url: '/sessions/current',
      originalUrl: '/sessions/current',
      headers: {} as Record<string, string | string[] | undefined>,
      query: {} as Record<string, unknown>,
      body: null,
    }
    const mockRes = {
      statusCode: 0,
      status(code: number) { this.statusCode = code; return this },
      setHeader(_k: string, _v: string) { /* no-op */ },
      end(_b?: string) { resolvePromise() },
    }

    // Express router is callable as (req, res, next); next is only called on error
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(router as any)(mockReq, mockRes, (err?: unknown) => {
      if (err) resolvePromise()
    })

    await done

    expect(capturedReq).not.toBeNull()
    expect(capturedReq!.method).toBe('GET')
    expect(capturedReq!.pathname).toBe('/sessions/current')
  })
})

// ── Fastify ───────────────────────────────────────────────────────────

describe('fastifyPlugin', () => {
  it('registers as a Fastify plugin and routes requests to handler', async () => {
    const Fastify = (await import('fastify')).default
    const { fastifyPlugin } = await import('../src/adapters/fastify.js')
    const handler = stubHandler(okResponse)

    const app = Fastify()
    await app.register(fastifyPlugin(handler))
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/sessions/current' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    await app.close()
  })
})
