/**
 * Tests for `NoydbOptions.getKeyring` — the fix for issue #5
 * (biometric / WebAuthn / OIDC unlock paths producing UnlockedKeyring
 * cannot currently be plumbed into createNoydb without a passphrase
 * bridge).
 */

import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { loadKeyring } from '../src/with-party/team/keyring.js'
import type { UnlockedKeyring } from '../src/with-party/team/keyring.js'

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

interface Note { title: string }

describe('NoydbOptions.getKeyring (issue #5)', () => {
  it('opens an existing vault using a caller-supplied UnlockedKeyring', async () => {
    const adapter = inlineMemory()
    const VAULT = 'V1'

    // Bootstrap: passphrase-based session writes a record to disk.
    const phaseOne = await createNoydb({ store: adapter, user: 'alice', secret: 'first-pass' })
    const v1 = await phaseOne.openVault(VAULT)
    await v1.collection<Note>('notes').put('n1', { title: 'hello' })

    // Now simulate biometric unlock: load the keyring out-of-band, then
    // open a fresh Noydb instance using only the keyring (no passphrase).
    const keyring = await loadKeyring(adapter, VAULT, 'alice', 'first-pass')

    const phaseTwo = await createNoydb({
      store: adapter,
      user: 'alice',
      getKeyring: async () => keyring,
    })
    const v2 = await phaseTwo.openVault(VAULT)
    const note = await v2.collection<Note>('notes').get('n1')
    expect(note?.title).toBe('hello')
  })

  it('round-trips writes through a getKeyring-only session', async () => {
    const adapter = inlineMemory()
    const VAULT = 'V1'

    const bootstrap = await createNoydb({ store: adapter, user: 'alice', secret: 'first-pass' })
    await bootstrap.openVault(VAULT)
    const keyring = await loadKeyring(adapter, VAULT, 'alice', 'first-pass')

    const db = await createNoydb({
      store: adapter,
      user: 'alice',
      getKeyring: async () => keyring,
    })
    const v = await db.openVault(VAULT)
    await v.collection<Note>('notes').put('n2', { title: 'written via callback' })
    expect((await v.collection<Note>('notes').get('n2'))?.title).toBe('written via callback')
  })

  it('caches the keyring per vault — callback invoked at most once per (instance, vault)', async () => {
    const adapter = inlineMemory()
    const VAULT = 'V1'

    const bootstrap = await createNoydb({ store: adapter, user: 'alice', secret: 'first-pass' })
    const v1 = await bootstrap.openVault(VAULT)
    await v1.collection<Note>('notes').put('n1', { title: 'a' })
    await v1.collection<Note>('notes').put('n2', { title: 'b' })
    const keyring = await loadKeyring(adapter, VAULT, 'alice', 'first-pass')

    let callCount = 0
    const db = await createNoydb({
      store: adapter,
      user: 'alice',
      getKeyring: async () => { callCount++; return keyring },
    })
    const v = await db.openVault(VAULT)

    // Multiple operations on the same vault should still invoke the callback only once.
    await v.collection<Note>('notes').get('n1')
    await v.collection<Note>('notes').get('n2')
    await v.collection<Note>('notes').list()
    expect(callCount).toBe(1)
  })

  it('throws at createNoydb if both secret and getKeyring are supplied', async () => {
    const adapter = inlineMemory()
    const dummyKeyring = {} as UnlockedKeyring
    await expect(
      createNoydb({
        store: adapter,
        user: 'alice',
        secret: 'p',
        getKeyring: async () => dummyKeyring,
      }),
    ).rejects.toThrow(/either `secret` or `getKeyring`, not both/)
  })

  it('throws at createNoydb if neither secret nor getKeyring is supplied (encryption on)', async () => {
    const adapter = inlineMemory()
    await expect(
      createNoydb({ store: adapter, user: 'alice' }),
    ).rejects.toThrow(/passphrase\) or getKeyring/)
  })

  it('still allows encrypt: false without secret OR getKeyring', async () => {
    const adapter = inlineMemory()
    const db = await createNoydb({ store: adapter, user: 'alice', encrypt: false })
    const v = await db.openVault('V1')
    await v.collection<Note>('notes').put('n1', { title: 'plaintext' })
    expect((await v.collection<Note>('notes').get('n1'))?.title).toBe('plaintext')
  })

  it('propagates callback rejection from openVault (lazy unlock surfaces on first vault open)', async () => {
    const adapter = inlineMemory()
    const db = await createNoydb({
      store: adapter,
      user: 'alice',
      getKeyring: async () => {
        throw new Error('SimulatedWebAuthnCancelled')
      },
    })
    // createNoydb itself succeeds (lazy unlock).
    // openVault triggers the keyring callback; the rejection surfaces here.
    await expect(db.openVault('V1')).rejects.toThrow(/SimulatedWebAuthnCancelled/)
  })

  it('issue #6: openVault succeeds on a cleared data store when getKeyring callback returns a valid keyring', async () => {
    const adapter = inlineMemory()

    // Bootstrap: create a vault with some data so the keyring exists on disk.
    const db1 = await createNoydb({ store: adapter, user: 'alice', secret: 'p' })
    const v1 = await db1.openVault('niwat')
    await v1.collection<Note>('notes').put('n1', { title: 'hello' })

    // Capture the keyring as it would be held by an "auth store" (e.g. niwat-auth_noydb).
    const authKeyring = await loadKeyring(adapter, 'niwat', 'alice', 'p')

    // Simulate the user deleting niwat_noydb in DevTools — use a fresh empty adapter.
    const clearedAdapter = inlineMemory()

    // The app's getKeyring callback reads from the still-intact auth store
    // (niwat-auth_noydb) and returns the keyring without touching the data store.
    const db2 = await createNoydb({
      store: clearedAdapter,
      user: 'alice',
      getKeyring: async () => authKeyring,
    })

    // Expected: openVault initialises a blank vault, not an InvalidKeyError.
    const v2 = await db2.openVault('niwat')
    expect(await v2.collection<Note>('notes').list()).toHaveLength(0)
  })

  it('different vaults invoke the callback independently', async () => {
    const adapter = inlineMemory()

    // Bootstrap two vaults under the same user with passphrase.
    const bootstrap = await createNoydb({ store: adapter, user: 'alice', secret: 'p' })
    const va = await bootstrap.openVault('VA')
    const vb = await bootstrap.openVault('VB')
    await va.collection<Note>('notes').put('a', { title: 'A' })
    await vb.collection<Note>('notes').put('b', { title: 'B' })
    const krA = await loadKeyring(adapter, 'VA', 'alice', 'p')
    const krB = await loadKeyring(adapter, 'VB', 'alice', 'p')

    const seenVaults: string[] = []
    const db = await createNoydb({
      store: adapter,
      user: 'alice',
      getKeyring: async (vault) => {
        seenVaults.push(vault)
        if (vault === 'VA') return krA
        if (vault === 'VB') return krB
        throw new Error(`unexpected vault: ${vault}`)
      },
    })

    expect((await (await db.openVault('VA')).collection<Note>('notes').get('a'))?.title).toBe('A')
    expect((await (await db.openVault('VB')).collection<Note>('notes').get('b'))?.title).toBe('B')

    expect(seenVaults).toEqual(['VA', 'VB'])
  })

  it('issue #88: db.team.getKeyring() returns a defensive copy — mutations on the returned Map do NOT leak into the cache', async () => {
    const adapter = inlineMemory()
    const db = await createNoydb({ store: adapter, user: 'alice', secret: 'p' })
    const vault = await db.openVault('acme')
    await vault.collection<Note>('notes').put('n-1', { title: 'first' })

    const snapshot1 = await db.team.getKeyring('acme')
    const collectionsBefore = [...snapshot1.deks.keys()].sort()

    // Mutate the returned Map. Pre-fix this would corrupt the hub's
    // cached keyring; post-fix it's a no-op on the cached state.
    snapshot1.deks.set('hijacked', snapshot1.deks.get('notes')!)
    snapshot1.deks.delete('notes')

    const snapshot2 = await db.team.getKeyring('acme')
    const collectionsAfter = [...snapshot2.deks.keys()].sort()
    expect(collectionsAfter).toEqual(collectionsBefore)
    expect(snapshot2.deks.has('hijacked')).toBe(false)
    expect(snapshot2.deks.has('notes')).toBe(true)

    // Subsequent vault operations still work — the cache wasn't corrupted.
    await vault.collection<Note>('notes').put('n-2', { title: 'second' })
    expect((await vault.collection<Note>('notes').get('n-2'))?.title).toBe('second')
  })

  it('issue #114: defensive copy also clones permissions and per-authenticator meta', async () => {
    const adapter = inlineMemory()
    const db = await createNoydb({ store: adapter, user: 'alice', secret: 'p' })
    await db.openVault('acme')
    // Inject a tier-2 slot directly into alice's keyring file so the snapshot
    // has a non-empty `authenticators` array with a real `meta` to mutate.
    const env = await adapter.get('acme', '_keyring', 'alice')
    const file = JSON.parse(env!._data) as Record<string, unknown> & { authenticators?: unknown[] }
    file.authenticators = [{
      id: 'webauthn-yubi',
      method: 'webauthn',
      enrolled_at: new Date().toISOString(),
      enrolled_via_tier: 1,
      wrapped_kek: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
      meta: { credentialId: 'cred-yubi', nickname: 'Original' },
    }]
    await adapter.put('acme', '_keyring', 'alice', { ...env!, _data: JSON.stringify(file) })
    // Force a fresh keyring load (the cache was populated from the original
    // envelope before we patched in the slot).
    db.close()
    const db2 = await createNoydb({ store: adapter, user: 'alice', secret: 'p' })
    await db2.openVault('acme')

    const snapshot1 = await db2.team.getKeyring('acme')

    // Mutate fields the original PR didn't deep-copy. Each of these would
    // corrupt the cache pre-#114 (they'd land on the cached keyring's
    // shared sub-objects).
    ;(snapshot1.permissions as Record<string, 'ro' | 'rw'>)['injected'] = 'rw'
    ;(snapshot1.authenticators[0]!.meta as Record<string, unknown>)['nickname'] = 'Hijacked'

    const snapshot2 = await db2.team.getKeyring('acme')
    expect((snapshot2.permissions as Record<string, 'ro' | 'rw'>)['injected']).toBeUndefined()
    expect(snapshot2.authenticators[0]!.meta['nickname']).toBe('Original')
  })
})
