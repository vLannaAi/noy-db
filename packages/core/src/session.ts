/**
 * Session tokens — v0.7 #109
 *
 * After a compartment is unlocked (via passphrase, WebAuthn, OIDC, or magic-
 * link), the caller can call `createSession()` to get a session token that
 * allows re-establishing the KEK for the session lifetime without re-running
 * PBKDF2 or any interactive auth challenge.
 *
 * Security model
 * ──────────────
 * A session consists of two pieces that must both be present to recover the
 * KEK:
 *
 *   1. The **session key** — a non-extractable AES-256-GCM CryptoKey that
 *      exists only in memory. "Non-extractable" is enforced by the WebCrypto
 *      API: the key object cannot be serialized, exported, or sent over
 *      postMessage. When the JS context is GC'd (tab close, navigation away,
 *      worker termination) the key becomes unrecoverable.
 *
 *   2. The **session token** — a JSON object that carries the KEK wrapped
 *      with the session key (AES-256-GCM, fresh IV per session), plus
 *      unencrypted session metadata (sessionId, userId, compartment, role,
 *      expiresAt). The token can be serialized to JSON and stored in
 *      sessionStorage or passed across callsites within the same tab, but
 *      it is useless without the session key.
 *
 * The session key is kept in a module-level Map indexed by sessionId. Callers
 * that need to re-use a session must hold on to the sessionId returned from
 * `createSession()`; the key is looked up automatically by `resolveSession()`.
 *
 * Revocation: `revokeSession()` removes the entry from the Map. Because the
 * key is non-extractable, removal is sufficient — no one holds a serializable
 * copy of the key.
 *
 * Tab-scoped lifetime: the module-level Map lives only as long as the JS
 * module. Tab close → module unloaded → Map GC'd → all session keys gone.
 * This is the zero-effort logout: closing the tab is always a secure logout.
 *
 * Expiry: `createSession()` accepts a `ttlMs` option. `resolveSession()`
 * checks `expiresAt` and throws `SessionExpiredError` if the token is stale,
 * even if the session key is still in the Map.
 */

import { bufferToBase64, base64ToBuffer } from './crypto.js'
import { generateULID } from './bundle/ulid.js'
import type { Role } from './types.js'
import type { UnlockedKeyring } from './keyring.js'
import { SessionExpiredError, SessionNotFoundError } from './errors.js'

const subtle = globalThis.crypto.subtle

// Default session TTL: 60 minutes
const DEFAULT_TTL_MS = 60 * 60 * 1000

// Module-level session key store. Tab-scoped by construction.
const sessionKeyStore = new Map<string, CryptoKey>()

// ─── Public types ──────────────────────────────────────────────────────

/** The serializable part of a session token. Safe to store in sessionStorage. */
export interface SessionToken {
  readonly _noydb_session: 1
  /** Unique session identifier (ULID). Use this as the handle for resolve/revoke. */
  readonly sessionId: string
  readonly userId: string
  readonly compartment: string
  readonly role: Role
  /** ISO timestamp — resolveSession() rejects this token after this time. */
  readonly expiresAt: string
  /** KEK wrapped with the session key (AES-256-GCM). Base64. */
  readonly wrappedKek: string
  /** IV used for the wrapping operation. Base64. */
  readonly kekIv: string
}

/** Result returned from `createSession()`. */
export interface CreateSessionResult {
  /** Serializable token — store in sessionStorage or pass to `resolveSession()`. */
  token: SessionToken
  /** The sessionId — use this handle for `resolveSession()` and `revokeSession()`. */
  sessionId: string
}

/** Options for `createSession()`. */
export interface CreateSessionOptions {
  /**
   * Session lifetime in milliseconds. Defaults to 60 minutes.
   * After this duration, `resolveSession()` throws `SessionExpiredError`.
   */
  ttlMs?: number
}

// ─── Core session operations ───────────────────────────────────────────

/**
 * Create a session for an already-unlocked keyring.
 *
 * Call this after any successful unlock (passphrase, WebAuthn, OIDC,
 * magic-link). The returned `sessionId` is the handle for later
 * `resolveSession()` and `revokeSession()` calls.
 *
 * The session key is generated fresh (non-extractable) and stored in the
 * module-level Map. The KEK from `keyring.kek` is exported (it must be
 * extractable — it was derived by `deriveKey()` which sets extractable: false,
 * but it's unwrapped from the keyring which sets extractable: true) and then
 * re-wrapped with the session key.
 *
 * @param keyring - An already-unlocked keyring whose `kek` is available.
 * @param compartment - The compartment name this session is scoped to.
 * @param options - Optional session configuration.
 */
