import { describe, it, expect } from 'vitest'
import { memory } from '@noy-db/to-memory'
import { ConflictError } from '@noy-db/hub'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { pairInMemory, peerStore, servePeerStore } from '../src/index.js'

function envelope(v: number, iv = 'aaaa'): EncryptedEnvelope {
  return {
    _noydb: 1,
    _v: v,
    _ts: new Date(1700000000000 + v * 1000).toISOString(),
    _iv: iv,
    _data: `ciphertext-${v}`,
  }
}

describe('peerStore + servePeerStore', () => {
  it('round-trips all six core methods through an in-memory channel pair', async () => {
    const [a, b] = pairInMemory()
    const remote = memory()
    const dispose = servePeerStore({ channel: b, store: remote })
    const local = peerStore({ channel: a })

    const env = envelope(1)
    await local.put('v1', 'c1', 'r1', env)
    expect(await local.get('v1', 'c1', 'r1')).toEqual(env)

    const ids = await local.list('v1', 'c1')
    expect(ids).toEqual(['r1'])

    await local.put('v1', 'c1', 'r2', envelope(1, 'bbbb'))
    const snap = await local.loadAll('v1')
    expect(Object.keys(snap['c1']!).sort()).toEqual(['r1', 'r2'])

    await local.delete('v1', 'c1', 'r1')
    expect(await local.get('v1', 'c1', 'r1')).toBeNull()

    await local.saveAll('v2', { c2: { id1: envelope(7) } })
    expect(await local.get('v2', 'c2', 'id1')).toEqual(envelope(7))

    local.dispose()
    dispose()
  })

  it('re-hydrates ConflictError with .version across the wire', async () => {
    const [a, b] = pairInMemory()
    const remote = memory()
    const dispose = servePeerStore({ channel: b, store: remote })
    const local = peerStore({ channel: a })

    await local.put('v1', 'c1', 'r1', envelope(1))

    await expect(local.put('v1', 'c1', 'r1', envelope(2), 999)).rejects.toBeInstanceOf(ConflictError)
    try {
      await local.put('v1', 'c1', 'r1', envelope(2), 999)
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError)
      expect((err as ConflictError).version).toBe(1)
    }

    local.dispose()
    dispose()
  })

  it('surfaces unknown remote methods as an Error', async () => {
    const [a, b] = pairInMemory()
    const remote = memory()
    const dispose = servePeerStore({ channel: b, store: remote })

    const { createRpcClient } = await import('../src/index.js')
    const rpc = createRpcClient(a)
    await expect(rpc.call('noSuchMethod', [])).rejects.toThrow(/Unknown RPC method/)

    rpc.dispose()
    dispose()
  })

  it('enforces the read-only allow whitelist', async () => {
    const [a, b] = pairInMemory()
    const remote = memory()
    await remote.put('v1', 'c1', 'r1', envelope(1))

    const dispose = servePeerStore({
      channel: b,
      store: remote,
      allow: new Set(['get', 'list', 'loadAll', 'ping']),
    })
    const local = peerStore({ channel: a })

    expect(await local.get('v1', 'c1', 'r1')).toEqual(envelope(1))
    await expect(local.put('v1', 'c1', 'r2', envelope(1))).rejects.toThrow(/not allowed/)

    local.dispose()
    dispose()
  })

  it('rejects pending calls when the channel closes', async () => {
    const [a, b] = pairInMemory()
    const remote = memory()
    // Don't wire serve on b — we want the call to hang.
    const local = peerStore({ channel: a, timeoutMs: 60_000 })

    const pending = local.get('v1', 'c1', 'r1')
    b.close()
    await expect(pending).rejects.toThrow(/closed before response/)

    // Use `remote` so it's not flagged unused.
    expect(remote.name).toBe('memory')

    local.dispose()
  })

  it('times out when the remote never responds', async () => {
    const [a] = pairInMemory()
    const local = peerStore({ channel: a, timeoutMs: 50 })

    await expect(local.get('v1', 'c1', 'r1')).rejects.toThrow(/timed out/)
    local.dispose()
  })
})
