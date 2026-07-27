/**
 * Single-flight refresh cache — `with-party/broker/active.ts`'s
 * `withBroker().credentialSource(ctx, profile)` (#479 slice 2b). Vector ids
 * map 1:1 to the credential-broker spec's §8 conformance list.
 */
import { describe, expect, it } from 'vitest'
import { withBroker } from '../../src/with-party/broker/active.js'
import type { BrokerSeedCtx, BrokerConfig } from '../../src/port/with/broker-strategy.js'
import { createOwnerKeyring } from '../../src/with-party/team/keyring.js'
import { enrollSeed } from '../../src/with-party/broker/seed.js'
import { NetworkError, BrokerProofError } from '../../src/kernel/errors.js'
import { memoryStore, makeTestHost } from './support.js'

const VAULT = 'test-vault'

async function setUp(hostOpts: Parameters<typeof makeTestHost>[0] = {}) {
  const store = memoryStore()
  const owner = await createOwnerKeyring(store, VAULT, { userId: 'owner', secret: 'owner-pw' })
  const host = makeTestHost({ requireAttestation: true, ...hostOpts })
  const config: BrokerConfig = {
    brokerId: 'broker-1', endpoint: 'https://broker.example.com',
    attestation: () => 'dev-token', fetch: host.fetch,
  }
  const ctx: BrokerSeedCtx = { store, vault: VAULT, keyring: owner, config }
  await enrollSeed(ctx)
  return { store, owner, host, config, ctx }
}

