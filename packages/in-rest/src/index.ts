/**
 * **@noy-db/in-rest** — Framework-neutral REST API integration for noy-db.
 *
 * A thin RPC dispatcher — the HTTP twin of `@noy-db/by-peer`'s
 * `servePeerStore` — that forwards the 6 `NoydbStore` methods straight to
 * the caller's ciphertext store. The server NEVER sees a secret, never
 * calls `createNoydb`/`openVault`, and never decrypts anything: every
 * request/response body is an `EncryptedEnvelope` (or a plain id/list of
 * one) round-tripped as-is.
 *
 * @example
 * ```ts
 * import { createRestHandler } from '@noy-db/in-rest'
 * import { honoAdapter } from '@noy-db/in-rest/hono'
 *
 * const handler = createRestHandler({
 *   store,
 *   authorize: (req) => req.headers['authorization'] === `Bearer ${API_KEY}`,
 * })
 * app.route('/api/noydb', honoAdapter(handler))
 * ```
 *
 * @packageDocumentation
 */

import type { NoydbStore } from '@noy-db/hub/to'
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
  /**
   * Authorize each request. Return `true` to allow. If OMITTED, the
   * handler is FAIL-CLOSED — every `/rpc` request is rejected with 401.
   * The caller MUST supply an authorizer to accept any traffic.
   */
  readonly authorize?: (req: RestRequest) => boolean | Promise<boolean>
  /**
   * Optional method allowlist (e.g. a read-only relay). When set, a
   * method not in the set is rejected with 403.
   */
  readonly allow?: ReadonlySet<string>
  readonly basePath?: string
}

export function createRestHandler(options: RestHandlerOptions): NoydbRestHandler {
  const route = buildRouter(options)
  return { handle: route }
}
