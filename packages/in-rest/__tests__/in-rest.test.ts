import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'
import { createRestHandler, type RestRequest } from '../src/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = store.get(v); if (!vm) { vm = new Map(); store.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const cm = gc(v, c); const ex = cm.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      cm.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = store.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [n, cm] of vm) {
        if (n.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[n] = r
      }
      return snap
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const cm = gc(v, n)
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
      }
    },
  }
}

function req(method: string, path: string, body?: unknown, token?: string): RestRequest {
  return {
    method,
    pathname: path,
    searchParams: new URLSearchParams(),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    json: () => Promise.resolve(body ?? null),
  }
}

function reqSearch(method: string, path: string, search: string, token: string): RestRequest {
  return {
    method,
    pathname: path,
    searchParams: new URLSearchParams(search),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    json: () => Promise.resolve(null),
  }
}

describe('in-rest base handler', () => {
  let store: NoydbStore
  beforeEach(() => { store = memory() })

  it('POST /sessions/unlock/passphrase → 200 with token', async () => {
    const handler = createRestHandler({ store, user: 'owner' })
    const res = await handler.handle(req('POST', '/sessions/unlock/passphrase', { passphrase: 'secret' }))
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body as string) as { token: string }
    expect(typeof body.token).toBe('string')
    expect(body.token.length).toBeGreaterThan(10)
  })

  it('GET /sessions/current without token → active: false', async () => {
    const handler = createRestHandler({ store, user: 'owner' })
    const res = await handler.handle(req('GET', '/sessions/current'))
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body as string) as { active: boolean }
    expect(body.active).toBe(false)
  })

  it('GET /sessions/current with valid token → active: true', async () => {
    const handler = createRestHandler({ store, user: 'owner' })
    const unlockRes = await handler.handle(req('POST', '/sessions/unlock/passphrase', { passphrase: 'secret' }))
    const { token } = JSON.parse(unlockRes.body as string) as { token: string }

    const res = await handler.handle(req('GET', '/sessions/current', undefined, token))
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body as string)).toMatchObject({ active: true })
  })

  it('vault routes require a valid token — 401 without one', async () => {
    const handler = createRestHandler({ store, user: 'owner' })
    const res = await handler.handle(req('GET', '/vaults'))
    expect(res.status).toBe(401)
  })

  it('full CRUD flow: list → put → get → delete', async () => {
    const handler = createRestHandler({ store, user: 'owner' })
    const { token } = JSON.parse(
      (await handler.handle(req('POST', '/sessions/unlock/passphrase', { passphrase: 'secret' }))).body as string
    ) as { token: string }

    const listVaultsRes = await handler.handle(req('GET', '/vaults', undefined, token))
    expect(listVaultsRes.status).toBe(200)

    const putRes = await handler.handle(
      req('POST', '/vaults/acme/collections/invoices/i1', { id: 'i1', amt: 100 }, token)
    )
    expect(putRes.status).toBe(200)

    const getRes = await handler.handle(req('GET', '/vaults/acme/collections/invoices/i1', undefined, token))
    expect(getRes.status).toBe(200)
    const record = JSON.parse(getRes.body as string) as { id: string; amt: number }
    expect(record.id).toBe('i1')
    expect(record.amt).toBe(100)

    const collRes = await handler.handle(req('GET', '/vaults/acme/collections/invoices', undefined, token))
    expect(collRes.status).toBe(200)
    const records = JSON.parse(collRes.body as string) as unknown[]
    expect(records).toHaveLength(1)

    const delRes = await handler.handle(req('DELETE', '/vaults/acme/collections/invoices/i1', undefined, token))
    expect(delRes.status).toBe(200)

    const gone = await handler.handle(req('GET', '/vaults/acme/collections/invoices/i1', undefined, token))
    expect(gone.status).toBe(404)
  })

  it('DELETE /sessions/current invalidates the token', async () => {
    const handler = createRestHandler({ store, user: 'owner' })
    const { token } = JSON.parse(
      (await handler.handle(req('POST', '/sessions/unlock/passphrase', { passphrase: 'secret' }))).body as string
    ) as { token: string }

    const delRes = await handler.handle(req('DELETE', '/sessions/current', undefined, token))
    expect(delRes.status).toBe(204)

    const afterDel = await handler.handle(req('GET', '/vaults', undefined, token))
    expect(afterDel.status).toBe(401)
  })

  it('?where=status:eq:paid filters results', async () => {
    const handler = createRestHandler({ store, user: 'owner' })
    const { token } = JSON.parse(
      (await handler.handle(req('POST', '/sessions/unlock/passphrase', { passphrase: 'secret' }))).body as string
    ) as { token: string }
    await handler.handle(req('POST', '/vaults/acme/collections/invoices/i1', { id: 'i1', status: 'paid', amt: 100 }, token))
    await handler.handle(req('POST', '/vaults/acme/collections/invoices/i2', { id: 'i2', status: 'draft', amt: 50 }, token))

    const res = await handler.handle(
      reqSearch('GET', '/vaults/acme/collections/invoices', 'where=status:eq:paid', token)
    )
    expect(res.status).toBe(200)
    const results = JSON.parse(res.body as string) as Array<{ status: string }>
    expect(results).toHaveLength(1)
    expect(results[0]!.status).toBe('paid')
  })

  it('?where=amt:pow:2 → 400 invalid op', async () => {
    const handler = createRestHandler({ store, user: 'owner' })
    const { token } = JSON.parse(
      (await handler.handle(req('POST', '/sessions/unlock/passphrase', { passphrase: 'secret' }))).body as string
    ) as { token: string }

    const res = await handler.handle(
      reqSearch('GET', '/vaults/acme/collections/invoices', 'where=amt:pow:2', token)
    )
    expect(res.status).toBe(400)
    const body = JSON.parse(res.body as string) as { error: string }
    expect(body.error).toBe('invalid_op')
  })

  it('basePath option strips the prefix before routing', async () => {
    const handler = createRestHandler({ store, user: 'owner', basePath: '/api/noydb' })
    const res = await handler.handle(req('POST', '/api/noydb/sessions/unlock/passphrase', { passphrase: 'secret' }))
    expect(res.status).toBe(200)
  })
})
