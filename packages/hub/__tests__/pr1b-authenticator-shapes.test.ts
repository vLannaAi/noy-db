/**
 * PR1b — `KeyringAuthenticator` discriminated union for wrap-KEK and
 * wrap-DEKs slot variants (#26 Path C).
 *
 * Pins the on-disk + type-level contract:
 *   - WebAuthn / OIDC slots use `wrapped_kek` (legacy / wrapKind absent
 *     or 'kek'); the existing format keeps working unchanged.
 *   - Password slots use `wrapped_deks` + `iv` + `wrapKind: 'deks'`;
 *     they sidestep the non-extractable-KEK constraint by wrapping the
 *     DEK set under an AES-GCM key, mirroring `mintPaperRecoveryEntry`
 *     and `@noy-db/on-pin`'s tier-3 pattern.
 *
 * The test does not exercise the actual unlock flow — that lives in
 * `@noy-db/on-password`'s tests after the package refactor. This test
 * pins the hub-level dispatch + persistence shape only.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, KeyringAuthenticator } from '../src/kernel/types.js'
import { createOwnerKeyring, loadKeyring, persistKeyring } from '../src/with-party/team/keyring.js'
import { enrollAuthenticator } from '../src/with-party/team/authenticators.js'
import { generateDEK } from '../src/kernel/enclave/index.js'

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

const PHRASE = 'correct horse battery staple printer toaster'

describe('KeyringAuthenticator wrap-KEK / wrap-DEKs (#26 Path C)', () => {
  it('round-trips a wrap-KEK slot through _keyring (legacy WebAuthn shape)', async () => {
    const store = inlineMemory()
    const keyring = await createOwnerKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
    keyring.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', keyring)

    const next = await enrollAuthenticator(store, 'acme', keyring, {
      id: 'webauthn-01',
      method: 'webauthn',
      meta: { credentialId: 'cred-base64', prfUsed: true },
      wrapped_kek: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
    })
    expect(next.authenticators).toHaveLength(1)

    const reloaded = await loadKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
    expect(reloaded.authenticators).toHaveLength(1)
    const slot = reloaded.authenticators[0]!
    // Discriminator absence (or 'kek') → wrap-KEK
    expect(slot.wrapKind).toBeUndefined()
    if (slot.wrapKind !== 'deks') {
      expect(slot.wrapped_kek).toBe('YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=')
      // wrap-DEKs fields must NOT be present on a wrap-KEK slot
      expect((slot as Partial<KeyringAuthenticator & { wrapped_deks?: string; iv?: string }>).wrapped_deks).toBeUndefined()
    } else {
      throw new Error('expected wrap-KEK slot, got wrap-DEKs')
    }
  })

  it('round-trips a wrap-DEKs slot through _keyring (new password shape)', async () => {
    const store = inlineMemory()
    const keyring = await createOwnerKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
    keyring.deks.set('invoices', await generateDEK())
    await persistKeyring(store, 'acme', keyring)

    const next = await enrollAuthenticator(store, 'acme', keyring, {
      id: 'password',
      method: 'password',
      wrapKind: 'deks',
      wrapped_deks: 'Y2lwaGVydGV4dC1iYXNlNjQ=',
      iv: 'aXYtYmFzZTY0LTEy',
      meta: { salt: 'c2FsdC1iYXNlNjQ=', minLength: 12 },
    })
    expect(next.authenticators).toHaveLength(1)

    const reloaded = await loadKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
    expect(reloaded.authenticators).toHaveLength(1)
    const slot = reloaded.authenticators[0]!
    expect(slot.wrapKind).toBe('deks')
    if (slot.wrapKind === 'deks') {
      expect(slot.wrapped_deks).toBe('Y2lwaGVydGV4dC1iYXNlNjQ=')
      expect(slot.iv).toBe('aXYtYmFzZTY0LTEy')
      // wrap-KEK field must NOT be present on a wrap-DEKs slot
      expect((slot as Partial<KeyringAuthenticator & { wrapped_kek?: string }>).wrapped_kek).toBeUndefined()
    } else {
      throw new Error('expected wrap-DEKs slot, got wrap-KEK')
    }
  })

  it('coexists — both shapes can live in the same keyring', async () => {
    const store = inlineMemory()
    const keyring = await createOwnerKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
    await persistKeyring(store, 'acme', keyring)

    const afterWebAuthn = await enrollAuthenticator(store, 'acme', keyring, {
      id: 'webauthn-01',
      method: 'webauthn',
      meta: { credentialId: 'cred-1' },
      wrapped_kek: 'd2VicGF5bG9hZA==',
    })
    const afterPassword = await enrollAuthenticator(store, 'acme', afterWebAuthn, {
      id: 'password',
      method: 'password',
      wrapKind: 'deks',
      wrapped_deks: 'cHdkLXdyYXBwZWQ=',
      iv: 'cHdkLWl2',
      meta: { salt: 'cHdkLXNhbHQ=', minLength: 12 },
    })
    expect(afterPassword.authenticators).toHaveLength(2)

    const reloaded = await loadKeyring(store, 'acme', { userId: 'alice', secret: PHRASE })
    const kinds = reloaded.authenticators.map((a) => a.wrapKind ?? 'kek')
    expect(kinds).toEqual(['kek', 'deks'])
  })
})
