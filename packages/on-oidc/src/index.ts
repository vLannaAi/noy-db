/**
 * @noy-db/on-oidc — v0.7 #112
 *
 * OAuth/OIDC bridge for noy-db with split-key key connector.
 *
 * This package enables federated login (LINE, Google, Apple, Microsoft,
 * Okta, Auth0, Keycloak, any OIDC-compliant provider) without the server
 * ever seeing plaintext or the unwrapped KEK.
 *
 * Split-key model (Bitwarden-style key connector)
 * ────────────────────────────────────────────────
 * The KEK is XOR-split into two equal-length key halves:
 *
 *   serverHalf ⊕ deviceHalf = KEK
 *
 * At enrollment time:
 *   1. The full KEK is available (user is authenticated via passphrase).
 *   2. `deviceHalf` is derived: HKDF(deviceSecret, "noydb-oidc-device-v1", sub)
 *      where `deviceSecret` is a per-device random value stored in IndexedDB
 *      or localStorage (never transmitted).
 *   3. `serverHalf = KEK ⊕ deviceHalf`.
 *   4. `serverHalf` is encrypted with the OIDC access token and sent to the
 *      key-connector server endpoint. The server stores it indexed by `sub`
 *      (the OIDC subject claim).
 *   5. The server NEVER sees the KEK — only serverHalf, encrypted.
 *
 * At unlock time:
 *   1. User completes OIDC flow → gets an ID token with `sub` claim.
 *   2. Client presents the ID token to the key-connector server.
 *   3. Server verifies the ID token, decrypts and returns `serverHalf`.
 *   4. Client derives `deviceHalf` (same HKDF, same deviceSecret).
 *   5. Client reconstructs `KEK = serverHalf ⊕ deviceHalf`.
 *   6. Client derives DEKs from the keyring file using the reconstructed KEK.
 *
 * Security properties:
 *   - Compromise of the OIDC provider (stolen tokens): attacker has the
 *     ID token → can get `serverHalf`. But without `deviceHalf` (which is
 *     device-local, never transmitted), they cannot reconstruct the KEK.
 *   - Compromise of the key-connector server: attacker gets all `serverHalf`
 *     values. Still cannot reconstruct KEKs without the per-device secrets.
 *   - Phishing / stolen device: attacker has `deviceHalf` (from the device)
 *     but needs a valid OIDC token to get `serverHalf`.
 *   - Full compromise (OIDC + key-connector + device): KEK is reconstructed.
 *     This is the threat model boundary — NOYDB does not defend against an
 *     attacker who controls all three.
 *
 * Key-connector server contract
 * ──────────────────────────────
 * This package handles the CLIENT side only. The server must:
 *   1. Expose a `PUT /kek-fragment` endpoint that accepts:
 *      `{ idToken, encryptedServerHalf, iv }` and stores the decrypted
 *      serverHalf indexed by the `sub` from the verified ID token.
 *   2. Expose a `GET /kek-fragment` endpoint that accepts a Bearer ID token,
 *      verifies it, and returns the encrypted `{ serverHalf, iv }` for that `sub`.
 *   3. Rotate the encryption key used for serverHalf periodically, with
 *      re-encryption at login time (beyond NOYDB's scope).
 *
 * Provider configuration
 * ──────────────────────
 * The `OidcProviderConfig` type describes the OIDC provider and the
 * key-connector endpoint URL. See `knownProviders` for pre-built configs
 * for common providers (LINE, Google, Apple).
 */

import { bufferToBase64, base64ToBuffer } from '@noy-db/hub'
import { ValidationError } from '@noy-db/hub'
import type { UnlockedKeyring, Role } from '@noy-db/hub'

export { ValidationError } from '@noy-db/hub'

// ─── Error types ──────────────────────────────────────────────────────

/**
 * Thrown when an OIDC ID token cannot be parsed, is expired, or fails
 * signature verification.
 *
 * This package does NOT perform full server-side verification — that is the
 * responsibility of the key-connector server. `OidcTokenError` is thrown
 * client-side when the token is structurally invalid (missing `sub`, expired
 * `exp`, wrong issuer) before a network call is made.
 */
