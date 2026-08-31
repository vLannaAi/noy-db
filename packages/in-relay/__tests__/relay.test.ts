// #1237 — the relay profile, tested for the property it exists to have.
import { describe, it, expect } from 'vitest'
import type { NoydbRelayStore, EncryptedEnvelope } from '@noy-db/hub/to'
import { createRelayHandler, RELAY_METHODS, NOT_RELAYED } from '../src/index.js'

function relayStore(): NoydbRelayStore & { calls: string[] } {
  const data = new Map<string, EncryptedEnvelope>()
  const calls: string[] = []
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    calls,
    async get(v, c, i) { calls.push('get'); return data.get(k(v, c, i)) ?? null },
    async put(v, c, i, e) { calls.push('put'); data.set(k(v, c, i), e) },
    async delete(v, c, i) { calls.push('delete'); data.delete(k(v, c, i)) },
    async list(v, c) { calls.push('list'); const p = `${v}/${c}/`; return [...data.keys()].filter(x => x.startsWith(p)).map(x => x.slice(p.length)) },
    async loadAll() { calls.push('loadAll'); return {} },
  }
}
const env = { _data: 'x', _v: 1 } as unknown as EncryptedEnvelope

describe('relay vocabulary', () => {
  it('excludes saveAll and listVaults BY CONSTRUCTION', () => {
    expect(RELAY_METHODS).not.toContain('saveAll')
    expect(RELAY_METHODS).not.toContain('listVaults')
    // The list cannot drift from the type: a store typed as NoydbRelayStore has
    // no such members, so adding either name would not compile a dispatch.
    expect([...RELAY_METHODS].sort()).toEqual(
      ['delete', 'estimateUsage', 'get', 'getStoreTime', 'list', 'listPage',
       'listSince', 'loadAll', 'ping', 'presencePublish', 'put', 'tx'],
    )
  })

  it('serves the granular methods', async () => {
    const store = relayStore()
    const handle = createRelayHandler({ store })
    expect(await handle({ id: '1', method: 'put', args: ['v', 'c', 'r1', env] })).toMatchObject({ ok: true })
    expect(await handle({ id: '2', method: 'get', args: ['v', 'c', 'r1'] })).toMatchObject({ ok: true })
    expect(await handle({ id: '3', method: 'list', args: ['v', 'c'] })).toMatchObject({ ok: true, value: ['r1'] })
    expect(store.calls).toEqual(['put', 'get', 'list'])
  })

  it('refuses saveAll as UNKNOWN (400), not forbidden (403)', async () => {
    // A 403 would confirm the method exists and is merely disallowed here,
    // naming the excluded surface to anyone probing.
    const handle = createRelayHandler({ store: relayStore() })
    const r = await handle({ id: '9', method: 'saveAll', args: ['v', {}] })
    expect(r).toMatchObject({ ok: false, status: 400 })
    expect(r.ok === false && r.error.name).toBe('UnknownRelayMethodError')
  })

  it('refuses listVaults identically — indistinguishable from any other unknown name', async () => {
    const handle = createRelayHandler({ store: relayStore() })
    const excluded = await handle({ id: '1', method: 'listVaults', args: [] })
    const nonsense = await handle({ id: '2', method: 'notAMethodAtAll', args: [] })
    // The CONTROL that gives the previous test meaning: an excluded member and
    // a name that never existed must be indistinguishable, or the refusal
    // itself leaks which methods were deliberately removed.
    expect(excluded.ok === false && excluded.status).toBe(nonsense.ok === false && nonsense.status)
    expect(excluded.ok === false && excluded.error.name).toBe(nonsense.ok === false && nonsense.error.name)
  })

  it('a store CARRYING saveAll still cannot be made to call it', async () => {
    // The realistic case: an ordinary full store is handed in. It has saveAll
    // at runtime; the handler is typed such that no frame can reach it.
    let saveAllCalled = false
    const full = { ...relayStore(), async saveAll() { saveAllCalled = true }, async listVaults() { return ['secret-vault'] } }
    const handle = createRelayHandler({ store: full })
    await handle({ id: '1', method: 'saveAll', args: ['v', {}] })
    await handle({ id: '2', method: 'listVaults', args: [] })
    expect(saveAllCalled).toBe(false)
  })

  it('forwards an error by NAME so a client can re-hydrate it (#1218 seam contract)', async () => {
    const store = { ...relayStore(), async get() { const e = new Error('version mismatch'); e.name = 'ConflictError'; throw e } }
    const handle = createRelayHandler({ store })
    const r = await handle({ id: '1', method: 'get', args: ['v', 'c', 'r1'] })
    expect(r).toMatchObject({ ok: false, status: 500 })
    expect(r.ok === false && r.error.name).toBe('ConflictError')
  })
})

/**
 * Follow-ups from doi-db's by-hand parity comparison against the published
 * 0.7.0-pre.16, in week one of a frozen first publish.
 */
describe('vocabulary completeness and capability gaps (parity follow-up)', () => {
  it('dispatches listPage — its absence made clients fall back to loadAll', async () => {
    const page = { ids: ['r1'], cursor: null }
    const store = { ...relayStore(), async listPage() { return page } }
    const handle = createRelayHandler({ store })
    const r = await handle({ id: '1', method: 'listPage', args: ['v', 'c', undefined, 10] })
    expect(r).toMatchObject({ ok: true, value: page })
  })

  it('a store lacking an OPTIONAL method gets 501, not 500', async () => {
    // The collapse this fixes: an absent optional method threw
    // UnknownRelayMethodError from inside dispatch and surfaced as 500,
    // reporting a store capability gap as a server fault. A client should
    // degrade on 501; an operator should investigate a 500.
    const handle = createRelayHandler({ store: relayStore() })   // no listSince/listPage
    for (const method of ['listSince', 'listPage', 'getStoreTime', 'estimateUsage', 'tx']) {
      const r = await handle({ id: '1', method, args: [] })
      expect(r, `${method} should be 501`).toMatchObject({ ok: false, status: 501 })
      expect(r.ok === false && r.error.name).toBe('UnsupportedRelayMethodError')
    }
  })

  it('501 and 400 stay DISTINCT — an unknown method is not a capability gap', async () => {
    const handle = createRelayHandler({ store: relayStore() })
    const unknown = await handle({ id: '1', method: 'saveAll', args: [] })
    const unsupported = await handle({ id: '2', method: 'listSince', args: [] })
    expect(unknown.ok === false && unknown.status).toBe(400)
    expect(unsupported.ok === false && unsupported.status).toBe(501)
  })

  it('the EXCLUDED members stay 400-unknown even though 501 now exists', async () => {
    // 501 must not become a way to learn that saveAll/listVaults were removed:
    // they are refused before dispatch, indistinguishable from a typo.
    const handle = createRelayHandler({ store: relayStore() })
    for (const method of ['saveAll', 'listVaults', 'presignUrl', 'presenceSubscribe', 'nonsense']) {
      const r = await handle({ id: '1', method, args: [] })
      expect(r, `${method}`).toMatchObject({ ok: false, status: 400 })
      expect(r.ok === false && r.error.name).toBe('UnknownRelayMethodError')
    }
  })

  it('NOT_RELAYED names every deliberate exclusion, so the vocabulary cannot drift silently', () => {
    // The compile-time check in src enforces coverage; this pins the REASONS
    // list so an exclusion cannot be added without appearing here.
    expect([...NOT_RELAYED].sort()).toEqual(['presenceSubscribe', 'presignUrl'])
    expect(RELAY_METHODS).not.toContain('presignUrl')
    expect(RELAY_METHODS).not.toContain('saveAll')
  })
})
