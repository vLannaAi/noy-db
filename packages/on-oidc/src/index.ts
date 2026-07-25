/**
 * @noy-db/on-oidc —
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
 *   1. The full key material is available — the caller holds an
 *      `UnlockedKeyring`. HOW it was unlocked does not matter: a
 *      passphrase-derived session works, and so does an invite-seeded one
 *      (the firm mints a magic-link invite via `@noy-db/on-magic-link`'s
 *      `issueInvite`; the recipient's `acceptInvite` yields the unlocked
 *      session — the portal client never has a passphrase of its own).
 *   2. `deviceHalf` is derived: HKDF(deviceSecret, "noydb-oidc-device-v1", sub)
 *      where `deviceSecret` is a per-device random value stored in IndexedDB
 *      or localStorage (never transmitted). A stable random `deviceId` is
 *      generated beside it and stored with it — it identifies THIS
 *      partition's entry on the key-connector.
 *   3. `serverHalf = KEK ⊕ deviceHalf`.
 *   4. `serverHalf` is encrypted with the OIDC access token and sent to the
 *      key-connector server endpoint. The server stores it indexed by
 *      `(sub, deviceId)` — one entry per enrolled device/partition.
 *   5. The server NEVER sees the KEK — only serverHalf, encrypted.
 *
 * At unlock time:
 *   1. User completes OIDC flow → gets an ID token with `sub` claim.
 *   2. Client presents the ID token (+ its `deviceId`) to the key-connector.
 *   3. Server verifies the ID token, decrypts and returns `serverHalf`.
 *   4. Client derives `deviceHalf` (same HKDF, same deviceSecret).
 *   5. Client reconstructs `KEK = serverHalf ⊕ deviceHalf`.
 *   6. Client derives DEKs from the keyring file using the reconstructed KEK.
 *
 * Token lifecycle (LIFF and friends)
 * ──────────────────────────────────
 * OIDC ID tokens are short-lived — LINE LIFF ID tokens expire after ~1 hour
 * and LIFF has NO silent refresh. Two rules keep that livable:
 *
 *   - Expiry is checked CLIENT-SIDE, BEFORE any network call: an expired
 *     token surfaces as the typed `OidcTokenError` from `enrollOidc`,
 *     `unlockOidc`, `listOidcDevices`, and `revokeOidcDevice`. Apps map it
 *     to a re-auth prompt (`liff.login()` on LINE).
 *   - **An unlocked session survives token expiry.** The ID token is needed
 *     exactly once — at serverHalf fetch (or PUT) time. The returned
 *     `UnlockedKeyring` holds DEKs only; nothing in this package retains or
 *     re-checks the token after unlock. Mid-session expiry never tears down
 *     the session — only the NEXT connector call needs a fresh token.
 *
 * Multi-device enrollment — firm re-invite ONLY
 * ─────────────────────────────────────────────
 * deviceHalf is partition-local by design (LINE in-app WebView, external
 * browser, and installed PWA all have isolated storage). A new partition or
 * device therefore ALWAYS needs the key material once — and the ONLY way to
 * deliver it is a fresh custodian (firm) invite: invite-seeded unlock →
 * `enrollOidcFromInvite` → new deviceSecret + deviceId + serverHalf entry.
 *
 * Device-to-device handoff (QR / one-time code minted by an enrolled
 * device) is deliberately NOT offered: a compromised client device could
 * mint handoffs and silently escalate one device compromise into persistent
 * multi-device access. Round-tripping through the firm makes every new
 * partition an audit point, a rate-limit point, and a revocation point —
 * client-device compromise cannot self-propagate. Enrollment REQUIRES an
 * `UnlockedKeyring`, which only the invite and passphrase paths produce;
 * an enrolled device holds DEKs but no primitive to mint one for a peer.
 * Expired/consumed/revoked invites fail in `@noy-db/on-magic-link`'s
 * `acceptInvite` (InviteExpiredError / InviteAlreadyAcceptedError /
 * InviteRevokedError) before this package is ever reached.
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
 * This package handles the CLIENT side only. Entries are keyed by
 * `(sub, deviceId)` — one serverHalf fragment per enrolled device. The
 * server must:
 *   1. Expose a `PUT /kek-fragment` endpoint (Bearer ID token) that accepts
 *      `{ encryptedServerHalf, iv, deviceId? }` and stores the decrypted
 *      serverHalf indexed by `(sub, deviceId)` where `sub` comes from the
 *      VERIFIED ID token (never from the body).
 *   2. Expose a `GET /kek-fragment?deviceId=<id>` endpoint (Bearer ID token)
 *      that verifies the token and returns the encrypted
 *      `{ encryptedServerHalf, iv }` for that `(sub, deviceId)`.
 *   3. Expose a `GET /kek-fragment/devices` endpoint (Bearer ID token) that
 *      returns `{ devices: [{ deviceId, createdAt? }] }` — every fragment
 *      entry for the token's `sub`. Feeds the firm-side device-management UI.
 *   4. Expose a `DELETE /kek-fragment?deviceId=<id>` endpoint (Bearer ID
 *      token) that removes ONE `(sub, deviceId)` entry — individual device
 *      revocation. Idempotent.
 *   5. Rotate the encryption key used for serverHalf periodically, with
 *      re-encryption at login time (beyond NOYDB's scope).
 *
 * Backward compatibility: a v1 server that IGNORES `deviceId` still works —
 * it degrades to a single entry per `sub` with last-write-wins semantics
 * (enrolling a second device clobbers the first device's fragment; only the
 * most recently enrolled partition can unlock). Clients built before the
 * per-device contract send no `deviceId`; servers should treat that as the
 * single-entry legacy key for the `sub`.
 *
 * Error taxonomy (client sees these as `KeyConnectorError.status`):
 *   - `401` — ID-token verification failed (expired server-side, bad
 *     signature, wrong `iss`/`aud`) → the app re-authenticates
 *     (`liff.login()` on LINE) and retries.
 *   - `404` — no fragment for this `(sub, deviceId)` → the device was
 *     revoked or never enrolled. Recovery is a fresh FIRM re-invite +
 *     `enrollOidcFromInvite`; there is no self-service or device-to-device
 *     recovery path by design.
 *   - `5xx` — server-side fault → retry with backoff; nothing is wrong with
 *     the enrollment.
 *
 * LINE-specific server verification (LIFF ID tokens):
 *   - Verify `iss === 'https://access.line.me'` and `alg === 'ES256'`.
 *   - Verify `aud` equals YOUR LINE Login channel ID (LIFF ID tokens are
 *     channel-scoped; `aud` is the numeric channel ID as a string).
 *   - Fetch keys from the JWKS endpoint
 *     `https://api.line.me/oauth2/v2.1/certs`, select by the token's `kid`,
 *     and CACHE the JWKS (respect HTTP cache headers; re-fetch on unknown
 *     `kid` to pick up rotation).
 *   - Allow a small clock skew (±60 s is customary) when checking
 *     `exp`/`iat` — LIFF tokens are minted on LINE's clock, not yours.
 *
 * Provider configuration
 * ──────────────────────
 * The `OidcProviderConfig` type describes the OIDC provider and the
 * key-connector endpoint URL. See `knownProviders` for pre-built configs
 * for common providers (LINE, Google, Apple).
 */

