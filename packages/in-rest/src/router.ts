import { createNoydb, PermissionDeniedError, NotFoundError } from '@noy-db/hub'
import type { NoydbStore } from '@noy-db/hub'
import type { RestRequest, RestResponse } from './index.js'
import { SessionStore } from './sessions.js'
import { parseQueryParams } from './query-params.js'

function json(status: number, body: unknown): RestResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function extractToken(req: RestRequest): string | null {
  const auth = req.headers['authorization'] ?? req.headers['Authorization']
  if (!auth?.startsWith('Bearer ')) return null
  return auth.slice(7)
}

export function buildRouter(store: NoydbStore, user: string, sessions: SessionStore, basePath: string) {
  function stripBase(pathname: string): string {
    if (basePath && pathname.startsWith(basePath)) return pathname.slice(basePath.length) || '/'
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
        const db = await createNoydb({ store, user, secret: passphrase, validatePassphrase: false })
        const token = sessions.create(db)
        return json(200, { token })
      } catch {
        return json(401, { error: 'invalid_passphrase' })
      }
    }

    if (method === 'GET' && path === '/sessions/current') {
      const token = extractToken(req)
      const active = token !== null && sessions.has(token)
      return json(200, { active })
    }

    if (method === 'DELETE' && path === '/sessions/current') {
      const token = extractToken(req)
      if (!token || !sessions.has(token)) return json(401, { error: 'unauthorized' })
      sessions.delete(token)
      return { status: 204, headers: {}, body: null }
    }

    // ── Auth guard ────────────────────────────────────────────────

    const token = extractToken(req)
    const db = token ? sessions.get(token) : null
    if (!db) return json(401, { error: 'unauthorized' })

    // ── Vault routes ──────────────────────────────────────────────

    if (method === 'GET' && path === '/vaults') {
      return json(200, [])
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
      } catch (err) {
        if (err instanceof PermissionDeniedError) return json(403, { error: 'forbidden' })
        if (err instanceof NotFoundError) return json(404, { error: 'not_found' })
        return json(500, { error: 'internal_error' })
      }
    }

    // Match /vaults/:vault/collections/:collection (list)
    const collMatch = path.match(/^\/vaults\/([^/]+)\/collections\/([^/]+)$/)
    if (collMatch && method === 'GET') {
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