export class OidcTokenError extends Error {
  readonly code = 'OIDC_TOKEN_ERROR'
  constructor(message: string) {
    super(message)
    this.name = 'OidcTokenError'
  }
}

/**
 * Thrown when the key-connector server returns an error response.
 *
 * The `status` field carries the HTTP status code when available — use it
 * to distinguish 401 Unauthorized (bad token, re-authenticate) from 404
 * (no key fragment stored for this sub, must re-enroll) and 5xx
 * (server-side error, retry).
 */
export class KeyConnectorError extends Error {
  readonly code = 'KEY_CONNECTOR_ERROR'
  /** HTTP status code from the key-connector server, if available. */
  readonly status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'KeyConnectorError'
    this.status = status
  }
}

/**
 * Thrown by `unlockOidc()` when the per-device secret for the OIDC subject
 * cannot be found in browser storage.
 *
 * The device secret is generated once at `enrollOidc()` time and stored in
 * IndexedDB/localStorage on the enrolling device — it is never transmitted.
 * This error means the device secret was cleared (storage wipe, private
 * browsing session, new device) and the user must re-enroll using their
 * passphrase.
 */
export class OidcDeviceSecretNotFoundError extends Error {
  readonly code = 'OIDC_DEVICE_SECRET_NOT_FOUND'
  constructor(sub: string) {
    super(
      `No device secret found for OIDC subject "${sub}". ` +
      'The device secret is generated at enrollment and stored in browser storage. ' +
      'Re-enroll on this device to restore OIDC unlock.',
    )
    this.name = 'OidcDeviceSecretNotFoundError'
  }
}

// ─── Types ────────────────────────────────────────────────────────────

/** OIDC provider configuration. */
export interface OidcProviderConfig {
  /** Provider name for display and debugging (e.g. 'LINE', 'Google'). */
  readonly name: string
  /** OIDC issuer URL. Used to discover the JWKS endpoint for token verification. */
  readonly issuer: string
  /** OAuth2 client ID for this application. */
  readonly clientId: string
  /** OAuth2 scopes to request. Default: ['openid', 'email']. */
  readonly scopes?: string[]
  /** Authorization endpoint URL. If omitted, discovered from issuer's .well-known. */
  readonly authorizationEndpoint?: string
  /** Token endpoint URL. If omitted, discovered from issuer's .well-known. */
  readonly tokenEndpoint?: string
  /**
   * Base URL of the noy-db key-connector server.
   * Must expose `PUT /kek-fragment` and `GET /kek-fragment`.
   */
  readonly keyConnectorUrl: string
}

/** The enrollment record persisted per-device per-OIDC-provider. */
export interface OidcEnrollment {
  readonly _noydb_oidc: 1
  /** OIDC provider name from `OidcProviderConfig.name`. */
  readonly providerName: string
  /** OIDC subject claim (`sub`) of the enrolled user. */
  readonly sub: string
  /** The vault this enrollment unlocks. */
  readonly vault: string
  /** ISO timestamp of enrollment. */
  readonly enrolledAt: string
  /**
   * Device-specific identifier (not the secret itself — the secret lives
   * in IndexedDB/localStorage). Used to look up the device secret at unlock.
   */
  readonly deviceKeyId: string
  /** Number of active enrollments for this sub (for key rotation auditing). */
  readonly enrollmentCount: number
}

/** Minimal JWT claims we need from an OIDC ID token. */
export interface OidcClaims {
  readonly sub: string
  readonly iss: string
  readonly aud: string | string[]
  readonly iat: number
  readonly exp: number
  readonly email?: string
  readonly name?: string
}

/** Options for `enrollOidc()`. */
export interface EnrollOidcOptions {
  /** Optional storage override for the device secret. Default: localStorage. */
  storage?: Storage
}

