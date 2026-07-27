/**
 * PR2a — atomic peer-recovery (`db.recoverUser`, issues #33 + #34).
 *
 * Pinned behaviors:
 *   1. Round-trip — alice (owner) recovers bob (admin); bob unlocks
 *      with the temp phrase.
 *   2. Owner→owner allowed — closes #33's hard block when both
 *      principals are co-owners.
 *   3. Admin→owner rejected — the structural rule survives recovery
 *      (admin cannot use peer-recovery as a privilege-uplift vector).
 *   4. Anti-privilege-escalation — caller without a target's DEK
 *      throws PrivilegeEscalationError.
 *   5. Tier-2 slots dropped — slots wrap the OLD KEK; recovery
 *      invalidates them (matches rotateSecret precedent).
 *   6. Identity preserved — userId / role / displayName / capabilities
 *      survive unless explicitly overridden.
 *   7. Atomic-by-construction — a failure mid-recovery (simulated via
 *      a `put`-throwing wrapper store) leaves the original keyring
 *      intact; recipient can still unlock with the OLD secret.
 *   8. Hub-level gating — `db.recoverUser` runs `peer-recover-user`
 *      gate before the team function.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, KeyringFile, KeyringAuthenticator } from '../src/kernel/types.js'
import { createOwnerKeyring, loadKeyring, grant, persistKeyring } from '../src/with-party/team/keyring.js'
import { recoverUser } from '../src/with-party/team/peer-recover.js'
import { generateDEK } from '../src/kernel/enclave/index.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { NoAccessError, PermissionDeniedError, PrivilegeEscalationError, InvalidKeyError } from '../src/kernel/errors.js'
import { PolicyDeniedError } from '../src/kernel/errors.js'
import { STRICT_POLICY } from '../src/with-party/policy/presets.js'
import { withTeam } from '../src/with-party/team/index.js'

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
    async get(c, col, id) { return gc(c, col).get(id) },
    async put(c, col, id, env) { gc(c, col).set(id, env) },
    async delete(c, col, id) { gc(c, col).delete(id) },
    async list(c, col) { return [...gc(c, col).keys()] },
    async loadAll() { return {} },
    async saveAll() {},
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
  } as unknown as NoydbStore
}

const ALICE_PHRASE = 'correct horse battery staple printer toaster'
const BOB_PHRASE = 'glasses cabinet bicycle umbrella thunder velvet'
const TEMP_PHRASE = 'temporary umbrella cabinet bicycle thunder velvet glasses'

describe('recoverUser (#34 atomicity, #33 owner→owner)', () => {
  it('round-trips: owner recovers admin; recipient unlocks with temp phrase', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    aliceKr.deks.set('clients', await generateDEK())
    await persistKeyring(store, 'acme', aliceKr)
    await grant(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
      secret: BOB_PHRASE,
    })

    await recoverUser(store, 'acme', aliceKr, {
      userId: 'bob',
      secret: TEMP_PHRASE,
    })

    // Old phrase no longer unlocks bob's keyring.
    await expect(loadKeyring(store, 'acme', 'bob', BOB_PHRASE)).rejects.toBeInstanceOf(InvalidKeyError)
    // Temp phrase does.
    const bobReloaded = await loadKeyring(store, 'acme', 'bob', TEMP_PHRASE)
    expect(bobReloaded.userId).toBe('bob')
    expect(bobReloaded.role).toBe('admin')
    expect(bobReloaded.deks.size).toBe(aliceKr.deks.size)
  }, 60_000)

  it('owner → owner peer-recovery succeeds (closes #33)', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', aliceKr)
    await grant(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob',
      role: 'owner',
      secret: BOB_PHRASE,
    })

    // Now bob (also owner) forgets his phrase. Alice (owner) recovers him.
    await expect(
      recoverUser(store, 'acme', aliceKr, { userId: 'bob', secret: TEMP_PHRASE }),
    ).resolves.toBeUndefined()

    const bobReloaded = await loadKeyring(store, 'acme', 'bob', TEMP_PHRASE)
    expect(bobReloaded.role).toBe('owner')
  }, 60_000)

  it('admin → owner peer-recovery rejected (the structural boundary survives recovery)', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', aliceKr)
    await grant(store, 'acme', aliceKr, {
      userId: 'admin1',
      displayName: 'Admin 1',
      role: 'admin',
      secret: 'admin-strong-phrase-with-enough-words-here',
    })

    // Admin tries to recover the owner (alice).
    const adminKr = await loadKeyring(store, 'acme', 'admin1', 'admin-strong-phrase-with-enough-words-here')
    await expect(
      recoverUser(store, 'acme', adminKr, { userId: 'alice', secret: TEMP_PHRASE }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  }, 60_000)

  it('admin cannot uplift a target to owner under cover of recovery', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', aliceKr)
    await grant(store, 'acme', aliceKr, {
      userId: 'admin1',
      displayName: 'Admin 1',
      role: 'admin',
      secret: 'admin-strong-phrase-with-enough-words-here',
    })
    await grant(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob',
      role: 'operator',
      secret: BOB_PHRASE,
    })

    const adminKr = await loadKeyring(store, 'acme', 'admin1', 'admin-strong-phrase-with-enough-words-here')
    await expect(
      recoverUser(store, 'acme', adminKr, {
        userId: 'bob',
        role: 'owner', // ← role uplift attempt
        secret: TEMP_PHRASE,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  }, 60_000)

  it('throws NoAccessError when the target has no keyring', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    await persistKeyring(store, 'acme', aliceKr)
    await expect(
      recoverUser(store, 'acme', aliceKr, { userId: 'ghost', secret: TEMP_PHRASE }),
    ).rejects.toBeInstanceOf(NoAccessError)
  })

  it('throws PrivilegeEscalationError when caller lacks a target collection DEK', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', aliceKr)
    await grant(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
      secret: BOB_PHRASE,
    })
    // Drop the 'invoices' DEK from caller's in-memory keyring AFTER
    // bob has it — simulates "the caller's DEK set is narrower than
    // the target's." The persisted keyring file still has it, so
    // canRecover passes; the in-memory check should catch it.
    aliceKr.deks.delete('invoices')

    await expect(
      recoverUser(store, 'acme', aliceKr, { userId: 'bob', secret: TEMP_PHRASE }),
    ).rejects.toBeInstanceOf(PrivilegeEscalationError)
  }, 60_000)

  it('drops tier-2 authenticator slots on recovery (matches rotateSecret precedent)', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', aliceKr)
    await grant(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
      secret: BOB_PHRASE,
    })

    // Simulate bob having enrolled a tier-2 slot before recovery —
    // patch the persisted keyring file directly (faster than running
    // the full enrollAuthenticator path).
    const env = await store.get('acme', '_keyring', 'bob')
    const file = JSON.parse(env!._data) as KeyringFile
    const slot: KeyringAuthenticator = {
      id: 'webauthn-old',
      method: 'webauthn',
      enrolled_at: new Date().toISOString(),
      enrolled_via_tier: 1,
      wrapped_kek: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
      meta: { credentialId: 'cred-old' },
    }
    const fileWithSlot: KeyringFile = { ...file, authenticators: [slot] }
    await store.put('acme', '_keyring', 'bob', {
      _noydb: 1, _v: 1, _ts: new Date().toISOString(), _iv: '',
      _data: JSON.stringify(fileWithSlot),
    })

    await recoverUser(store, 'acme', aliceKr, { userId: 'bob', secret: TEMP_PHRASE })

    const bobReloaded = await loadKeyring(store, 'acme', 'bob', TEMP_PHRASE)
    expect(bobReloaded.authenticators).toHaveLength(0)
  }, 60_000)

  it('preserves identity (userId / displayName / role) when not overridden', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', aliceKr)
    await grant(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob the Original',
      role: 'admin',
      secret: BOB_PHRASE,
    })

    await recoverUser(store, 'acme', aliceKr, { userId: 'bob', secret: TEMP_PHRASE })

    const bobReloaded = await loadKeyring(store, 'acme', 'bob', TEMP_PHRASE)
    expect(bobReloaded.userId).toBe('bob')
    expect(bobReloaded.displayName).toBe('Bob the Original')
    expect(bobReloaded.role).toBe('admin')
  }, 60_000)

  it('honors displayName override when provided', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', aliceKr)
    await grant(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob the Original',
      role: 'admin',
      secret: BOB_PHRASE,
    })

    await recoverUser(store, 'acme', aliceKr, {
      userId: 'bob',
      secret: TEMP_PHRASE,
      displayName: 'Bob the Recovered',
    })

    const bobReloaded = await loadKeyring(store, 'acme', 'bob', TEMP_PHRASE)
    expect(bobReloaded.displayName).toBe('Bob the Recovered')
  }, 60_000)

  it('atomic-by-construction: pre-put failure leaves the original keyring intact', async () => {
    const innerStore = inlineMemory()
    const aliceKr = await createOwnerKeyring(innerStore, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    await persistKeyring(innerStore, 'acme', aliceKr)
    await grant(innerStore, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
      secret: BOB_PHRASE,
    })

    // Wrap the store so any put against `_keyring` throws — simulates
    // a backend write failure mid-recovery. recoverUser executes
    // load/check/derive/wrap/build before the put; the put is the
    // only mutation. Throwing here proves the invariant: the original
    // keyring stays intact, no partial-failure window.
    const failingStore: NoydbStore = {
      ...innerStore,
      put: async (vault: string, coll: string, id: string, env: EncryptedEnvelope) => {
        if (coll === '_keyring') {
          throw new Error('simulated backend write failure')
        }
        return innerStore.put(vault, coll, id, env)
      },
    } as unknown as NoydbStore

    await expect(
      recoverUser(failingStore, 'acme', aliceKr, { userId: 'bob', secret: TEMP_PHRASE }),
    ).rejects.toThrow('simulated backend write failure')

    // Original keyring still unlocks with the OLD phrase.
    const bobReloaded = await loadKeyring(innerStore, 'acme', 'bob', BOB_PHRASE)
    expect(bobReloaded.userId).toBe('bob')
  }, 60_000)
})

describe('db.recoverUser (#33 + #34 hub-level integration)', () => {
  it('runs the peer-recover-user policy gate before the team call', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ teamStrategy: withTeam(),
      store,
      user: 'alice',
      secret: ALICE_PHRASE,
      // Strict policy requires a recovery / TOTP / email-OTP factor proof
      // for peer-recover-user (per the preset's gate definition).
      policy: STRICT_POLICY,
    })
    await db.openVault('acme')
    // grant() under STRICT_POLICY requires a factor proof (#79 wired the
    // enroll-user gate). Pass TOTP for the setup; the actual assertion
    // below is about recoverUser's gate, not grant's.
    await db.grant('acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
      secret: BOB_PHRASE,
    }, { factors: [{ kind: 'totp', mintedAt: new Date().toISOString() }] })

    // Without a factor proof, the gate denies.
    await expect(
      db.team.recoverUser('acme', { userId: 'bob', secret: TEMP_PHRASE }),
    ).rejects.toBeInstanceOf(PolicyDeniedError)

    // With a recovery factor proof, recovery succeeds.
    await db.team.recoverUser(
      'acme',
      { userId: 'bob', secret: TEMP_PHRASE },
      { factors: [{ kind: 'recovery', mintedAt: new Date().toISOString() }] },
    )

    const bobReloaded = await loadKeyring(store, 'acme', 'bob', TEMP_PHRASE)
    expect(bobReloaded.userId).toBe('bob')
  }, 60_000)
})
