import { describe, it, expect } from 'vitest'
import { memoryStore } from '@noy-db/hub'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { pairInMemory, peerStore, serveMultiPeerStore } from '../src/index.js'

const envelope = (v: number): EncryptedEnvelope => ({
  _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(),
  _iv: 'aaaa', _data: `ciphertext-${v}`,
})

/**
 * #1239 — a browser peer that accepts N invites instead of 1. Star topology:
 * every invited peer talks to the hub peer, never to each other.
 *
 * The one thing that is not assembly is A TOKEN PER PEER. `servePeerStore`
 * takes one token, which is right for 1:1; N invites means N tokens, and the
 * failure mode to design against is a multi-peer API where "no token" quietly
 * becomes "any peer" — the pre-#1236 behaviour arriving by a different route.
 */
describe('serveMultiPeerStore — N invites, one token per peer (#1239)', () => {
  it('serves two peers, each on its own channel with its own token — the honest control', async () => {
    const hub = memoryStore()
    const server = serveMultiPeerStore({ store: hub })
    const [a1, b1] = pairInMemory()
    const [a2, b2] = pairInMemory()
    server.accept({ channel: b1, token: 'invite-for-alice' })
    server.accept({ channel: b2, token: 'invite-for-bob' })
    const alice = peerStore({ channel: a1, token: 'invite-for-alice' })
    const bob = peerStore({ channel: a2, token: 'invite-for-bob' })

    await alice.put('v', 'c', 'from-alice', envelope(1))
    expect(await bob.get('v', 'c', 'from-alice')).toEqual(envelope(1))
    expect(server.size).toBe(2)
    alice.dispose(); bob.dispose(); server.dispose()
  })

  it('a token is bound to the channel it was accepted on — another peer\'s token is refused', async () => {
    const server = serveMultiPeerStore({ store: memoryStore() })
    const [a1, b1] = pairInMemory()
    const [a2, b2] = pairInMemory()
    server.accept({ channel: b1, token: 'invite-for-alice' })
    server.accept({ channel: b2, token: 'invite-for-bob' })
    const mallory = peerStore({ channel: a2, token: 'invite-for-alice' })   // bob's channel, alice's token

    await expect(mallory.get('v', 'c', 'x')).rejects.toThrow(/unauthor/i)
    // And the right token on that channel still works.
    const bob = peerStore({ channel: a2, token: 'invite-for-bob' })
    expect(await bob.get('v', 'c', 'x')).toBeNull()
    void a1
    mallory.dispose(); bob.dispose(); server.dispose()
  })

  it('revoking one peer does not touch the others', async () => {
    const server = serveMultiPeerStore({ store: memoryStore() })
    const [a1, b1] = pairInMemory()
    const [a2, b2] = pairInMemory()
    const revokeAlice = server.accept({ channel: b1, token: 'invite-for-alice' })
    server.accept({ channel: b2, token: 'invite-for-bob' })
    const alice = peerStore({ channel: a1, token: 'invite-for-alice', timeoutMs: 200 })
    const bob = peerStore({ channel: a2, token: 'invite-for-bob' })
    expect(await alice.get('v', 'c', 'x')).toBeNull()

    revokeAlice()
    expect(server.size).toBe(1)
    // Nothing answers on alice's channel any more: the request times out
    // rather than being served. (Revocation stops serving; the channel itself
    // stays with its owner, as with servePeerStore's dispose.)
    await expect(alice.get('v', 'c', 'x')).rejects.toThrow(/timed out/)
    expect(await bob.get('v', 'c', 'x')).toBeNull()
    revokeAlice() // idempotent
    expect(server.size).toBe(1)
    alice.dispose(); bob.dispose(); server.dispose()
  })

  it('FAIL-CLOSED survives the widening: an invite with no token is refused at accept()', () => {
    const server = serveMultiPeerStore({ store: memoryStore() })
    const [, b] = pairInMemory()
    expect(() => server.accept({ channel: b, token: '' })).toThrow(/token/i)
    // @ts-expect-error — token is required by type; the runtime check is for JS callers.
    expect(() => server.accept({ channel: b })).toThrow(/token/i)
    expect(server.size).toBe(0)
    server.dispose()
  })

  it('refuses a token that is already live — one token, one peer, or revocation and attribution are meaningless', () => {
    const server = serveMultiPeerStore({ store: memoryStore() })
    const [, b1] = pairInMemory()
    const [, b2] = pairInMemory()
    server.accept({ channel: b1, token: 'same' })
    expect(() => server.accept({ channel: b2, token: 'same' })).toThrow(/already/i)
    expect(server.size).toBe(1)
    server.dispose()
  })

  it('a peer whose channel closes is dropped, and its token may be issued again', () => {
    const server = serveMultiPeerStore({ store: memoryStore() })
    const [, b1] = pairInMemory()
    server.accept({ channel: b1, token: 't' })
    b1.close()
    expect(server.size).toBe(0)
    const [, b2] = pairInMemory()
    expect(() => server.accept({ channel: b2, token: 't' })).not.toThrow()
    server.dispose()
  })

  it('a per-invite allow set makes one peer read-only without affecting the others', async () => {
    const server = serveMultiPeerStore({ store: memoryStore() })
    const [a1, b1] = pairInMemory()
    const [a2, b2] = pairInMemory()
    server.accept({ channel: b1, token: 'writer' })
    server.accept({ channel: b2, token: 'reader', allow: new Set(['get', 'list', 'loadAll', 'ping']) })
    const writer = peerStore({ channel: a1, token: 'writer' })
    const reader = peerStore({ channel: a2, token: 'reader' })

    await writer.put('v', 'c', 'id', envelope(1))
    expect(await reader.get('v', 'c', 'id')).toEqual(envelope(1))
    await expect(reader.put('v', 'c', 'id2', envelope(2))).rejects.toThrow(/not allowed/i)
    writer.dispose(); reader.dispose(); server.dispose()
  })

  it('dispose() revokes every peer and further accept() is refused', async () => {
    const server = serveMultiPeerStore({ store: memoryStore() })
    const [a1, b1] = pairInMemory()
    server.accept({ channel: b1, token: 't' })
    const p = peerStore({ channel: a1, token: 't', timeoutMs: 200 })
    server.dispose()
    expect(server.size).toBe(0)
    await expect(p.get('v', 'c', 'x')).rejects.toThrow(/timed out/)
    const [, b2] = pairInMemory()
    expect(() => server.accept({ channel: b2, token: 'u' })).toThrow(/disposed/i)
    p.dispose()
  })
})
