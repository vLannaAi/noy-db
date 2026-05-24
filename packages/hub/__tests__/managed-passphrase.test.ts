/**
 * #14 — Managed-passphrase mode (rubber-hose resistant).
 *
 * A vault mode where the passphrase is machine-generated and never
 * exposed to the user, sealed under a developer-provided key store
 * (macOS Keychain / Windows Credential Manager / libsecret / cloud KMS).
 * The user has no secret to give up to coercion.
 *
 * Slice 1 of the issue's full scope. Deferred to follow-ups:
 *   - Block rotate-passphrase under managed mode (policy gate override).
 *   - Mandatory strong-recovery enforcement at creation (depends on #10).
 *   - Recovery-under-managed flow that generates a fresh sealed phrase.
 *   - Concrete providers (macOS Keychain, etc.) live outside hub.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/types.js'
import { createNoydb } from '../src/noydb.js'
import { ConflictError, ValidationError } from '../src/errors.js'
import {
  MemorySealingKeyProvider,
  loadSealedPassphrase,
  saveSealedPassphrase,
  SEALED_PASSPHRASE_RECORD_ID,
  type SealingKeyProvider,
} from '../src/team/managed-passphrase.js'
import { shamirRecoveryProvider } from '@noy-db/on-shamir'

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

interface Note extends Record<string, unknown> { id: string; body: string }

describe('SealingKeyProvider — contract', () => {
  it('seal → unseal round-trip yields identical bytes', async () => {
    const provider = new MemorySealingKeyProvider({ id: 'test-1' })
    const passphrase = new TextEncoder().encode('hunter2 garden palace cushion bridge')
    const sealed = await provider.seal(passphrase)
    expect(sealed).not.toEqual(passphrase) // sealed bytes differ from plaintext
    const unsealed = await provider.unseal(sealed)
    expect(new TextDecoder().decode(unsealed)).toBe('hunter2 garden palace cushion bridge')
  })

  it('different providers cannot unseal each other', async () => {
    const a = new MemorySealingKeyProvider({ id: 'a' })
    const b = new MemorySealingKeyProvider({ id: 'b' })
    const sealed = await a.seal(new TextEncoder().encode('secret-A'))
    await expect(b.unseal(sealed)).rejects.toThrow()
  })

  it('provider.id is the disclosed (non-sensitive) identifier', () => {
    const p: SealingKeyProvider = new MemorySealingKeyProvider({ id: 'macos-keychain:com.example.app' })
    expect(p.id).toBe('macos-keychain:com.example.app')
  })
})

describe('_meta/sealed-passphrase envelope storage', () => {
  it('round-trips a sealed-passphrase envelope through the store', async () => {
    const store = inlineMemory()
    const sealed = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF])
    await saveSealedPassphrase(store, 'acme', { providerId: 'p-1', sealed })
    const loaded = await loadSealedPassphrase(store, 'acme')
    expect(loaded?.providerId).toBe('p-1')
    expect(Array.from(loaded?.sealed ?? [])).toEqual([0xDE, 0xAD, 0xBE, 0xEF])
  })

  it('returns undefined when nothing has been persisted', async () => {
    const store = inlineMemory()
    expect(await loadSealedPassphrase(store, 'acme')).toBeUndefined()
  })

  it('uses the reserved record id `sealed-passphrase` under _meta', async () => {
    expect(SEALED_PASSPHRASE_RECORD_ID).toBe('sealed-passphrase')
    const store = inlineMemory()
    const sealed = new Uint8Array([1, 2, 3])
    await saveSealedPassphrase(store, 'acme', { providerId: 'p-1', sealed })
    // Envelope is reachable via the standard _meta path.
    const env = await store.get('acme', '_meta', 'sealed-passphrase')
    expect(env).not.toBeNull()
  })
})

describe('createNoydb({ passphraseMode: "managed" }) — slice 1', () => {
  let store: NoydbStore
  let provider: MemorySealingKeyProvider

  beforeEach(() => {
    store = inlineMemory()
    provider = new MemorySealingKeyProvider({ id: 'test-keychain' })
  })

  it('rejects managed mode without a sealingKey', async () => {
    await expect(
      createNoydb({ store, user: 'alice', passphraseMode: 'managed' }),
    ).rejects.toThrow(ValidationError)
  })

  it('rejects managed mode combined with secret', async () => {
    await expect(
      createNoydb({
        store, user: 'alice',
        secret: 'should-not-be-here',
        passphraseMode: 'managed',
        sealingKey: provider,
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('rejects managed mode combined with getKeyring', async () => {
    await expect(
      createNoydb({
        store, user: 'alice',
        passphraseMode: 'managed',
        sealingKey: provider,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getKeyring: (async () => ({} as any)) as never,
      }),
    ).rejects.toThrow(ValidationError)
  })

  // Per #195, openVault under managed mode requires a STRONG recovery
  // profile to be enrolled. Tests that exercise the #186 sealing core
  // bootstrap via openVaultAndEnrollRecovery to satisfy that.
  it('first openVault generates a random passphrase, seals it, and persists', async () => {
    const db = await createNoydb({
      store, user: 'alice',
      passphraseMode: 'managed',
      sealingKey: provider,
      shamirRecovery: shamirRecoveryProvider(),
    })
    await db.openVaultAndEnrollRecovery('acme', {
      recovery: [{ profile: 'shamir', k: 2, n: 3 }],
    })
    const loaded = await loadSealedPassphrase(store, 'acme')
    expect(loaded).toBeDefined()
    expect(loaded!.providerId).toBe('test-keychain')
    expect(loaded!.sealed.byteLength).toBeGreaterThan(0)
  })

  it('reopening reuses the persisted sealed passphrase (no new random generated)', async () => {
    // First open — establishes the sealed envelope + strong recovery.
    const db1 = await createNoydb({
      store, user: 'alice',
      passphraseMode: 'managed',
      sealingKey: provider,
      shamirRecovery: shamirRecoveryProvider(),
    })
    await db1.openVaultAndEnrollRecovery('acme', {
      recovery: [{ profile: 'shamir', k: 2, n: 3 }],
    })
    const sealed1 = (await loadSealedPassphrase(store, 'acme'))!.sealed
    db1.close()

    // Second open — same sealing provider, same store, must unseal + reuse.
    const db2 = await createNoydb({
      store, user: 'alice',
      passphraseMode: 'managed',
      sealingKey: provider,
    })
    await db2.openVault('acme')
    const sealed2 = (await loadSealedPassphrase(store, 'acme'))!.sealed
    expect(Array.from(sealed2)).toEqual(Array.from(sealed1))
    db2.close()
  })

  it('round-trips records under managed mode (proves the unsealed phrase actually works)', async () => {
    const db = await createNoydb({
      store, user: 'alice',
      passphraseMode: 'managed',
      sealingKey: provider,
      shamirRecovery: shamirRecoveryProvider(),
    })
    const { vault } = await db.openVaultAndEnrollRecovery('acme', {
      recovery: [{ profile: 'shamir', k: 2, n: 3 }],
    })
    const notes = vault.collection<Note>('notes')
    await notes.put('n1', { id: 'n1', body: 'managed-mode record' })
    db.close()

    const db2 = await createNoydb({
      store, user: 'alice',
      passphraseMode: 'managed',
      sealingKey: provider,
    })
    const vault2 = await db2.openVault('acme')
    const notes2 = vault2.collection<Note>('notes')
    expect(await notes2.get('n1')).toEqual({ id: 'n1', body: 'managed-mode record' })
    db2.close()
  })

  it('db.rotatePassphrase throws PolicyDeniedError under managed mode', async () => {
    const db = await createNoydb({
      store, user: 'alice',
      passphraseMode: 'managed',
      sealingKey: provider,
      shamirRecovery: shamirRecoveryProvider(),
    })
    await db.openVaultAndEnrollRecovery('acme', {
      recovery: [{ profile: 'shamir', k: 2, n: 3 }],
    })
    await expect(
      db.rotatePassphrase('acme', {
        oldPassphrase: 'irrelevant — user does not know it',
        newPassphrase: 'also-irrelevant-but-policy-fires-first',
        allowWeakPassphrase: true,
      }),
    ).rejects.toThrowError(/managed-passphrase mode|disabled/i)
  })

  it('a different sealing provider rejects the persisted envelope', async () => {
    const db = await createNoydb({
      store, user: 'alice',
      passphraseMode: 'managed',
      sealingKey: provider,
      shamirRecovery: shamirRecoveryProvider(),
    })
    await db.openVaultAndEnrollRecovery('acme', {
      recovery: [{ profile: 'shamir', k: 2, n: 3 }],
    })
    db.close()

    // Different provider id → unseal fails → reopen throws
    const wrongProvider = new MemorySealingKeyProvider({ id: 'different-keychain' })
    const db2 = await createNoydb({
      store, user: 'alice',
      passphraseMode: 'managed',
      sealingKey: wrongProvider,
    })
    await expect(db2.openVault('acme')).rejects.toThrow()
  })
})
