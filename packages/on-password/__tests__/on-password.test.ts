/**
 * Cryptographic round-trip tests for the tier-2 password authenticator.
 *
 * Post-PR1b (#26 Path C) the slot uses the **wrap-DEKs** variant — the
 * password-derived AES-GCM key encrypts the DEK set, NOT the KEK.
 * Verifies:
 *   1. enroll → verify with the same password recovers the DEK set
 *   2. wrong password rejects with `PasswordInvalidError`
 *   3. tier-1 phrase ≠ tier-2 password (independent slot)
 *   4. weak password rejects with `PasswordTooWeakError`
 *   5. verifyPasswordSlot returns kek:null (sensitive ops require tier-1)
 */
import { describe, it, expect } from 'vitest'
import {
  enrollPasswordAuthenticator,
  unwrapDeksWithPassword,
  verifyPasswordSlot,
  passwordSlotRewrapCeremony,
  PasswordTooWeakError,
  PasswordInvalidError,
} from '../src/index.js'
import type { UnlockedKeyring, KeyringAuthenticator, NoydbStore, EncryptedEnvelope, KeyringFile, SlotRewrapContext } from '@noy-db/hub'
import { ValidationError } from '@noy-db/hub'

const subtle = globalThis.crypto.subtle

async function buildKeyring(): Promise<UnlockedKeyring> {
  // Mint a real KEK (extractable=false matches hub's runtime invariant)
  // and two DEKs so the wrap-DEKs round-trip exercises the JSON
  // serialization path.
  const ikm = await subtle.importKey(
    'raw',
    new TextEncoder().encode('correct horse battery staple printer toaster'),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  const kek = await subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: crypto.getRandomValues(new Uint8Array(32)) as BufferSource,
      iterations: 600_000,
      hash: 'SHA-256',
    },
    ikm,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  )
  const dek1 = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const dek2 = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  return {
    userId: 'alice',
    displayName: 'alice',
    role: 'owner',
    permissions: {},
    deks: new Map([['invoices', dek1], ['clients', dek2]]),
    kek,
    salt: new Uint8Array(32),
    authenticators: [],
  }
}

function slotFromOptions(opts: Awaited<ReturnType<typeof enrollPasswordAuthenticator>>): KeyringAuthenticator {
  if (opts.wrapKind !== 'deks') throw new Error('expected wrap-DEKs slot')
  return {
    id: opts.id,
    method: opts.method,
    enrolled_at: new Date().toISOString(),
    enrolled_via_tier: opts.enrolled_via_tier ?? 1,
    wrapKind: 'deks',
    wrapped_deks: opts.wrapped_deks,
    iv: opts.iv,
    meta: opts.meta,
  }
}

