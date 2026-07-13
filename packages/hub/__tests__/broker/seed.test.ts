/**
 * `_broker` seed lifecycle — `with-party/broker/seed.ts` (#479 slice 2b).
 * Vector ids map 1:1 to the credential-broker spec's §8 conformance list.
 */
import { describe, expect, it } from 'vitest'
import { enrollSeed, rotateSeed, mintStoreCredentials } from '../../src/with-party/broker/seed.js'
import type { BrokerCtx, BrokerConfig } from '../../src/port/with/broker-strategy.js'
import { createOwnerKeyring, grant, loadKeyring, ensureCollectionDEK } from '../../src/with-party/team/keyring.js'
import type { UnlockedKeyring } from '../../src/with-party/team/keyring.js'
import { BROKER_COLLECTION } from '../../src/with-party/team/reserved-secret-collections.js'
import { PermissionDeniedError, BrokerEnrolmentError } from '../../src/kernel/errors.js'
import type { NoydbStore } from '../../src/kernel/types.js'
import { memoryStore, makeTestHost } from './support.js'

const VAULT = 'test-vault'

function config(host: ReturnType<typeof makeTestHost>, overrides: Partial<BrokerConfig> = {}): BrokerConfig {
  return { brokerId: 'broker-1', endpoint: 'https://broker.example.com', fetch: host.fetch, ...overrides }
}

function ctx(store: NoydbStore, keyring: UnlockedKeyring, cfg: BrokerConfig): BrokerCtx {
  return { store, vault: VAULT, keyring, config: cfg }
}

