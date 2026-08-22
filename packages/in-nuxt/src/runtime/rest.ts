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
 * handler. That wiring is deferred to the  follow-up PR.
 *
 * The handler is intentionally stateless at module scope — the lazy `_handler`
 * singleton is reset on each cold-start (Nitro worker restart), which matches
 * the expected lifecycle.
 */

import { defineEventHandler, getRequestURL, readBody } from 'h3'
import type { H3Event } from 'h3'
import { createRestHandler } from '@noy-db/in-rest'
import { nitroAdapter } from '@noy-db/in-rest/nitro'
import type { NoydbRestHandler, RestRequest } from '@noy-db/in-rest'
import type { NoydbStore } from '@noy-db/hub/to'

let _handler: NoydbRestHandler | null = null

/**
 * Case-insensitive `Authorization: Bearer <token>` check against the
 * configured `rest.authToken`. HTTP header names are case-insensitive on
 * the wire — `nitroAdapter` already lowercases them, but `RestRequest`'s
 * type gives no such guarantee, so both castings are checked defensively
 * (matching what `@noy-db/in-rest`'s own pre-proxy `extractToken` did).
 */
function bearerAuthorize(expectedToken: string) {
  return (req: RestRequest): boolean => {
    const auth = req.headers['authorization'] ?? req.headers['Authorization']
    if (!auth?.startsWith('Bearer ')) return false
    return auth.slice(7) === expectedToken
  }
}

function getHandler(
  store: NoydbStore,
  authToken: string | undefined,
  basePath: string,
): NoydbRestHandler {
  if (!_handler) {
    // FAIL-CLOSED: @noy-db/in-rest rejects every /rpc request with 401
    // when `authorize` is omitted. Without an `authToken`, that's exactly
    // what happens here — the deployer MUST configure
    // `noydb.rest.authToken` (or wire a custom handler directly) to
    // accept any traffic.
    _handler = createRestHandler({
      store,
      basePath,
      ...(authToken ? { authorize: bearerAuthorize(authToken) } : {}),
    })
  }
  return _handler
}

export default defineEventHandler(async (event: H3Event) => {
  // Read REST config from Nitro's runtime config. Nitro stores it at
  // `event.context.nitro.runtimeConfig` (the canonical location — confirmed
  // by reading nitropack's config.mjs). The fallback on
  // `event.context.runtimeConfig` covers bespoke setups that might inject
  // config at that alternate key. `basePath` comes off the PUBLIC branch
  // (module.ts mirrors it there too, it's not a secret); `authToken` comes
  // off the PRIVATE branch — module.ts deliberately never puts it under
  // `.public`, so it never reaches the client bundle.
  const ctx = event.context as {
    nitro?: {
      runtimeConfig?: {
        public?: { noydb?: { rest?: Record<string, unknown> } }
        noydb?: { rest?: Record<string, unknown> }
      }
    }
    runtimeConfig?: {
      public?: { noydb?: { rest?: Record<string, unknown> } }
      noydb?: { rest?: Record<string, unknown> }
    }
    noydbStore?: NoydbStore
  }
  const publicConfig =
    ctx.nitro?.runtimeConfig?.public?.noydb?.rest ??
    ctx.runtimeConfig?.public?.noydb?.rest ??
    {}
  const privateConfig =
    ctx.nitro?.runtimeConfig?.noydb?.rest ??
    ctx.runtimeConfig?.noydb?.rest ??
    {}

  // The store must be provided by a separate Nitro server plugin that
  // creates and populates `event.context.noydbStore` before this handler
  // runs. See module docstring above.
  const store = ctx.noydbStore

  if (!store) {
    return new Response(
      JSON.stringify({ error: 'noydb_store_not_configured' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )
  }

  const restConfig = publicConfig as { basePath?: string }
  const authToken = (privateConfig as { authToken?: string }).authToken
  const handler = getHandler(
    store,
    authToken,
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
