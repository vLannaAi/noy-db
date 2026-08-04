import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'
import { createRestHandler, type RestRequest } from '../src/index.js'

function toMemory(): NoydbStore {
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

// A representative ciphertext envelope — `_data` is base64, never plaintext.
function envelope(overrides: Partial<EncryptedEnvelope> = {}): EncryptedEnvelope {
  return {
    _noydb: 1,
    _v: 1,
    _ts: '2026-08-04T00:00:00.000Z',
    _iv: 'aXZpdml2aXY=',
    _data: 'Y2lwaGVydGV4dC1ub3QtcGxhaW50ZXh0',
    ...overrides,
  } as EncryptedEnvelope
}

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): RestRequest {
  return {
    method,
    pathname: path,
    searchParams: new URLSearchParams(),
    headers: { 'content-type': 'application/json', ...headers },
    json: () => Promise.resolve(body ?? null),
  }
}

const allowAll = () => true

describe('in-rest envelope-proxy handler', () => {
  let store: NoydbStore
  beforeEach(() => { store = toMemory() })

  // ── Envelope pass-through ────────────────────────────────────────

  it('put then get returns the exact stored EncryptedEnvelope, ciphertext untouched', async () => {
    const handler = createRestHandler({ store, authorize: allowAll })
    const env = envelope()

    const putRes = await handler.handle(
      req('POST', '/rpc', { method: 'put', args: ['acme', 'invoices', 'i1', env] })
    )
    expect(putRes.status).toBe(200)
    expect(JSON.parse(putRes.body as string)).toBeNull()

    const getRes = await handler.handle(
      req('POST', '/rpc', { method: 'get', args: ['acme', 'invoices', 'i1'] })
    )
    expect(getRes.status).toBe(200)
    const got = JSON.parse(getRes.body as string) as EncryptedEnvelope
    expect(got).toEqual(env)
    expect(got._data).toBe('Y2lwaGVydGV4dC1ub3QtcGxhaW50ZXh0')
  })

  it('list forwards to store.list and returns raw id array', async () => {
    const handler = createRestHandler({ store, authorize: allowAll })
    await handler.handle(req('POST', '/rpc', { method: 'put', args: ['acme', 'invoices', 'i1', envelope()] }))

    const res = await handler.handle(req('POST', '/rpc', { method: 'list', args: ['acme', 'invoices'] }))
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body as string)).toEqual(['i1'])
  })

  it('loadAll / saveAll forward raw VaultSnapshot', async () => {
    const handler = createRestHandler({ store, authorize: allowAll })
    const snapshot: VaultSnapshot = { invoices: { i1: envelope() } }

    const saveRes = await handler.handle(req('POST', '/rpc', { method: 'saveAll', args: ['acme', snapshot] }))
    expect(saveRes.status).toBe(200)
    expect(JSON.parse(saveRes.body as string)).toBeNull()

    const loadRes = await handler.handle(req('POST', '/rpc', { method: 'loadAll', args: ['acme'] }))
    expect(loadRes.status).toBe(200)
    expect(JSON.parse(loadRes.body as string)).toEqual(snapshot)
  })

  it('delete forwards to store.delete', async () => {
    const handler = createRestHandler({ store, authorize: allowAll })
    await handler.handle(req('POST', '/rpc', { method: 'put', args: ['acme', 'invoices', 'i1', envelope()] }))

    const delRes = await handler.handle(req('POST', '/rpc', { method: 'delete', args: ['acme', 'invoices', 'i1'] }))
    expect(delRes.status).toBe(200)
    expect(JSON.parse(delRes.body as string)).toBeNull()

    const getRes = await handler.handle(req('POST', '/rpc', { method: 'get', args: ['acme', 'invoices', 'i1'] }))
    expect(JSON.parse(getRes.body as string)).toBeNull()
  })

  // ── Security invariant: no plaintext / no passphrase server-side ──

  it('no unlock/secret route exists — unknown method → 400', async () => {
    const handler = createRestHandler({ store, authorize: allowAll })
    const unlockRes = await handler.handle(req('POST', '/rpc', { method: 'unlock', args: ['correct-horse-battery-staple'] }))
    expect(unlockRes.status).toBe(400)

    const secretRes = await handler.handle(req('POST', '/rpc', { method: 'secret', args: ['correct-horse-battery-staple'] }))
    expect(secretRes.status).toBe(400)
  })

  it('does not import createNoydb/openVault (structural — no decrypt path in the module)', async () => {
    const routerSrc = await import('node:fs').then((fs) =>
      fs.promises.readFile(new URL('../src/router.ts', import.meta.url), 'utf8')
    )
    expect(routerSrc).not.toMatch(/createNoydb/)
    expect(routerSrc).not.toMatch(/openVault/)
  })

  it('a put of an envelope then get round-trips the SAME ciphertext, never plaintext', async () => {
    const handler = createRestHandler({ store, authorize: allowAll })
    const env = envelope({ _data: 'c2VjcmV0LWNpcGhlcnRleHQ=' })
    await handler.handle(req('POST', '/rpc', { method: 'put', args: ['acme', 'invoices', 'i1', env] }))
    const getRes = await handler.handle(req('POST', '/rpc', { method: 'get', args: ['acme', 'invoices', 'i1'] }))
    const got = JSON.parse(getRes.body as string) as EncryptedEnvelope
    expect(got._data).toBe('c2VjcmV0LWNpcGhlcnRleHQ=')
  })

  // ── CAS conflict ────────────────────────────────────────────────

  it('put with a stale expectedVersion → 409 with {error:{name:ConflictError,version}}', async () => {
    const handler = createRestHandler({ store, authorize: allowAll })
    await handler.handle(req('POST', '/rpc', { method: 'put', args: ['acme', 'invoices', 'i1', envelope({ _v: 1 })] }))

    const res = await handler.handle(
      req('POST', '/rpc', { method: 'put', args: ['acme', 'invoices', 'i1', envelope({ _v: 2 }), 99] })
    )
    expect(res.status).toBe(409)
    const body = JSON.parse(res.body as string) as { error: { name: string; message: string; version: number } }
    expect(body.error.name).toBe('ConflictError')
    expect(typeof body.error.version).toBe('number')
    expect(body.error.version).toBe(1)
  })

  // ── Fail-closed auth ────────────────────────────────────────────

  it('no authorize supplied → every /rpc → 401 (fail-closed)', async () => {
    const handler = createRestHandler({ store })
    const res = await handler.handle(req('POST', '/rpc', { method: 'get', args: ['acme', 'invoices', 'i1'] }))
    expect(res.status).toBe(401)
  })

  it('authorize returning false → 401', async () => {
    const handler = createRestHandler({ store, authorize: () => false })
    const res = await handler.handle(req('POST', '/rpc', { method: 'get', args: ['acme', 'invoices', 'i1'] }))
    expect(res.status).toBe(401)
  })

  it('authorize returning true → 200', async () => {
    const handler = createRestHandler({ store, authorize: () => true })
    const res = await handler.handle(req('POST', '/rpc', { method: 'list', args: ['acme', 'invoices'] }))
    expect(res.status).toBe(200)
  })

  it('authorize that throws → 500 (fail-closed, structured response, never open or uncaught)', async () => {
    const handler = createRestHandler({
      store,
      authorize: () => {
        throw new Error('auth backend down')
      },
    })
    const res = await handler.handle(req('POST', '/rpc', { method: 'get', args: ['acme', 'invoices', 'i1'] }))
    expect(res.status).toBe(500)
    // must not fall open, and must not leak the internal reason
    expect(res.status).not.toBe(200)
    expect(res.body).not.toContain('auth backend down')
  })

  // ── allow allowlist ─────────────────────────────────────────────

  it('allow: Set(["get","list"]) → put is 403, get is 200', async () => {
    const handler = createRestHandler({ store, authorize: allowAll, allow: new Set(['get', 'list']) })
    const putRes = await handler.handle(req('POST', '/rpc', { method: 'put', args: ['acme', 'invoices', 'i1', envelope()] }))
    expect(putRes.status).toBe(403)

    const getRes = await handler.handle(req('POST', '/rpc', { method: 'get', args: ['acme', 'invoices', 'i1'] }))
    expect(getRes.status).toBe(200)
  })

  // ── Unknown / malformed ─────────────────────────────────────────

  it('unknown method → 400', async () => {
    const handler = createRestHandler({ store, authorize: allowAll })
    const res = await handler.handle(req('POST', '/rpc', { method: 'frobnicate', args: [] }))
    expect(res.status).toBe(400)
  })

  it('body without an args array → 400', async () => {
    const handler = createRestHandler({ store, authorize: allowAll })
    const res = await handler.handle(req('POST', '/rpc', { method: 'get' }))
    expect(res.status).toBe(400)
  })

  it('malformed JSON body → 400', async () => {
    const handler = createRestHandler({ store, authorize: allowAll })
    const badReq: RestRequest = {
      method: 'POST',
      pathname: '/rpc',
      searchParams: new URLSearchParams(),
      headers: { 'content-type': 'application/json' },
      json: () => Promise.reject(new Error('invalid json')),
    }
    const res = await handler.handle(badReq)
    expect(res.status).toBe(400)
  })

  // ── Optional-method + error-message hygiene ─────────────────────

  it('unsupported optional method → 501 (client can feature-detect, not 400)', async () => {
    // toMemory implements only the 6 core methods — not listVaults.
    const handler = createRestHandler({ store, authorize: allowAll })
    const res = await handler.handle(req('POST', '/rpc', { method: 'listVaults', args: [] }))
    expect(res.status).toBe(501)
    const body = JSON.parse(res.body as string) as { error: { name: string } }
    expect(body.error.name).toBe('NotImplemented')
  })

  it('a store error does not leak its raw message to the client (500)', async () => {
    const leaky: NoydbStore = {
      name: 'leaky',
      async get(): Promise<EncryptedEnvelope | null> {
        throw new Error('postgres://user:secret@db.internal:5432 connection refused')
      },
      async put() {},
      async delete() {},
      async list() { return [] },
      async loadAll(): Promise<VaultSnapshot> { return {} },
      async saveAll() {},
    }
    const handler = createRestHandler({ store: leaky, authorize: allowAll })
    const res = await handler.handle(req('POST', '/rpc', { method: 'get', args: ['acme', 'invoices', 'i1'] }))
    expect(res.status).toBe(500)
    expect(res.body).not.toContain('secret')
    expect(res.body).not.toContain('postgres://')
  })

  // ── Routing / basePath ──────────────────────────────────────────

  it('unmatched path/method → 404', async () => {
    const handler = createRestHandler({ store, authorize: allowAll })
    const res = await handler.handle(req('GET', '/rpc'))
    expect(res.status).toBe(404)

    const res2 = await handler.handle(req('POST', '/vaults/acme/collections/invoices/i1'))
    expect(res2.status).toBe(404)
  })

  it('basePath option strips the prefix before routing', async () => {
    const handler = createRestHandler({ store, authorize: allowAll, basePath: '/api/noydb' })
    const res = await handler.handle(req('POST', '/api/noydb/rpc', { method: 'list', args: ['acme', 'invoices'] }))
    expect(res.status).toBe(200)
  })
})
