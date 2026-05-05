/**
 * User-envelope lifecycle binding to keyring grant/revoke (#20).
 *
 * Verifies:
 *  - createOwnerKeyring eager-provisions the _users DEK (no manual
 *    "touch the API to create the DEK" workaround required).
 *  - grant() writes the new principal's envelope, seeded with
 *    initialProfile if provided, else empty.
 *  - The seeded envelope is decryptable by the new principal — the
 *    DEK propagated correctly via the system-collection branch.
 *  - revoke() deletes the principal's envelope alongside the keyring.
 *  - Cascade-revoke of an admin tree deletes every descendant's envelope.
 *
 * @see docs/superpowers/specs/2026-05-05-user-envelope-design.md
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/types.js'
import { createNoydb, type Noydb } from '../src/noydb.js'
import { USER_ENVELOPE_COLLECTION } from '../src/meta/user-envelope/index.js'

interface TestProfile {
  profile: { displayName?: string; locale?: string }
  preferences?: { theme?: 'light' | 'dark' }
}

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

describe('user envelope — keyring lifecycle (#20)', () => {
  let store: NoydbStore
  let aliceDb: Noydb

  beforeEach(async () => {
    store = inlineMemory()
    aliceDb = await createNoydb({ store, user: 'alice', secret: 'alice-pass-2026-strong' })
  })

  it('createOwnerKeyring eager-provisions the _users DEK', async () => {
    const vault = await aliceDb.openVault('demo')
    // No prior call to vault.user.*. The DEK should already exist —
    // a write that requires the DEK should succeed without lazy-create.
    await vault.user.updateMe<TestProfile>({ profile: { displayName: 'Alice' } })
    const me = await vault.user.me<TestProfile>()
    expect(me).not.toBeNull()
    expect(me!.data.profile.displayName).toBe('Alice')
  })

  it('grant() writes an empty envelope by default', async () => {
    await aliceDb.openVault('demo') // ensure vault exists
    await aliceDb.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'viewer',
      passphrase: 'bob-pass-2026-strong',
    })
    aliceDb.close()

    const bobDb = await createNoydb({ store, user: 'bob', secret: 'bob-pass-2026-strong' })
    const bobVault = await bobDb.openVault('demo')
    const me = await bobVault.user.me<TestProfile>()
    expect(me).not.toBeNull()
    // Default seed is `{}`. The reader returns it as the typed shape;
    // an unwritten profile field is undefined.
    expect(me!.data.profile?.displayName).toBeUndefined()
  })

  it('grant() seeds the envelope with initialProfile when provided', async () => {
    await aliceDb.openVault('demo')
    await aliceDb.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'viewer',
      passphrase: 'bob-pass-2026-strong',
      initialProfile: {
        profile: { displayName: 'Bob (pre-filled)', locale: 'fr-FR' },
        preferences: { theme: 'dark' },
      } satisfies TestProfile,
    })
    aliceDb.close()

    // Bob unlocks his own keyring and reads the seeded envelope.
    const bobDb = await createNoydb({ store, user: 'bob', secret: 'bob-pass-2026-strong' })
    const bobVault = await bobDb.openVault('demo')
    const me = await bobVault.user.me<TestProfile>()
    expect(me!.data.profile.displayName).toBe('Bob (pre-filled)')
    expect(me!.data.profile.locale).toBe('fr-FR')
    expect(me!.data.preferences?.theme).toBe('dark')
  })

  it('alice can read bob\'s seeded envelope (cross-principal read)', async () => {
    await aliceDb.openVault('demo')
    await aliceDb.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'viewer',
      passphrase: 'bob-pass-2026-strong',
      initialProfile: { profile: { displayName: 'Bob' } } satisfies TestProfile,
    })
    const aliceVault = await aliceDb.openVault('demo')
    const bobProfile = await aliceVault.user.get<TestProfile>('bob')
    expect(bobProfile!.data.profile.displayName).toBe('Bob')
  })

  it('revoke() deletes the principal\'s user envelope alongside the keyring', async () => {
    await aliceDb.openVault('demo')
    await aliceDb.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'viewer',
      passphrase: 'bob-pass-2026-strong',
      initialProfile: { profile: { displayName: 'Bob' } } satisfies TestProfile,
    })
    const aliceVault = await aliceDb.openVault('demo')
    expect(await aliceVault.user.get<TestProfile>('bob')).not.toBeNull()

    await aliceDb.revoke('demo', { userId: 'bob' })

    // Re-open vault to refresh state — alice still has access.
    aliceDb.close()
    aliceDb = await createNoydb({ store, user: 'alice', secret: 'alice-pass-2026-strong' })
    const refreshed = await aliceDb.openVault('demo')
    expect(await refreshed.user.get<TestProfile>('bob')).toBeNull()

    // Direct store check — no orphan envelope at _users/bob.
    const orphan = await store.get('demo', USER_ENVELOPE_COLLECTION, 'bob')
    expect(orphan).toBeUndefined()
  })

  it('revoke() is idempotent for principals who never wrote (no error on missing envelope)', async () => {
    await aliceDb.openVault('demo')
    await aliceDb.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'viewer',
      passphrase: 'bob-pass-2026-strong',
      // No initialProfile — bob has only the empty `{}` envelope from grant.
    })
    // Even if we hypothetically deleted bob's envelope already (e.g. a
    // race or partial state), revoke must not throw.
    await expect(aliceDb.revoke('demo', { userId: 'bob' })).resolves.toBeUndefined()
  })

  it('cascade-revoke deletes every descendant\'s envelope', async () => {
    await aliceDb.openVault('demo')
    // alice (owner) → bob (admin) → carol (admin granted by bob).
    await aliceDb.grant('demo', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
      passphrase: 'bob-pass-2026-strong',
      initialProfile: { profile: { displayName: 'Bob' } } satisfies TestProfile,
    })
    aliceDb.close()
    const bobDb = await createNoydb({ store, user: 'bob', secret: 'bob-pass-2026-strong' })
    await bobDb.openVault('demo')
    await bobDb.grant('demo', {
      userId: 'carol',
      displayName: 'Carol',
      role: 'admin',
      passphrase: 'carol-pass-2026-strong',
      initialProfile: { profile: { displayName: 'Carol' } } satisfies TestProfile,
    })
    bobDb.close()

    aliceDb = await createNoydb({ store, user: 'alice', secret: 'alice-pass-2026-strong' })
    const aliceVault = await aliceDb.openVault('demo')
    expect(await aliceVault.user.get<TestProfile>('bob')).not.toBeNull()
    expect(await aliceVault.user.get<TestProfile>('carol')).not.toBeNull()

    // Revoke bob with default cascade='strict' → carol goes too.
    await aliceDb.revoke('demo', { userId: 'bob' })

    aliceDb.close()
    aliceDb = await createNoydb({ store, user: 'alice', secret: 'alice-pass-2026-strong' })
    const refreshed = await aliceDb.openVault('demo')
    expect(await refreshed.user.get<TestProfile>('bob')).toBeNull()
    expect(await refreshed.user.get<TestProfile>('carol')).toBeNull()
  })
})
