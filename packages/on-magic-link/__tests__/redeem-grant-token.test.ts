/**
 * `redeemGrantToken` — the Tier-3 wire (#949): connects the frozen
 * `#g=` share-link grammar (`@noy-db/hub/share-link`) to the existing
 * invite-acceptance ladder (`acceptInvite`). Pure wiring — no new
 * crypto; every error class inherited verbatim from `invite.ts`.
 */
import { describe, it, expect } from 'vitest'
import {
  issueInvite,
  issuePeerRecovery,
  revokeInvite,
  decodeInvitePayload,
  redeemGrantToken,
  GrantTokenMissingError,
  InviteExpiredError,
  InviteRevokedError,
  InviteAlreadyAcceptedError,
  InviteAuditMissingError,
} from '../src/index.js'
import { createNoydb, generateULID } from '@noy-db/hub'
import type { NoydbStore, EncryptedEnvelope } from '@noy-db/hub'
import { withTeam } from '@noy-db/hub/team'
import { buildShareLink, parseShareLink } from '@noy-db/hub/share-link'

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'inline-memory',
    async get(c: string, col: string, id: string) { return gc(c, col).get(id) },
    async put(c: string, col: string, id: string, env: EncryptedEnvelope) { gc(c, col).set(id, env) },
    async delete(c: string, col: string, id: string) { gc(c, col).delete(id) },
    async list(c: string, col: string) { return [...gc(c, col).keys()] },
    async loadAll() { return {} },
    async saveAll() {},
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
  } as unknown as NoydbStore
}

const ALICE_PHRASE = 'correct horse battery staple printer toaster'
const BOB_OLD_PHRASE = 'glasses cabinet bicycle umbrella thunder velvet'
const BOB_NEW_PHRASE = 'evergreen marble lantern apricot velvet thunder'

/** A share link's vaultHandle is addressing only — any valid ULID works. */
function shareLinkFor(grantToken?: string) {
  const vaultHandle = generateULID()
  const url = buildShareLink({
    vaultHandle,
    collection: 'invoices',
    recordId: 'r1',
    ...(grantToken !== undefined && { grantToken }),
  })
  return parseShareLink(url)
}

describe('redeemGrantToken — end to end', () => {
  it('redeems an issued invite through a parsed share link', async () => {
    const store = inlineMemory()
    const issuer = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: ALICE_PHRASE })
    await issuer.openVault('acme')

    const { encoded } = await issueInvite(issuer, 'acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
    })
    const link = shareLinkFor(encoded)
    expect(link.grantToken).toBe(encoded)

    const result = await redeemGrantToken(link, { store, newPhrase: BOB_NEW_PHRASE })
    expect(result.payload.userId).toBe('bob')
    expect(result.payload.kind).toBe('invite')

    const keyring = await result.db.team.getKeyring('acme')
    expect(keyring.userId).toBe('bob')
    expect(keyring.role).toBe('admin')
  }, 120_000)

  it('single-use: a second redemption of the same link rejects', async () => {
    const store = inlineMemory()
    const issuer = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: ALICE_PHRASE })
    await issuer.openVault('acme')

    const { encoded } = await issueInvite(issuer, 'acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
    })
    const link = shareLinkFor(encoded)

    await redeemGrantToken(link, { store, newPhrase: BOB_NEW_PHRASE })

    await expect(
      redeemGrantToken(link, { store, newPhrase: 'another-attempt-phrase-strong' }),
    ).rejects.toBeInstanceOf(InviteAlreadyAcceptedError)
  }, 180_000)

  it('expired invite redemption rejects with InviteExpiredError', async () => {
    const store = inlineMemory()
    const issuer = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: ALICE_PHRASE })
    await issuer.openVault('acme')

    const { encoded } = await issueInvite(issuer, 'acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
      ttlMs: 1,
    })
    await new Promise((r) => setTimeout(r, 50))
    const link = shareLinkFor(encoded)

    await expect(
      redeemGrantToken(link, { store, newPhrase: BOB_NEW_PHRASE }),
    ).rejects.toBeInstanceOf(InviteExpiredError)
  }, 60_000)

  it('revoked invite redemption rejects with InviteRevokedError', async () => {
    const store = inlineMemory()
    const issuer = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: ALICE_PHRASE })
    await issuer.openVault('acme')

    const { encoded } = await issueInvite(issuer, 'acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
    })
    await revokeInvite(issuer, 'acme', encoded)
    const link = shareLinkFor(encoded)

    await expect(
      redeemGrantToken(link, { store, newPhrase: BOB_NEW_PHRASE }),
    ).rejects.toBeInstanceOf(InviteRevokedError)
  }, 60_000)

  it('audit-doc-missing redemption fails closed with InviteAuditMissingError', async () => {
    const store = inlineMemory()
    const issuer = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: ALICE_PHRASE })
    await issuer.openVault('acme')

    const { encoded } = await issueInvite(issuer, 'acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
    })
    const payload = decodeInvitePayload(encoded)
    await store.delete('acme', '_meta', `invite-audit-${payload.tokenId}`)
    const link = shareLinkFor(encoded)

    await expect(
      redeemGrantToken(link, { store, newPhrase: BOB_NEW_PHRASE }),
    ).rejects.toBeInstanceOf(InviteAuditMissingError)
  }, 60_000)

  it('a link with no #g= grant token rejects with GrantTokenMissingError', async () => {
    const store = inlineMemory()
    const link = shareLinkFor(undefined)
    expect(link.grantToken).toBeUndefined()

    await expect(
      redeemGrantToken(link, { store, newPhrase: BOB_NEW_PHRASE }),
    ).rejects.toBeInstanceOf(GrantTokenMissingError)
  })

  it('peer-recovery redemption rewraps the existing principal; old phrase no longer unlocks', async () => {
    const store = inlineMemory()
    const alice = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: ALICE_PHRASE })
    await alice.openVault('acme')
    await alice.grant('acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
      secret: BOB_OLD_PHRASE,
    })

    const { encoded } = await issuePeerRecovery(alice, 'acme', { userId: 'bob' })
    const link = shareLinkFor(encoded)

    const { db: bobDb } = await redeemGrantToken(link, { store, newPhrase: BOB_NEW_PHRASE })
    const bobKeyring = await bobDb.team.getKeyring('acme')
    expect(bobKeyring.userId).toBe('bob')
    expect(bobKeyring.role).toBe('admin')
    expect(bobKeyring.deks.size).toBeGreaterThan(0)

    await expect(
      createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: BOB_OLD_PHRASE }).then((d) => d.openVault('acme')),
    ).rejects.toThrow()
  }, 180_000)
})
