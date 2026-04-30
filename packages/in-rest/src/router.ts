import { createNoydb, PermissionDeniedError, NotFoundError, ConflictError, ValidationError } from '@noy-db/hub'
import type { NoydbStore } from '@noy-db/hub'
import type { RestRequest, RestResponse } from './index.js'
import type { SessionStore } from './sessions.js'
import { parseQueryParams } from './query-params.js'

function json(status: number, body: unknown): RestResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function extractToken(req: RestRequest): string | null {
  // HTTP headers are case-insensitive; check both common casings.
  const auth = req.headers['authorization'] ?? req.headers['Authorization']
  if (!auth?.startsWith('Bearer ')) return null
  return auth.slice(7)
}

export function buildRouter(store: NoydbStore, user: string, sessions: SessionStore, basePath: string) {
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

    // ── Session routes (no auth required) ─────────────────────────

    if (method === 'POST' && path === '/sessions/unlock/passphrase') {
      let body: unknown
      try { body = await req.json() } catch { return json(400, { error: 'invalid_json' }) }
      const passphrase = (body as Record<string, unknown>)?.passphrase
      if (typeof passphrase !== 'string' || !passphrase) {
        return json(400, { error: 'passphrase_required' })
      }
      try {
        const db = await createNoydb({ store, user, secret: passphrase })
        const token = sessions.create(db)
        return json(200, { token })
      } catch (err) {
        if (err instanceof ValidationError) {
          return json(400, { error: 'weak_passphrase', message: err.message })
        }
        return json(401, { error: 'invalid_passphrase' })
      }
    }

    if (method === 'GET' && path === '/sessions/current') {
      const token = extractToken(req)
      const active = token !== null && sessions.peek(token)
      return json(200, { active })
    }

    if (method === 'DELETE' && path === '/sessions/current') {
      const token = extractToken(req)
      if (!token || !sessions.peek(token)) return json(401, { error: 'unauthorized' })
      sessions.delete(token)
      return { status: 204, headers: {}, body: null }
    }

    // ── Auth guard ────────────────────────────────────────────────

    const token = extractToken(req)
    const db = token ? sessions.get(token) : null
    if (!db) return json(401, { error: 'unauthorized' })

    // ── Vault routes ──────────────────────────────────────────────

    if (method === 'GET' && path === '/vaults') {
      try {
        if (typeof store.listVaults === 'function') {
          const vaults = await db.listAccessibleVaults()
          return json(200, vaults.map(v => v.id))
        }
        return json(200, [])
      } catch {
        return json(200, [])
      }
    }

    // Match /vaults/:vault/collections/:collection/:id
    const recordMatch = path.match(/^\/vaults\/([^/]+)\/collections\/([^/]+)\/([^/]+)$/)
    if (recordMatch) {
      const vaultName = recordMatch[1]
      const collName = recordMatch[2]
      const id = recordMatch[3]
      if (vaultName === undefined || collName === undefined || id === undefined) {
        return json(500, { error: 'internal_error' })
      }
      try {
        const vault = await db.openVault(vaultName)
        const coll = vault.collection<Record<string, unknown>>(collName)

        if (method === 'GET') {
          const record = await coll.get(id)
          if (!record) return json(404, { error: 'not_found' })
          return json(200, record)
        }

        if (method === 'POST') {
          let body: unknown
          try { body = await req.json() } catch { return json(400, { error: 'invalid_json' }) }
          await coll.put(id, body as Record<string, unknown>)
          return json(200, { ok: true })
        }

        if (method === 'DELETE') {
          await coll.delete(id)
          return json(200, { ok: true })
        }

        return {
          status: 405,
          headers: { 'content-type': 'application/json', allow: 'GET, POST, DELETE' },
          body: JSON.stringify({ error: 'method_not_allowed' }),
        }
      } catch (err) {
        if (err instanceof PermissionDeniedError) return json(403, { error: 'forbidden' })
        if (err instanceof NotFoundError) return json(404, { error: 'not_found' })
        if (err instanceof ConflictError) return json(409, { error: 'conflict' })
        return json(500, { error: 'internal_error' })
      }
    }

    // Match /vaults/:vault/collections/:collection (list)
    const collMatch = path.match(/^\/vaults\/([^/]+)\/collections\/([^/]+)$/)
    if (collMatch) {
      if (method !== 'GET') {
        return {
          status: 405,
          headers: { 'content-type': 'application/json', allow: 'GET' },
          body: JSON.stringify({ error: 'method_not_allowed' }),
        }
      }
      const vaultName = collMatch[1]
      const collName = collMatch[2]
      if (vaultName === undefined || collName === undefined) {
        return json(500, { error: 'internal_error' })
      }
      const params = parseQueryParams(req.searchParams)
      if (params.error) return json(400, params.error)
      try {
        const vault = await db.openVault(vaultName)
        const coll = vault.collection<Record<string, unknown>>(collName)
        let results = params.apply(coll.query()).toArray()
        if (params.limit !== null) results = results.slice(0, params.limit)
        return json(200, results)
      } catch (err) {
        if (err instanceof PermissionDeniedError) return json(403, { error: 'forbidden' })
        return json(500, { error: 'internal_error' })
      }
    }

    return json(404, { error: 'not_found' })
  }
}
