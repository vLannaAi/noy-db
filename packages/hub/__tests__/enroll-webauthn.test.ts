/**
 * db.enrollWebAuthn() — native WebAuthn enrollment using the real
 * internal keyring (#16). Unblocks vLannaAi/niwat#31.
 *
 * The ceremony callback receives the live `UnlockedKeyring` so the
 * `wrapped_kek` references the live KEK — not a synthetic app-layer
 * payload that fails at unlock time.
 *
 * These tests use a stubbed ceremony that mimics the @noy-db/on-webauthn
 * shape: it produces a `wrapped_kek` derived from the real keyring's
 * KEK and method-specific `meta`. No actual WebAuthn API needed.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'
import { createNoydb, type Noydb } from '../src/noydb.js'
import { ValidationError } from '../src/errors.js'

/**
 * Placeholder for the AES-GCM-encrypted keyring-summary blob that the
 * real `@noy-db/on-webauthn` produces. The hub does not validate
 * `wrapped_kek` contents — it just persists the slot — so using a
 * stable base64 string here is fine for testing the hub's enrollment
 * flow. The actual ceremony's wrapping logic is exercised in the
 * on-webauthn package's own tests.
 */
const FAKE_WRAPPED_PAYLOAD = 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE='

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

describe('db.enrollWebAuthn() (#16)', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: inlineMemory(),
      user: 'alice',
      secret: 'alice-pass-2026-strong',
    })
    // Open vault to ensure keyring is in cache.
    await db.openVault('demo')
  })

  it('runs ceremony with the real internal keyring (not synthetic)', async () => {
    let receivedKeyring: { userId: string; kek: CryptoKey; deks: Map<string, CryptoKey> } | undefined
    await db.enrollWebAuthn('demo', async (keyring) => {
      // The whole point of #16: ceremony sees the LIVE keyring,
      // including the live KEK and the live DEKs map. The wrapped_kek
      // returned here is what the real @noy-db/on-webauthn produces
      // (AES-GCM-encrypted keyring summary under a WebAuthn-derived
      // wrapping key). Hub does not validate the contents — it just
      // persists the slot — so a placeholder is fine for this test.
      receivedKeyring = { userId: keyring.userId, kek: keyring.kek!, deks: keyring.deks }
      return {
        id: 'webauthn-test-1',
        method: 'webauthn',
        wrapped_kek: FAKE_WRAPPED_PAYLOAD,
        meta: {
          credentialId: 'cred-base64-abc123',
          wrapIv: '',
          prfUsed: true,
          beFlag: false,
          requireSingleDevice: false,
        },
      }
    })

    expect(receivedKeyring?.userId).toBe('alice')
    expect(receivedKeyring?.kek).toBeDefined()
    expect(receivedKeyring?.deks).toBeInstanceOf(Map)
  })

  it('persists the slot via the standard tier-2 enrollAuthenticator path', async () => {
    const result = await db.enrollWebAuthn('demo', async () => ({
      id: 'webauthn-yubikey',
      method: 'webauthn',
      wrapped_kek: FAKE_WRAPPED_PAYLOAD,
      meta: { credentialId: 'cred-yubikey-base64' },
    }))

    expect(result.credentialId).toBe('cred-yubikey-base64')

    const slots = await db.listAuthenticators('demo')
    expect(slots.length).toBe(1)
    expect(slots[0]!.id).toBe('webauthn-yubikey')
    expect(slots[0]!.method).toBe('webauthn')
  })

  it('rejects ceremony results with method !== "webauthn"', async () => {
    await expect(
      db.enrollWebAuthn('demo', async () => ({
        id: 'wrong-1',
        method: 'password' as const,
        wrapped_kek: FAKE_WRAPPED_PAYLOAD,
        meta: { credentialId: 'whatever' },
      })),
    ).rejects.toThrow(ValidationError)
  })

  it('rejects ceremony results without a credentialId in meta', async () => {
    await expect(
      db.enrollWebAuthn('demo', async () => ({
        id: 'webauthn-no-credid',
        method: 'webauthn',
        wrapped_kek: FAKE_WRAPPED_PAYLOAD,
        meta: {}, // missing credentialId
      })),
    ).rejects.toThrow(/credentialId/)
  })
})

describe('db.listWebAuthnSlots() (#16)', () => {
  it('filters the slot list to webauthn-method slots only', async () => {
    const db = await createNoydb({
      store: inlineMemory(),
      user: 'alice',
      secret: 'alice-pass-2026-strong',
    })
    await db.openVault('demo')

    await db.enrollWebAuthn('demo', async () => ({
      id: 'webauthn-1',
      method: 'webauthn',
      wrapped_kek: FAKE_WRAPPED_PAYLOAD,
      meta: { credentialId: 'cred-1' },
    }))
    await db.enrollWebAuthn('demo', async () => ({
      id: 'webauthn-2',
      method: 'webauthn',
      wrapped_kek: FAKE_WRAPPED_PAYLOAD,
      meta: { credentialId: 'cred-2' },
    }))

    // Mix in a password slot via the existing enrollAuthenticator path.
    await db.enrollAuthenticator('demo', {
      id: 'password',
      method: 'password',
      wrapped_kek: FAKE_WRAPPED_PAYLOAD,
      meta: { salt: 'fake-salt-base64' },
    })

    const allSlots = await db.listAuthenticators('demo')
    expect(allSlots.length).toBe(3)

    const webauthnOnly = await db.listWebAuthnSlots('demo')
    expect(webauthnOnly.length).toBe(2)
    expect(webauthnOnly.map((s) => s.id).sort()).toEqual(['webauthn-1', 'webauthn-2'])
    expect(webauthnOnly.map((s) => s.credentialId).sort()).toEqual(['cred-1', 'cred-2'])
  })

  it('returns an empty list when no webauthn slots are enrolled', async () => {
    const db = await createNoydb({
      store: inlineMemory(),
      user: 'alice',
      secret: 'alice-pass-2026-strong',
    })
    await db.openVault('demo')
    const slots = await db.listWebAuthnSlots('demo')
    expect(slots.length).toBe(0)
  })
})