import { bufferToBase64, base64ToBuffer, generateULID } from '@noy-db/hub'
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
 * to distinguish 401 Unauthorized (token failed server-side verification —
 * re-authenticate, e.g. `liff.login()` on LINE, and retry) from 404 (no key
 * fragment stored for this `(sub, deviceId)` — the device was revoked or
 * never enrolled; recovery is a fresh firm re-invite + enrollment, see
 * `enrollOidcFromInvite`) and 5xx (server-side error, retry with backoff).
 *
 * A failed `fetch` itself (offline, DNS, CORS) rejects with the runtime's
 * own `TypeError` — enrollment and device management are online-only
 * ceremonies; callers should gate them on connectivity.
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
 * The device secret is generated once at enrollment time and stored in
 * IndexedDB/localStorage on the enrolling device — it is never transmitted.
 * This error means the device secret was cleared (storage wipe, private
 * browsing session, new device/partition) and this partition must be
 * enrolled afresh — via a new firm invite (`enrollOidcFromInvite`) or, where
 * the user holds one, a passphrase-unlocked `enrollOidc`. There is no
 * device-to-device recovery path by design.
 */
export class OidcDeviceSecretNotFoundError extends Error {
  readonly code = 'OIDC_DEVICE_SECRET_NOT_FOUND'
  constructor(sub: string) {
    super(
      `No device secret found for OIDC subject "${sub}". ` +
      'The device secret is generated at enrollment and stored in browser storage. ' +
      'Request a fresh enrollment invite from the vault custodian (firm re-invite) ' +
      'to enroll this device — enrolled devices cannot hand off credentials to it.',
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
   * JWKS endpoint URL for ID-token signature verification (performed by the
   * KEY-CONNECTOR SERVER, never client-side — this package's checks are
   * structural only). If omitted, discovered from the issuer's .well-known.
   * LINE publishes ES256 keys at `https://api.line.me/oauth2/v2.1/certs`.
   */
  readonly jwksUri?: string
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
  /**
   * Stable per-partition device id (ULID). Generated beside the device
   * secret at enrollment, stored with it, and sent with every key-connector
   * PUT/GET so the server can key fragments by `(sub, deviceId)`. Absent on
   * enrollment records created before the per-device contract — unlock then
   * falls back to the partition-stored device id, or omits `deviceId`
   * entirely (legacy single-entry server contract).
   */
  readonly deviceId?: string
}

/** One per-device serverHalf entry, as listed by `listOidcDevices()`. */
export interface OidcDeviceEntry {
  /** The `(sub, deviceId)` key's device component. */
  readonly deviceId: string
  /** ISO timestamp of the entry's creation, when the server records it. */
  readonly createdAt?: string
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
const DEVICE_ID_PREFIX = 'noydb:oidc:device-id:'

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

function getStoredDeviceId(sub: string, storage?: Storage): string | null {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
  if (!store) return null
  return store.getItem(DEVICE_ID_PREFIX + sub)
}

function saveDeviceId(sub: string, deviceId: string, storage?: Storage): void {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
  if (!store) throw new ValidationError('localStorage is not available in this environment')
  store.setItem(DEVICE_ID_PREFIX + sub, deviceId)
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
  deviceId?: string,
): Promise<void> {
  const resp = await fetch(`${keyConnectorUrl}/kek-fragment`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      encryptedServerHalf: serverHalfBase64,
      iv: ivBase64,
      ...(deviceId !== undefined && { deviceId }),
    }),
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
  deviceId?: string,
): Promise<{ encryptedServerHalf: string; iv: string }> {
  const query = deviceId !== undefined ? `?deviceId=${encodeURIComponent(deviceId)}` : ''
  const resp = await fetch(`${keyConnectorUrl}/kek-fragment${query}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${idToken}` },
  })
  if (!resp.ok) {
    if (resp.status === 404) {
      throw new KeyConnectorError(
        'Key connector GET failed: 404 — no key fragment stored for this subject/device. ' +
        'The device was revoked or was never enrolled. Request a fresh enrollment invite ' +
        'from the vault custodian (firm re-invite) and enroll this device again — ' +
        'enrolled devices cannot hand off or restore credentials for another device.',
        404,
      )
    }
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
 * Requires an unlocked keyring and a valid OIDC ID token. HOW the keyring
 * was unlocked is irrelevant — a passphrase session works, and so does an
 * invite-seeded one (`@noy-db/on-magic-link`'s `acceptInvite` on a firm
 * invite; the portal client never holds a passphrase). Only the keyring's
 * DEKs/salt/identity are read; `keyring.kek` may be `null`.
 *
 * Derives the device half, XOR-splits the serialized keyring payload,
 * encrypts the server half with the ID token, and sends it to the
 * key-connector server. A fresh `deviceSecret` AND a fresh `deviceId` are
 * generated for THIS partition — enrolling never reuses or transfers
 * another device's material.
 *
 * Returns an `OidcEnrollment` that should be stored (e.g. in localStorage
 * or a noy-db collection) so `unlockOidc()` can look up the `sub` and
 * `deviceId` later.
 *
 * @param keyring - The currently unlocked keyring (passphrase- or invite-sourced).
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

  // Generate a device secret + stable per-partition device id, derive the device half
  const deviceSecret = globalThis.crypto.getRandomValues(new Uint8Array(32))
  const deviceKeyId = bufferToBase64(globalThis.crypto.getRandomValues(new Uint8Array(16)))
  const deviceId = generateULID()
  saveDeviceSecret(claims.sub, deviceSecret, options.storage)
  saveDeviceId(claims.sub, deviceId, options.storage)

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
    deviceId,
  )

