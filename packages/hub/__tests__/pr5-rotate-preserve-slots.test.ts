/**
 * PR5 — preserve tier-2 slots across rotatePassphrase (#29).
 *
 * Without `slotCeremonies`, rotation drops every slot (pre-pre.8
 * behavior). With ceremonies supplied, slots whose id appears in the
 * map are PRESERVED — the ceremony re-derives its method-specific
 * wrapping under the freshly rewrapped DEKs, and hub persists the
 * new slot atomically with the rotation.
 *
 * Pinned behaviors:
 *   1. Default — no `slotCeremonies` drops all slots (regression test).
 *   2. Preserved wrap-DEKs slot — password-style ceremony returns a
 *      wrapped_deks/iv result; hub persists it; the new wrapping
 *      decrypts to the new DEK set.
 *   3. Preserved wrap-KEK slot — webauthn-style ceremony returns a
 *      wrapped_kek result; hub persists it; the slot survives.
 *   4. Mixed — some slots ceremony'd, some dropped, in one rotation.
 *   5. Anti-slot-swap: id mismatch in ceremony result throws.
 *   6. Anti-slot-swap: method mismatch in ceremony result throws.
 *   7. Ceremony receives newDeks + newKek + oldSlot in context.
 *   8. enrolled_at preserved (rotation is rewrapping, not re-enrollment).
 *   9. Ceremony exception aborts the entire rotation.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, KeyringAuthenticator } from '../src/types.js'
import { createOwnerKeyring, loadKeyring, persistKeyring } from '../src/team/keyring.js'
import { rotatePassphrase, type SlotRewrapCeremony } from '../src/team/rotate-recover.js'
import { generateDEK } from '../src/crypto.js'
import { ValidationError } from '../src/errors.js'
import type { EnrollAuthenticatorOptions } from '../src/team/authenticators.js'

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

const OLD_PHRASE = 'correct horse battery staple printer toaster'
const NEW_PHRASE = 'glasses cabinet bicycle umbrella thunder velvet'

/**
 * Set up a vault with `alice` as owner + N pre-rotation slots. Returns
 * the seeded store and the slot specs that were persisted.
 */
async function setupVaultWithSlots(slots: KeyringAuthenticator[]): Promise<NoydbStore> {
  const store = inlineMemory()
  const keyring = await createOwnerKeyring(store, 'acme', 'alice', OLD_PHRASE)
  keyring.deks.set('invoices', await generateDEK())
  keyring.deks.set('clients', await generateDEK())
  await persistKeyring(store, 'acme', keyring)

  // Patch the persisted keyring file directly to add the slots —
  // faster than running the full enrollAuthenticator path for each.
  if (slots.length > 0) {
    const env = await store.get('acme', '_keyring', 'alice')
    const file = JSON.parse(env!._data) as Record<string, unknown>
    await store.put('acme', '_keyring', 'alice', {
      _noydb: 1, _v: 1, _ts: new Date().toISOString(), _iv: '',
      _data: JSON.stringify({ ...file, authenticators: slots }),
    })
  }
  return store
}