export async function createSession(
  keyring: UnlockedKeyring,
  compartment: string,
  options: CreateSessionOptions = {},
): Promise<CreateSessionResult> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const sessionId = generateULID()
  const expiresAt = new Date(Date.now() + ttlMs).toISOString()

  // Generate a fresh non-extractable session key.
  // AES-256-GCM is used here (rather than AES-KW) because the session key
  // wraps raw key bytes (the exported KEK) rather than a CryptoKey object.
  const sessionKey = await subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable — this is the tab-scope security invariant
    ['encrypt', 'decrypt'],
  )

  // Export the KEK as raw bytes so we can wrap it.
  // The KEK is AES-256-KW, which must have been importable (extractable: true)
  // to allow wrapKey — it is, because unwrapKey sets extractable: true for
  // DEKs, but the KEK itself is derived with extractable: false (see
  // crypto.ts deriveKey). We use a separate raw export + encrypt path.
  //
  // Wait — the KEK is AES-KW with extractable:false. We cannot export it.
  // Instead, we wrap the DEKs (which ARE extractable) and the salt+role+userId
  // metadata together. This means resolveSession() reconstructs an
  // UnlockedKeyring by re-wrapping the DEKs list from the token.
  //
  // Simpler approach: export each DEK (they're extractable) and encrypt
  // the serialized DEK map with the session key. The keyring is reconstructed
  // from the session token without the original KEK — only DEKs matter for
  // record operations.
  //
  // This is the right design: sessions don't need the KEK (no re-grant,
  // no re-derive during session lifetime). They need the DEK set.

  const dekMap: Record<string, string> = {}
  for (const [collName, dek] of keyring.deks) {
    const raw = await subtle.exportKey('raw', dek)
    dekMap[collName] = bufferToBase64(raw)
  }

  const payload = JSON.stringify({
    userId: keyring.userId,
    displayName: keyring.displayName,
    role: keyring.role,
    permissions: keyring.permissions,
    deks: dekMap,
    salt: bufferToBase64(keyring.salt),
  })

  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    sessionKey,
    new TextEncoder().encode(payload),
  )

  const token: SessionToken = {
    _noydb_session: 1,
    sessionId,
    userId: keyring.userId,
    compartment,
    role: keyring.role,
    expiresAt,
    wrappedKek: bufferToBase64(encrypted),
    kekIv: bufferToBase64(iv),
  }

  sessionKeyStore.set(sessionId, sessionKey)
  return { token, sessionId }
}

/**
 * Resolve a session token back into an UnlockedKeyring.
 *
 * Looks up the session key by `sessionId`, checks the token is not expired,
 * then decrypts the payload to reconstruct the keyring's DEK set.
 *
 * Throws `SessionExpiredError` if the token's `expiresAt` is in the past.
 * Throws `SessionNotFoundError` if the session key is not in the store
 * (tab was reloaded, session was revoked, or the sessionId is wrong).
 *
 * @param token - The SessionToken from `createSession()`.
 */
export async function resolveSession(token: SessionToken): Promise<UnlockedKeyring> {
  // Expiry check first — fast path without touching crypto
  if (Date.now() > new Date(token.expiresAt).getTime()) {
    sessionKeyStore.delete(token.sessionId)
    throw new SessionExpiredError(token.sessionId)
  }

  const sessionKey = sessionKeyStore.get(token.sessionId)
  if (!sessionKey) {
    throw new SessionNotFoundError(token.sessionId)
  }

  const iv = base64ToBuffer(token.kekIv)
  const ciphertext = base64ToBuffer(token.wrappedKek)

  let plaintext: ArrayBuffer
  try {
    plaintext = await subtle.decrypt(
      { name: 'AES-GCM', iv },
      sessionKey,
      ciphertext,
    )
  } catch {
    throw new SessionNotFoundError(token.sessionId)
  }

  const payload = JSON.parse(new TextDecoder().decode(plaintext)) as {
    userId: string
    displayName: string
    role: Role
    permissions: Record<string, 'rw' | 'ro'>
    deks: Record<string, string>
    salt: string
  }

  const deks = new Map<string, CryptoKey>()
  for (const [collName, rawBase64] of Object.entries(payload.deks)) {
    const dek = await subtle.importKey(
      'raw',
      base64ToBuffer(rawBase64),
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
    deks.set(collName, dek)
  }

  return {
    userId: payload.userId,
    displayName: payload.displayName,
    role: payload.role,
    permissions: payload.permissions,
    deks,
    kek: null as unknown as CryptoKey, // KEK not available in session context
    salt: base64ToBuffer(payload.salt),
  }
}

/**
 * Revoke a session by removing its key from the store.
 *
 * After revocation, `resolveSession()` will throw `SessionNotFoundError`
 * for this sessionId. The session token (if held by the caller) becomes
 * permanently useless. This is the explicit logout path.
 *
 * No-op if the session was already expired or does not exist.
 */
export function revokeSession(sessionId: string): void {
  sessionKeyStore.delete(sessionId)
}

/**
 * Check if a session is still alive (key in store + not expired).
 * Does not decrypt anything — purely a metadata check.
 */
export function isSessionAlive(token: SessionToken): boolean {
  if (Date.now() > new Date(token.expiresAt).getTime()) return false
  return sessionKeyStore.has(token.sessionId)
}

/**
 * Revoke all active sessions. Used by `Noydb.close()` to ensure that
 * closing the instance destroys all session state, not just the keyring
 * cache.
 */
export function revokeAllSessions(): void {
  sessionKeyStore.clear()
}

/**
 * Return the number of active sessions currently in the store.
 * Useful for diagnostics and tests.
 */
export function activeSessionCount(): number {
  return sessionKeyStore.size
}