describe('@noy-db/on-password — wrap-DEKs enroll + verify (#26 Path C)', () => {
  it('enrolls a wrap-DEKs slot whose password recovers the same DEK set', async () => {
    const keyring = await buildKeyring()
    const opts = await enrollPasswordAuthenticator(keyring, {
      password: 'strong-password-2026',
    })
    expect(opts.method).toBe('password')
    expect(opts.id).toBe('password')
    expect(opts.wrapKind).toBe('deks')
    if (opts.wrapKind !== 'deks') throw new Error('unreachable')
    expect(typeof opts.wrapped_deks).toBe('string')
    expect(typeof opts.iv).toBe('string')

    const recovered = await unwrapDeksWithPassword(slotFromOptions(opts), 'strong-password-2026')
    expect(recovered.size).toBe(2)
    expect(recovered.has('invoices')).toBe(true)
    expect(recovered.has('clients')).toBe(true)

    // The recovered DEK must be byte-equivalent to the original — exportKey('raw')
    // should yield identical bytes.
    const originalRaw = new Uint8Array(await subtle.exportKey('raw', keyring.deks.get('invoices')!))
    const recoveredRaw = new Uint8Array(await subtle.exportKey('raw', recovered.get('invoices')!))
    expect(Array.from(recoveredRaw)).toEqual(Array.from(originalRaw))
  }, 30_000)

  it('rejects a wrong password with PasswordInvalidError', async () => {
    const keyring = await buildKeyring()
    const opts = await enrollPasswordAuthenticator(keyring, {
      password: 'strong-password-2026',
    })
    await expect(
      unwrapDeksWithPassword(slotFromOptions(opts), 'wrong-password-9999'),
    ).rejects.toBeInstanceOf(PasswordInvalidError)
  }, 30_000)

  it('rejects a too-short password with PasswordTooWeakError', async () => {
    const keyring = await buildKeyring()
    await expect(
      enrollPasswordAuthenticator(keyring, { password: 'short' }),
    ).rejects.toBeInstanceOf(PasswordTooWeakError)
  })

  it('honours per-app minLength', async () => {
    const keyring = await buildKeyring()
    await expect(
      enrollPasswordAuthenticator(keyring, {
        password: 'twelve-chars',
        minLength: 16,
      }),
    ).rejects.toBeInstanceOf(PasswordTooWeakError)
  })

  it('honours custom pattern (must contain digit)', async () => {
    const keyring = await buildKeyring()
    await expect(
      enrollPasswordAuthenticator(keyring, {
        password: 'no-digits-here-2',
        pattern: /[0-9]/,
      }),
    ).resolves.toBeDefined()

    await expect(
      enrollPasswordAuthenticator(keyring, {
        password: 'no-digits-here',
        pattern: /[0-9]/,
      }),
    ).rejects.toBeInstanceOf(PasswordTooWeakError)
  }, 30_000)

  it('different password ≠ tier-1 phrase (independent storage)', async () => {
    const keyring = await buildKeyring()
    const opts = await enrollPasswordAuthenticator(keyring, {
      password: 'strong-password-2026',
    })
    // The tier-1 phrase used to derive the keyring is "correct horse...";
    // it must NOT unlock the password slot.
    await expect(
      unwrapDeksWithPassword(slotFromOptions(opts), 'correct horse battery staple printer toaster'),
    ).rejects.toBeInstanceOf(PasswordInvalidError)
  }, 30_000)

  it('rejects a wrap-KEK slot (legacy pre-pre.8 password slots) with the re-enrol message', async () => {
    // Construct a synthetic legacy slot that mimics the pre-PR1b shape.
    const legacy: KeyringAuthenticator = {
      id: 'password-legacy',
      method: 'password',
      enrolled_at: new Date().toISOString(),
      enrolled_via_tier: 1,
      wrapped_kek: 'd2hhdGV2ZXItbGVnYWN5LWJ5dGVz',
      meta: { salt: 'c2FsdC1ub3JtYWw=', minLength: 12 },
    }
    // Pin the user-facing recovery instruction — a future refactor that
    // throws PasswordInvalidError for a different reason would silently
    // regress the "re-enrol" UX. Per Niwat's PR #42 review point 4.
    await expect(
      unwrapDeksWithPassword(legacy, 'strong-password-2026'),
    ).rejects.toMatchObject({
      name: 'PasswordInvalidError',
      message: expect.stringMatching(/wrap-DEKs|re-enrol/),
    })
  })

  it('verifyPasswordSlot returns UnlockedKeyring with kek:null + identity from disk (cold-start path)', async () => {
    // Niwat PR #42 review point 3: verifier loads identity from
    // `_keyring/<userId>` directly, so cold-start (createNoydb +
    // getKeyring callback) works without a pre-existing keyring.
    const keyring = await buildKeyring()
    const opts = await enrollPasswordAuthenticator(keyring, {
      password: 'strong-password-2026',
    })

    // Build a real store with a written keyring file to feed the verifier.
    const store = inlineMemory()
    const file: KeyringFile = {
      _noydb_keyring: 1,
      user_id: 'alice',
      display_name: 'Alice Example',
      role: 'owner',
      permissions: {},
      deks: {},
      salt: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      created_at: new Date().toISOString(),
      granted_by: 'alice',
    }
    await store.put('acme', '_keyring', 'alice', {
      _noydb: 1,
      _v: 1,
      _ts: new Date().toISOString(),
      _iv: '',
      _data: JSON.stringify(file),
    })

    const unlocked = await verifyPasswordSlot(
      slotFromOptions(opts),
      'strong-password-2026',
      { store, vault: 'acme', userId: 'alice' },
    )
    expect(unlocked.userId).toBe('alice')
    expect(unlocked.displayName).toBe('Alice Example')
    expect(unlocked.role).toBe('owner')
    expect(unlocked.deks.size).toBe(2)
    // wrap-DEKs unlock cannot recover the KEK — must be null.
    expect(unlocked.kek).toBeNull()
  }, 30_000)

  it('verifyPasswordSlot throws when the keyring file is missing', async () => {
    const keyring = await buildKeyring()
    const opts = await enrollPasswordAuthenticator(keyring, {
      password: 'strong-password-2026',
    })
    const store = inlineMemory()
    await expect(
      verifyPasswordSlot(
        slotFromOptions(opts),
        'strong-password-2026',
        { store, vault: 'acme', userId: 'ghost' },
      ),
    ).rejects.toBeInstanceOf(PasswordInvalidError)
  }, 30_000)
})

