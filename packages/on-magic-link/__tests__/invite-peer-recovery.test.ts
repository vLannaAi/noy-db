/**
 * PR2b — invite + peer-recovery primitives (#32).
 *
 * Pinned behaviors:
 *   1. issueInvite → acceptInvite round-trip — recipient unlocks
 *      under newPhrase; tempPhrase is invalid post-acceptance.
 *   2. issuePeerRecovery → acceptInvite round-trip — existing user
 *      rewrapped under tempPhrase, then recipient's newPhrase;
 *      original DEKs preserved.
 *   3. Expired TTL rejected with InviteExpiredError BEFORE opening
 *      a session.
 *   4. Revoked invite rejected with InviteRevokedError.
 *   5. Single-use — second acceptInvite call rejects with
 *      InviteAlreadyAcceptedError.
 *   6. Audit doc round-trips with all expected metadata fields.
 *   7. Revoked-link-shadow-keyring defense — InviteAuditMissingError
 *      thrown when audit doc absent (closes #32 point 4).
 *   8. Encoded payload round-trips through encode/decode without
 *      data loss (URL-fragment-safe base64url).
 */
import { describe, it, expect } from 'vitest'
import {
  issueInvite,
  issuePeerRecovery,
  acceptInvite,
  revokeInvite,
  encodeInvitePayload,
  decodeInvitePayload,
  InviteExpiredError,
  InviteRevokedError,
  InviteAlreadyAcceptedError,
  InviteAuditMissingError,
} from '../src/index.js'
import { createNoydb } from '@noy-db/hub'
import type { NoydbStore, EncryptedEnvelope } from '@noy-db/hub'
import { withTeam } from '@noy-db/hub/team'

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

describe('issueInvite + acceptInvite round-trip', () => {
  it('mints a new user; recipient claims under newPhrase; tempPhrase invalidated', async () => {
    const store = inlineMemory()
    const issuer = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: ALICE_PHRASE })
    await issuer.openVault('acme')

    const { encoded, payload } = await issueInvite(issuer, 'acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
    })
    expect(payload.kind).toBe('invite')
    expect(payload.userId).toBe('bob')
    expect(payload.tempPhrase).toMatch(/^[0-9a-f]{64}$/)
    expect(typeof encoded).toBe('string')

    const result = await acceptInvite(encoded, { store, newPhrase: BOB_NEW_PHRASE })
    expect(result.payload.userId).toBe('bob')
    expect(result.payload.kind).toBe('invite')

    // Recipient is now logged in as bob with the new phrase. The
    // returned db handle is live.
    const bobDb = result.db
    const reopenedKeyring = await bobDb.getKeyring('acme')
    expect(reopenedKeyring.userId).toBe('bob')
    expect(reopenedKeyring.role).toBe('admin')

    // Temp phrase is now invalid — opening with it should fail.
    await expect(
      createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: payload.tempPhrase }).then((d) => d.openVault('acme')),
    ).rejects.toThrow()

    // newPhrase opens fresh sessions cleanly.
    const reopen = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: BOB_NEW_PHRASE })
    await reopen.openVault('acme')
    const verify = await reopen.getKeyring('acme')
    expect(verify.userId).toBe('bob')
  }, 120_000)
})

describe('issuePeerRecovery + acceptInvite round-trip', () => {
  it('rewraps existing user; original DEKs preserved; new phrase works', async () => {
    const store = inlineMemory()
    const alice = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: ALICE_PHRASE })
    await alice.openVault('acme')
    await alice.grant('acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
      passphrase: BOB_OLD_PHRASE,
    })

    // Alice (owner) issues a peer-recovery for bob (admin) who forgot
    // his phrase. This rewraps bob's existing keyring under a temp
    // phrase atomically (no revoke step).
    const { encoded } = await issuePeerRecovery(alice, 'acme', { userId: 'bob' })

    // Bob accepts. The temp phrase is in the URL fragment; he supplies
    // his new phrase.
    const { db: bobDb } = await acceptInvite(encoded, { store, newPhrase: BOB_NEW_PHRASE })
    const bobKeyring = await bobDb.getKeyring('acme')
    expect(bobKeyring.userId).toBe('bob')
    expect(bobKeyring.role).toBe('admin')
    // DEK count preserved — peer-recovery doesn't rotate keys, so bob
    // keeps access to the same collections he had before.
    expect(bobKeyring.deks.size).toBeGreaterThan(0)

    // Old phrase doesn't unlock anymore.
    await expect(
      createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: BOB_OLD_PHRASE }).then((d) => d.openVault('acme')),
    ).rejects.toThrow()
  }, 180_000)

  it('owner→owner peer-recovery (closes #33 + #34 end-to-end)', async () => {
    const store = inlineMemory()
    const alice = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: ALICE_PHRASE })
    await alice.openVault('acme')
    await alice.grant('acme', {
      userId: 'mrs-niwat',
      displayName: 'Mrs Niwat',
      role: 'owner',
      passphrase: BOB_OLD_PHRASE,
    })

    // Mrs Niwat (also owner) forgets her phrase; alice (owner)
    // recovers her — the case the original db.revoke blocked.
    const { encoded } = await issuePeerRecovery(alice, 'acme', { userId: 'mrs-niwat' })
    const { db: recoveredDb } = await acceptInvite(encoded, { store, newPhrase: BOB_NEW_PHRASE })
    const kr = await recoveredDb.getKeyring('acme')
    expect(kr.role).toBe('owner')
  }, 180_000)
})