  return {
    _noydb_oidc: 1,
    providerName: config.name,
    sub: claims.sub,
    vault,
    enrolledAt: new Date().toISOString(),
    deviceKeyId,
    enrollmentCount: 1,
    deviceId,
  }
}

/**
 * Enroll THIS partition after an invite-seeded unlock — the second-device /
 * second-partition (re-invite) ceremony.
 *
 * The flow: the firm mints a fresh single-use invite bound to the SAME
 * keyring identity (`@noy-db/on-magic-link`'s `issueInvite` semantics —
 * rebind, don't re-grant; no new principal, same slots/roles/user-envelope),
 * the new partition accepts it (`acceptInvite` — expired / revoked /
 * already-consumed invites fail THERE with its typed errors before this
 * function is ever reached), and the resulting unlocked keyring is passed
 * here. A fresh `deviceSecret` + `deviceId` are generated for this
 * partition and a NEW `(sub, deviceId)` serverHalf entry is written —
 * existing device entries are untouched (enrolling a new partition never
 * auto-revokes old ones; revocation is a separate firm-side
 * `revokeOidcDevice` call).
 *
 * This is deliberately the ONLY way to add a device: enrollment requires an
 * `UnlockedKeyring`, which only the invite and passphrase paths produce.
 * An enrolled device cannot mint one for a peer — no device-to-device
 * handoff exists, so client-device compromise cannot self-propagate.
 *
 * Functionally identical to `enrollOidc` (which is keyring-source-agnostic);
 * exported under the ceremony's own name so call sites document intent.
 *
 * @param keyring - The invite-derived unlocked keyring from `acceptInvite`.
 * @param vault - The vault to enroll for.
 * @param config - OIDC provider + key-connector configuration.
 * @param idToken - A valid OIDC ID token from the completed OIDC flow.
 * @param options - Optional storage override.
 */
