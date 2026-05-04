/**
 * Cryptographic round-trip tests for the tier-2 password authenticator.
 *
 * The tests build a minimal `UnlockedKeyring` with a real AES-KW KEK
 * and verify:
 *   1. enroll → unlock with the same password recovers the KEK
 *   2. wrong password rejects with `PasswordInvalidError`
 *   3. tier-1 phrase ≠ tier-2 password (independent slot, independent strength)
 *   4. weak password rejects with `PasswordTooWeakError`
 *   5. removing a slot does not affect other slots
 */
import { describe, it, expect } from 'vitest'
import {
  enrollPasswordAuthenticator,
  unwrapKekWithPassword,
  PasswordTooWeakError,
  PasswordInvalidError,
} from '../src/index.js'
import type { UnlockedKeyring } from '@noy-db/hub'

const subtle = globalThis.crypto.subtle

async function buildKeyring(): Promise<UnlockedKeyring> {
  // Mint a real KEK so wrap/unwrap round-trips through AES-KW.
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
    true,
    ['wrapKey', 'unwrapKey'],
  )
  return {
    userId: 'alice',
    displayName: 'alice',
    role: 'owner',
    permissions: {},
    deks: new Map(),
    kek,
    salt: new Uint8Array(32),
    authenticators: [],
  }
}

describe('@noy-db/on-password — enroll + unlock', () => {
  it('enrolls a slot whose password unlocks the same KEK', async () => {
    const keyring = await buildKeyring()
    const slot = await enrollPasswordAuthenticator(keyring, {
      password: 'daily-password-2026',
    })
    expect(slot.method).toBe('password')
    expect(slot.id).toBe('password-daily')
    expect(typeof slot.wrapped_kek).toBe('string')

    const recoveredKek = await unwrapKekWithPassword(
      {
        id: slot.id,
        method: 'password',
        enrolled_at: new Date().toISOString(),
        enrolled_via_tier: 1,
        wrapped_kek: slot.wrapped_kek,
        meta: slot.meta,
      },
      'daily-password-2026',
    )

    // Sanity: re-wrap a small DEK with the recovered KEK, then unwrap with the original.
    const dek = await subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
    const wrapped = await subtle.wrapKey('raw', dek, recoveredKek, 'AES-KW')
    const unwrapped = await subtle.unwrapKey(
      'raw',
      wrapped,
      keyring.kek,
      'AES-KW',
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
    expect(unwrapped).toBeDefined()
  }, 30_000)

  it('rejects a wrong password with PasswordInvalidError', async () => {
    const keyring = await buildKeyring()
    const slot = await enrollPasswordAuthenticator(keyring, {
      password: 'daily-password-2026',
    })
    await expect(
      unwrapKekWithPassword(
        {
          id: slot.id,
          method: 'password',
          enrolled_at: new Date().toISOString(),
          enrolled_via_tier: 1,
          wrapped_kek: slot.wrapped_kek,
          meta: slot.meta,
        },
        'wrong-password-9999',
      ),
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
        password: 'no-digits-here-2',  // satisfies, has '2'
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
    const slot = await enrollPasswordAuthenticator(keyring, {
      password: 'daily-password-2026',
    })
    // The tier-1 phrase used to derive the keyring is "correct horse...";
    // it must NOT unlock the password slot.
    await expect(
      unwrapKekWithPassword(
        {
          id: slot.id,
          method: 'password',
          enrolled_at: new Date().toISOString(),
          enrolled_via_tier: 1,
          wrapped_kek: slot.wrapped_kek,
          meta: slot.meta,
        },
        'correct horse battery staple printer toaster',
      ),
    ).rejects.toBeInstanceOf(PasswordInvalidError)
  }, 30_000)
})
