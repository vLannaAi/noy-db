import { Hono } from 'hono'
import type { NoydbRestHandler, RestRequest } from '../index.js'

export function honoAdapter(handler: NoydbRestHandler): Hono {
  const app = new Hono()

  app.all('*', async (c) => {
    const headers: Record<string, string> = {}
    c.req.raw.headers.forEach((v, k) => { headers[k] = v })

    const url = new URL(c.req.url)
    const restReq: RestRequest = {
      method: c.req.method,
      pathname: url.pathname,
      searchParams: url.searchParams,
      headers,
      json: () => c.req.json<unknown>(),
    }

    const res = await handler.handle(restReq)
    // `RestResponse.body` is `string | Uint8Array | null`, all valid BodyInit.
    return new Response(res.body as BodyInit | null, {
      status: res.status,
      headers: res.headers,
    })
  })

  return app
}
