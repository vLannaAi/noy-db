/**
 * #1097 — a NARROWING re-grant rotates what it takes away.
 *
 * `writeKeyringFile` is a bare `put`, so a re-grant OVERWRITES in place and the
 * file it replaces was legitimately minted by this vault. A store that kept a
 * copy can re-serve it, and `loadKeyring` accepts it: the KEK unwraps, the
 * canary checks out, the roster tag verifies — none of which is a claim about
 * being CURRENT.
 *
 * ADR 0003 bounded a suppressed keyring delete on the grounds that revocation
 * rotates, so an old roster's DEKs cannot open post-rotation records. A
 * narrowing re-grant rotated NOTHING, so a replayed file opened records written
 * after the narrowing — live access rather than stale access. Rotating the
 * dropped collections restores that bound.
 *
 * ⚠️ The replay itself is NOT closed by this, and #1097 stays open for it: the
 * old file also restores the old ROLE, and role gates capabilities rather than
 * keys. That half needs an anchor the store cannot rewind.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'

const VAULT = 'acme'
const OWNER_SECRET = 'owner-pass-correct-horse-battery-staple'
const BOB_SECRET = 'bob-pass-correct-horse-battery-staple'

interface Doc extends Record<string, unknown> { body: string }

async function seeded() {
  const store = memoryStore()
  const db = await createNoydb({ teamStrategy: withTeam(), store, user: 'owner', secret: OWNER_SECRET })
  const vault = await db.openVault(VAULT)
  await vault.collection<Doc>('secrets').put('s1', { body: 'before' })
  await vault.collection<Doc>('public').put('p1', { body: 'public' })
  return { store, db, vault }
}

/** The envelope of a collection record, straight off the store. */
const raw = (store: NoydbStore, coll: string, id: string): Promise<EncryptedEnvelope | null> =>
  store.get(VAULT, coll, id)

describe('#1097 — narrowing a grant rotates the collections it drops', () => {
  it('a record written AFTER the narrowing is not readable with the pre-narrowing keyring', async () => {
    const { store, db, vault } = await seeded()

    // Bob is granted both collections...
    await db.grant(VAULT, {
      userId: 'bob', displayName: 'B', role: 'operator', secret: BOB_SECRET,
      permissions: { secrets: 'rw', public: 'rw' },
    })
    // ...and the store keeps a copy of that broader file.
    const replayable = (await store.get(VAULT, '_keyring', 'bob'))!

    // Narrowed: `secrets` is taken away.
    await db.grant(VAULT, {
      userId: 'bob', displayName: 'B', role: 'operator', secret: BOB_SECRET,
      permissions: { public: 'rw' },
    })

    // A record written after the narrowing.
    await vault.collection<Doc>('secrets').put('s2', { body: 'after' })

    // The store re-serves the broader file — the replay this issue is about.
    await store.put(VAULT, '_keyring', 'bob', replayable)

    const bobDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: BOB_SECRET })
    const bobVault = await bobDb.openVault(VAULT)
    // The replayed keyring's `secrets` DEK is now stale: it cannot open the
    // record written after the narrowing.
    await expect(bobVault.collection<Doc>('secrets').get('s2')).rejects.toThrow()
  })

  it('the owner still reads everything afterwards — availability, the other half', async () => {
    const { db, vault } = await seeded()
    await db.grant(VAULT, {
      userId: 'bob', displayName: 'B', role: 'operator', secret: BOB_SECRET,
      permissions: { secrets: 'rw', public: 'rw' },
    })
    await db.grant(VAULT, {
      userId: 'bob', displayName: 'B', role: 'operator', secret: BOB_SECRET,
      permissions: { public: 'rw' },
    })
    expect(await vault.collection<Doc>('secrets').get('s1')).toMatchObject({ body: 'before' })
    expect(await vault.collection<Doc>('public').get('p1')).toMatchObject({ body: 'public' })
  })

  it('rotation actually happened — the dropped collection re-encrypted', async () => {
    const { store, db } = await seeded()
    await db.grant(VAULT, {
      userId: 'bob', displayName: 'B', role: 'operator', secret: BOB_SECRET,
      permissions: { secrets: 'rw', public: 'rw' },
    })
    const before = (await raw(store, 'secrets', 's1'))!._data
    await db.grant(VAULT, {
      userId: 'bob', displayName: 'B', role: 'operator', secret: BOB_SECRET,
      permissions: { public: 'rw' },
    })
    const after = (await raw(store, 'secrets', 's1'))!._data
    expect(after).not.toBe(before)
  })

  it('a WIDENING re-grant rotates nothing — this is not a tax on every grant', async () => {
    const { store, db } = await seeded()
    await db.grant(VAULT, {
      userId: 'bob', displayName: 'B', role: 'operator', secret: BOB_SECRET,
      permissions: { public: 'rw' },
    })
    const before = (await raw(store, 'public', 'p1'))!._data
    await db.grant(VAULT, {
      userId: 'bob', displayName: 'B', role: 'operator', secret: BOB_SECRET,
      permissions: { secrets: 'rw', public: 'rw' },
    })
    expect((await raw(store, 'public', 'p1'))!._data).toBe(before)
  })

  it('a FIRST grant rotates nothing', async () => {
    const { store, db } = await seeded()
    const before = (await raw(store, 'secrets', 's1'))!._data
    await db.grant(VAULT, {
      userId: 'carol', displayName: 'C', role: 'operator', secret: 'carol-pass-correct-horse-battery',
      permissions: { secrets: 'rw' },
    })
    expect((await raw(store, 'secrets', 's1'))!._data).toBe(before)
  })
})
