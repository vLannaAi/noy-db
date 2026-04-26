/**
 * **@noy-db/in-rest** — Framework-neutral REST API integration for noy-db.
 *
 * @example
 * ```ts
 * import { createRestHandler } from '@noy-db/in-rest'
 * import { honoAdapter } from '@noy-db/in-rest/hono'
 *
 * const handler = createRestHandler({ store, user: 'api' })
 * app.route('/api/noydb', honoAdapter(handler))
 * ```
 *
 * @packageDocumentation
 */

import type { NoydbStore } from '@noy-db/hub'
import { SessionStore } from './sessions.js'
import { buildRouter } from './router.js'

export interface RestRequest {
  readonly method: string
  readonly pathname: string
  readonly searchParams: URLSearchParams
  readonly headers: Record<string, string>
  json(): Promise<unknown>
}

export interface RestResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: string | Uint8Array | null
}

export interface NoydbRestHandler {
  handle(req: RestRequest): Promise<RestResponse>
}

export interface RestHandlerOptions {
  readonly store: NoydbStore
  readonly user: string
  readonly ttlSeconds?: number
  readonly basePath?: string
}

export function createRestHandler(options: RestHandlerOptions): NoydbRestHandler {
  const sessions = new SessionStore(options.ttlSeconds ?? 900)
  const route = buildRouter(options.store, options.user, sessions, options.basePath ?? '')
  return { handle: route }
}
