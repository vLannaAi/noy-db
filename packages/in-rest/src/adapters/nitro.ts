import type { NoydbRestHandler, RestRequest } from '../index.js'

interface H3Event {
  method: string
  path: string
  headers: Headers | Record<string, string>
  _body?: unknown
}

export function nitroAdapter(handler: NoydbRestHandler) {
  return async function eventHandler(event: H3Event) {
    const headers: Record<string, string> = {}
    if (event.headers instanceof Headers) {
      event.headers.forEach((v, k) => { headers[k] = v })
    } else {
      Object.assign(headers, event.headers)
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

    return handler.handle(restReq)
  }
}