export async function enrollOidcFromInvite(
  keyring: UnlockedKeyring,
  vault: string,
  config: OidcProviderConfig,
  idToken: string,
  options: EnrollOidcOptions = {},
): Promise<OidcEnrollment> {
  return enrollOidc(keyring, vault, config, idToken, options)
}

/**
 * Unlock a vault using OIDC (client-side portion).
 *
 * Fetches the server half from the key-connector server (keyed by this
 * partition's `deviceId`), derives the device half from the local device
 * secret, XORs them to reconstruct the keyring payload, and returns an
 * UnlockedKeyring.
 *
 * Token lifecycle: the ID token is used exactly ONCE — for the serverHalf
 * fetch. An expired token fails fast with `OidcTokenError` BEFORE any
 * network call (map it to re-auth, e.g. `liff.login()`). The returned
 * session SURVIVES later token expiry: nothing retains or re-checks the
 * token after unlock, so a LIFF token expiring ~1h into the session never
 * tears the session down — only the next connector call needs a fresh one.
 *
 * A 404 from the connector means no fragment exists for this
 * `(sub, deviceId)` — the device was revoked or never enrolled. It surfaces
 * as `KeyConnectorError` (status 404) whose message points at the firm
 * re-invite flow (`enrollOidcFromInvite`); there is no self-service or
 * device-to-device recovery path.
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

  // Resolve this partition's device id: the enrollment record carries it;
  // fall back to the partition-local stored copy. Both absent = legacy
  // (pre-per-device) enrollment — the GET goes out without deviceId and a
  // legacy single-entry server still resolves it by `sub` alone.
  const deviceId = enrollment.deviceId ?? getStoredDeviceId(sub, options.storage) ?? undefined

  // Fetch the server half from the key-connector
  const { encryptedServerHalf, iv: ivBase64 } = await getServerHalf(
    config.keyConnectorUrl,
    idToken,
    deviceId,
  )

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
    kek: null,
    salt: base64ToBuffer(parsed.salt),
    authenticators: [],
  }
}

// ─── Device management ─────────────────────────────────────────────────

/**
 * List every per-device serverHalf entry the key-connector holds for the
 * ID token's `sub` (`GET /kek-fragment/devices`).
 *
 * Feeds the firm-side device-management UI: show the user's enrolled
 * partitions, then revoke stale ones individually via `revokeOidcDevice()`.
 *
 * @throws {OidcTokenError} when the ID token is expired (checked BEFORE any
 *         network call — re-authenticate first).
 * @throws {KeyConnectorError} on any non-2xx connector response (`status`
 *         carries the HTTP code: 401 re-auth, 5xx retry).
 */
