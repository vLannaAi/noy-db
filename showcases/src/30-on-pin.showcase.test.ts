/**
 * Showcase 30 — Session-resume PIN
 *
 * What you'll learn
 * ─────────────────
 * `enrollPin(keyring, { pin, ttlMs })` wraps the entire `UnlockedKeyring`
 * with a PBKDF2-derived key from the 4-6 digit PIN and returns a
 * `PinResumeState` to keep in memory (or sessionStorage).
 * `resumePin(state, { pin })` unwraps it. After `PIN_DEFAULT_TTL_MS` or
 * `PIN_DEFAULT_MAX_ATTEMPTS`, the state is invalidated.
 *
 * Why it matters
 * ──────────────
 * Re-typing a 30-character passphrase every 5 minutes is the death of
 * security UX. PIN-based session resume gives the user a short code that
 * unlocks for a short window — bounded blast radius if the device is
 * snatched mid-session.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 22-on-passphrase.
 *
 * What to read next
 * ─────────────────
 *   - showcase 31-on-threat (lockout + duress)
 *   - docs/subsystems/auth-pin.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → auths → on-pin
 */

import { describe, it, expect } from 'vitest'
import { enrollPin, resumePin, PinInvalidError } from '@noy-db/on-pin'
import type { UnlockedKeyring } from '@noy-db/hub'

async function makeKeyring(userId: string): Promise<UnlockedKeyring> {
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  return {
    userId, displayName: userId, role: 'owner', permissions: { invoices: 'rw' },
    deks: new Map([['invoices', dek]]),
    kek: null as unknown as CryptoKey, salt: new Uint8Array(32).fill(7),
  }
}

describe('Showcase 30 — Session-resume PIN', () => {
  it('enroll → resume reproduces the same keyring', async () => {
    const keyring = await makeKeyring('alice')
    const state = await enrollPin(keyring, { pin: '4824' })

    const resumed = await resumePin(state, { pin: '4824' })
    expect(resumed.userId).toBe('alice')
    expect(resumed.role).toBe('owner')
    expect(resumed.deks.size).toBe(1)
  })

  it('a wrong PIN throws PinInvalidError', async () => {
    const keyring = await makeKeyring('alice')
    const state = await enrollPin(keyring, { pin: '4824' })

    await expect(resumePin(state, { pin: '0000' })).rejects.toBeInstanceOf(PinInvalidError)
  })
})
