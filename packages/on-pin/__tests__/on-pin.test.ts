/**
 * Tests for @noy-db/on-pin — session-resume PIN quick-lock.
 *
 * Covers:
 *   - enroll + resume happy path (right PIN → same keyring back)
 *   - wrong PIN → PinInvalidError + attempts counter increments
 *   - attempts exceeded → PinAttemptsExceededError
 *   - expired state → PinExpiredError
 *   - clearPinState makes the state un-resumable
 *   - isPinStateValid TTL + attempts predicate
 *   - serialization round-trip preserves userId / displayName / role /
 *     permissions / DEK contents (DEKs are functional keys, not just bytes)
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { UnlockedKeyring } from '@noy-db/hub'
import {
  enrollPin,
  resumePin,
  isPinStateValid,
  clearPinState,
  PinInvalidError,
  PinExpiredError,
  PinAttemptsExceededError,
  PIN_DEFAULT_TTL_MS,
  PIN_DEFAULT_MAX_ATTEMPTS,
} from '../src/index.js'

afterEach(() => {
  vi.useRealTimers()
})

// ─── Helpers ────────────────────────────────────────────────────────────

async function makeTestKeyring(): Promise<UnlockedKeyring> {
  const dek1 = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable — required by on-pin
    ['encrypt', 'decrypt'],
  )
  const dek2 = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
  return {
    userId: 'alice',
    displayName: 'Alice',
    role: 'owner',
    permissions: { invoices: 'rw', clients: 'rw' },
    deks: new Map([
      ['invoices', dek1],
      ['clients', dek2],
    ]),
    kek: null as unknown as CryptoKey, // simulate post-unlock state
    salt: new Uint8Array(32).fill(7),
  }
}

async function encryptWithDek(dek: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    dek,
    new TextEncoder().encode(plaintext),
  )
  // Concat iv + ct, base64 — not cryptographically important; we just
  // need a roundtrip check that the DEKs work after deserialisation.
  const out = new Uint8Array(iv.byteLength + ct.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(ct), iv.byteLength)
  let s = ''
  for (const b of out) s += String.fromCharCode(b)
  return btoa(s)
}

async function decryptWithDek(dek: CryptoKey, blob: string): Promise<string> {
  const raw = atob(blob)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  const iv = bytes.slice(0, 12)
  const ct = bytes.slice(12)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, dek, ct)
  return new TextDecoder().decode(plain)
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('enrollPin + resumePin — happy path', () => {
  it('resumes with the correct PIN and returns an equivalent keyring', async () => {
    const keyring = await makeTestKeyring()
    const state = await enrollPin(keyring, { pin: '1234' })
    const resumed = await resumePin(state, { pin: '1234' })

    expect(resumed.userId).toBe('alice')
    expect(resumed.displayName).toBe('Alice')
    expect(resumed.role).toBe('owner')
    expect(resumed.permissions).toEqual({ invoices: 'rw', clients: 'rw' })
    expect(resumed.deks.size).toBe(2)
    expect(resumed.deks.has('invoices')).toBe(true)
    expect(resumed.deks.has('clients')).toBe(true)
    // KEK is deliberately null on resumed keyrings.
    expect(resumed.kek).toBeNull()
  })

  it('resumed DEKs actually decrypt data encrypted by the originals', async () => {
    // This proves the base64 export→import round-trip reconstructs a
    // functional AES-GCM key, not just a byte-equal object.
    const keyring = await makeTestKeyring()
    const originalInvoicesDek = keyring.deks.get('invoices')!
    const ciphertext = await encryptWithDek(originalInvoicesDek, 'hello, resume')

    const state = await enrollPin(keyring, { pin: 'longer-pin-with-letters' })
    const resumed = await resumePin(state, { pin: 'longer-pin-with-letters' })

    const roundTrip = await decryptWithDek(resumed.deks.get('invoices')!, ciphertext)
    expect(roundTrip).toBe('hello, resume')
  })

  it('state carries the expected default TTL and attempt cap', async () => {
    const keyring = await makeTestKeyring()
    const before = Date.now()
    const state = await enrollPin(keyring, { pin: '1234' })
    const after = Date.now()

    const expiresMs = new Date(state.expiresAt).getTime()
    expect(expiresMs).toBeGreaterThanOrEqual(before + PIN_DEFAULT_TTL_MS)
    expect(expiresMs).toBeLessThanOrEqual(after + PIN_DEFAULT_TTL_MS)
    expect(state.maxAttempts).toBe(PIN_DEFAULT_MAX_ATTEMPTS)
    expect(state.attempts).toBe(0)
    expect(state._noydb_on_pin).toBe(1)
  })

  it('respects a custom ttlMs + maxAttempts', async () => {
    const keyring = await makeTestKeyring()
    const state = await enrollPin(keyring, {
      pin: '99',
      ttlMs: 60_000,
      maxAttempts: 2,
    })
    expect(state.maxAttempts).toBe(2)
    const age = new Date(state.expiresAt).getTime() - Date.now()
    expect(age).toBeGreaterThan(50_000)
    expect(age).toBeLessThan(70_000)
  })
})

describe('wrong-PIN handling', () => {
  it('throws PinInvalidError on wrong PIN and increments attempts', async () => {
    const keyring = await makeTestKeyring()
    const state = await enrollPin(keyring, { pin: '1234' })

    expect(state.attempts).toBe(0)
    await expect(resumePin(state, { pin: 'WRONG' })).rejects.toBeInstanceOf(PinInvalidError)
    expect(state.attempts).toBe(1)
    await expect(resumePin(state, { pin: 'WRONG' })).rejects.toBeInstanceOf(PinInvalidError)
    expect(state.attempts).toBe(2)
  })

  it('throws PinAttemptsExceededError once attempts hits the cap', async () => {
    const keyring = await makeTestKeyring()
    const state = await enrollPin(keyring, { pin: '1234', maxAttempts: 2 })

    // First two wrong attempts produce PinInvalidError
    await expect(resumePin(state, { pin: 'no' })).rejects.toBeInstanceOf(PinInvalidError)
    await expect(resumePin(state, { pin: 'no' })).rejects.toBeInstanceOf(PinInvalidError)
    expect(state.attempts).toBe(2)

    // Third attempt — even with the RIGHT pin — refuses, because the state
    // is dead. User must re-enter the full passphrase.
    await expect(resumePin(state, { pin: '1234' })).rejects.toBeInstanceOf(
      PinAttemptsExceededError,
    )
  })
})

describe('expiry', () => {
  it('throws PinExpiredError after the TTL has elapsed', async () => {
    const keyring = await makeTestKeyring()
    // Fake timers to advance past expiry without sleeping
    const state = await enrollPin(keyring, { pin: '1234', ttlMs: 1000 })
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.now() + 5000))
    await expect(resumePin(state, { pin: '1234' })).rejects.toBeInstanceOf(PinExpiredError)
  })

  it('isPinStateValid reflects both TTL and attempts', async () => {
    const keyring = await makeTestKeyring()
    const state = await enrollPin(keyring, { pin: '1234', ttlMs: 1000, maxAttempts: 1 })
    expect(isPinStateValid(state)).toBe(true)

    // One wrong attempt hits the cap
    await expect(resumePin(state, { pin: 'no' })).rejects.toBeInstanceOf(PinInvalidError)
    expect(isPinStateValid(state)).toBe(false)
  })
})

describe('clearPinState', () => {
  it('renders the state un-resumable', async () => {
    const keyring = await makeTestKeyring()
    const state = await enrollPin(keyring, { pin: '1234' })
    clearPinState(state)

    // Either expired or attempts-exceeded — both mean "dead"
    await expect(resumePin(state, { pin: '1234' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof PinExpiredError || e instanceof PinAttemptsExceededError,
    )
    expect(isPinStateValid(state)).toBe(false)
  })
})