describe('TTL + revoke + single-use', () => {
  it('rejects expired invite with InviteExpiredError before opening session', async () => {
    const store = inlineMemory()
    const alice = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: ALICE_PHRASE })
    await alice.openVault('acme')

    const { encoded } = await issueInvite(alice, 'acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
      ttlMs: 1, // 1ms — guarantees expiry
    })
    // Wait long enough that Date.now() > expiresAt regardless of clock skew.
    await new Promise((r) => setTimeout(r, 50))

    await expect(
      acceptInvite(encoded, { store, newPhrase: BOB_NEW_PHRASE }),
    ).rejects.toBeInstanceOf(InviteExpiredError)
  }, 60_000)

  it('rejects revoked invite with InviteRevokedError', async () => {
    const store = inlineMemory()
    const alice = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: ALICE_PHRASE })
    await alice.openVault('acme')

    const { encoded } = await issueInvite(alice, 'acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
    })
    await revokeInvite(alice, 'acme', encoded)

    await expect(
      acceptInvite(encoded, { store, newPhrase: BOB_NEW_PHRASE }),
    ).rejects.toBeInstanceOf(InviteRevokedError)
  }, 60_000)

  it('revokeInvite is idempotent', async () => {
    const store = inlineMemory()
    const alice = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: ALICE_PHRASE })
    await alice.openVault('acme')
    const { encoded } = await issueInvite(alice, 'acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
    })
    await expect(revokeInvite(alice, 'acme', encoded)).resolves.toBeUndefined()
    await expect(revokeInvite(alice, 'acme', encoded)).resolves.toBeUndefined()
  }, 60_000)

  it('rejects second acceptInvite with InviteAlreadyAcceptedError (single-use)', async () => {
    const store = inlineMemory()
    const alice = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: ALICE_PHRASE })
    await alice.openVault('acme')

    const { encoded } = await issueInvite(alice, 'acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
    })
    await acceptInvite(encoded, { store, newPhrase: BOB_NEW_PHRASE })

    await expect(
      acceptInvite(encoded, { store, newPhrase: 'another-attempt-phrase-strong' }),
    ).rejects.toBeInstanceOf(InviteAlreadyAcceptedError)
  }, 180_000)
})

describe('revoked-link-shadow-keyring defense (#32 point 4)', () => {
  it('throws InviteAuditMissingError when the audit doc is absent', async () => {
    const store = inlineMemory()
    const alice = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: ALICE_PHRASE })
    await alice.openVault('acme')

    const { encoded } = await issueInvite(alice, 'acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
    })

    // Simulate the "audit doc deleted" case — e.g. a different store,
    // a partial sync, or an attacker who managed to delete the audit
    // entry without rotating the keyring. The recipient must NOT
    // silently fall through to a fresh-empty-vault session.
    const payload = decodeInvitePayload(encoded)
    await store.delete('acme', '_meta', `invite-audit-${payload.tokenId}`)

    await expect(
      acceptInvite(encoded, { store, newPhrase: BOB_NEW_PHRASE }),
    ).rejects.toBeInstanceOf(InviteAuditMissingError)
  }, 60_000)
})

