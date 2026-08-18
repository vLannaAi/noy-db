/**
 * Gate test for the multi-user team capability (#267 Track A tail).
 * `db.grant` / `db.revoke` / `db.rotate` throw `TeamNotEnabledError` unless
 * `teamStrategy: withTeam()` is passed to createNoydb; opting in makes them
 * live with unchanged semantics. This completes the keyring-grant → `team`
 * split: the always-on floor is genuinely single-user, and the grant/revoke/
 * rotate keyring engines are reachable only through the `@noy-db/hub/team`
 * subpath (bundle-charged to team consumers, not the floor).
 *
 * Single-user primitives stay ungated: owner keyring creation, unlock,
 * `listUsers`, `updateUser`, secret rotate/recover.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, TeamNotEnabledError, NoAccessError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withTeam, NO_TEAM } from '../src/with-party/team/index.js'

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) }
    },
  }
}

const VAULT = 'T-optin'

describe('team opt-in gate (#267)', () => {
  it('grant / revoke / rotate throw TeamNotEnabledError when not opted in', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'owner-01', secret: 'owner-pass' })
    await db.openVault(VAULT)
    await expect(
      db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'operator', secret: 'bob-pass-long' }),
    ).rejects.toThrow(TeamNotEnabledError)
    await expect(db.revoke(VAULT, { userId: 'bob' })).rejects.toThrow(TeamNotEnabledError)
    await expect(db.rotate(VAULT, ['notes'])).rejects.toThrow(TeamNotEnabledError)
    // #1121 — the roster diagnostic and quarantine are team operations too, so
    // they must be gated identically. A new team method that forgot the gate
    // would be a silent hole in the opt-in floor.
    await expect(db.verifyRoster(VAULT)).rejects.toThrow(TeamNotEnabledError)
    await expect(db.quarantineKeyring(VAULT, 'bob')).rejects.toThrow(TeamNotEnabledError)
    await db.close()
  })

  it('NO_TEAM is the stub the floor default resolves to', async () => {
    await expect(
      NO_TEAM.rotate(null as never, VAULT, []),
    ).rejects.toThrow(TeamNotEnabledError)
    await expect(NO_TEAM.verifyRoster(null as never, VAULT)).rejects.toThrow(TeamNotEnabledError)
    await expect(NO_TEAM.quarantineKeyring(null as never, VAULT, 'bob')).rejects.toThrow(TeamNotEnabledError)
  })

  it('grant / revoke work end-to-end with withTeam()', async () => {
    const adapter = inlineMemory()
    const db = await createNoydb({
      store: adapter, user: 'owner-01', secret: 'owner-pass',
      teamStrategy: withTeam(),
    })
    const vault = await db.openVault(VAULT)
    const notes = vault.collection<{ text: string }>('notes')
    await notes.put('n1', { text: 'hello' })

    await db.grant(VAULT, {
      userId: 'bob', displayName: 'Bob', role: 'operator', secret: 'bob-pass-long',
      permissions: { notes: 'rw' },
    })
    const users = await db.listUsers(VAULT)
    expect(users.map((u) => u.userId).sort()).toEqual(['bob', 'owner-01'])

    // Bob can actually unlock and read through his granted keyring.
    const bobDb = await createNoydb({ store: adapter, user: 'bob', secret: 'bob-pass-long' })
    const bobVault = await bobDb.openVault(VAULT)
    const bobNotes = bobVault.collection<{ text: string }>('notes')
    expect((await bobNotes.get('n1'))?.text).toBe('hello')
    await bobDb.close()

    await db.revoke(VAULT, { userId: 'bob' })
    const after = await db.listUsers(VAULT)
    expect(after.map((u) => u.userId)).toEqual(['owner-01'])
    await db.close()
  })

  it('rotate re-keys collections and keeps the owner readable', async () => {
    const adapter = inlineMemory()
    const db = await createNoydb({
      store: adapter, user: 'owner-01', secret: 'owner-pass',
      teamStrategy: withTeam(),
    })
    const vault = await db.openVault(VAULT)
    const notes = vault.collection<{ text: string }>('notes')
    await notes.put('n1', { text: 'pre-rotation' })
    await db.rotate(VAULT, ['notes'])

    // Fresh session unlocks fine and reads the re-encrypted record.
    const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const v2 = await db2.openVault(VAULT)
    expect((await v2.collection<{ text: string }>('notes').get('n1'))?.text).toBe('pre-rotation')
    await db2.close()
    await db.close()
  })

  it('single-user primitives stay ungated without withTeam()', async () => {
    const adapter = inlineMemory()
    const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    await db.openVault(VAULT)
    // listUsers (read-only introspection) stays live.
    expect((await db.listUsers(VAULT)).map((u) => u.userId)).toEqual(['owner-01'])
    // updateUser (identity-header rewrite) stays live for the owner's own row.
    await db.updateUser(VAULT, { userId: 'owner-01', displayName: 'The Owner' })
    // Target-missing path still reports the domain error, not the gate error.
    await expect(db.updateUser(VAULT, { userId: 'ghost', role: 'viewer' })).rejects.toThrow(NoAccessError)
    await db.close()
  })
})