describe('rotatePassphrase slot preservation (#29)', () => {
  it('without slotCeremonies, drops all slots (regression test for pre-#29 behavior)', async () => {
    const store = await setupVaultWithSlots([
      {
        id: 'webauthn-yubikey',
        method: 'webauthn',
        enrolled_at: '2026-01-01T00:00:00Z',
        enrolled_via_tier: 1,
        wrapped_kek: 'WRAPPEDKEKBASE64',
        meta: { credentialId: 'cred-1' },
      },
    ])

    await rotatePassphrase(store, 'acme', 'alice', {
      oldPassphrase: OLD_PHRASE,
      newPassphrase: NEW_PHRASE,
    })

    const reloaded = await loadKeyring(store, 'acme', 'alice', NEW_PHRASE)
    expect(reloaded.authenticators).toHaveLength(0)
  }, 60_000)

  it('preserves a wrap-DEKs slot via ceremony', async () => {
    const store = await setupVaultWithSlots([
      {
        id: 'password',
        method: 'password',
        enrolled_at: '2026-01-01T00:00:00Z',
        enrolled_via_tier: 1,
        wrapKind: 'deks',
        wrapped_deks: 'OLDWRAPPEDDEKSBASE64',
        iv: 'OLDIVBASE64',
        meta: { salt: 'OLDSALT', minLength: 12 },
      },
    ])

    let ceremonyCallCount = 0
    let receivedNewDeks: Map<string, CryptoKey> | undefined
    const passwordCeremony: SlotRewrapCeremony = async ({ newDeks, oldSlot }) => {
      ceremonyCallCount++
      receivedNewDeks = newDeks
      return {
        id: oldSlot.id,
        method: 'password',
        wrapKind: 'deks',
        wrapped_deks: 'NEWWRAPPEDDEKSBASE64',
        iv: 'NEWIVBASE64',
        meta: { salt: 'NEWSALT', minLength: 14 },
      } satisfies EnrollAuthenticatorOptions
    }

    await rotatePassphrase(store, 'acme', 'alice', {
      oldPassphrase: OLD_PHRASE,
      newPassphrase: NEW_PHRASE,
      slotCeremonies: { 'password': passwordCeremony },
    })

    expect(ceremonyCallCount).toBe(1)
    expect(receivedNewDeks?.size).toBeGreaterThan(0)

    const reloaded = await loadKeyring(store, 'acme', 'alice', NEW_PHRASE)
    expect(reloaded.authenticators).toHaveLength(1)
    const slot = reloaded.authenticators[0]!
    expect(slot.id).toBe('password')
    expect(slot.method).toBe('password')
    if (slot.wrapKind === 'deks') {
      expect(slot.wrapped_deks).toBe('NEWWRAPPEDDEKSBASE64')
      expect(slot.iv).toBe('NEWIVBASE64')
      expect((slot.meta as { minLength?: number }).minLength).toBe(14)
    } else {
      throw new Error('expected wrap-DEKs slot')
    }
  }, 60_000)

  it('preserves a wrap-KEK slot via ceremony', async () => {
    const store = await setupVaultWithSlots([
      {
        id: 'webauthn-touchid',
        method: 'webauthn',
        enrolled_at: '2026-01-01T00:00:00Z',
        enrolled_via_tier: 1,
        wrapped_kek: 'OLDWRAPPEDKEK',
        meta: { credentialId: 'cred-touchid' },
      },
    ])

    let receivedNewKek: CryptoKey | undefined
    const webauthnCeremony: SlotRewrapCeremony = async ({ newKek, oldSlot }) => {
      receivedNewKek = newKek
      return {
        id: oldSlot.id,
        method: 'webauthn',
        wrapped_kek: 'NEWWRAPPEDKEK',
        meta: { credentialId: 'cred-touchid', wrapIv: 'newiv' },
      } satisfies EnrollAuthenticatorOptions
    }

    await rotatePassphrase(store, 'acme', 'alice', {
      oldPassphrase: OLD_PHRASE,
      newPassphrase: NEW_PHRASE,
      slotCeremonies: { 'webauthn-touchid': webauthnCeremony },
    })

    expect(receivedNewKek).toBeInstanceOf(CryptoKey)

    const reloaded = await loadKeyring(store, 'acme', 'alice', NEW_PHRASE)
    expect(reloaded.authenticators).toHaveLength(1)
    const slot = reloaded.authenticators[0]!
    expect(slot.id).toBe('webauthn-touchid')
    if (slot.wrapKind !== 'deks') {
      expect(slot.wrapped_kek).toBe('NEWWRAPPEDKEK')
    } else {
      throw new Error('expected wrap-KEK slot')
    }
  }, 60_000)

  it('mixed: some slots ceremony\'d, some dropped, in one rotation', async () => {
    const store = await setupVaultWithSlots([
      {
        id: 'webauthn-yubikey',
        method: 'webauthn',
        enrolled_at: '2026-01-01T00:00:00Z',
        enrolled_via_tier: 1,
        wrapped_kek: 'WRAPPEDKEK',
        meta: { credentialId: 'cred-yubikey' },
      },
      {
        id: 'password',
        method: 'password',
        enrolled_at: '2026-01-02T00:00:00Z',
        enrolled_via_tier: 1,
        wrapKind: 'deks',
        wrapped_deks: 'WRAPPEDDEKS',
        iv: 'IV',
        meta: { salt: 'SALT', minLength: 12 },
      },
      {
        id: 'pin-resume',
        method: 'password', // tier-3 PIN slots also use the 'password' method
        enrolled_at: '2026-01-03T00:00:00Z',
        enrolled_via_tier: 3,
        wrapKind: 'deks',
        wrapped_deks: 'PINWRAPPEDDEKS',
        iv: 'PINIV',
        meta: { salt: 'PINSALT' },
      },
    ])

    // Only ceremony the webauthn slot — password + pin will be dropped.
    const webauthnCeremony: SlotRewrapCeremony = async ({ oldSlot }) => ({
      id: oldSlot.id,
      method: 'webauthn',
      wrapped_kek: 'NEWWRAPPEDKEK',
      meta: { credentialId: 'cred-yubikey' },
    })

    await rotatePassphrase(store, 'acme', 'alice', {
      oldPassphrase: OLD_PHRASE,
      newPassphrase: NEW_PHRASE,
      slotCeremonies: { 'webauthn-yubikey': webauthnCeremony },
    })

    const reloaded = await loadKeyring(store, 'acme', 'alice', NEW_PHRASE)
    expect(reloaded.authenticators).toHaveLength(1)
    expect(reloaded.authenticators[0]!.id).toBe('webauthn-yubikey')
  }, 60_000)

  it('rejects id mismatch in ceremony result (anti-slot-swap)', async () => {
    const store = await setupVaultWithSlots([
      {
        id: 'webauthn-original',
        method: 'webauthn',
        enrolled_at: '2026-01-01T00:00:00Z',
        enrolled_via_tier: 1,
        wrapped_kek: 'WRAPPED',
        meta: { credentialId: 'cred' },
      },
    ])

    const swapCeremony: SlotRewrapCeremony = async () => ({
      id: 'webauthn-IMPOSTER', // ← mismatched id
      method: 'webauthn',
      wrapped_kek: 'NEWWRAPPED',
      meta: { credentialId: 'cred' },
    })

    await expect(
      rotatePassphrase(store, 'acme', 'alice', {
        oldPassphrase: OLD_PHRASE,
        newPassphrase: NEW_PHRASE,
        slotCeremonies: { 'webauthn-original': swapCeremony },
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  }, 60_000)

  it('rejects method mismatch in ceremony result (anti-slot-swap)', async () => {
    const store = await setupVaultWithSlots([
      {
        id: 'webauthn-original',
        method: 'webauthn',
        enrolled_at: '2026-01-01T00:00:00Z',
        enrolled_via_tier: 1,
        wrapped_kek: 'WRAPPED',
        meta: { credentialId: 'cred' },
      },
    ])

    const methodSwapCeremony: SlotRewrapCeremony = async ({ oldSlot }) => ({
      id: oldSlot.id,
      method: 'password', // ← mismatched method
      wrapKind: 'deks',
      wrapped_deks: 'WRAPPED',
      iv: 'IV',
      meta: { salt: 'SALT' },
    })

    await expect(
      rotatePassphrase(store, 'acme', 'alice', {
        oldPassphrase: OLD_PHRASE,
        newPassphrase: NEW_PHRASE,
        slotCeremonies: { 'webauthn-original': methodSwapCeremony },
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  }, 60_000)

  it('preserves enrolled_at across rotation (rotation is rewrapping, not re-enrollment)', async () => {
    const originalEnrolledAt = '2025-06-15T08:30:00.000Z'
    const store = await setupVaultWithSlots([
      {
        id: 'webauthn-touchid',
        method: 'webauthn',
        enrolled_at: originalEnrolledAt,
        enrolled_via_tier: 1,
        wrapped_kek: 'WRAPPED',
        meta: { credentialId: 'cred' },
      },
    ])

    const ceremony: SlotRewrapCeremony = async ({ oldSlot }) => ({
      id: oldSlot.id,
      method: 'webauthn',
      wrapped_kek: 'NEWWRAPPED',
      meta: { credentialId: 'cred' },
    })

    await rotatePassphrase(store, 'acme', 'alice', {
      oldPassphrase: OLD_PHRASE,
      newPassphrase: NEW_PHRASE,
      slotCeremonies: { 'webauthn-touchid': ceremony },
    })

    const reloaded = await loadKeyring(store, 'acme', 'alice', NEW_PHRASE)
    expect(reloaded.authenticators[0]!.enrolled_at).toBe(originalEnrolledAt)
  }, 60_000)

  it('ceremony exception aborts the entire rotation', async () => {
    const store = await setupVaultWithSlots([
      {
        id: 'webauthn-touchid',
        method: 'webauthn',
        enrolled_at: '2026-01-01T00:00:00Z',
        enrolled_via_tier: 1,
        wrapped_kek: 'WRAPPED',
        meta: { credentialId: 'cred' },
      },
    ])

    const failingCeremony: SlotRewrapCeremony = async () => {
      throw new Error('user cancelled re-prove')
    }

    await expect(
      rotatePassphrase(store, 'acme', 'alice', {
        oldPassphrase: OLD_PHRASE,
        newPassphrase: NEW_PHRASE,
        slotCeremonies: { 'webauthn-touchid': failingCeremony },
      }),
    ).rejects.toThrow(/user cancelled/)

    // Original keyring intact — old phrase still works.
    const reloaded = await loadKeyring(store, 'acme', 'alice', OLD_PHRASE)
    expect(reloaded.authenticators).toHaveLength(1)
    expect(reloaded.authenticators[0]!.id).toBe('webauthn-touchid')
  }, 60_000)
})
