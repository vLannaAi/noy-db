import express from 'express'
import type { Router as ExpressRouter } from 'express'
import type { NoydbRestHandler, RestRequest } from '../index.js'

export function expressAdapter(handler: NoydbRestHandler): ExpressRouter {
  const router = express.Router()

  // Express 5 dropped support for bare `*` as a wildcard path — use router.use()
  // which runs for all methods and paths without needing path-to-regexp.
  router.use(async (req, res, next) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v
    }

    const url = new URL(req.path, 'http://localhost')
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v === 'string') url.searchParams.append(k, v)
    }

    let bodyCache: unknown
    let bodyRead = false

    const restReq: RestRequest = {
      method: req.method,
      pathname: req.path,
      searchParams: url.searchParams,
      headers,
      json: () => {
        if (!bodyRead) { bodyCache = req.body; bodyRead = true }
        return Promise.resolve(bodyCache)
      },
    }

    // Express 5 awaits returned promises from middleware, BUT throwing
    // inside `async` middleware only reaches the default error handler
    // when the adapter forwards the rejection via `next(err)`. Unlike
    // the fastify / hono / nitro adapters (whose frameworks hoist any
    // thrown error to their own 500 path automatically), Express needs
    // the explicit try/catch.
    try {
      const restRes = await handler.handle(restReq)
      res.status(restRes.status)
      for (const [k, v] of Object.entries(restRes.headers)) res.setHeader(k, v)
      if (restRes.body !== null) {
        res.end(restRes.body)
      } else {
        res.end()
      }
    } catch (err) {
      next(err)
    }
  })

  return router
}
