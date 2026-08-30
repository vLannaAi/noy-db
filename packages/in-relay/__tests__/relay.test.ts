// #1237 — the relay profile, tested for the property it exists to have.
import { describe, it, expect } from 'vitest'
import type { NoydbRelayStore, EncryptedEnvelope } from '@noy-db/hub/to'
import { createRelayHandler, RELAY_METHODS } from '../src/index.js'

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
      ['delete', 'get', 'list', 'listSince', 'loadAll', 'ping', 'put'],
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