describe('passwordSlotRewrapCeremony (#96)', () => {
  /** Build a SlotRewrapContext with newly-rotated DEKs + the slot to preserve. */
  async function buildContext(slot: KeyringAuthenticator): Promise<SlotRewrapContext> {
    const newDek1 = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    const newDek2 = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    // newKek is required by SlotRewrapContext but the password ceremony
    // doesn't use it (wrap-DEKs unlocks don't recover a KEK).
    const newKek = await subtle.generateKey({ name: 'AES-KW', length: 256 }, true, ['wrapKey', 'unwrapKey'])
    return {
      newKek,
      newDeks: new Map([['invoices', newDek1], ['clients', newDek2]]),
      oldSlot: slot,
    }
  }

  it('preserves slot id, method, wrapKind across rotation; new wrapping unlocks via the same password', async () => {
    const keyring = await buildKeyring()
    const opts = await enrollPasswordAuthenticator(keyring, {
      id: 'password',
      password: 'daily-password-2026',
      minLength: 14,
    })
    const slot = slotFromOptions(opts)

    const ctx = await buildContext(slot)
    const ceremony = passwordSlotRewrapCeremony('daily-password-2026')
    const result = await ceremony(ctx)

    // Anti-slot-swap invariants — same id / method / wrapKind. Hub's
    // rotate-recover validates these structurally; this test pins them
    // at the ceremony layer too.
    expect(result.id).toBe('password')
    expect(result.method).toBe('password')
    expect(result.wrapKind).toBe('deks')
    if (result.wrapKind !== 'deks') throw new Error('unreachable')

    // Strength config carried through.
    expect(result.meta.minLength).toBe(14)

    // The new slot unwraps to the rotated DEK set, not the original.
    const recovered = await unwrapDeksWithPassword(slotFromOptions(result), 'daily-password-2026')
    expect(recovered.size).toBe(2)
    expect([...recovered.keys()].sort()).toEqual(['clients', 'invoices'])
  }, 60_000)

  it('rejects oldSlot.method !== "password" with ValidationError (anti-cross-method)', async () => {
    const wrongMethodSlot: KeyringAuthenticator = {
      id: 'webauthn-yubi',
      method: 'webauthn',
      enrolled_at: new Date().toISOString(),
      enrolled_via_tier: 1,
      wrapped_kek: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
      meta: { credentialId: 'cred' },
    }
    const ctx = await buildContext(wrongMethodSlot)
    const ceremony = passwordSlotRewrapCeremony('daily-password-2026')
    await expect(ceremony(ctx)).rejects.toBeInstanceOf(ValidationError)
  }, 30_000)

  it('rejects legacy wrap-KEK password slot with ValidationError', async () => {
    const legacyWrapKekSlot: KeyringAuthenticator = {
      id: 'password',
      method: 'password',
      enrolled_at: '2025-01-01T00:00:00Z',
      enrolled_via_tier: 1,
      wrapped_kek: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
      meta: { salt: 'YWFh' },
    }
    const ctx = await buildContext(legacyWrapKekSlot)
    const ceremony = passwordSlotRewrapCeremony('daily-password-2026')
    await expect(ceremony(ctx)).rejects.toBeInstanceOf(ValidationError)
  }, 30_000)

  it('preserves enrolled_via_tier from the old slot', async () => {
    const keyring = await buildKeyring()
    const opts = await enrollPasswordAuthenticator(keyring, {
      password: 'daily-password-2026',
      enrolledViaTier: 2,
    })
    const slot = slotFromOptions(opts)
    expect(slot.enrolled_via_tier).toBe(2)

    const ctx = await buildContext(slot)
    const ceremony = passwordSlotRewrapCeremony('daily-password-2026')
    const result = await ceremony(ctx)
    expect(result.enrolled_via_tier).toBe(2)
  }, 60_000)
})

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