export async function listOidcDevices(
  config: OidcProviderConfig,
  idToken: string,
): Promise<OidcDeviceEntry[]> {
  if (isIdTokenExpired(idToken)) {
    throw new OidcTokenError('ID token is expired. Complete a fresh OIDC flow before listing devices.')
  }
  const resp = await fetch(`${config.keyConnectorUrl}/kek-fragment/devices`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${idToken}` },
  })
  if (!resp.ok) {
    throw new KeyConnectorError(
      `Key connector device list failed: ${resp.status} ${resp.statusText}`,
      resp.status,
    )
  }
  const body = await resp.json() as { devices?: OidcDeviceEntry[] }
  return body.devices ?? []
}

/**
 * Revoke ONE per-device serverHalf entry for the ID token's `sub`
 * (`DELETE /kek-fragment?deviceId=<id>`).
 *
 * After revocation, that partition's next `unlockOidc()` gets a 404 —
 * mapped to a `KeyConnectorError` whose message directs the user to the
 * firm re-invite flow. Other devices' entries are untouched: revocation is
 * per-device, never account-wide.
 *
 * @throws {OidcTokenError} when the ID token is expired (checked BEFORE any
 *         network call — re-authenticate first).
 * @throws {KeyConnectorError} on any non-2xx connector response.
 */
export async function revokeOidcDevice(
  config: OidcProviderConfig,
  idToken: string,
  deviceId: string,
): Promise<void> {
  if (isIdTokenExpired(idToken)) {
    throw new OidcTokenError('ID token is expired. Complete a fresh OIDC flow before revoking a device.')
  }
  const resp = await fetch(
    `${config.keyConnectorUrl}/kek-fragment?deviceId=${encodeURIComponent(deviceId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${idToken}` },
    },
  )
  if (!resp.ok) {
    throw new KeyConnectorError(
      `Key connector device revoke failed: ${resp.status} ${resp.statusText}`,
      resp.status,
    )
  }
}

// ─── Known provider configs ────────────────────────────────────────────

/**
 * Pre-built provider configs for common OIDC providers.
 * Pass your client ID and key-connector URL to get a complete config.
 */
export const knownProviders = {
  /**
   * LINE Login / LIFF.
   *
   * `clientId` is the LINE Login CHANNEL ID (numeric, as a string) — LIFF
   * ID tokens are channel-scoped and carry it as their `aud` claim. Tokens
   * are ES256-signed (`iss: 'https://access.line.me'`); the key-connector
   * server verifies signatures against the JWKS at
   * `https://api.line.me/oauth2/v2.1/certs` (see the contract block above
   * for cache/skew guidance). LIFF ID tokens expire after ~1 hour with no
   * silent refresh — expired tokens surface client-side as `OidcTokenError`
   * before any network call; map that to `liff.login()`.
   */
  line: (clientId: string, keyConnectorUrl: string): OidcProviderConfig => ({
    name: 'LINE',
    issuer: 'https://access.line.me',
    clientId,
    scopes: ['openid', 'profile', 'email'],
    authorizationEndpoint: 'https://access.line.me/oauth2/v2.1/authorize',
    tokenEndpoint: 'https://api.line.me/oauth2/v2.1/token',
    jwksUri: 'https://api.line.me/oauth2/v2.1/certs',
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
