import type { NoydbRestHandler, RestRequest } from '../index.js'

interface H3Event {
  method: string
  path: string
  headers: Headers | Record<string, string>
  _body?: unknown
}

/**
 * Nitro / H3 adapter. Returns a Fetch-spec `Response` — both h3 v1 and v2
 * relay a returned `Response` to the underlying HTTP layer, preserving
 * status, headers, and body (including `Uint8Array`). Returning the raw
 * `RestResponse` shape would be JSON-stringified by h3 and the status
 * would default to 200, which is wrong.
 */
export function nitroAdapter(handler: NoydbRestHandler) {
  // No explicit try/catch — Nitro's `defineEventHandler` wraps the
  // returned function and converts any thrown error into a 500 via
  // h3's `createError` path. Contrast with the Express adapter, which
  // needs `next(err)`.
  return async function eventHandler(event: H3Event): Promise<Response> {
    // Normalize headers to lowercase — consistent with Hono / Express /
    // Fastify and with Node's IncomingMessage.headers convention.
    const headers: Record<string, string> = {}
    if (event.headers instanceof Headers) {
      event.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })
    } else {
      for (const [k, v] of Object.entries(event.headers)) {
        headers[k.toLowerCase()] = v
      }
    }

    const url = new URL(event.path, 'http://localhost')
    let bodyCache: unknown
    let bodyRead = false

    const restReq: RestRequest = {
      method: event.method,
      pathname: url.pathname,
      searchParams: url.searchParams,
      headers,
      async json() {
        if (!bodyRead) { bodyCache = event._body ?? null; bodyRead = true }
        return bodyCache
      },
    }

    const res = await handler.handle(restReq)
    // `RestResponse.body` is `string | Uint8Array | null`, all of which are
    // valid `BodyInit`. TS's generic-parameter drift on Uint8Array under
    // lib.es5 requires the cast; the runtime assignment is safe.
    return new Response(res.body as BodyInit | null, {
      status: res.status,
      headers: res.headers,
    })
  }
}