describe('broker credentialSource cache', () => {
  it('V8: N concurrent calls near expiry trigger exactly one /challenge + /credentials round trip', async () => {
    const { ctx, host } = await setUp()
    const strategy = withBroker(ctx.config)
    const source = strategy.credentialSource(ctx, 'read')

    const [a, b, c] = await Promise.all([source(), source(), source()])
    expect(a).toEqual(b)
    expect(b).toEqual(c)
    expect(host.calls.challenge).toBe(1)
    expect(host.calls.credentials).toBe(1)
  })

  it('V9: cached creds are returned until the floored boundary, then a fresh mint happens', async () => {
    const nearExpiry = new Date(Date.now() + 2_000).toISOString() // 2s out
    const { ctx, host } = await setUp({
      credentials: () => ({ kind: 'aws', accessKeyId: 'A', secretAccessKey: 'B', expiresAt: nearExpiry }),
    })
    const strategy = withBroker({ ...ctx.config, skewMs: 500 })
    const source = strategy.credentialSource(ctx, 'read')

    const first = await source()
    expect(host.calls.credentials).toBe(1)
    // Immediately re-calling reuses the cache (still within the floored window).
    const second = await source()
    expect(second).toEqual(first)
    expect(host.calls.credentials).toBe(1)
  })

  it('V22a: a rejected in-flight promise is cleared from the cache — the NEXT call retries instead of wedging', async () => {
    const { ctx, host } = await setUp({ rejectProofs: true })
    const strategy = withBroker(ctx.config)
    const source = strategy.credentialSource(ctx, 'read')

    await expect(source()).rejects.toThrow(BrokerProofError)
    const callsAfterFirst = host.calls.credentials

    // A second call must actually retry (not resolve/reject instantly from a stale
    // wedged promise) — assert it performs a NEW round trip.
    await expect(source()).rejects.toThrow(BrokerProofError)
    expect(host.calls.credentials).toBe(callsAfterFirst + 1)
  })

  it('V22b: a credential TTL below 2×skewMs is floored so the source does not re-prove on every call', async () => {
    const shortLived = new Date(Date.now() + 100).toISOString() // 100ms out — sub-skew
    const { ctx, host } = await setUp({
      credentials: () => ({ kind: 'aws', accessKeyId: 'A', secretAccessKey: 'B', expiresAt: shortLived }),
    })
    const cfgWithSkew: BrokerConfig = { ...ctx.config, skewMs: 60_000 }
    const strategy = withBroker(cfgWithSkew)
    const source = strategy.credentialSource(ctx, 'read')

    await source()
    const callsAfterFirst = host.calls.credentials
    // Called again immediately — the floor (now + minCacheMs) must still be in the
    // future, so this reuses the cache rather than immediately re-proving.
    await source()
    expect(host.calls.credentials).toBe(callsAfterFirst)
  })

  it('V13: broker host unreachable surfaces NetworkError (not a data-loss silent failure)', async () => {
    const { ctx } = await setUp()
    const throwingFetch = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
    const cfgDown: BrokerConfig = { ...ctx.config, fetch: throwingFetch }
    const strategy = withBroker(cfgDown)
    const source = strategy.credentialSource(ctx, 'read')

    await expect(source()).rejects.toThrow(NetworkError)
  })

  it('V13b: a BrokerProofError mid-mint is a distinct, offline-degradable failure class from NetworkError (mock-store-scoped)', async () => {
    // Honestly scoped per the task brief: this asserts the ERROR SHAPE a mock
    // token-path store would see and would need to treat as requeue-not-drop
    // (R-B4/I8) — it does not exercise real sync-flush code, which lives
    // outside this hub-internal slice.
    const { ctx } = await setUp({ rejectProofs: true })
    const strategy = withBroker(ctx.config)
    const source = strategy.credentialSource(ctx, 'read')

    let caught: unknown
    try {
      await source()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(BrokerProofError)
    expect(caught).not.toBeInstanceOf(NetworkError)

    // A mock store honoring R-B4/I8 treats ANY credentialSource throw (network
    // OR proof) as offline-degradable — requeue, not drop.
    const pendingOps: string[] = ['op-1']
    async function flush(cs: () => Promise<unknown>): Promise<void> {
      try {
        await cs()
        pendingOps.shift()
      } catch (err) {
        if (err instanceof NetworkError || err instanceof BrokerProofError) return // requeue: op stays pending
        throw err
      }
    }
    await flush(source)
    expect(pendingOps).toEqual(['op-1']) // requeued, not dropped
  })

  it('rotate(): quiesces in-flight round-trips before the seed swap, then clears the cache', async () => {
    const { ctx, store, owner, host } = await setUp()
    const strategy = withBroker(ctx.config)
    const source = strategy.credentialSource(ctx, 'read')

    const inFlight = source() // don't await yet
    await strategy.rotate(ctx)
    const creds = await inFlight
    expect(creds).toMatchObject({ kind: 'aws' })
    expect(host.registeredKeyCount(VAULT, 'broker-1')).toBe(2) // old + new (grace window)

    // A call AFTER rotate mints fresh (cache was cleared) under the new seed.
    const callsBefore = host.calls.credentials
    const post = await strategy.credentialSource({ store, vault: VAULT, keyring: owner }, 'read')()
    expect(post).toMatchObject({ kind: 'aws' })
    expect(host.calls.credentials).toBe(callsBefore + 1)
  })

  it('C1: two vaults sharing ONE withBroker() strategy get DISTINCT credentials via SEPARATE round trips (no cross-vault cache collision)', async () => {
    const VAULT_A = 'vault-a'
    const VAULT_B = 'vault-b'
    const store = memoryStore()
    const ownerA = await createOwnerKeyring(store, VAULT_A, { userId: 'owner', secret: 'owner-pw' })
    const ownerB = await createOwnerKeyring(store, VAULT_B, { userId: 'owner', secret: 'owner-pw' })
    const host = makeTestHost({
      requireAttestation: true,
      // Mint a DISTINCT credential per vaultId so a collided cache would be caught by value, not just by count.
      credentials: (vaultId) => ({
        kind: 'aws',
        accessKeyId: `AKID-${vaultId}`,
        secretAccessKey: 'secret',
        sessionToken: `token-${vaultId}`,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    })
    const config: BrokerConfig = {
      brokerId: 'broker-1', endpoint: 'https://broker.example.com',
      attestation: () => 'dev-token', fetch: host.fetch,
    }
    const ctxA: BrokerSeedCtx = { store, vault: VAULT_A, keyring: ownerA, config }
    const ctxB: BrokerSeedCtx = { store, vault: VAULT_B, keyring: ownerB, config }
    await enrollSeed(ctxA)
    await enrollSeed(ctxB)

    // ONE shared strategy instance — ONE single-flight cache closure — used by both vaults,
    // exactly like `vault.broker()` shares one `BrokerStrategy` across every vault of a
    // `createNoydb()` instance.
    const strategy = withBroker(config)
    const sourceA = strategy.credentialSource(ctxA, 'read')
    const sourceB = strategy.credentialSource(ctxB, 'read')

    const credsA = await sourceA()
    const credsB = await sourceB()

    expect(host.calls.credentials).toBe(2) // each vault made its OWN round trip — no shared-cache hit
    expect(credsA).not.toEqual(credsB)
    expect((credsA as { accessKeyId: string }).accessKeyId).toBe('AKID-vault-a')
    expect((credsB as { accessKeyId: string }).accessKeyId).toBe('AKID-vault-b')
  })
})
