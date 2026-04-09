/**
 * Tests for v0.7 #109 — session tokens
 *
 * Tests the core session primitive:
 * - createSession() wraps the keyring state with a non-extractable session key
 * - resolveSession() reconstructs an equivalent keyring from the token
 * - revokeSession() invalidates a session by dropping the key from the store
 * - SessionExpiredError thrown when expiresAt is in the past
 * - SessionNotFoundError thrown when session key is gone
 * - revokeAllSessions() clears every active session
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createSession,
  resolveSession,
  revokeSession,
  revokeAllSessions,
  isSessionAlive,
  activeSessionCount,
} from '../src/session.js'
import { SessionExpiredError, SessionNotFoundError } from '../src/errors.js'
import type { UnlockedKeyring } from '../src/keyring.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeFakeDek(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
}

async function makeKeyring(overrides?: Partial<UnlockedKeyring>): Promise<UnlockedKeyring> {
  const dek = await makeFakeDek()
  const dek2 = await makeFakeDek()
  return {
    userId: 'alice',
    displayName: 'Alice',
    role: 'owner',
    permissions: {},
    deks: new Map([['invoices', dek], ['clients', dek2]]),
    kek: null as unknown as CryptoKey, // KEK is not needed by session layer
    salt: new Uint8Array(32).fill(1),
    ...overrides,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('session tokens (#109)', () => {
  beforeEach(() => {
    revokeAllSessions()
  })

  afterEach(() => {
    revokeAllSessions()
    vi.useRealTimers()
  })

  // ── createSession ──────────────────────────────────────────────────────────

  it('creates a session token with correct metadata', async () => {
    const keyring = await makeKeyring()
    const { token, sessionId } = await createSession(keyring, 'company-a')

    expect(token._noydb_session).toBe(1)
    expect(token.sessionId).toBe(sessionId)
    expect(token.userId).toBe('alice')
    expect(token.compartment).toBe('company-a')
    expect(token.role).toBe('owner')
    expect(token.expiresAt).toBeTruthy()
    expect(new Date(token.expiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(token.wrappedKek).toBeTruthy()
    expect(token.kekIv).toBeTruthy()
  })

  it('generates a unique sessionId per call', async () => {
    const keyring = await makeKeyring()
    const { sessionId: id1 } = await createSession(keyring, 'company-a')
    const { sessionId: id2 } = await createSession(keyring, 'company-a')
    expect(id1).not.toBe(id2)
  })

  it('uses the supplied ttlMs for expiry', async () => {
    const keyring = await makeKeyring()
    const before = Date.now()
    const { token } = await createSession(keyring, 'company-a', { ttlMs: 5 * 60 * 1000 })
    const after = Date.now()
    const expiresAt = new Date(token.expiresAt).getTime()
    // Should expire approximately 5 minutes from now
    expect(expiresAt).toBeGreaterThanOrEqual(before + 5 * 60 * 1000)
    expect(expiresAt).toBeLessThanOrEqual(after + 5 * 60 * 1000)
  })

  it('adds the session key to the store', async () => {
    const keyring = await makeKeyring()
    const countBefore = activeSessionCount()
    await createSession(keyring, 'company-a')
    expect(activeSessionCount()).toBe(countBefore + 1)
  })

  // ── resolveSession ─────────────────────────────────────────────────────────

  it('resolves a session back to an equivalent keyring', async () => {
    const keyring = await makeKeyring()
    const { token } = await createSession(keyring, 'company-a')
    const resolved = await resolveSession(token)

    expect(resolved.userId).toBe(keyring.userId)
    expect(resolved.displayName).toBe(keyring.displayName)
    expect(resolved.role).toBe(keyring.role)
    expect(resolved.deks.size).toBe(keyring.deks.size)
    expect([...resolved.deks.keys()].sort()).toEqual([...keyring.deks.keys()].sort())
  })

  it('resolved DEKs can encrypt and decrypt (key material preserved)', async () => {
    const keyring = await makeKeyring()
    const { token } = await createSession(keyring, 'company-a')

    // Encrypt with the original DEK
    const originalDek = keyring.deks.get('invoices')!
    const plaintext = new TextEncoder().encode('hello')
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      originalDek,
      plaintext,
    )

    // Decrypt with the resolved DEK
    const resolved = await resolveSession(token)
    const resolvedDek = resolved.deks.get('invoices')!
    const decrypted = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      resolvedDek,
      ciphertext,
    )
    expect(new TextDecoder().decode(decrypted)).toBe('hello')
  })

  it('throws SessionExpiredError when token is past expiresAt', async () => {
    const keyring = await makeKeyring()
    const { token } = await createSession(keyring, 'company-a', { ttlMs: 1000 })

    // Fake the expiry by patching the token's expiresAt
    const expired: typeof token = {
      ...token,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }

    await expect(resolveSession(expired)).rejects.toThrow(SessionExpiredError)
  })

  it('removes the session key from the store on expiry check', async () => {
    const keyring = await makeKeyring()
    const { token, sessionId } = await createSession(keyring, 'company-a')

    const expired: typeof token = {
      ...token,
      expiresAt: new Date(Date.now() - 1).toISOString(),
    }

    await expect(resolveSession(expired)).rejects.toThrow(SessionExpiredError)
    // Subsequent resolve with the same sessionId should throw SessionNotFoundError
    await expect(resolveSession({ ...expired, expiresAt: new Date(Date.now() + 60_000).toISOString() })).rejects.toThrow(SessionNotFoundError)
    expect(activeSessionCount()).toBe(0)
    void sessionId // just to avoid unused warning
  })

  it('throws SessionNotFoundError when session key is not in the store', async () => {
    const keyring = await makeKeyring()
    const { token, sessionId } = await createSession(keyring, 'company-a')

    // Remove the key manually (simulating tab reload / close)
    revokeSession(sessionId)

    await expect(resolveSession(token)).rejects.toThrow(SessionNotFoundError)
  })

  // ── revokeSession ──────────────────────────────────────────────────────────

  it('revokeSession removes the key from the store', async () => {
    const keyring = await makeKeyring()
    const { sessionId } = await createSession(keyring, 'company-a')

    expect(activeSessionCount()).toBe(1)
    revokeSession(sessionId)
    expect(activeSessionCount()).toBe(0)
  })

  it('revokeSession is a no-op for unknown sessionIds', () => {
    expect(() => revokeSession('nonexistent-session-id')).not.toThrow()
  })

  it('subsequent resolveSession after revocation throws SessionNotFoundError', async () => {
    const keyring = await makeKeyring()
    const { token, sessionId } = await createSession(keyring, 'company-a')
    revokeSession(sessionId)
    await expect(resolveSession(token)).rejects.toThrow(SessionNotFoundError)
  })

  // ── revokeAllSessions ──────────────────────────────────────────────────────

  it('revokeAllSessions clears all active sessions', async () => {
    const keyring = await makeKeyring()
    await createSession(keyring, 'company-a')
    await createSession(keyring, 'company-b')
    await createSession(keyring, 'company-c')

    expect(activeSessionCount()).toBe(3)
    revokeAllSessions()
    expect(activeSessionCount()).toBe(0)
  })

  // ── isSessionAlive ─────────────────────────────────────────────────────────

  it('isSessionAlive returns true for a fresh session', async () => {
    const keyring = await makeKeyring()
    const { token } = await createSession(keyring, 'company-a')
    expect(isSessionAlive(token)).toBe(true)
  })

  it('isSessionAlive returns false after expiry', async () => {
    const keyring = await makeKeyring()
    const { token } = await createSession(keyring, 'company-a')
    const expired = { ...token, expiresAt: new Date(Date.now() - 1).toISOString() }
    expect(isSessionAlive(expired)).toBe(false)
  })

  it('isSessionAlive returns false after revocation', async () => {
    const keyring = await makeKeyring()
    const { token, sessionId } = await createSession(keyring, 'company-a')
    revokeSession(sessionId)
    expect(isSessionAlive(token)).toBe(false)
  })

  // ── Multiple sessions / isolation ─────────────────────────────────────────

  it('multiple sessions for the same keyring are independent', async () => {
    const keyring = await makeKeyring()
    const { token: t1, sessionId: s1 } = await createSession(keyring, 'company-a')
    const { token: t2, sessionId: s2 } = await createSession(keyring, 'company-a')

    revokeSession(s1)

    // t2 still resolves
    const resolved = await resolveSession(t2)
    expect(resolved.userId).toBe('alice')

    // t1 throws
    await expect(resolveSession(t1)).rejects.toThrow(SessionNotFoundError)

    void s2
  })

  it('operator-scoped session preserves explicit permissions', async () => {
    const dek = await makeFakeDek()
    const keyring = await makeKeyring({
      role: 'operator',
      permissions: { invoices: 'rw' },
      deks: new Map([['invoices', dek]]),
    })
    const { token } = await createSession(keyring, 'company-a')
    const resolved = await resolveSession(token)

    expect(resolved.role).toBe('operator')
    expect(resolved.permissions['invoices']).toBe('rw')
    expect(resolved.deks.has('invoices')).toBe(true)
  })
})
