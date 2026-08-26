import { isConflictError } from '@noy-db/hub'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub/to'
import type { RestRequest, RestResponse, RestHandlerOptions } from './index.js'

function json(status: number, body: unknown): RestResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/**
 * The 6 required `NoydbStore` methods plus the optional sync/pagination
 * extensions — the exact set `by-peer`'s `servePeerStore` exposes. The
 * router never decrypts or interprets an argument; it forwards the
 * positional tuple straight to `store.*` and returns the raw result.
 */
const CORE_METHODS = new Set<string>([
  'get',
  'put',
  'delete',
  'list',
  'loadAll',
  'saveAll',
  'ping',
  'listSince',
  'listPage',
  'listVaults',
])

class UnknownMethodError extends Error {}
class UnsupportedMethodError extends Error {}

async function dispatch(store: NoydbStore, method: string, args: readonly unknown[]): Promise<unknown> {
  switch (method) {
    case 'get': {
      const [vault, collection, id] = args as [string, string, string]
      return store.get(vault, collection, id)
    }
    case 'put': {
      const [vault, collection, id, envelope, expectedVersion] = args as [
        string,
        string,
        string,
        EncryptedEnvelope,
        number | undefined,
      ]
      await store.put(vault, collection, id, envelope, expectedVersion)
      return null
    }
    case 'delete': {
      const [vault, collection, id] = args as [string, string, string]
      await store.delete(vault, collection, id)
      return null
    }
    case 'list': {
      const [vault, collection] = args as [string, string]
      return store.list(vault, collection)
    }
    case 'loadAll': {
      const [vault] = args as [string]
      return store.loadAll(vault)
    }
    case 'saveAll': {
      const [vault, data] = args as [string, VaultSnapshot]
      await store.saveAll(vault, data)
      return null
    }
    case 'ping': {
      if (!store.ping) return true
      return store.ping()
    }
    case 'listSince': {
      if (!store.listSince) throw new UnsupportedMethodError('listSince not supported by this store')
      const [vault, collection, since] = args as [string, string, string]
      return store.listSince(vault, collection, since)
    }
    case 'listPage': {
      if (!store.listPage) throw new UnsupportedMethodError('listPage not supported by this store')
      const [vault, collection, cursor, limit] = args as [
        string,
        string,
        string | undefined,
        number | undefined,
      ]
      return store.listPage(vault, collection, cursor, limit)
    }
    case 'listVaults': {
      if (!store.listVaults) throw new UnsupportedMethodError('listVaults not supported by this store')
      return store.listVaults()
    }
  }
  /* istanbul ignore next — CORE_METHODS gate makes this unreachable */
  throw new UnknownMethodError(`Unhandled method: ${method}`)
}

export function buildRouter(opts: RestHandlerOptions) {
  const { store, authorize, allow } = opts
  const basePath = opts.basePath ?? ''

  function stripBase(pathname: string): string {
    // Segment-aware prefix match: basePath '/api' matches '/api' or '/api/...'
    // but NOT '/apifoo' or '/api-other/...'.
    if (!basePath) return pathname
    if (pathname === basePath) return '/'
    if (pathname.startsWith(basePath + '/')) return pathname.slice(basePath.length)
    return pathname
  }

  return async function route(req: RestRequest): Promise<RestResponse> {
    const path = stripBase(req.pathname)
    const method = req.method.toUpperCase()

    if (method !== 'POST' || path !== '/rpc') {
      return json(404, { error: { name: 'NotFound', message: 'no such route' } })
    }

    // Auth first, and fail-closed: an omitted authorizer denies every
    // request. The caller MUST supply one to accept any traffic. A throwing
    // authorizer also fails closed — a structured 500 with no leaked detail,
    // never an open request or an uncaught rejection out of handle().
    let authorized: boolean
    try {
      authorized = authorize ? await authorize(req) : false
    } catch {
      return json(500, { error: { name: 'Error', message: 'authorization failed' } })
    }
    if (!authorized) {
      return json(401, { error: { name: 'Unauthorized', message: 'unauthorized' } })
    }

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return json(400, { error: { name: 'BadRequest', message: 'invalid JSON body' } })
    }
    const rpcMethod = (body as Record<string, unknown> | null)?.method
    const rpcArgs = (body as Record<string, unknown> | null)?.args
    if (typeof rpcMethod !== 'string' || !Array.isArray(rpcArgs)) {
      return json(400, { error: { name: 'BadRequest', message: 'body must be { method: string, args: unknown[] }' } })
    }

    if (!CORE_METHODS.has(rpcMethod)) {
      return json(400, { error: { name: 'BadRequest', message: `unknown method: ${rpcMethod}` } })
    }
    if (allow && !allow.has(rpcMethod)) {
      return json(403, { error: { name: 'Forbidden', message: `method not allowed: ${rpcMethod}` } })
    }

    try {
      const result = await dispatch(store, rpcMethod, rpcArgs)
      return json(200, result ?? null)
    } catch (err) {
      if (isConflictError(err)) {
        // #1218 — the winning writer's `_v` deliberately does NOT cross the
        // wire. It is another principal's progress counter; a client able to
        // provoke a 409 would otherwise learn how far a writer it may hold no
        // read grant for has advanced a record, and repetition turns that into
        // a write-activity oracle. The 409 still says "your write lost"; the
        // client re-reads to learn what won, at the cost of one round trip.
        //
        // `name` is LOAD-BEARING and must not be renamed or dropped: clients
        // re-hydrate ConflictError by keying off it (@noy-db/to-rest >=
        // 0.7.0-pre.1 does exactly that, defaulting version to NaN). Older
        // to-rest REQUIRED `version` and treats a 409 without it as a generic
        // error — which is why that client had to ship first.
        //
        // `ConflictError.version` itself is unchanged and still carried
        // in-process; the sync engine needs it. This is the transport boundary.
        return json(409, { error: { name: 'ConflictError', message: err.message } })
      }
      if (err instanceof UnsupportedMethodError) {
        // The request was well-formed; the backing store just lacks this
        // optional method. 501 (not 400) lets a client feature-detect.
        return json(501, { error: { name: 'NotImplemented', message: err.message } })
      }
      // Preserve the error NAME so a client can branch / re-hydrate, but do
      // NOT echo the raw store message — it may embed operational internals
      // (connection strings, paths). Operators read the detail from logs.
      const e = err as Error
      return json(500, { error: { name: e.name ?? 'Error', message: 'store error' } })
    }
  }
}