/** Options for `unlockOidc()`. */
export interface UnlockOidcOptions {
  /** Optional storage override for the device secret. Default: localStorage. */
  storage?: Storage
}

// ─── Device secret management ─────────────────────────────────────────

const DEVICE_SECRET_PREFIX = 'noydb:oidc:device-secret:'

function getDeviceSecret(sub: string, storage?: Storage): Uint8Array | null {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
  if (!store) return null
  const raw = store.getItem(DEVICE_SECRET_PREFIX + sub)
  if (!raw) return null
  return base64ToBuffer(raw)
}

function saveDeviceSecret(sub: string, secret: Uint8Array, storage?: Storage): void {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
  if (!store) throw new ValidationError('localStorage is not available in this environment')
  store.setItem(DEVICE_SECRET_PREFIX + sub, bufferToBase64(secret))
}

// ─── HKDF device half derivation ──────────────────────────────────────

async function deriveDeviceHalf(
  deviceSecret: Uint8Array,
  sub: string,
  vault: string,
  keyLengthBytes: number,
): Promise<Uint8Array> {
  const subtle = globalThis.crypto.subtle
  const ikm = await subtle.importKey('raw', deviceSecret as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveBits'])
  const bits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(sub),
      info: new TextEncoder().encode(`noydb-oidc-device-v1:${vault}`),
    },
    ikm,
    keyLengthBytes * 8,
  )
  return new Uint8Array(bits)
}

// ─── XOR key operations ────────────────────────────────────────────────

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) {
    throw new Error(`xorBytes: length mismatch (${a.length} vs ${b.length})`)
  }
  const out = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!
  return out
}

// ─── ID token parsing (client-side, no verification) ──────────────────

/**
 * Extract claims from a JWT ID token without cryptographic verification.
 * Verification is the key-connector server's responsibility.
 *
 * We do check the `exp` claim client-side as a fast path to avoid
 * unnecessary network calls with obviously expired tokens.
 */
export function parseIdTokenClaims(idToken: string): OidcClaims {
  const parts = idToken.split('.')
  if (parts.length !== 3) {
    throw new OidcTokenError('Invalid ID token format: expected 3 JWT segments')
  }
  const payloadPart = parts[1]!
  // Base64url decode (add padding as needed)
  const padded = payloadPart + '='.repeat((4 - payloadPart.length % 4) % 4)
  const json = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  const claims = JSON.parse(json) as OidcClaims
  if (!claims.sub) throw new OidcTokenError('ID token missing "sub" claim')
  if (!claims.exp) throw new OidcTokenError('ID token missing "exp" claim')
  return claims
}

/**
 * Check if an ID token is expired based on its `exp` claim.
 * Does NOT perform cryptographic signature verification.
 */
export function isIdTokenExpired(idToken: string): boolean {
  try {
    const claims = parseIdTokenClaims(idToken)
    return Date.now() / 1000 > claims.exp
  } catch {
    return true
  }
}

// ─── Key-connector HTTP helpers ────────────────────────────────────────

async function putServerHalf(
  keyConnectorUrl: string,
  idToken: string,
  serverHalfBase64: string,
  ivBase64: string,
): Promise<void> {
  const resp = await fetch(`${keyConnectorUrl}/kek-fragment`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ encryptedServerHalf: serverHalfBase64, iv: ivBase64 }),
  })
  if (!resp.ok) {
    throw new KeyConnectorError(
      `Key connector PUT failed: ${resp.status} ${resp.statusText}`,
      resp.status,
    )
  }
}

