/**
 * The keyring's AUTHORITY half is unauthenticated (#1043).
 *
 * ## What this set was written to answer, and what it found instead
 *
 * #1043 left exactly one question open: *can `grant` ever mint a keyring
 * broader than the user's later standing?* — because if so, a store that
 * suppresses a `_keyring` write hands back **escalation** rather than mere
 * reinstatement, and ADR 0003's rotation argument (an old roster's DEKs cannot
 * open post-rotation records) stops covering it.
 *
 * The answer is yes (section B). But probing it surfaced something strictly
 * larger, and section A leads with it:
 *
 * > **A `_keyring` file is stored in PLAINTEXT** (`_iv: ''`). `role` and
 * > `permissions` sit in the clear, authenticated by nothing. Only `deks` and
 * > `canary` are wrapped under the user's KEK.
 *
 * So a hostile store does not need to keep an old file and replay it. It edits
 * one word. #1043's own text says *"the store cannot fabricate one (KEK +
 * canary must check out)"* — that is true of the **keys** and false of the
 * **role**, and the distinction is the whole finding.
 *
 * ## The boundary, measured rather than asserted
 *
 * | | forgeable by the store? |
 * |---|---|
 * | **authority** — `role`, and every capability gated on it | **YES** — plaintext, unauthenticated |
 * | **confidentiality** — which collections you can decrypt | no — bounded by the AES-KW-wrapped DEKs |
 *
 * A forged admin can `grant` and `revoke` real users. It still cannot read a
 * collection it holds no DEK for. Both halves are pinned below, because a fix
 * that authenticates the file must preserve the second while closing the first.
 *
 * ## These rows assert the VULNERABILITY, deliberately
 *
 * Same convention as the `_tier`/rewind rows in the identity harness: recording
 * real behaviour beats asserting a defence that does not exist. When the roster
 * gains an authenticated epoch these flip to refusals, and the flip is the
 * signal that the fix landed.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import type { NoydbStore } from '../src/kernel/types.js'

const VAULT = 'acme'

async function ownerWith(store: NoydbStore) {
  const db = await createNoydb({ teamStrategy: withTeam(), store, user: 'owner-01', secret: 'owner-pass-1' })
  const vault = await db.openVault(VAULT)
  await vault.collection<{ amount: number }>('invoices').put('inv-1', { amount: 100 })
  return { db, vault }
}

/** The store rewrites the one plaintext word. No key, no prior file. */
async function forgeRole(store: NoydbStore, userId: string, role: string): Promise<void> {
  const env = (await store.get(VAULT, '_keyring', userId))!
  await store.put(VAULT, '_keyring', userId, {
    ...env,
    _data: env._data.replace(/"role":"[a-z]+"/, `"role":"${role}"`),
  })
}

