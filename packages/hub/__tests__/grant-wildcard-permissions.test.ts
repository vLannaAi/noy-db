/**
 * #1010 — `permissions: { '*': 'rw' }`.
 *
 * `Permissions` documents `'*'` as "the wildcard collection matching all
 * collections in the vault", but nothing expanded it: not the DEK wrapping in
 * `grant()`, not `hasAccess`, not `hasWritePermission`. The only `'*'` handling
 * in the codebase was for export-capability FORMATS, which is unrelated. So the
 * documented catch-all silently produced a grantee with no keys.
 *
 * Also covers the second half of #1004, which that fix missed: an ENTITLED
 * principal (admin / viewer / custodian, or an operator holding the collection
 * in `permissions`) reading a collection created AFTER their grant still fell
 * through to minting a fresh DEK, and so still surfaced `TamperedError`.
 * Wrapping a DEK requires the grantee's KEK — derived from a secret the vault
 * never stores — so nothing can back-fill it. Denying honestly is the only
 * correct answer, and it must not masquerade as tampering.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, NoAccessError, TamperedError, ReadOnlyError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withTeam } from '../src/with-party/team/index.js'

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

interface Thing extends Record<string, unknown> { id: string; n: number }
const V = 'niwat'

async function seededOwner(store: NoydbStore) {
  const db = await createNoydb({ store, user: 'ann', secret: 'ann-secret-2026', teamStrategy: withTeam() })
  const vault = await db.openVault(V)
  await vault.collection<Thing>('things').put('t1', { id: 't1', n: 1 })
  await vault.collection<Thing>('others').put('o1', { id: 'o1', n: 2 })
  return db
}
const asUser = (store: NoydbStore, user: string, secret: string) =>
  createNoydb({ store, user, secret, teamStrategy: withTeam() })

describe("#1010 — permissions: { '*': ... }", () => {
  it('wraps every collection DEK for an operator granted the wildcard', async () => {
    const store = inlineMemory()
    const owner = await seededOwner(store)
    await owner.grant(V, {
      userId: 'belle', displayName: 'Belle', role: 'operator',
      secret: 'belle-secret-2026', allowWeakSecret: true, permissions: { '*': 'rw' },
    })

    const vault = await (await asUser(store, 'belle', 'belle-secret-2026')).openVault(V)
    expect(await vault.collection<Thing>('things').list()).toEqual([{ id: 't1', n: 1 }])
    expect(await vault.collection<Thing>('others').list()).toEqual([{ id: 'o1', n: 2 }])
  })

  it('grants write through the wildcard when it is `rw`', async () => {
    const store = inlineMemory()
    const owner = await seededOwner(store)
    await owner.grant(V, {
      userId: 'belle', displayName: 'Belle', role: 'operator',
      secret: 'belle-secret-2026', allowWeakSecret: true, permissions: { '*': 'rw' },
    })
    const vault = await (await asUser(store, 'belle', 'belle-secret-2026')).openVault(V)
    await expect(vault.collection<Thing>('things').put('t2', { id: 't2', n: 9 })).resolves.not.toThrow()
  })

  it('a `ro` wildcard reads everything but writes nothing', async () => {
    const store = inlineMemory()
    const owner = await seededOwner(store)
    await owner.grant(V, {
      userId: 'carl', displayName: 'Carl', role: 'operator',
      secret: 'carl-secret-2026', allowWeakSecret: true, permissions: { '*': 'ro' },
    })
    const vault = await (await asUser(store, 'carl', 'carl-secret-2026')).openVault(V)
    expect(await vault.collection<Thing>('things').list()).toEqual([{ id: 't1', n: 1 }])
    await expect(vault.collection<Thing>('things').put('t3', { id: 't3', n: 3 }))
      .rejects.toBeInstanceOf(ReadOnlyError)
  })

  it('does not create a literal `*` collection', async () => {
    const store = inlineMemory()
    const owner = await seededOwner(store)
    await owner.grant(V, {
      userId: 'belle', displayName: 'Belle', role: 'operator',
      secret: 'belle-secret-2026', allowWeakSecret: true, permissions: { '*': 'rw' },
    })
    expect(await store.list(V, '*')).toEqual([])
  })

  it('an explicit enumeration still scopes — the wildcard is opt-in, not implied', async () => {
    const store = inlineMemory()
    const owner = await seededOwner(store)
    await owner.grant(V, {
      userId: 'dee', displayName: 'Dee', role: 'operator',
      secret: 'dee-secret-2026', allowWeakSecret: true, permissions: { things: 'rw' },
    })
    const vault = await (await asUser(store, 'dee', 'dee-secret-2026')).openVault(V)
    expect(await vault.collection<Thing>('things').list()).toEqual([{ id: 't1', n: 1 }])
    await expect(vault.collection<Thing>('others').list()).rejects.toBeInstanceOf(NoAccessError)
  })
})

describe('#1010 — a collection created AFTER a grant denies honestly (completes #1004)', () => {
  /** Grant first, create the collection second, then read as the grantee. */
  async function readAfterLateCreate(role: 'admin' | 'viewer' | 'custodian' | 'operator', permissions?: Record<string, 'rw' | 'ro'>) {
    const store = inlineMemory()
    const owner = await createNoydb({ store, user: 'ann', secret: 'ann-secret-2026', teamStrategy: withTeam() })
    await owner.openVault(V)
    await owner.grant(V, {
      userId: 'belle', displayName: 'Belle', role,
      secret: 'belle-secret-2026', allowWeakSecret: true, ...(permissions ? { permissions } : {}),
    })
    // The collection comes into existence only now, under the OWNER's DEK.
    const ownerAgain = await createNoydb({ store, user: 'ann', secret: 'ann-secret-2026', teamStrategy: withTeam() })
    await (await ownerAgain.openVault(V)).collection<Thing>('late').put('l1', { id: 'l1', n: 7 })

    const vault = await (await asUser(store, 'belle', 'belle-secret-2026')).openVault(V)
    return vault.collection<Thing>('late').list()
  }

  for (const role of ['admin', 'viewer', 'custodian'] as const) {
    it(`${role}: NoAccessError, never TamperedError`, async () => {
      await expect(readAfterLateCreate(role)).rejects.toBeInstanceOf(NoAccessError)
      await expect(readAfterLateCreate(role)).rejects.not.toThrow(TamperedError)
    })
  }

  it('an ENUMERATED permission does cover a late-created collection — #1004 pre-mints that DEK into both keyrings', async () => {
    // The distinction that decides the whole design: naming a collection at
    // grant time lets the DEK be minted then and wrapped for the grantee.
    // A wildcard or a role-based grant cannot enumerate collections that do
    // not exist yet, so those two genuinely cannot be covered.
    await expect(readAfterLateCreate('operator', { late: 'rw' })).resolves.toEqual([{ id: 'l1', n: 7 }])
  })

  it('the message says the grant is stale, not that permissions are missing', async () => {
    await expect(readAfterLateCreate('admin')).rejects.toThrow(/re-grant/i)
  })

  it('the owner is unaffected and still reads the collection', async () => {
    const store = inlineMemory()
    const owner = await createNoydb({ store, user: 'ann', secret: 'ann-secret-2026', teamStrategy: withTeam() })
    await owner.openVault(V)
    await owner.grant(V, { userId: 'belle', displayName: 'Belle', role: 'admin', secret: 'belle-secret-2026', allowWeakSecret: true })
    const ownerAgain = await createNoydb({ store, user: 'ann', secret: 'ann-secret-2026', teamStrategy: withTeam() })
    await (await ownerAgain.openVault(V)).collection<Thing>('late').put('l1', { id: 'l1', n: 7 })

    const reread = await createNoydb({ store, user: 'ann', secret: 'ann-secret-2026', teamStrategy: withTeam() })
    expect(await (await reread.openVault(V)).collection<Thing>('late').list()).toEqual([{ id: 'l1', n: 7 }])
  })

  it('re-granting after the collection exists restores access', async () => {
    const store = inlineMemory()
    const owner = await createNoydb({ store, user: 'ann', secret: 'ann-secret-2026', teamStrategy: withTeam() })
    await owner.openVault(V)
    await owner.grant(V, { userId: 'belle', displayName: 'Belle', role: 'admin', secret: 'belle-secret-2026', allowWeakSecret: true })
    const ownerAgain = await createNoydb({ store, user: 'ann', secret: 'ann-secret-2026', teamStrategy: withTeam() })
    await (await ownerAgain.openVault(V)).collection<Thing>('late').put('l1', { id: 'l1', n: 7 })
    await ownerAgain.grant(V, { userId: 'belle', displayName: 'Belle', role: 'admin', secret: 'belle-secret-2026', allowWeakSecret: true })

    const vault = await (await asUser(store, 'belle', 'belle-secret-2026')).openVault(V)
    expect(await vault.collection<Thing>('late').list()).toEqual([{ id: 'l1', n: 7 }])
  })

  /**
   * The distinction the deny-on-miss check must not lose: a SECOND LIVE HANDLE
   * for the same principal (a second tab, a second `createNoydb` over one
   * store) opened before a collection existed holds a keyring snapshot without
   * that DEK — but the key is already on its own keyring file, because whoever
   * first touched the collection persisted it there. That principal is stale,
   * not unauthorized, and denying them breaks multi-tab propagation.
   */
  it('a second live handle for the SAME user picks up a DEK minted after it opened', async () => {
    const store = inlineMemory()
    const a = await createNoydb({ store, user: 'ann', secret: 'ann-secret-2026', teamStrategy: withTeam() })
    const b = await createNoydb({ store, user: 'ann', secret: 'ann-secret-2026', teamStrategy: withTeam() })
    const va = await a.openVault(V)
    const vb = await b.openVault(V) // opened BEFORE `late` exists

    await va.collection<Thing>('late').put('x', { id: 'x', n: 1 })

    expect(await vb.collection<Thing>('late').list()).toEqual([{ id: 'x', n: 1 }])
  })

  it('the same holds for a grantee whose handle predates the collection but whose grant does not', async () => {
    const store = inlineMemory()
    const owner = await seededOwner(store)
    await owner.grant(V, {
      userId: 'belle', displayName: 'Belle', role: 'admin',
      secret: 'belle-secret-2026', allowWeakSecret: true,
    })
    const belle = await createNoydb({ store, user: 'belle', secret: 'belle-secret-2026', teamStrategy: withTeam() })
    const vb = await belle.openVault(V)

    // Belle's own second handle mints + persists the DEK for a new collection;
    // the first handle must adopt it rather than deny.
    const belle2 = await createNoydb({ store, user: 'belle', secret: 'belle-secret-2026', teamStrategy: withTeam() })
    await (await belle2.openVault(V)).collection<Thing>('fresh').put('f1', { id: 'f1', n: 3 })

    expect(await vb.collection<Thing>('fresh').list()).toEqual([{ id: 'f1', n: 3 }])
  })

  it('creating a brand-new collection still works for an entitled writer', async () => {
    const store = inlineMemory()
    const owner = await seededOwner(store)
    const vault = await owner.openVault(V)
    await expect(vault.collection<Thing>('fresh').put('f1', { id: 'f1', n: 1 })).resolves.not.toThrow()
    expect(await vault.collection<Thing>('fresh').list()).toEqual([{ id: 'f1', n: 1 }])
  })
})
