/**
 * Nitro catch-all server handler for the opt-in REST API integration.
 *
 * This file is registered as a server handler entry point by the module when
 * `rest.enabled: true`. It bridges Nitro's H3 event model to
 * `@noy-db/in-rest`'s `NoydbRestHandler` via the `nitroAdapter`.
 *
 * **Store wiring (scaffold note):**
 * The handler reads the noydb store from `event.context.noydbStore`. A
 * separate Nitro server plugin must populate this before requests reach this
 * handler. That wiring is deferred to the #273 follow-up PR.
 *
 * The handler is intentionally stateless at module scope — the lazy `_handler`
 * singleton is reset on each cold-start (Nitro worker restart), which matches
 * the expected lifecycle.
 */

import { defineEventHandler, getRequestURL, readBody } from 'h3'
import type { H3Event } from 'h3'
import { createRestHandler } from '@noy-db/in-rest'
import { nitroAdapter } from '@noy-db/in-rest/nitro'
import type { NoydbRestHandler } from '@noy-db/in-rest'
import type { NoydbStore } from '@noy-db/hub'

let _handler: NoydbRestHandler | null = null

function getHandler(
  store: NoydbStore,
  user: string,
  ttlSeconds: number,
  basePath: string,
): NoydbRestHandler {
  if (!_handler) {
    _handler = createRestHandler({ store, user, ttlSeconds, basePath })
  }
  return _handler
}

export default defineEventHandler(async (event: H3Event) => {
  // Read REST config from Nitro's public runtime config, injected by the
  // module setup via nuxt.options.runtimeConfig.public.noydb.rest.
  const ctx = event.context as Record<string, unknown>
  const runtimeConfig = ctx['runtimeConfig'] as
    | { public?: { noydb?: { rest?: Record<string, unknown> } } }
    | undefined
  const config = runtimeConfig?.public?.noydb?.rest ?? {}

  // The store must be provided by a separate Nitro server plugin that
  // creates and populates `event.context.noydbStore` before this handler
  // runs. See module docstring above.
  const store = ctx['noydbStore'] as NoydbStore | undefined

  if (!store) {
    return new Response(
      JSON.stringify({ error: 'noydb_store_not_configured' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )
  }

  const restConfig = config as {
    user?: string
    ttlSeconds?: number
    basePath?: string
  }
  const handler = getHandler(
    store,
    restConfig.user ?? 'api',
    restConfig.ttlSeconds ?? 900,
    restConfig.basePath ?? '/api/noydb',
  )

  // Build the adapter-friendly event shape. We pass event.headers directly
  // because `nitroAdapter` already handles both `Headers` instances and
  // plain `Record<string, string>` objects.
  const url = getRequestURL(event)
  const method = (event.method ?? 'GET').toUpperCase()

  let body: unknown = null
  if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
    try { body = await readBody(event) } catch { body = null }
  }

  const h3Adapter = nitroAdapter(handler)
  return h3Adapter({
    method,
    path: url.pathname + url.search,
    // nitroAdapter's H3Event accepts Headers | Record<string,string> — pass
    // the Headers instance directly to avoid lossy serialization.
    headers: event.headers,
    _body: body,
  })
})