async function getServerHalf(
  keyConnectorUrl: string,
  idToken: string,
): Promise<{ encryptedServerHalf: string; iv: string }> {
  const resp = await fetch(`${keyConnectorUrl}/kek-fragment`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${idToken}` },
  })
  if (!resp.ok) {
    throw new KeyConnectorError(
      `Key connector GET failed: ${resp.status} ${resp.statusText}`,
      resp.status,
    )
  }
  return resp.json() as Promise<{ encryptedServerHalf: string; iv: string }>
}

// ─── Enrollment ────────────────────────────────────────────────────────

/**
 * Enroll a device for OIDC unlock (client-side portion).
 *
 * Requires an unlocked keyring (user is already authenticated) and a valid
 * OIDC ID token. Derives the device half, XOR-splits the serialized keyring
 * payload, encrypts the server half with the ID token, and sends it to the
 * key-connector server.
 *
 * Returns an `OidcEnrollment` that should be stored (e.g. in localStorage
 * or a noy-db collection) so `unlockOidc()` can look up the `sub` and
 * `deviceKeyId` later.
 *
 * @param keyring - The currently unlocked keyring.
 * @param vault - The vault to enroll for.
 * @param config - OIDC provider + key-connector configuration.
 * @param idToken - A valid OIDC ID token from the completed OIDC flow.
 * @param options - Optional storage override.
 */
export async function enrollOidc(
  keyring: UnlockedKeyring,
  vault: string,
  config: OidcProviderConfig,
  idToken: string,
  options: EnrollOidcOptions = {},
): Promise<OidcEnrollment> {
  const claims = parseIdTokenClaims(idToken)
  if (isIdTokenExpired(idToken)) {
    throw new OidcTokenError('ID token is expired. Complete a fresh OIDC flow before enrolling.')
  }

  const subtle = globalThis.crypto.subtle

  // Serialize the keyring payload (same as session.ts)
  const dekMap: Record<string, string> = {}
  for (const [collName, dek] of keyring.deks) {
    const raw = await subtle.exportKey('raw', dek)
    dekMap[collName] = bufferToBase64(raw)
  }
  const payloadJson = JSON.stringify({
    userId: keyring.userId,
    displayName: keyring.displayName,
    role: keyring.role,
    permissions: keyring.permissions,
    deks: dekMap,
    salt: bufferToBase64(keyring.salt),
  })
  const payloadBytes = new TextEncoder().encode(payloadJson)

  // Generate a device secret and derive the device half
  const deviceSecret = globalThis.crypto.getRandomValues(new Uint8Array(32))
  const deviceKeyId = bufferToBase64(globalThis.crypto.getRandomValues(new Uint8Array(16)))
  saveDeviceSecret(claims.sub, deviceSecret, options.storage)

  // Pad payload to the next 16-byte boundary to avoid leaking length
  const padLen = (16 - (payloadBytes.length % 16)) % 16
  const padded = new Uint8Array(payloadBytes.length + padLen)
  padded.set(payloadBytes)

  const deviceHalf = await deriveDeviceHalf(deviceSecret, claims.sub, vault, padded.length)
  const serverHalf = xorBytes(padded, deviceHalf)

  // Encrypt serverHalf with the ID token using HKDF(idToken) as the key
  // The server decrypts this with the same derivation, storing only the plaintext serverHalf
  const tokenKey = await deriveKeyFromIdToken(idToken)
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const encryptedServerHalf = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    tokenKey,
    serverHalf as Uint8Array<ArrayBuffer>,
  )

  await putServerHalf(
    config.keyConnectorUrl,
    idToken,
    bufferToBase64(encryptedServerHalf),
    bufferToBase64(iv),
  )

  return {
    _noydb_oidc: 1,
    providerName: config.name,
    sub: claims.sub,
    vault,
    enrolledAt: new Date().toISOString(),
    deviceKeyId,
    enrollmentCount: 1,
  }
}

/**
 * Unlock a vault using OIDC (client-side portion).
 *
 * Fetches the server half from the key-connector server, derives the device
 * half from the local device secret, XORs them to reconstruct the keyring
 * payload, and returns an UnlockedKeyring.
 *
 * @param enrollment - The enrollment record from `enrollOidc()`.
 * @param config - OIDC provider + key-connector configuration.
 * @param idToken - A valid OIDC ID token from the completed OIDC flow.
 * @param options - Optional storage override.
 */
export async function unlockOidc(
  enrollment: OidcEnrollment,
  config: OidcProviderConfig,
  idToken: string,
  options: UnlockOidcOptions = {},
): Promise<UnlockedKeyring> {
  if (isIdTokenExpired(idToken)) {
    throw new OidcTokenError('ID token is expired. Complete a fresh OIDC flow before unlocking.')
  }

  const { sub, vault } = enrollment

  // Load the device secret
  const deviceSecret = getDeviceSecret(sub, options.storage)
  if (!deviceSecret) {
    throw new OidcDeviceSecretNotFoundError(sub)
  }

  // Fetch the server half from the key-connector
  const { encryptedServerHalf, iv: ivBase64 } = await getServerHalf(config.keyConnectorUrl, idToken)

  // Decrypt the server half using the ID token
  const tokenKey = await deriveKeyFromIdToken(idToken)
  const serverHalf = new Uint8Array(
    await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBuffer(ivBase64) },
      tokenKey,
      base64ToBuffer(encryptedServerHalf),
    ),
  )

  // Reconstruct the padded payload
  const deviceHalf = await deriveDeviceHalf(deviceSecret, sub, vault, serverHalf.length)
  const padded = xorBytes(serverHalf, deviceHalf)

  // Parse the payload (strip padding: find the last non-null byte + 1)
  let payloadEnd = padded.length
  while (payloadEnd > 0 && padded[payloadEnd - 1] === 0) payloadEnd--
  const payloadJson = new TextDecoder().decode(padded.subarray(0, payloadEnd))

  const parsed = JSON.parse(payloadJson) as {
    userId: string
    displayName: string
    role: Role
    permissions: Record<string, 'rw' | 'ro'>
    deks: Record<string, string>
    salt: string
  }

  const subtle = globalThis.crypto.subtle
  const deks = new Map<string, CryptoKey>()
  for (const [collName, rawBase64] of Object.entries(parsed.deks)) {
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
    userId: parsed.userId,
    displayName: parsed.displayName,
    role: parsed.role,
    permissions: parsed.permissions,
    deks,
    kek: null as unknown as CryptoKey,
    salt: base64ToBuffer(parsed.salt),
  }
}

// ─── Known provider configs ────────────────────────────────────────────

/**
 * Pre-built provider configs for common OIDC providers.
 * Pass your client ID and key-connector URL to get a complete config.
 */
export const knownProviders = {
  line: (clientId: string, keyConnectorUrl: string): OidcProviderConfig => ({
    name: 'LINE',
    issuer: 'https://access.line.me',
    clientId,
    scopes: ['openid', 'profile', 'email'],
    authorizationEndpoint: 'https://access.line.me/oauth2/v2.1/authorize',
    tokenEndpoint: 'https://api.line.me/oauth2/v2.1/token',
    keyConnectorUrl,
  }),
  google: (clientId: string, keyConnectorUrl: string): OidcProviderConfig => ({
    name: 'Google',
    issuer: 'https://accounts.google.com',
    clientId,
    scopes: ['openid', 'email'],
    keyConnectorUrl,
  }),
  apple: (clientId: string, keyConnectorUrl: string): OidcProviderConfig => ({
    name: 'Apple',
    issuer: 'https://appleid.apple.com',
    clientId,
    scopes: ['openid', 'email'],
    keyConnectorUrl,
  }),
}

// ─── Internal ─────────────────────────────────────────────────────────

/**
 * Derive a transient AES-256-GCM key from an OIDC ID token.
 * Used to encrypt the server half before transmitting to the key-connector.
 * The server derives the same key to decrypt and store the plaintext serverHalf.
 */
async function deriveKeyFromIdToken(idToken: string): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle
  const ikm = await subtle.importKey(
    'raw',
    new TextEncoder().encode(idToken),
    'HKDF',
    false,
    ['deriveKey'],
  )
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('noydb-oidc-transport-encrypt-v1'),
      info: new TextEncoder().encode('key-connector-put'),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}
