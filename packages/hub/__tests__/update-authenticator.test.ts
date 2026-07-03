/**
 * #55 — db.updateAuthenticator(slotId, { meta }) for slot nickname rename.
 *
 * Pinned behaviors:
 *   1. Round-trip — meta keys merged, wrap material preserved.
 *   2. Anti-slot-swap is structural — id, method, wrapped_kek (or
 *      wrapped_deks + iv) cannot change through this entry point;
 *      only `meta` is mutable.
 *   3. null-as-delete on meta keys (#57-aligned semantics, scoped to
 *      the top-level meta merge).
 *   4. Non-existent slot → NoAccessError.
 *   5. Empty diff → ValidationError.
 *   6. Idempotent meta merge — re-applying the same patch is a no-op.
 *   7. Hub-level gating — `db.updateAuthenticator` runs the
 *      `update-authenticator` gate. STRICT_POLICY without factor proof
 *      rejects.
 *   8. wrap-KEK and wrap-DEKs slots both round-trip identically (the
 *      rename path is variant-agnostic).
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, KeyringAuthenticator } from '../src/kernel/types.js'
import { createOwnerKeyring, loadKeyring, persistKeyring } from '../src/with-party/team/keyring.js'
import { enrollAuthenticator, updateAuthenticator } from '../src/with-party/team/authenticators.js'
import { generateDEK } from '../src/kernel/enclave/index.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { NoAccessError, ValidationError } from '../src/kernel/errors.js'
import { PolicyDeniedError } from '../src/kernel/errors.js'
import { STRICT_POLICY } from '../src/with-party/policy/presets.js'

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

const PHRASE = 'correct horse battery staple printer toaster'
const STRICT_PHRASE = 'correct horse battery staple printer toaster picnic'

describe('updateAuthenticator (team layer, #55)', () => {
  it('merges meta keys, preserves wrap material (wrap-KEK)', async () => {
    const store = inlineMemory()
    const keyring = await createOwnerKeyring(store, 'acme', 'alice', PHRASE)
    keyring.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', keyring)

    const enrolled = await enrollAuthenticator(store, 'acme', keyring, {
      id: 'webauthn-yubi',
      method: 'webauthn',
      meta: { credentialId: 'cred-yubi', prfUsed: true },
      wrapped_kek: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
    })

    const next = await updateAuthenticator(store, 'acme', enrolled, 'webauthn-yubi', {
      meta: { nickname: 'Blue YubiKey' },
    })

    const reloaded = await loadKeyring(store, 'acme', 'alice', PHRASE)
    expect(reloaded.authenticators).toHaveLength(1)
    const slot = reloaded.authenticators[0]!
    // Original meta keys preserved (top-level merge).
    expect(slot.meta.credentialId).toBe('cred-yubi')
    expect(slot.meta.prfUsed).toBe(true)
    // New meta key landed.
    expect(slot.meta.nickname).toBe('Blue YubiKey')
    // Wrap material UNCHANGED — anti-slot-swap structural guard.
    if (slot.wrapKind !== 'deks') {
      expect(slot.wrapped_kek).toBe('YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=')
    } else {
      throw new Error('expected wrap-KEK slot, got wrap-DEKs')
    }
    expect(next.authenticators[0]!.id).toBe('webauthn-yubi')
    expect(next.authenticators[0]!.method).toBe('webauthn')
  }, 60_000)

  it('round-trips on wrap-DEKs slots without crossing the variant boundary', async () => {
    const store = inlineMemory()
    const keyring = await createOwnerKeyring(store, 'acme', 'alice', PHRASE)
    keyring.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', keyring)

    await enrollAuthenticator(store, 'acme', keyring, {
      id: 'password',
      method: 'password',
      wrapKind: 'deks',
      wrapped_deks: 'YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI=',
      iv: 'aWl2aXZpdml2aXY=',
      meta: { salt: 'cmFuZG9tc2FsdA==', minLength: 12 },
    })
    // Reload to pick up the persisted slot in a fresh keyring snapshot.
    const fresh = await loadKeyring(store, 'acme', 'alice', PHRASE)
    await updateAuthenticator(store, 'acme', fresh, 'password', {
      meta: { nickname: 'My password' },
    })

    const reloaded = await loadKeyring(store, 'acme', 'alice', PHRASE)
    const slot = reloaded.authenticators[0]!
    expect(slot.wrapKind).toBe('deks')
    if (slot.wrapKind === 'deks') {
      expect(slot.wrapped_deks).toBe('YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI=')
      expect(slot.iv).toBe('aWl2aXZpdml2aXY=')
    }
    expect(slot.meta.salt).toBe('cmFuZG9tc2FsdA==')
    expect(slot.meta.minLength).toBe(12)
    expect(slot.meta.nickname).toBe('My password')
  }, 60_000)

  it('null in a meta key deletes that key (#55 ↔ #57 semantics)', async () => {
    const store = inlineMemory()
    const keyring = await createOwnerKeyring(store, 'acme', 'alice', PHRASE)
    keyring.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', keyring)

    await enrollAuthenticator(store, 'acme', keyring, {
      id: 'webauthn-mac',
      method: 'webauthn',
      meta: { credentialId: 'cred-mac', nickname: 'MacBook Touch ID', prfUsed: true },
      wrapped_kek: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
    })
    const fresh = await loadKeyring(store, 'acme', 'alice', PHRASE)

    // Drop the nickname; preserve the rest.
    await updateAuthenticator(store, 'acme', fresh, 'webauthn-mac', {
      meta: { nickname: null },
    })

    const reloaded = await loadKeyring(store, 'acme', 'alice', PHRASE)
    const slot = reloaded.authenticators[0]!
    expect(slot.meta.nickname).toBeUndefined()
    expect(Object.keys(slot.meta)).not.toContain('nickname')
    expect(slot.meta.credentialId).toBe('cred-mac')
    expect(slot.meta.prfUsed).toBe(true)
  }, 60_000)

  it('throws NoAccessError when slot id is unknown', async () => {
    const store = inlineMemory()
    const keyring = await createOwnerKeyring(store, 'acme', 'alice', PHRASE)
    await persistKeyring(store, 'acme', keyring)

    await expect(
      updateAuthenticator(store, 'acme', keyring, 'webauthn-ghost', {
        meta: { nickname: 'Ghost' },
      }),
    ).rejects.toBeInstanceOf(NoAccessError)
  }, 30_000)

  it('throws ValidationError on empty diff', async () => {
    const store = inlineMemory()
    const keyring = await createOwnerKeyring(store, 'acme', 'alice', PHRASE)
    keyring.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', keyring)

    const enrolled = await enrollAuthenticator(store, 'acme', keyring, {
      id: 'webauthn-x',
      method: 'webauthn',
      meta: { credentialId: 'cred-x' },
      wrapped_kek: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
    })

    await expect(
      updateAuthenticator(store, 'acme', enrolled, 'webauthn-x', {}),
    ).rejects.toBeInstanceOf(ValidationError)
  }, 30_000)

  it('idempotent meta merge — re-applying the same patch yields the same slot', async () => {
    const store = inlineMemory()
    const keyring = await createOwnerKeyring(store, 'acme', 'alice', PHRASE)
    keyring.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', keyring)

    const enrolled = await enrollAuthenticator(store, 'acme', keyring, {
      id: 'webauthn-x',
      method: 'webauthn',
      meta: { credentialId: 'cred-x' },
      wrapped_kek: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
    })

    const a = await updateAuthenticator(store, 'acme', enrolled, 'webauthn-x', {
      meta: { nickname: 'X' },
    })
    const b = await updateAuthenticator(store, 'acme', a, 'webauthn-x', {
      meta: { nickname: 'X' },
    })
    expect(b.authenticators[0]!.meta.nickname).toBe('X')
  }, 60_000)
})

describe('Noydb.updateAuthenticator (hub-level wiring, #55)', () => {
  // Fixture helper: bootstrap the keyring + inject a slot via the team
  // layer BEFORE creating the Noydb instance, so the keyring cache
  // populates with the injected slot already present on disk.
  async function bootstrapVaultWithSlot(
    store: NoydbStore,
    phrase: string,
    slotId: string,
  ): Promise<void> {
    const keyring = await createOwnerKeyring(store, 'acme', 'alice', phrase)
    keyring.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', keyring)
    await enrollAuthenticator(store, 'acme', keyring, {
      id: slotId,
      method: 'webauthn',
      meta: { credentialId: `cred-${slotId}` },
      wrapped_kek: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
    })
  }

  it('round-trip via the public Noydb method', async () => {
    const store = inlineMemory()
    await bootstrapVaultWithSlot(store, PHRASE, 'webauthn-test')

    const alice = await createNoydb({ store, user: 'alice', secret: PHRASE })
    await alice.openVault('acme')

    await alice.updateAuthenticator('acme', 'webauthn-test', {
      meta: { nickname: 'Test slot' },
    })

    const slots = await alice.listAuthenticators('acme')
    expect(slots).toHaveLength(1)
    expect(slots[0]!.meta.nickname).toBe('Test slot')
    expect(slots[0]!.meta.credentialId).toBe('cred-webauthn-test')
  }, 120_000)

  it('STRICT_POLICY rejects updateAuthenticator without factor proof', async () => {
    const store = inlineMemory()
    await bootstrapVaultWithSlot(store, STRICT_PHRASE, 'webauthn-strict')

    const alice = await createNoydb({
      store,
      user: 'alice',
      secret: STRICT_PHRASE,
      policy: STRICT_POLICY,
    })
    await alice.openVault('acme')

    await expect(
      alice.updateAuthenticator('acme', 'webauthn-strict', { meta: { nickname: 'X' } }),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
  }, 120_000)
})