describe('audit doc + payload encoding', () => {
  it('audit doc holds issuer / kind / target / issuedAt / expiresAt', async () => {
    const store = inlineMemory()
    const alice = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: ALICE_PHRASE })
    await alice.openVault('acme')

    const { payload } = await issueInvite(alice, 'acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
    })
    const env = await store.get('acme', '_meta', `invite-audit-${payload.tokenId}`)
    expect(env).toBeDefined()
    const audit = JSON.parse(env!._data) as Record<string, unknown>
    expect(audit.tokenId).toBe(payload.tokenId)
    expect(audit.kind).toBe('invite')
    expect(audit.issuer).toBe('alice')
    expect(audit.target).toBe('bob')
    expect(typeof audit.issuedAt).toBe('string')
    expect(audit.expiresAt).toBe(payload.expiresAt)
    expect(audit.revokedAt).toBeUndefined()
    expect(audit.acceptedAt).toBeUndefined()
  }, 60_000)

  it('audit doc records acceptedAt after successful claim', async () => {
    const store = inlineMemory()
    const alice = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: ALICE_PHRASE })
    await alice.openVault('acme')

    const { encoded, payload } = await issueInvite(alice, 'acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
    })
    await acceptInvite(encoded, { store, newPhrase: BOB_NEW_PHRASE })

    const env = await store.get('acme', '_meta', `invite-audit-${payload.tokenId}`)
    const audit = JSON.parse(env!._data) as { acceptedAt?: string }
    expect(typeof audit.acceptedAt).toBe('string')
  }, 180_000)

  it('forwards passphrasePolicy to the inner rotation (#53)', async () => {
    const store = inlineMemory()
    const alice = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: ALICE_PHRASE })
    await alice.openVault('acme')

    const { encoded } = await issueInvite(alice, 'acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
    })

    // Hyphen-separated phrase — rejected by the default lowercase+spaces
    // validator, accepted by a customValidator. Without the #53 fix,
    // the inner rotation throws WeakPassphraseError regardless of any
    // policy plumbed through `noydbOptions`.
    const HYPHENATED_PHRASE = 'mrs-niwat-her-own-phrase-2026'
    const passphrase = {
      customValidator: (phrase: string) =>
        phrase.length >= 16 && /^[a-z0-9-]+$/.test(phrase)
          ? ({ ok: true, words: 1 } as const)
          : ({ ok: false, reason: 'invalid-chars' } as const),
    }

    const result = await acceptInvite(encoded, {
      store,
      newPhrase: HYPHENATED_PHRASE,
      passphrasePolicy: passphrase,
    })
    expect(result.payload.userId).toBe('bob')

    // Reopen with the hyphenated phrase to confirm it actually rotated.
    const reopen = await createNoydb({ teamStrategy: withTeam(),
      store,
      user: 'bob',
      secret: HYPHENATED_PHRASE,
      policy: { passphrase, gates: {} },
    })
    await reopen.openVault('acme')
    const verify = await reopen.getKeyring('acme')
    expect(verify.userId).toBe('bob')
  }, 180_000)

  it('rejects newPhrase that violates the supplied passphrasePolicy (#53)', async () => {
    const store = inlineMemory()
    const alice = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: ALICE_PHRASE })
    await alice.openVault('acme')

    const { encoded } = await issueInvite(alice, 'acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
    })

    // Strict customValidator: must contain a digit. Plain word-phrase
    // newPhrase (default-validator-passing) must fail under this policy.
    await expect(
      acceptInvite(encoded, {
        store,
        newPhrase: BOB_NEW_PHRASE,
        passphrasePolicy: {
          customValidator: (phrase: string) =>
            /\d/.test(phrase)
              ? ({ ok: true, words: 1 } as const)
              : ({ ok: false, reason: 'invalid-chars' } as const),
        },
      }),
    ).rejects.toThrow(/invalid-chars/)
  }, 60_000)

  it('allowWeakPassphrase: true bypasses the rotation validator (#53)', async () => {
    const store = inlineMemory()
    const alice = await createNoydb({ teamStrategy: withTeam(), store, user: 'alice', secret: ALICE_PHRASE })
    await alice.openVault('acme')

    const { encoded } = await issueInvite(alice, 'acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
    })

    // 'short' would normally fail the strength validator. With
    // allowWeakPassphrase: true, the rotation accepts it.
    const result = await acceptInvite(encoded, {
      store,
      newPhrase: 'short',
      allowWeakPassphrase: true,
    })
    expect(result.payload.userId).toBe('bob')
  }, 120_000)

  it('encodeInvitePayload / decodeInvitePayload round-trip without loss', () => {
    const payload = {
      tokenId: '01HX6E1N0Q8WYK3F4A2J3D2F5G',
      vault: 'acme',
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin' as const,
      kind: 'invite' as const,
      issuer: 'alice',
      tempPhrase: 'a'.repeat(64),
      expiresAt: '2026-05-09T00:00:00.000Z',
    }
    const encoded = encodeInvitePayload(payload)
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
    expect(encoded).not.toContain('=')
    const decoded = decodeInvitePayload(encoded)
    expect(decoded).toEqual(payload)
  })
})
