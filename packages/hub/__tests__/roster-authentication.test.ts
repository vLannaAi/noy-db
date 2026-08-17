/**
 * #1096 — the `_keyring` roster is authenticated.
 *
 * A `_keyring` file is stored plaintext (`_iv: ''`) so an admin can edit a
 * member's authority without holding that member's credential. That left
 * `role` / `permissions` / `granted_by` / the capability bits authenticated by
 * nothing: a hostile store promoted a viewer to admin by editing one word.
 *
 * The defence is a vault-wide ROSTER KEY carried as a reserved DEK-map entry
 * (`deks['_roster']`) plus a `roster_tag` over the canonical authority fields.
 * `__tests__/keyring-replay-escalation.test.ts` holds the attack rows; this
 * file pins the MECHANISM — the parts a future refactor could quietly remove
 * while every attack row still passed for the wrong reason.
 *
 * Assertions here are deliberately about the OUTPUT domain ("every member ends
 * up holding the same roster key", "rotation never removes it") rather than
 * about specific call sequences, because the failure this closes was a field
 * nobody had to touch to break.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import { ROSTER_KEY_ID } from '../src/kernel/constants.js'
import { isSecretBearingReservedCollection } from '../src/with-party/team/reserved-secret-collections.js'
import { mintRosterTag } from '../src/with-party/team/roster-tag.js'
import { changeSecret } from '../src/with-party/team/keyring.js'
import type { NoydbStore, KeyringFile, Role } from '../src/kernel/types.js'

const VAULT = 'acme'

async function ownerWith(store: NoydbStore) {
  const db = await createNoydb({ teamStrategy: withTeam(), store, user: 'owner-01', secret: 'owner-pass-1' })
  const vault = await db.openVault(VAULT)
  await vault.collection<{ amount: number }>('invoices').put('inv-1', { amount: 100 })
  return { db, vault }
}

async function fileOf(store: NoydbStore, userId: string): Promise<KeyringFile> {
  const env = (await store.get(VAULT, '_keyring', userId))!
  return JSON.parse(env._data) as KeyringFile
}

async function rewrite(store: NoydbStore, userId: string, file: KeyringFile): Promise<void> {
  const env = (await store.get(VAULT, '_keyring', userId))!
  await store.put(VAULT, '_keyring', userId, { ...env, _data: JSON.stringify(file) })
}

describe('#1096 — the roster key reaches everyone who is subject to the roster', () => {
  it('is NOT secret-bearing, so it propagates to every role', () => {
    // The whole mechanism rests on this. If `_roster` were ever classified
    // secret-bearing, grant would withhold it from operator/viewer/client/
    // custodian grantees — and a member who cannot verify the roster they are
    // subject to is a silent hole, not a locked door.
    expect(isSecretBearingReservedCollection(ROSTER_KEY_ID)).toBe(false)
  })

  it('the owner mints one, and every grantee receives the SAME one', async () => {
    const store = memoryStore()
    const { db } = await ownerWith(store)
    for (const [userId, role] of [['bob', 'viewer'], ['carol', 'operator'], ['dave', 'admin']] as Array<[string, Role]>) {
      await db.grant(VAULT, { userId, displayName: userId, role, secret: `${userId}-pass-1` })
    }

    const wrapped = await Promise.all(
      ['owner-01', 'bob', 'carol', 'dave'].map(async u => (await fileOf(store, u)).deks[ROSTER_KEY_ID]),
    )
    // Each is wrapped under its own KEK, so the ciphertexts differ — presence
    // is what is assertable here; sameness is proved by every member's file
    // verifying below.
    expect(wrapped.every(w => typeof w === 'string' && w.length > 0)).toBe(true)

    // The real proof of sameness: the owner stamped each of these tags, and
    // each member unwraps its own roster key and verifies its own tag.
    for (const [userId, secret] of [['bob', 'bob-pass-1'], ['carol', 'carol-pass-1'], ['dave', 'dave-pass-1']] as Array<[string, string]>) {
      const memberDb = await createNoydb({ teamStrategy: withTeam(), store, user: userId, secret })
      await expect(memberDb.openVault(VAULT)).resolves.toBeDefined()
      memberDb.close()
    }
  })
})

describe('#1096 — absence is an alarm, not a skip', () => {
  it('refuses a file whose roster-key entry the store deleted', async () => {
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    // Deleting a wrapped DEK needs no key. If a missing entry meant "skip
    // verification", this single delete would restore the whole #1096 forgery.
    const file = await fileOf(store, 'bob')
    const { [ROSTER_KEY_ID]: _dropped, ...deks } = file.deks
    await rewrite(store, 'bob', { ...file, deks })

    const bobDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    await expect(bobDb.openVault(VAULT)).rejects.toMatchObject({
      name: 'KeyringTamperedError',
      details: { userId: 'bob', reason: 'roster-key-missing' },
    })
    bobDb.close()
  })

  it('refuses a file whose roster_tag the store deleted', async () => {
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    const file = await fileOf(store, 'bob')
    const { roster_tag: _dropped, ...withoutTag } = file
    await rewrite(store, 'bob', withoutTag as KeyringFile)

    const bobDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    await expect(bobDb.openVault(VAULT)).rejects.toMatchObject({
      name: 'KeyringTamperedError',
      details: { userId: 'bob', reason: 'roster-tag-missing' },
    })
    bobDb.close()
  })

  it('a WRONG SECRET still reports as InvalidKeyError, never as tampering', async () => {
    // The ordering this pins is not cosmetic. Roster verification runs after
    // the key epilogue precisely so an ordinary typo is never announced to a
    // user as "the store serving this vault may have altered the roster" — the
    // cry-wolf failure that `TamperedError` already had to be rescued from.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    const bobDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'wrong-pass-9' })
    await expect(bobDb.openVault(VAULT)).rejects.toMatchObject({ name: 'InvalidKeyError' })
    bobDb.close()
  })
})

describe('#1096 — legitimate authority edits restamp', () => {
  it('updateUser rewrites role AND tag, so the target still opens', async () => {
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    const before = (await fileOf(store, 'bob')).roster_tag
    await db.updateUser(VAULT, { userId: 'bob', role: 'operator' })
    const after = await fileOf(store, 'bob')

    expect(after.role).toBe('operator')
    expect(after.roster_tag).not.toEqual(before)

    const bobDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    await expect(bobDb.openVault(VAULT)).resolves.toBeDefined()
    bobDb.close()
  })

  it('revoke — which narrows every survivor\'s permissions — leaves them able to open', async () => {
    // `revoke` rotates, and rotation NARROWS each survivor's `permissions`,
    // which is an authority field. Without a restamp there, one revoke would
    // lock every remaining member out of the vault.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'operator', permissions: { invoices: 'rw' }, secret: 'bob-pass-1' })
    await db.grant(VAULT, { userId: 'carol', displayName: 'Carol', role: 'operator', permissions: { invoices: 'rw' }, secret: 'carol-pass-1' })

    await db.revoke(VAULT, { userId: 'bob' })

    const carolDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'carol', secret: 'carol-pass-1' })
    await expect(carolDb.openVault(VAULT)).resolves.toBeDefined()
    carolDb.close()
  })

  it('rotateKeys REFUSES an explicit roster-key rotation rather than dropping it silently', async () => {
    // `revoke` filters the roster key out at source (it gathers DEK-map keys
    // implicitly), so anything reaching `rotateKeys` named it deliberately —
    // and a caller with a mistaken model of what rotation does is better told
    // than quietly humoured. Silent-drop is the failure shape to avoid here.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await expect(db.rotate(VAULT, [ROSTER_KEY_ID])).rejects.toMatchObject({
      name: 'ValidationError',
      message: expect.stringContaining(ROSTER_KEY_ID),
    })
    // A rotation naming only real collections is unaffected.
    await expect(db.rotate(VAULT, ['invoices'])).resolves.toBeDefined()
  })

  it('persistKeyring carries `expires_at` forward instead of authenticating its erasure', async () => {
    // `UnlockedKeyring` does not carry `expires_at`, so rebuilding the file
    // from it used to silently CLEAR a time-boxed grant on the next
    // DEK-provisioning write. #1096 raised the stakes: the roster tag would be
    // stamped over the cleared value, so the erasure came out authenticated.
    // Same carry-forward class as the granted_by / created_at bugs already
    // fixed in that function.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    // admin so bob's own write provisions a DEK and triggers `persistKeyring`.
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'admin', secret: 'bob-pass-1' })

    // Seed a LEGITIMATELY expiring keyring — stamped with the vault roster key,
    // exactly as an admin setting a time-boxed grant would. Writing the field
    // without restamping would be a forgery, and (correctly) refused.
    const expiresAt = '2099-01-01T00:00:00.000Z'
    const ownerKeyring = await db.team.getKeyring(VAULT)
    const rosterKey = ownerKeyring.deks.get(ROSTER_KEY_ID)!
    const expiring = { ...(await fileOf(store, 'bob')), expires_at: expiresAt }
    await rewrite(store, 'bob', { ...expiring, roster_tag: await mintRosterTag(expiring, rosterKey) })

    // Provoke a DEK-provisioning persist on bob's own keyring.
    const bobDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    const bobVault = await bobDb.openVault(VAULT)
    await bobVault.collection<{ n: number }>('notes').put('n-1', { n: 1 })
    bobDb.close()

    expect((await fileOf(store, 'bob')).expires_at).toBe(expiresAt)
  })

  it('changeSecret carries origin + capability fields forward instead of authenticating their erasure', async () => {
    // `UnlockedKeyring` carries none of `granted_by` / `expires_at` /
    // `export_capability` / `import_capability`, so rebuilding the file from it
    // re-parented the holder to themselves (collapsing the admin delegation
    // subtree `revoke`'s cascade walks) and dropped a time-boxed grant and both
    // capability bits. #1096 makes each erasure come out SIGNED.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, {
      userId: 'bob', displayName: 'Bob', role: 'admin', secret: 'bob-pass-1',
      exportCapability: { bundle: true }, importCapability: { bundle: true },
    })

    const expiresAt = '2099-01-01T00:00:00.000Z'
    const ownerKeyring = await db.team.getKeyring(VAULT)
    const rosterKey = ownerKeyring.deks.get(ROSTER_KEY_ID)!
    const expiring = { ...(await fileOf(store, 'bob')), expires_at: expiresAt }
    await rewrite(store, 'bob', { ...expiring, roster_tag: await mintRosterTag(expiring, rosterKey) })

    const bobDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    await bobDb.openVault(VAULT)
    await changeSecret(store, VAULT, await bobDb.team.getKeyring(VAULT), {
      newSecret: 'bob-pass-2-much-longer', allowWeakSecret: true,
    })
    bobDb.close()

    const after = await fileOf(store, 'bob')
    expect(after.granted_by).toBe('owner-01')
    expect(after.expires_at).toBe(expiresAt)
    expect(after.export_capability).toEqual({ bundle: true })
    expect(after.import_capability).toEqual({ bundle: true })

    // And the result is loadable — the carried fields are inside the new tag.
    const reopened = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-2-much-longer' })
    await expect(reopened.openVault(VAULT)).resolves.toBeDefined()
    reopened.close()
  })

  it('the roster key SURVIVES a revoke — rotation must never drop it', async () => {
    // `revoke` builds its rotation set from `Object.keys(targetKeyring.deks)`,
    // which contains `_roster`. Rotating it would mint a fresh key for the
    // caller and strip the entry from every other member — an ordinary revoke
    // would brick the entire vault. `rotateKeys` filters it out for this
    // reason; this row is what notices if that filter is ever removed.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'admin', secret: 'bob-pass-1' })
    await db.grant(VAULT, { userId: 'carol', displayName: 'Carol', role: 'admin', secret: 'carol-pass-1' })

    const carolBefore = (await fileOf(store, 'carol')).deks[ROSTER_KEY_ID]
    await db.revoke(VAULT, { userId: 'bob' })
    const carolAfter = (await fileOf(store, 'carol')).deks[ROSTER_KEY_ID]

    expect(carolAfter).toBeDefined()
    // Same key, same KEK, and AES-KW is deterministic — so the survivor's
    // wrapped roster key must be byte-identical, not merely present.
    expect(carolAfter).toBe(carolBefore)
  })
})
