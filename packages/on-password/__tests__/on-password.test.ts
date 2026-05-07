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
  PasswordTooWeakError,
  PasswordInvalidError,
} from '../src/index.js'
import type { UnlockedKeyring, KeyringAuthenticator } from '@noy-db/hub'

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
      password: 'daily-password-2026',
    })
    expect(opts.method).toBe('password')
    expect(opts.id).toBe('password-daily')
    expect(opts.wrapKind).toBe('deks')
    if (opts.wrapKind !== 'deks') throw new Error('unreachable')
    expect(typeof opts.wrapped_deks).toBe('string')
    expect(typeof opts.iv).toBe('string')

    const recovered = await unwrapDeksWithPassword(slotFromOptions(opts), 'daily-password-2026')
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
      password: 'daily-password-2026',
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
      password: 'daily-password-2026',
    })
    // The tier-1 phrase used to derive the keyring is "correct horse...";
    // it must NOT unlock the password slot.
    await expect(
      unwrapDeksWithPassword(slotFromOptions(opts), 'correct horse battery staple printer toaster'),
    ).rejects.toBeInstanceOf(PasswordInvalidError)
  }, 30_000)

  it('rejects a wrap-KEK slot (legacy pre-pre.8 password slots) with a clear error', async () => {
    // Construct a synthetic legacy slot that mimics the pre-PR1b shape.
    const legacy: KeyringAuthenticator = {
      id: 'password-legacy',
      method: 'password',
      enrolled_at: new Date().toISOString(),
      enrolled_via_tier: 1,
      wrapped_kek: 'd2hhdGV2ZXItbGVnYWN5LWJ5dGVz',
      meta: { salt: 'c2FsdC1ub3JtYWw=', minLength: 12 },
    }
    await expect(
      unwrapDeksWithPassword(legacy, 'daily-password-2026'),
    ).rejects.toBeInstanceOf(PasswordInvalidError)
  })

  it('verifyPasswordSlot returns UnlockedKeyring with kek:null + reference identity fields', async () => {
    const keyring = await buildKeyring()
    const opts = await enrollPasswordAuthenticator(keyring, {
      password: 'daily-password-2026',
    })
    const unlocked = await verifyPasswordSlot(
      slotFromOptions(opts),
      'daily-password-2026',
      { keyring },
    )
    expect(unlocked.userId).toBe('alice')
    expect(unlocked.role).toBe('owner')
    expect(unlocked.deks.size).toBe(2)
    // wrap-DEKs unlock cannot recover the KEK — must be null.
    expect(unlocked.kek).toBeNull()
  }, 30_000)
})