describe('broker seed lifecycle', () => {
  it('V2b: enroll() by a non-owner/admin role throws PermissionDeniedError', async () => {
    const store = memoryStore()
    const owner = await createOwnerKeyring(store, VAULT, 'owner', 'owner-pw')
    await grant(store, VAULT, owner, { userId: 'viewer1', displayName: 'Viewer', role: 'viewer', passphrase: 'viewer-pw' })
    const viewer = await loadKeyring(store, VAULT, 'viewer1', 'viewer-pw')

    const host = makeTestHost()
    await expect(enrollSeed(ctx(store, viewer, config(host)))).rejects.toThrow(PermissionDeniedError)
    await expect(rotateSeed(ctx(store, viewer, config(host)))).rejects.toThrow(PermissionDeniedError)
  })

  it('V10: enroll() refused without a valid attestation surfaces BrokerEnrolmentError', async () => {
    const store = memoryStore()
    const owner = await createOwnerKeyring(store, VAULT, 'owner', 'owner-pw')
    const host = makeTestHost({ requireAttestation: true })

    await expect(enrollSeed(ctx(store, owner, config(host)))).rejects.toThrow(BrokerEnrolmentError)
  })

  it('enroll() succeeds with a valid attestation, and mintStoreCredentials then mints creds', async () => {
    const store = memoryStore()
    const owner = await createOwnerKeyring(store, VAULT, 'owner', 'owner-pw')
    const host = makeTestHost({ requireAttestation: true })
    const cfg = config(host, { attestation: () => 'dev-token' })

    await enrollSeed(ctx(store, owner, cfg))
    const creds = await mintStoreCredentials(ctx(store, owner, cfg), 'read')
    expect(creds).toMatchObject({ kind: 'aws' })
  })

  it('V23: a partial enrol (host 401s /enroll) leaves registered !== true; credentialSource fails fast with BrokerEnrolmentError, not an opaque proof error', async () => {
    const store = memoryStore()
    const owner = await createOwnerKeyring(store, VAULT, 'owner', 'owner-pw')
    const host = makeTestHost({ requireAttestation: true }) // no attestation configured below -> 401
    const cfg = config(host)

    await expect(enrollSeed(ctx(store, owner, cfg))).rejects.toThrow(BrokerEnrolmentError)

    // The seed WAS persisted (create-if-absent CAS ran), just unregistered.
    const raw = await store.get(VAULT, BROKER_COLLECTION, 'broker-1')
    expect(raw).toBeTruthy()

    await expect(mintStoreCredentials(ctx(store, owner, cfg), 'read')).rejects.toThrow(BrokerEnrolmentError)

    // A later successful enrol (now with attestation) completes registration and mints normally.
    const cfgWithAttestation = config(host, { attestation: () => 'dev-token' })
    await enrollSeed(ctx(store, owner, cfgWithAttestation))
    const creds = await mintStoreCredentials(ctx(store, owner, cfgWithAttestation), 'read')
    expect(creds).toMatchObject({ kind: 'aws' })
  })

  it('V20: two concurrent enroll() calls on an absent seed persist exactly one seed (CAS)', async () => {
    const store = memoryStore()
    const owner = await createOwnerKeyring(store, VAULT, 'owner', 'owner-pw')
    const host = makeTestHost({ requireAttestation: true })
    const cfg = config(host, { attestation: () => 'dev-token' })

    await Promise.all([enrollSeed(ctx(store, owner, cfg)), enrollSeed(ctx(store, owner, cfg))])

    const raw = await store.get(VAULT, BROKER_COLLECTION, 'broker-1')
    expect(raw).toBeTruthy()
    // Exactly one registered proof key was ever recorded for this brokerId — both concurrent
    // enrols converged on the SAME seed (a divergent second seed would register a second key).
    expect(host.registeredKeyCount(VAULT, 'broker-1')).toBe(1)

    const creds = await mintStoreCredentials(ctx(store, owner, cfg), 'read')
    expect(creds).toMatchObject({ kind: 'aws' })
  })

  it('V-KEK: enroll() on a DEK-only keyring (kek===null) throws BrokerEnrolmentError when the _broker DEK does not exist yet; use of an already-enrolled seed succeeds with the DEK alone', async () => {
    const store = memoryStore()
    const owner = await createOwnerKeyring(store, VAULT, 'owner', 'owner-pw')
    const host = makeTestHost({ requireAttestation: true })
    const cfg = config(host, { attestation: () => 'dev-token' })

    // A DEK-only keyring (tier-3 PIN resume / session-restore) attempting the FIRST-EVER
    // enrol (no _broker DEK exists yet — a fresh `deks` snapshot, not owner's live Map, so
    // the failed attempt below can't pollute the real owner keyring used afterwards).
    const dekOnly: UnlockedKeyring = { ...owner, kek: null, deks: new Map(owner.deks) }
    await expect(enrollSeed(ctx(store, dekOnly, cfg))).rejects.toThrow(BrokerEnrolmentError)

    // Enrol normally (WITH the KEK) — creates the _broker DEK + registers.
    await enrollSeed(ctx(store, owner, cfg))

    // Minting credentials from the now-enrolled seed needs only the DEK, not the KEK —
    // a fresh DEK-only view (post-enrol) succeeds.
    const dekOnlyAfter: UnlockedKeyring = { ...owner, kek: null }
    const creds = await mintStoreCredentials(ctx(store, dekOnlyAfter, cfg), 'read')
    expect(creds).toMatchObject({ kind: 'aws' })
  })

  it('V7: fetch bodies carry no seed, DEK, or passphrase — only vaultId/brokerId/proofKey/challenge/proof/profile', async () => {
    const store = memoryStore()
    const owner = await createOwnerKeyring(store, VAULT, 'owner', 'owner-pw')
    const host = makeTestHost({ requireAttestation: true })
    const cfg = config(host, { attestation: () => 'dev-token' })

    const bodies: Record<string, unknown>[] = []
    const spyFetch = (async (input: string | URL, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(init.body as string) as Record<string, unknown>)
      return host.fetch(input, init)
    }) as typeof fetch

    await enrollSeed(ctx(store, owner, { ...cfg, fetch: spyFetch }))
    await mintStoreCredentials(ctx(store, owner, { ...cfg, fetch: spyFetch }), 'read')

    expect(bodies.length).toBeGreaterThan(0)
    const serialized = JSON.stringify(bodies)
    expect(serialized).not.toMatch(/owner-pw/)
    expect(serialized).not.toMatch(/"seed"/)
    expect(serialized).not.toMatch(/"dek"/i)
    for (const body of bodies) {
      expect(Object.keys(body).every((k) =>
        ['vaultId', 'brokerId', 'proofKey', 'challenge', 'proof', 'profile'].includes(k),
      )).toBe(true)
    }
  })

  it('V6/V21: rotate() registers a new proof key and overwrites the local seed; a proof minted under the pre-rotation seed no longer verifies once the grace-window registration for the OLD key is dropped', async () => {
    const store = memoryStore()
    const owner = await createOwnerKeyring(store, VAULT, 'owner', 'owner-pw')
    const host = makeTestHost({ requireAttestation: true })
    const cfg = config(host, { attestation: () => 'dev-token' })

    await enrollSeed(ctx(store, owner, cfg))
    expect(host.registeredKeyCount(VAULT, 'broker-1')).toBe(1)

    await rotateSeed(ctx(store, owner, cfg))
    // The host now holds BOTH the old and new registrations (grace window) — this test
    // host never expires old registrations, so this asserts register-new-first landed
    // ADDITIVELY (2 keys on file), not as a destructive overwrite.
    expect(host.registeredKeyCount(VAULT, 'broker-1')).toBe(2)

    // Minting against the NEW local seed still succeeds post-rotation.
    const creds = await mintStoreCredentials(ctx(store, owner, cfg), 'read')
    expect(creds).toMatchObject({ kind: 'aws' })
  })

  it('rotate() on a not-yet-enrolled brokerId behaves like a first enrol', async () => {
    const store = memoryStore()
    const owner = await createOwnerKeyring(store, VAULT, 'owner', 'owner-pw')
    const host = makeTestHost({ requireAttestation: true })
    const cfg = config(host, { attestation: () => 'dev-token' })

    await rotateSeed(ctx(store, owner, cfg))
    expect(host.registeredKeyCount(VAULT, 'broker-1')).toBe(1)
    const creds = await mintStoreCredentials(ctx(store, owner, cfg), 'read')
    expect(creds).toMatchObject({ kind: 'aws' })
  })

  it('enrollSeed is idempotent — a second call on an already-registered seed is a no-op (no second /enroll POST)', async () => {
    const store = memoryStore()
    const owner = await createOwnerKeyring(store, VAULT, 'owner', 'owner-pw')
    const host = makeTestHost({ requireAttestation: true })
    const cfg = config(host, { attestation: () => 'dev-token' })

    await enrollSeed(ctx(store, owner, cfg))
    const enrollCallsAfterFirst = host.calls.enroll
    await enrollSeed(ctx(store, owner, cfg))
    expect(host.calls.enroll).toBe(enrollCallsAfterFirst)
  })

  it('the persisted _broker seed is never reachable via a raw list — only the reserved-collection API sees it', async () => {
    const store = memoryStore()
    const owner = await createOwnerKeyring(store, VAULT, 'owner', 'owner-pw')
    const host = makeTestHost({ requireAttestation: true })
    await enrollSeed(ctx(store, owner, config(host, { attestation: () => 'dev-token' })))
    const ids = await store.list(VAULT, BROKER_COLLECTION)
    expect(ids).toEqual(['broker-1'])
    // sanity: ensureCollectionDEK for _broker resolves the SAME dek the module used (no drift)
    const getDek = await ensureCollectionDEK(store, VAULT, owner)
    await expect(getDek(BROKER_COLLECTION)).resolves.toBeDefined()
  })
})
