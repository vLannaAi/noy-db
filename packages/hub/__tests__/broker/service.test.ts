/**
 * `@noy-db/hub/broker` service wiring — `vault.broker()` end-to-end through
 * `createNoydb()` (#479 slice 2b). Vector ids map 1:1 to the credential-broker
 * spec's §8 conformance list.
 */
import { describe, expect, it } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withTeam } from '../../src/with-party/team/index.js'
import { withBroker, NO_BROKER, issueChallenge } from '../../src/with-party/broker/index.js'
import { BrokerNotEnabledError, ReservedCollectionNameError, PermissionDeniedError } from '../../src/kernel/errors.js'
import { loadKeyring } from '../../src/with-party/team/keyring.js'
import { BROKER_COLLECTION } from '../../src/with-party/team/reserved-secret-collections.js'
import { memoryStore, makeTestHost } from './support.js'

const VAULT = 'T-broker'

describe('vault.broker() service wiring', () => {
  it('R-B1: vault.broker() throws BrokerNotEnabledError when not opted in', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'owner-01', secret: 'owner-pass' })
    const vault = await db.openVault(VAULT)
    await expect(vault.broker().enroll()).rejects.toThrow(BrokerNotEnabledError)
    await expect(vault.broker().rotate()).rejects.toThrow(BrokerNotEnabledError)
    expect(() => vault.broker().credentialSource()).toThrow(BrokerNotEnabledError)
    await db.close()
  })

  it('NO_BROKER is the stub the floor default resolves to', async () => {
    await expect(NO_BROKER.enroll(null as never)).rejects.toThrow(BrokerNotEnabledError)
    await expect(NO_BROKER.rotate(null as never)).rejects.toThrow(BrokerNotEnabledError)
    expect(() => NO_BROKER.credentialSource(null as never)).toThrow(BrokerNotEnabledError)
  })

  it('end-to-end: enroll() then credentialSource(profile)() mints store credentials through vault.broker()', async () => {
    const host = makeTestHost({ requireAttestation: true })
    const adapter = memoryStore()
    const db = await createNoydb({
      store: adapter, user: 'owner-01', secret: 'owner-pass',
      brokerStrategy: withBroker({
        brokerId: 'broker-1', endpoint: 'https://broker.example.com',
        attestation: () => 'dev-token', fetch: host.fetch,
      }),
    })
    const vault = await db.openVault(VAULT)

    await vault.broker().enroll()
    const source = vault.broker().credentialSource('read')
    const creds = await source()
    expect(creds).toMatchObject({ kind: 'aws' })
    await db.close()
  })

  it('V11: vault.collection("_broker") is rejected as a reserved collection (the shipped guard)', async () => {
    const host = makeTestHost({ requireAttestation: true })
    const db = await createNoydb({
      store: memoryStore(), user: 'owner-01', secret: 'owner-pass',
      brokerStrategy: withBroker({
        brokerId: 'broker-1', endpoint: 'https://broker.example.com',
        attestation: () => 'dev-token', fetch: host.fetch,
      }),
    })
    const vault = await db.openVault(VAULT)
    expect(() => vault.collection(BROKER_COLLECTION)).toThrow(ReservedCollectionNameError)
    await db.close()
  })

  it('V17: a granted sub-admin (operator) keyring has NO _broker DEK and cannot decrypt the seed', async () => {
    const host = makeTestHost({ requireAttestation: true })
    const adapter = memoryStore()
    const db = await createNoydb({
      store: adapter, user: 'owner-01', secret: 'owner-pass',
      teamStrategy: withTeam(),
      brokerStrategy: withBroker({
        brokerId: 'broker-1', endpoint: 'https://broker.example.com',
        attestation: () => 'dev-token', fetch: host.fetch,
      }),
    })
    const vault = await db.openVault(VAULT)
    await vault.broker().enroll() // creates + registers the _broker DEK/seed

    await db.grant(VAULT, {
      userId: 'op1', displayName: 'Operator', role: 'operator', passphrase: 'op-pass-long',
      permissions: { notes: 'rw' },
    })
    const opKeyring = await loadKeyring(adapter, VAULT, 'op1', 'op-pass-long')
    expect(opKeyring.deks.has(BROKER_COLLECTION)).toBe(false)

    // An admin grantee, by contrast, DOES receive the secret-bearing DEK (owner/admin bucket).
    await db.grant(VAULT, {
      userId: 'admin1', displayName: 'Admin', role: 'admin', passphrase: 'admin-pass-long',
    })
    const adminKeyring = await loadKeyring(adapter, VAULT, 'admin1', 'admin-pass-long')
    expect(adminKeyring.deks.has(BROKER_COLLECTION)).toBe(true)

    await db.close()
  })

  it('V2b (role gate, integration level): a non-owner/admin vault.broker() handle rejects enroll/rotate with PermissionDeniedError', async () => {
    const host = makeTestHost({ requireAttestation: true })
    const adapter = memoryStore()
    const brokerStrategy = withBroker({
      brokerId: 'broker-1', endpoint: 'https://broker.example.com',
      attestation: () => 'dev-token', fetch: host.fetch,
    })
    const db = await createNoydb({
      store: adapter, user: 'owner-01', secret: 'owner-pass',
      teamStrategy: withTeam(), brokerStrategy,
    })
    const vault = await db.openVault(VAULT)
    await db.grant(VAULT, {
      userId: 'viewer1', displayName: 'Viewer', role: 'viewer', passphrase: 'viewer-pass-long',
    })
    await db.close()

    const viewerDb = await createNoydb({
      store: adapter, user: 'viewer1', secret: 'viewer-pass-long',
      teamStrategy: withTeam(), brokerStrategy,
    })
    const viewerVault = await viewerDb.openVault(VAULT)
    await expect(viewerVault.broker().enroll()).rejects.toThrow(PermissionDeniedError)
    await expect(viewerVault.broker().rotate()).rejects.toThrow(PermissionDeniedError)
    await viewerDb.close()
  })

  it('carried-forward TTL clamp (I6b): issueChallenge floors/ceils to [10s, 60s]', () => {
    expect(Date.parse(issueChallenge({ ttlMs: 1_000 }).expiresAt) - Date.now()).toBeGreaterThanOrEqual(9_000)
    expect(Date.parse(issueChallenge({ ttlMs: 1_000 }).expiresAt) - Date.now()).toBeLessThanOrEqual(11_000)
    expect(Date.parse(issueChallenge({ ttlMs: 600_000 }).expiresAt) - Date.now()).toBeLessThanOrEqual(61_000)
    const defaulted = Date.parse(issueChallenge().expiresAt) - Date.now()
    expect(defaulted).toBeGreaterThan(55_000)
    expect(defaulted).toBeLessThanOrEqual(60_000)
  })
})
