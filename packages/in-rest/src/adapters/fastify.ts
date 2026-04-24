import type { FastifyPluginAsync } from 'fastify'
import type { NoydbRestHandler, RestRequest } from '../index.js'

export function fastifyPlugin(handler: NoydbRestHandler): FastifyPluginAsync {
  return async function plugin(fastify) {
    // Use '/*' — Fastify v5 / find-my-way requires the leading slash on wildcards
    fastify.all('/*', async (request, reply) => {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(request.headers)) {
        if (typeof v === 'string') headers[k] = v
      }

      const url = new URL(request.url, 'http://localhost')

      let bodyCache: unknown
      let bodyRead = false

      const restReq: RestRequest = {
        method: request.method,
        pathname: url.pathname,
        searchParams: url.searchParams,
        headers,
        json: () => {
          if (!bodyRead) { bodyCache = request.body; bodyRead = true }
          return Promise.resolve(bodyCache)
        },
      }

      const restRes = await handler.handle(restReq)
      reply.status(restRes.status)
      for (const [k, v] of Object.entries(restRes.headers)) {
        reply.header(k, v)
      }
      if (restRes.body !== null) {
        return reply.send(restRes.body)
      }
      return reply.send()
    })
  }
}