describe('#1043 A — a `_keyring` file is plaintext, so ROLE is forgeable outright', () => {
  it('1. the file really is plaintext — `_iv` is empty and `role` is readable', async () => {
    // Stated as a fact of the format rather than left implicit, because every
    // row below follows from it and a future change to encrypt the file should
    // fail HERE first, loudly, rather than silently making the rest vacuous.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    const env = (await store.get(VAULT, '_keyring', 'bob'))!
    expect(env._iv).toBe('')
    expect(env._data).toContain('"role":"viewer"')
    // The keys, by contrast, are wrapped — this is the half that holds.
    expect(env._data).not.toContain('bob-pass-1')
  })

  it('2. editing that word promotes a viewer to admin, and the promotion is REAL', async () => {
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    // Control first: a genuine viewer is refused, so what follows cannot pass
    // because granting happens to be unguarded.
    const asViewer = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    await expect(
      asViewer.grant(VAULT, { userId: 'm', displayName: 'M', role: 'viewer', secret: 'm-pass-1' }),
    ).rejects.toThrow()

    await forgeRole(store, 'bob', 'admin')

    const forged = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    expect((await forged.openVault(VAULT))._introspectState().keyring.role).toBe('admin')
    await expect(
      forged.grant(VAULT, { userId: 'm', displayName: 'M', role: 'viewer', secret: 'm-pass-1' }),
    ).resolves.toBeUndefined()
    // The minted user is real — the escalation propagates into the roster.
    expect(await store.get(VAULT, '_keyring', 'm')).not.toBeNull()
  })

  it('3. a forged admin can REVOKE a genuine user — availability, not just confidentiality', async () => {
    // Worth its own row: revocation needs no keys at all, so this is reachable
    // even by a forged role that inherited a nearly empty DEK map.
    const store = memoryStore()
    const { db } = await ownerWith(store)
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'client', secret: 'bob-pass-1', permissions: { invoices: 'ro' } })
    await db.grant(VAULT, { userId: 'carol', displayName: 'C', role: 'viewer', secret: 'carol-pass-1' })

    // Control: the genuine `client` bob is refused.
    const asClient = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    await expect(asClient.revoke(VAULT, { userId: 'carol' })).rejects.toThrow()
    expect(await store.get(VAULT, '_keyring', 'carol')).not.toBeNull()

    await forgeRole(store, 'bob', 'admin')
    const forged = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    await forged.revoke(VAULT, { userId: 'carol' })
    // Assert the EFFECT, not the return value — `revoke` resolves to void, so
    // `resolves.toBeDefined()` fails on a revocation that actually happened.
    expect(await store.get(VAULT, '_keyring', 'carol')).toBeNull()
  })

  it('4. THE BOUND THAT HOLDS: a forged role does not confer a key it never had', async () => {
    // This is what keeps the finding at "authority forgery" rather than "total
    // compromise", and it is exactly the property a fix must not trade away.
    // `role` is plaintext; `deks` are AES-KW-wrapped under the user's KEK, and
    // the store holds no KEK.
    const store = memoryStore()
    const { db, vault } = await ownerWith(store)
    await vault.collection<{ amount: number }>('secrets').put('s-1', { amount: 42 })
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'client', secret: 'bob-pass-1', permissions: { invoices: 'ro' } })

    await forgeRole(store, 'bob', 'admin')
    const forged = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    const bv = await forged.openVault(VAULT)
    await expect(bv.collection<{ amount: number }>('secrets').get('s-1')).rejects.toThrow()
  })
})

describe('#1043 B — the original question: a replay is ESCALATION, not reinstatement', () => {
  it('5. a re-grant NARROWS standing in place, so a broader file legitimately existed', async () => {
    // The premise the whole question rests on. If narrowing required
    // revoke-then-grant (which rotates), there would be no broader file to
    // keep. It does not: `grant` overwrites unconditionally.
    const store = memoryStore()
    const { db } = await ownerWith(store)

    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'admin', secret: 'bob-pass-1' })
    const asAdmin = (await store.get(VAULT, '_keyring', 'bob'))!
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })
    const asViewer = (await store.get(VAULT, '_keyring', 'bob'))!

    expect(asViewer).not.toEqual(asAdmin)
    const bobNow = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    expect((await bobNow.openVault(VAULT))._introspectState().keyring.role).toBe('viewer')
  })

  it('6. replaying the pre-narrowing file restores the higher role', async () => {
    // Nothing in the load path asks "is this the current roster?" — no epoch,
    // no monotonic marker, no signature over "this is version N".
    const store = memoryStore()
    const { db } = await ownerWith(store)

    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'admin', secret: 'bob-pass-1' })
    const asAdmin = (await store.get(VAULT, '_keyring', 'bob'))!
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    await store.put(VAULT, '_keyring', 'bob', asAdmin)

    const bob = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    expect((await bob.openVault(VAULT))._introspectState().keyring.role).toBe('admin')
  })

  it('7. rotation does NOT bound the replay — the restored DEKs are current', async () => {
    // Precisely where ADR 0003's rotation argument stops applying, and the
    // reason this needed probing rather than reasoning about.
    //
    // For a REVOKED member the argument holds: revocation rotates, so an old
    // roster's DEKs open nothing written since. A NARROWING re-grant rotates
    // nothing — the collection DEKs are untouched — so the replayed file opens
    // data added AFTER the narrowing. That is live access, not stale access.
    const store = memoryStore()
    const { db, vault } = await ownerWith(store)

    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'admin', secret: 'bob-pass-1' })
    const asAdmin = (await store.get(VAULT, '_keyring', 'bob'))!
    await db.grant(VAULT, { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass-1' })

    await vault.collection<{ amount: number }>('invoices').put('inv-2', { amount: 999 })

    await store.put(VAULT, '_keyring', 'bob', asAdmin)
    const replayed = await createNoydb({ teamStrategy: withTeam(), store, user: 'bob', secret: 'bob-pass-1' })
    const bv = await replayed.openVault(VAULT)
    expect(await bv.collection<{ amount: number }>('invoices').get('inv-2')).toEqual({ amount: 999 })
  })
})
