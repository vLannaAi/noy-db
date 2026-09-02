import { describe, it, expect } from 'vitest'
import { memoryStore } from '@noy-db/hub'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { pairInMemory, peerStore, servePeerStore } from '../src/index.js'

const envelope = (v: number): EncryptedEnvelope => ({
  _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(),
  _iv: 'aaaa', _data: `ciphertext-${v}`,
})

/**
 * Milestone 52 — `servePeerStore` was fail-OPEN: its options were
 * `{ channel, store, allow?, leaderElection? }` with no authorize hook at all,
 * and `allow` is a METHOD whitelist, not authentication. Anyone reaching the
 * channel got the whole store.
 *
 * Fail-open is defensible for a 1:1 invite-based session share, where holding
 * the channel IS the credential. It stops being defensible the moment a channel
 * stops meaning "I invited this person" — which is exactly what milestone 53
 * (multi-peer) does, and why 53 is blocked on this.
 *
 * Auth shape decided 2026-08-11: a bearer token from the invite, fail-closed —
 * matching `in-rest`, where no authorize means 401 on everything.
 */
describe('servePeerStore is fail-closed (milestone 52)', () => {
  it('serves a request carrying the right token', async () => {
    // The honest control. Every refusal below is only evidence because this
    // same path succeeds.
    const [a, b] = pairInMemory()
    const remote = memoryStore()
    await remote.put('v', 'c', 'id1', envelope(1))
    const dispose = servePeerStore({ channel: b, store: remote, token: 'from-the-invite' })
    const local = peerStore({ channel: a, token: 'from-the-invite' })

    expect(await local.get('v', 'c', 'id1')).toEqual(envelope(1))
    local.dispose(); dispose()
  })

  it('REFUSES a client presenting no token', async () => {
    const [a, b] = pairInMemory()
    const remote = memoryStore()
    await remote.put('v', 'c', 'id1', envelope(1))
    const dispose = servePeerStore({ channel: b, store: remote, token: 'from-the-invite' })
    const local = peerStore({ channel: a })   // no token

    await expect(local.get('v', 'c', 'id1')).rejects.toThrow(/unauthor/i)
    local.dispose(); dispose()
  })

  it('REFUSES a client presenting the wrong token', async () => {
    const [a, b] = pairInMemory()
    const remote = memoryStore()
    const dispose = servePeerStore({ channel: b, store: remote, token: 'from-the-invite' })
    const local = peerStore({ channel: a, token: 'guessed' })

    await expect(local.get('v', 'c', 'id1')).rejects.toThrow(/unauthor/i)
    local.dispose(); dispose()
  })

  it('FAIL-CLOSED: a server configured with no token serves nobody', async () => {
    // The load-bearing case. Previously this configuration served everything.
    // Matching in-rest: no credential configured means refuse, not allow.
    const [a, b] = pairInMemory()
    const remote = memoryStore()
    await remote.put('v', 'c', 'id1', envelope(1))
    const dispose = servePeerStore({ channel: b, store: remote })   // no token
    const local = peerStore({ channel: a, token: 'anything' })

    await expect(local.get('v', 'c', 'id1')).rejects.toThrow(/unauthor/i)
    local.dispose(); dispose()
  })

  it('refuses BEFORE touching the store — a rejected write must not land', async () => {
    // Refusing after the effect would be worse than not refusing: the caller
    // sees an error and the write happened anyway.
    const [a, b] = pairInMemory()
    const remote = memoryStore()
    const dispose = servePeerStore({ channel: b, store: remote, token: 'right' })
    const local = peerStore({ channel: a, token: 'wrong' })

    await expect(local.put('v', 'c', 'id1', envelope(1))).rejects.toThrow(/unauthor/i)
    expect(await remote.get('v', 'c', 'id1')).toBeNull()
    local.dispose(); dispose()
  })

  it('the method allowlist still applies on top of a valid token', async () => {
    // `allow` was never authentication and still is not — it composes with it.
    const [a, b] = pairInMemory()
    const remote = memoryStore()
    const dispose = servePeerStore({
      channel: b, store: remote, token: 't', allow: new Set(['get']),
    })
    const local = peerStore({ channel: a, token: 't' })

    await expect(local.put('v', 'c', 'id1', envelope(1))).rejects.toThrow(/not allowed/i)
    local.dispose(); dispose()
  })
})

describe('auth is checked BEFORE method validity (milestone 52)', () => {
  it('an unauthorized caller cannot learn which methods exist', async () => {
    // Ordering is a security property, not an implementation detail. If method
    // validity were checked first, "Unknown RPC method: x" versus
    // "Unauthorized" would tell an unauthenticated caller which of the six
    // methods this peer serves — an existence oracle, the same class as
    // enumeration via `listVaults`. Both answers must be identical.
    const [a, b] = pairInMemory()
    const dispose = servePeerStore({ channel: b, store: memoryStore(), token: 'right' })
    const local = peerStore({ channel: a, token: 'wrong' })

    const real = await local.get('v', 'c', 'id').catch((e: Error) => e.message)
    local.dispose()

    const [c, d] = pairInMemory()
    const dispose2 = servePeerStore({ channel: d, store: memoryStore(), token: 'right' })
    const { createRpcClient } = await import('../src/index.js')
    const rpc = createRpcClient(c, { token: 'wrong' })
    const bogus = await rpc.call('noSuchMethod', []).catch((e: Error) => e.message)
    rpc.dispose(); dispose2(); dispose()

    expect(real).toMatch(/unauthor/i)
    expect(bogus).toBe(real)   // indistinguishable, by construction
  })
})
