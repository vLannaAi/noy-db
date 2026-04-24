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
  it('normalises an H3 event into a RestRequest and returns the RestResponse', async () => {
    const { nitroAdapter } = await import('../src/adapters/nitro.js')
    let capturedReq: RestRequest | null = null
    const handler: NoydbRestHandler = {
      async handle(r) { capturedReq = r; return okResponse }
    }
    const eventHandler = nitroAdapter(handler)

    const mockEvent = {
      method: 'GET',
      path: '/sessions/current',
      headers: new Headers({ 'x-test': '1' }),
      _body: null as unknown,
    }

    const res = await (eventHandler as (event: typeof mockEvent) => Promise<RestResponse>)(mockEvent)
    expect(res.status).toBe(200)
    expect(capturedReq).not.toBeNull()
    expect(capturedReq!.method).toBe('GET')
    expect(capturedReq!.pathname).toBe('/sessions/current')
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
