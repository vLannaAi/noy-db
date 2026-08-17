/**
 * #1114 — an unverifiable `_keyring` file quarantines its OWNER, not the vault.
 *
 * ## The availability defect #1096 introduced
 *
 * #1096 made every roster editor verify a file before restamping it, which is
 * what stops a store's forgery being laundered into a genuine tag by a routine
 * roster edit. But `rotateKeys` iterates `store.list(vault, '_keyring')` —
 * EVERY member — and `revoke` calls `rotateKeys` unconditionally. So one forged
 * file froze `revoke` and `rotateKeys` vault-wide: the two security-critical
 * operations, unavailable because of a file belonging to someone else.
 *
 * ## Why skipping is safe HERE and nowhere else
 *
 * Rotation's effect on a member is to hand them re-wrapped DEKs. Skipping one
 * therefore gives them **less**, never more: their file is left untouched, so
 * they keep only stale wrappings for collections that have been re-keyed. That
 * is the same fail-closed end state rotation already produces for a member it
 * cannot re-wrap for (#854), reached by a different route.
 *
 * The cascade walk in `revoke` is deliberately NOT relaxed the same way, and
 * the asymmetry is the point: there, skipping an unverifiable file would drop a
 * member from the delegation tree, so a store serving a forged copy to the
 * revoker and the genuine copy to the victim could keep an admin descendant
 * alive through a cascade. Skipping would give that member MORE. Revoking an
 * admin therefore still requires a roster that verifies end to end.
 *
 * ## What these rows pin
 *
 * Counts, not just absence — a rotation that silently skipped EVERYONE would
 * report an empty `needsRegrant` and look perfectly clean.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import { KeyringTamperedError } from '../src/kernel/errors.js'
import type { NoydbStore, KeyringFile } from '../src/kernel/types.js'

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

/** The store rewrites the one plaintext word. No key, no prior file. */
async function forgeRole(store: NoydbStore, userId: string, role: string): Promise<void> {
  const env = (await store.get(VAULT, '_keyring', userId))!
  await store.put(VAULT, '_keyring', userId, {
    ...env,
    _data: env._data.replace(/"role":"[a-z]+"/, `"role":"${role}"`),
  })
}

describe('#1114 — rotation skips an unverifiable member instead of failing the vault', () => {
  it('rotates the healthy members and REPORTS the skipped one', async () => {
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })
    await db.grant(VAULT, { userId: 'carol', displayName: 'C', role: 'viewer', secret: 'carol-pass-1' })

    await forgeRole(store, 'carol', 'admin')

    const result = await db.rotate(VAULT, ['invoices'])

    // The count is the assertion. "No error" would also be true of a rotation
    // that skipped everyone, which is the failure this row exists to exclude.
    expect(result.unverified.map((u) => u.userId)).toEqual(['carol'])
    expect(result.unverified[0]?.reason).toBe('roster-tag-mismatch')
    // bob was NOT skipped — he is a real, rotated member.
    expect(result.needsRegrant.some((r) => r.userId === 'bob')).toBe(true)
    expect(result.needsRegrant.some((r) => r.userId === 'carol')).toBe(false)
  })

  it('leaves the skipped member FAIL-CLOSED — untouched file, no new key', async () => {
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'carol', displayName: 'C', role: 'viewer', secret: 'carol-pass-1' })

    await forgeRole(store, 'carol', 'admin')
    const before = await fileOf(store, 'carol')

    await db.rotate(VAULT, ['invoices'])

    const after = await fileOf(store, 'carol')
    // Byte-identical: not restamped (no laundering) and not re-wrapped (no new
    // key). Both halves matter, and one object comparison pins both.
    expect(after).toEqual(before)
    // And she still cannot open the vault — the forgery is refused, as before.
    const asCarol = await createNoydb({ teamStrategy: withTeam(), store, user: 'carol', secret: 'carol-pass-1' })
    await expect(asCarol.openVault(VAULT)).rejects.toThrow(KeyringTamperedError)
  })

  it('a healthy roster reports NOTHING unverified — the field is not vacuous', async () => {
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    const result = await db.rotate(VAULT, ['invoices'])

    expect(result.unverified).toEqual([])
    expect(result.needsRegrant.some((r) => r.userId === 'bob')).toBe(true)
  })

  it('THE POINT: revoking a healthy member succeeds despite an unrelated forged file', async () => {
    // This is the availability defect itself. Before #1114 this threw
    // KeyringTamperedError about carol while trying to revoke dave.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'carol', displayName: 'C', role: 'viewer', secret: 'carol-pass-1' })
    await db.grant(VAULT, { userId: 'dave', displayName: 'D', role: 'viewer', secret: 'dave-pass-1' })

    await forgeRole(store, 'carol', 'admin')

    await db.revoke(VAULT, { userId: 'dave' })

    // Assert the EFFECT — `revoke` resolves to void.
    expect(await store.get(VAULT, '_keyring', 'dave')).toBeNull()
    // carol's forged file is still there, still inert.
    expect(await store.get(VAULT, '_keyring', 'carol')).not.toBeNull()
  })

  it('still REFUSES to revoke the forged member itself — the target is trusted for `canRevoke`', async () => {
    // Deliberately unchanged by #1114: the target's own role decides whether
    // the caller may revoke them, so it cannot come from an unverified file.
    // Removing the bad file remains an out-of-band repair; see #1114.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'carol', displayName: 'C', role: 'viewer', secret: 'carol-pass-1' })

    await forgeRole(store, 'carol', 'admin')

    await expect(db.revoke(VAULT, { userId: 'carol' })).rejects.toThrow(KeyringTamperedError)
    expect(await store.get(VAULT, '_keyring', 'carol')).not.toBeNull()
  })
})
