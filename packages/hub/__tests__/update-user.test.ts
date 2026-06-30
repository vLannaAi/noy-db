/**
 * #54 — db.updateUser for post-grant role / displayName / permissions mutation.
 *
 * Pinned behaviors:
 *   1. Round-trip — owner promotes a viewer to admin; new role + displayName
 *      + permissions persist; userId unchanged.
 *   2. Pure header rewrite — DEKs preserved (count + keys identical
 *      pre/post update). No re-encrypt of any record. Optimistic
 *      concurrency via the existing envelope put.
 *   3. Partial diff — only specified fields move. Omitted fields untouched.
 *   4. Tier-2 slots survive — wrapped DEKs / authenticators[] not affected.
 *   5. Empty diff — ValidationError.
 *   6. Missing keyring — NoAccessError.
 *   7. Role-elevation guard — admin cannot promote target to owner;
 *      admin cannot demote an owner; owner can do anything.
 *   8. Self-elevation blocked — admin cannot upgrade their OWN role to
 *      owner via updateUser.
 *   9. Hub-level gating — `db.updateUser` runs `update-user` gate.
 *      STRICT_POLICY without factor proof rejects.
 *  10. Post-update self-targeting refreshes the cached keyring so the
 *      caller sees their own updated header on subsequent reads.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, KeyringFile, KeyringAuthenticator } from '../src/types.js'
import { createOwnerKeyring, loadKeyring, grant, persistKeyring, updateKeyringIdentity } from '../src/with-party/team/keyring.js'
import { generateDEK } from '../src/crypto.js'
import { createNoydb } from '../src/noydb.js'
import { NoAccessError, PermissionDeniedError, ValidationError } from '../src/errors.js'
import { PolicyDeniedError } from '../src/policy/errors.js'
import { STRICT_POLICY } from '../src/policy/presets.js'

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
const CAROL_PHRASE = 'evergreen marble lantern apricot velvet thunder'

describe('updateKeyringIdentity (team layer, #54)', () => {
  it('owner updates role + displayName + permissions in one call', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    aliceKr.deks.set('clients', await generateDEK())
    await persistKeyring(store, 'acme', aliceKr)
    await grant(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob',
      role: 'viewer',
      passphrase: BOB_PHRASE,
    })

    const bobBefore = await loadKeyring(store, 'acme', 'bob', BOB_PHRASE)
    const dekKeysBefore = [...bobBefore.deks.keys()].sort()

    await updateKeyringIdentity(store, 'acme', aliceKr, {
      userId: 'bob',
      role: 'operator',
      displayName: 'Bob the Operator',
      permissions: { invoices: 'rw' },
    })

    // Same passphrase still unlocks — KEK / salt / DEKs unchanged.
    const bobAfter = await loadKeyring(store, 'acme', 'bob', BOB_PHRASE)
    expect(bobAfter.userId).toBe('bob')
    expect(bobAfter.displayName).toBe('Bob the Operator')
    expect(bobAfter.role).toBe('operator')
    expect(bobAfter.permissions).toEqual({ invoices: 'rw' })

    // Pure header rewrite — DEK set identical (same collection names, same count).
    const dekKeysAfter = [...bobAfter.deks.keys()].sort()
    expect(dekKeysAfter).toEqual(dekKeysBefore)
  }, 60_000)

  it('partial diff — only specified field changes', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', aliceKr)
    await grant(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob the Original',
      role: 'admin',
      passphrase: BOB_PHRASE,
    })

    await updateKeyringIdentity(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob the Renamed',
    })

    const bob = await loadKeyring(store, 'acme', 'bob', BOB_PHRASE)
    expect(bob.displayName).toBe('Bob the Renamed')
    // Untouched fields survive.
    expect(bob.role).toBe('admin')
  }, 60_000)

  it('issue #85: displayName: null clears the field (matches UserApi.updateMe convention)', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', aliceKr)
    await grant(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob the Original',
      role: 'admin',
      passphrase: BOB_PHRASE,
    })

    await updateKeyringIdentity(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: null,
    })

    const bob = await loadKeyring(store, 'acme', 'bob', BOB_PHRASE)
    expect(bob.displayName).toBe('')
    // Other fields untouched.
    expect(bob.role).toBe('admin')
  }, 60_000)

  it('issue #85: displayName: undefined leaves the field untouched (preserve semantics)', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', aliceKr)
    await grant(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob the Original',
      role: 'admin',
      passphrase: BOB_PHRASE,
    })

    // Update only role — displayName should survive.
    await updateKeyringIdentity(store, 'acme', aliceKr, {
      userId: 'bob',
      role: 'operator',
      permissions: { invoices: 'rw' },
    })

    const bob = await loadKeyring(store, 'acme', 'bob', BOB_PHRASE)
    expect(bob.displayName).toBe('Bob the Original')
    expect(bob.role).toBe('operator')
  }, 60_000)

  it('tier-2 authenticator slots survive the update (#54 vs peer-recover)', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', aliceKr)
    await grant(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
      passphrase: BOB_PHRASE,
    })

    // Inject a tier-2 slot directly into bob's keyring file (no real
    // ceremony needed — the test only asserts persistence semantics).
    const env = await store.get('acme', '_keyring', 'bob')
    const file = JSON.parse(env!._data) as KeyringFile
    const slot: KeyringAuthenticator = {
      id: 'webauthn-yubikey',
      method: 'webauthn',
      enrolled_at: new Date().toISOString(),
      enrolled_via_tier: 1,
      wrapKind: 'kek',
      wrapped_kek: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
      meta: { credentialId: 'cred-yubi' },
    }
    const withSlot: KeyringFile = { ...file, authenticators: [slot] }
    await store.put('acme', '_keyring', 'bob', {
      _noydb: 1, _v: 1, _ts: new Date().toISOString(), _iv: '',
      _data: JSON.stringify(withSlot),
    })

    await updateKeyringIdentity(store, 'acme', aliceKr, {
      userId: 'bob',
      role: 'operator',
    })

    const bob = await loadKeyring(store, 'acme', 'bob', BOB_PHRASE)
    expect(bob.role).toBe('operator')
    expect(bob.authenticators).toHaveLength(1)
    expect(bob.authenticators[0]?.id).toBe('webauthn-yubikey')
  }, 60_000)

  it('empty diff throws ValidationError', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    await persistKeyring(store, 'acme', aliceKr)
    await grant(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
      passphrase: BOB_PHRASE,
    })

    await expect(
      updateKeyringIdentity(store, 'acme', aliceKr, { userId: 'bob' }),
    ).rejects.toBeInstanceOf(ValidationError)
  }, 30_000)

  it('missing target keyring throws NoAccessError', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    await persistKeyring(store, 'acme', aliceKr)

    await expect(
      updateKeyringIdentity(store, 'acme', aliceKr, {
        userId: 'ghost',
        role: 'operator',
      }),
    ).rejects.toBeInstanceOf(NoAccessError)
  }, 30_000)

  it('admin cannot promote target to owner (PermissionDeniedError on new role)', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', aliceKr)
    // Alice grants Bob admin; Bob then tries to promote Carol (operator) to owner.
    await grant(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
      passphrase: BOB_PHRASE,
    })
    await grant(store, 'acme', aliceKr, {
      userId: 'carol',
      displayName: 'Carol',
      role: 'operator',
      passphrase: CAROL_PHRASE,
    })
    const bobKr = await loadKeyring(store, 'acme', 'bob', BOB_PHRASE)

    await expect(
      updateKeyringIdentity(store, 'acme', bobKr, {
        userId: 'carol',
        role: 'owner',
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  }, 60_000)

  it('admin cannot demote an owner (PermissionDeniedError on old role)', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', aliceKr)
    // Alice (owner) grants Bob admin. Bob tries to demote Alice (owner)
    // to operator — blocked because the OLD role is owner, which Bob
    // (admin) cannot manage.
    await grant(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
      passphrase: BOB_PHRASE,
    })
    const bobKr = await loadKeyring(store, 'acme', 'bob', BOB_PHRASE)

    await expect(
      updateKeyringIdentity(store, 'acme', bobKr, {
        userId: 'alice',
        role: 'operator',
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  }, 60_000)

  it('admin cannot self-promote to owner', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', aliceKr)
    await grant(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
      passphrase: BOB_PHRASE,
    })
    const bobKr = await loadKeyring(store, 'acme', 'bob', BOB_PHRASE)

    await expect(
      updateKeyringIdentity(store, 'acme', bobKr, {
        userId: 'bob',
        role: 'owner',
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  }, 60_000)

  it('non-admin callers cannot call updateUser even on themselves (use vault.user.updateMe instead)', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', aliceKr)
    await grant(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob',
      role: 'operator',
      passphrase: BOB_PHRASE,
    })
    const bobKr = await loadKeyring(store, 'acme', 'bob', BOB_PHRASE)

    // Operator tries to rename themselves via updateUser. The
    // role-elevation guard rejects (operator role can't manage any
    // role, including its own). Self-display-name editing should go
    // through vault.user.updateMe (the user-envelope API), not the
    // keyring identity API.
    await expect(
      updateKeyringIdentity(store, 'acme', bobKr, {
        userId: 'bob',
        displayName: 'Bob the Self-Renamed',
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  }, 60_000)

  it('permissions: {} clears all collection ACLs', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    aliceKr.deks.set('clients', await generateDEK())
    await persistKeyring(store, 'acme', aliceKr)
    await grant(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob',
      role: 'operator',
      passphrase: BOB_PHRASE,
      permissions: { invoices: 'rw', clients: 'rw' },
    })

    await updateKeyringIdentity(store, 'acme', aliceKr, {
      userId: 'bob',
      permissions: {},
    })

    const bob = await loadKeyring(store, 'acme', 'bob', BOB_PHRASE)
    expect(bob.permissions).toEqual({})
  }, 60_000)

  it('permissions is full-replacement at the map level (not deep merge)', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    aliceKr.deks.set('clients', await generateDEK())
    await persistKeyring(store, 'acme', aliceKr)
    await grant(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob',
      role: 'operator',
      passphrase: BOB_PHRASE,
      permissions: { invoices: 'rw', clients: 'rw' },
    })

    // Pass only `invoices` — the resulting permissions map has ONLY
    // `invoices`. `clients` is dropped silently. This is the
    // documented contract; consumers who want a partial merge must
    // construct it themselves.
    await updateKeyringIdentity(store, 'acme', aliceKr, {
      userId: 'bob',
      permissions: { invoices: 'ro' },
    })

    const bob = await loadKeyring(store, 'acme', 'bob', BOB_PHRASE)
    expect(bob.permissions).toEqual({ invoices: 'ro' })
    expect(bob.permissions).not.toHaveProperty('clients')
  }, 60_000)

  it('admin can manage admin/operator/viewer/client laterally', async () => {
    const store = inlineMemory()
    const aliceKr = await createOwnerKeyring(store, 'acme', 'alice', ALICE_PHRASE)
    aliceKr.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', aliceKr)
    await grant(store, 'acme', aliceKr, {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
      passphrase: BOB_PHRASE,
    })
    await grant(store, 'acme', aliceKr, {
      userId: 'carol',
      displayName: 'Carol',
      role: 'client',
      passphrase: CAROL_PHRASE,
    })
    const bobKr = await loadKeyring(store, 'acme', 'bob', BOB_PHRASE)

    // Bob (admin) promotes Carol (client → operator). Allowed.
    await updateKeyringIdentity(store, 'acme', bobKr, {
      userId: 'carol',
      role: 'operator',
    })

    const carol = await loadKeyring(store, 'acme', 'carol', CAROL_PHRASE)
    expect(carol.role).toBe('operator')
  }, 60_000)
})

describe('Noydb.updateUser (hub-level wiring, #54)', () => {
  it('round-trip via the public Noydb method', async () => {
    const store = inlineMemory()
    const alice = await createNoydb({ store, user: 'alice', secret: ALICE_PHRASE })
    await alice.openVault('acme')
    await alice.grant('acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'viewer',
      passphrase: BOB_PHRASE,
    })

    await alice.updateUser('acme', {
      userId: 'bob',
      role: 'operator',
      displayName: 'Bob the Promoted',
    })

    const reopen = await createNoydb({ store, user: 'bob', secret: BOB_PHRASE })
    await reopen.openVault('acme')
    const bob = await reopen.getKeyring('acme')
    expect(bob.role).toBe('operator')
    expect(bob.displayName).toBe('Bob the Promoted')
  }, 120_000)

  it('STRICT_POLICY rejects updateUser without factor proof', async () => {
    const store = inlineMemory()
    const alice = await createNoydb({
      store,
      user: 'alice',
      secret: 'correct horse battery staple printer toaster picnic',
      policy: STRICT_POLICY,
    })
    await alice.openVault('acme')
    // grant() under STRICT_POLICY requires a factor proof (#79 wired the
    // enroll-user gate). Pass TOTP for the setup; the actual assertion
    // below is about updateUser's gate, not grant's.
    await alice.grant('acme', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'admin',
      passphrase: 'glasses cabinet bicycle umbrella thunder velvet picnic',
    }, { factors: [{ kind: 'totp', mintedAt: new Date().toISOString() }] })

    // No factor proof — STRICT_POLICY's update-user gate requires totp/email-otp.
    await expect(
      alice.updateUser('acme', { userId: 'bob', role: 'operator' }),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
  }, 120_000)

  it('refreshes the cached keyring after self-update', async () => {
    const store = inlineMemory()
    const alice = await createNoydb({ store, user: 'alice', secret: ALICE_PHRASE })
    await alice.openVault('acme')

    // Alice updates her OWN displayName (any role can update displayName
    // on their own keyring under the role-elevation guard since old/new
    // role match → owner can update owner). The cached keyring snapshot
    // is then stale; the test asserts the cache invalidation hook fires.
    await alice.updateUser('acme', {
      userId: 'alice',
      displayName: 'Alice the Updated',
    })

    const krAfter = await alice.getKeyring('acme')
    expect(krAfter.displayName).toBe('Alice the Updated')
  }, 120_000)
})
