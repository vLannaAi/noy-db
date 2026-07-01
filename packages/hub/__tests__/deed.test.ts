/**
 * FR-6 Task 3 — Deed marker + sealed-owner provisioning.
 *
 * A Deed vault has a latent owner: the owner credential is minted
 * machine-side and sealed under a NON-FIRM {@link SealingKeyProvider}
 * (the cryptographic inalienability anchor). The owner never types a
 * passphrase — they re-resolve it through the same provider.
 *
 * The `_meta/deed` marker is PLAINTEXT metadata: it records WHO the
 * latent owner is and WHICH sealing boundary protects them, so it must
 * be readable without unlocking the vault. The marker itself is never
 * sealed — the owner *credential* is.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { MemorySealingKeyProvider } from '../src/with-party/team/managed-passphrase.js'
import {
  createDeedOwner,
  loadDeedMarker,
  isDeedVault,
  DEED_RECORD_ID,
  type DeedMarker,
} from '../src/with-party/team/deed.js'

function inlineMemory(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string) => {
    let comp = data.get(v); if (!comp) { comp = new Map(); data.set(v, comp) }
    let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  return {
    async get(v, c, id) { return gc(v, c).get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = gc(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { gc(v, c).delete(id) },
    async list(v, c) { return [...gc(v, c).keys()] },
    async loadAll() { return {} },
    async saveAll() {},
  }
}

describe('FR-6 Deed — sealed/latent owner provisioning', () => {
  let store: NoydbStore
  let provider: MemorySealingKeyProvider

  beforeEach(() => {
    store = inlineMemory()
    provider = new MemorySealingKeyProvider({ id: 'client-kms' })
  })

  it('createDeedOwner returns an unlocked owner keyring', async () => {
    const keyring = await createDeedOwner(store, 'deed-vault', 'client-01', provider)
    expect(keyring.userId).toBe('client-01')
    expect(keyring.role).toBe('owner')
    // Owner is unlocked (KEK present — derived from the sealed passphrase).
    expect(keyring.kek).not.toBeNull()
  })

  it('writes a plaintext _meta/deed marker describing the latent owner + sealing boundary', async () => {
    const before = new Date().toISOString()
    await createDeedOwner(store, 'deed-vault', 'client-01', provider)
    const after = new Date().toISOString()

    const marker = await loadDeedMarker(store, 'deed-vault')
    expect(marker).not.toBeNull()
    expect(marker!.ownerUserId).toBe('client-01')
    expect(marker!.sealedUnder).toBe('client-kms')
    expect(marker!.latent).toBe(true)
    expect(typeof marker!.issuedAt).toBe('string')
    expect(marker!.issuedAt >= before).toBe(true)
    expect(marker!.issuedAt <= after).toBe(true)
    expect(marker!.liberatedAt).toBeUndefined()
  })

  it('the marker is readable WITHOUT unlocking (plaintext metadata, not sealed)', async () => {
    await createDeedOwner(store, 'deed-vault', 'client-01', provider)
    // Read the raw envelope directly off the store and parse it as plain JSON.
    const env = await store.get('deed-vault', '_meta', DEED_RECORD_ID)
    expect(env).not.toBeNull()
    const payload = JSON.parse(env!._data) as Record<string, unknown>
    expect(payload['ownerUserId']).toBe('client-01')
    expect(payload['sealedUnder']).toBe('client-kms')
    expect(payload['latent']).toBe(true)
  })

  it('isDeedVault → true for a provisioned Deed vault', async () => {
    await createDeedOwner(store, 'deed-vault', 'client-01', provider)
    expect(await isDeedVault(store, 'deed-vault')).toBe(true)
  })

  it('isDeedVault → false for a vault with no deed marker', async () => {
    expect(await isDeedVault(store, 'plain-vault')).toBe(false)
    expect(await loadDeedMarker(store, 'plain-vault')).toBeNull()
  })

  it('the latent owner can be re-resolved via the SAME provider with no interactive passphrase', async () => {
    // Provision the Deed owner once.
    const first = await createDeedOwner(store, 'deed-vault', 'client-01', provider)
    expect(first.role).toBe('owner')

    // Re-resolve the sealed passphrase through the SAME provider — no human
    // ever typed it. This is the latent-owner proof.
    const { resolveManagedSecret } = await import('../src/with-party/team/managed-passphrase.js')
    const reopenProvider = new MemorySealingKeyProvider({ id: 'client-kms' })
    const passphrase = await resolveManagedSecret(store, 'deed-vault', reopenProvider)
    expect(typeof passphrase).toBe('string')
    expect(passphrase.length).toBeGreaterThan(0)

    // Re-derive the owner KEK from the unsealed passphrase + persisted salt
    // and confirm it unlocks the same keyring (canary verifies).
    const { loadKeyring } = await import('../src/with-party/team/keyring.js')
    const reopened = await loadKeyring(store, 'deed-vault', 'client-01', passphrase)
    expect(reopened.userId).toBe('client-01')
    expect(reopened.role).toBe('owner')
    expect(reopened.kek).not.toBeNull()
  })

  it('a non-firm provider is the only anchor — a different provider id cannot re-resolve', async () => {
    await createDeedOwner(store, 'deed-vault', 'client-01', provider)
    const firmProvider = new MemorySealingKeyProvider({ id: 'firm-kms' })
    const { resolveManagedSecret } = await import('../src/with-party/team/managed-passphrase.js')
    await expect(
      resolveManagedSecret(store, 'deed-vault', firmProvider),
    ).rejects.toThrow()
  })

  it('DeedMarker shape (type-level sanity)', async () => {
    await createDeedOwner(store, 'deed-vault', 'client-01', provider)
    const marker = (await loadDeedMarker(store, 'deed-vault')) as DeedMarker
    // Exhaustive read — proves the four required fields exist.
    const { ownerUserId, sealedUnder, latent, issuedAt } = marker
    expect([ownerUserId, sealedUnder, latent, issuedAt]).toEqual([
      'client-01', 'client-kms', true, marker.issuedAt,
    ])
  })
})
