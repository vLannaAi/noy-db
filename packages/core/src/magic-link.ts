/**
 * Magic-link unlock — v0.7 #113
 *
 * A magic link is a one-time URL that lets a recipient (a "client portal
 * viewer") open a compartment in a read-only, viewer-scoped session WITHOUT
 * entering a passphrase. The link expires after use or after the TTL, and
 * the resulting session is strictly limited to the viewer role.
 *
 * Security model
 * ──────────────
 * The viewer KEK is derived via:
 *
 *   HKDF-SHA256(
 *     ikm   = serverSecret,
 *     salt  = sha256(token),
 *     info  = "noydb-magic-link-v1:" + compartmentId,
 *   )
 *
 * Where:
 *   - `serverSecret` is a server-held secret that the SERVER knows but is
 *     NOT embedded in the link. If the link is intercepted, the attacker
 *     cannot derive the KEK without the server secret.
 *   - `token` is a ULID embedded in the URL. It is single-use at the
 *     application layer (the server marks it consumed after first use).
 *   - `compartmentId` binds the derived key to a specific compartment —
 *     a token for compartment A cannot be used to unlock compartment B.
 *
 * The resulting keyring is ALWAYS viewer-scoped (role: 'viewer'). The
 * DEKs available to the viewer are only the collections in the
 * `viewerCollections` list — a subset of the compartment's collections,
 * determined by the admin who created the link. This matches the 'viewer'
 * role in the ACL which has `*: ro` permission.
 *
 * Implementation note
 * ───────────────────
 * This module provides the CRYPTO layer only — it does not:
 *   - Issue HTTP tokens or send emails (that's the application layer)
 *   - Mark tokens as consumed (that's the server's responsibility)
 *   - Store viewer keyrings in the adapter (callers do this via `grant()`)
 *
 * The pattern at the application layer:
 *   1. Server calls `createMagicLink()` with the server secret + compartmentId.
 *   2. Server emails the link (containing `token`) to the viewer.
 *   3. Viewer clicks the link → browser sends token to server endpoint.
 *   4. Server calls `deriveMagicLinkKEK()` with the same serverSecret + token
 *      + compartmentId → gets back the viewer KEK.
 *   5. Server calls `grant(compartment, viewerOptions)` using the derived KEK,
 *      creating a viewer keyring in the adapter.
 *   6. Viewer client calls `resolveMagicLink()` with the token → gets a
 *      short-lived UnlockedKeyring that can hydrate a session token.
 *
 * In practice, the server and client often both call `deriveMagicLinkKEK()`;
 * the key is the same on both sides because HKDF is deterministic.
 */

import { generateULID } from './bundle/ulid.js'
import type { Role } from './types.js'
import type { UnlockedKeyring } from './keyring.js'

// HKDF info string — version-namespaced so future schemes are distinguishable
const MAGIC_LINK_INFO_PREFIX = 'noydb-magic-link-v1:'

// Default link TTL: 24 hours
export const MAGIC_LINK_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

// ─── Types ────────────────────────────────────────────────────────────

/**
 * The serializable metadata describing a magic link.
 * Embed this in the link URL as a query parameter or path segment.
 */
export interface MagicLinkToken {
  /** Unique one-time token (ULID). Embed this in the URL. */
  readonly token: string
  /** The compartment this link unlocks (viewer-only). */
  readonly compartment: string
  /** ISO timestamp after which the link is invalid. */
  readonly expiresAt: string
  /** Role of the resulting session. Always 'viewer' for magic links. */
  readonly role: 'viewer'
}

/** Options for `createMagicLink()`. */
export interface CreateMagicLinkOptions {
  /**
   * Link lifetime in milliseconds. Default: 24 hours.
   */
  ttlMs?: number
}

// ─── KEK derivation ────────────────────────────────────────────────────

/**
 * Derive a viewer KEK from the server secret and the magic link token.
 *
 * Both the server (at grant time) and the client (at unlock time) call this
 * with the same inputs to get the same key. The key is used to:
 *   - Server: derive the KEK, call `grant()` to create a viewer keyring.
 *   - Client: derive the KEK, call `loadKeyring()` with this KEK directly
 *     (bypassing PBKDF2) to unlock the viewer session.
 *
 * @param serverSecret - Server-held secret (never sent to the client).
 * @param token - The ULID from the magic link URL.
 * @param compartment - The compartment ID this link is for.
 */
export async function deriveMagicLinkKEK(
  serverSecret: string | Uint8Array<ArrayBuffer>,
  token: string,
  compartment: string,
): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle

  // IKM: the server secret
  const ikmBytes =
    serverSecret instanceof Uint8Array
      ? serverSecret
      : new TextEncoder().encode(serverSecret)

  // Salt: SHA-256(token) — hashing the token prevents the salt from being
  // trivially guessable if the token format is known (ULID is predictable
  // in its structure; hashing removes that structure from the HKDF salt)
  const tokenBytes = new TextEncoder().encode(token)
  const saltBuffer = await subtle.digest('SHA-256', tokenBytes)

  // Info: "noydb-magic-link-v1:" + compartmentId
  const info = new TextEncoder().encode(MAGIC_LINK_INFO_PREFIX + compartment)

  const ikm = await subtle.importKey('raw', ikmBytes, 'HKDF', false, ['deriveKey'])

  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltBuffer,
      info,
    },
    ikm,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}

// ─── Link creation (server-side) ───────────────────────────────────────

/**
 * Generate a magic link token (server-side).
 *
 * Returns a `MagicLinkToken` whose `token` field should be embedded in the
 * URL sent to the viewer. The server must store the token metadata (or
 * reconstruct it from the URL) so it can:
 *   1. Validate that the token has not expired or been used.
 *   2. Call `deriveMagicLinkKEK()` to create the viewer keyring.
 *
 * @param compartment - The compartment to grant viewer access to.
 * @param options - Optional TTL configuration.
 */
export function createMagicLinkToken(
  compartment: string,
  options: CreateMagicLinkOptions = {},
): MagicLinkToken {
  const ttlMs = options.ttlMs ?? MAGIC_LINK_DEFAULT_TTL_MS
  return {
    token: generateULID(),
    compartment,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    role: 'viewer',
  }
}

/**
 * Validate that a magic link token is not expired.
 * Returns `true` if valid, `false` if expired.
 */
export function isMagicLinkValid(linkToken: MagicLinkToken): boolean {
  return Date.now() <= new Date(linkToken.expiresAt).getTime()
}

/**
 * Build a stub UnlockedKeyring from the magic-link-derived KEK and the
 * viewer's DEK set.
 *
 * This is a thin wrapper for callers that have already:
 *   1. Called `deriveMagicLinkKEK()` to get the viewer KEK.
 *   2. Loaded the viewer's keyring from the adapter (which holds the DEKs
 *      wrapped with the magic-link KEK).
 *   3. Unwrapped the DEKs.
 *
 * The resulting keyring is always viewer-scoped. Callers who want to turn
 * it into a session token should call `createSession()` from `@noy-db/core`.
 *
 * @param viewerUserId - The user ID the viewer keyring was granted for.
 * @param deks - The unwrapped DEKs (viewer-scoped subset of the compartment).
 * @param kek - The magic-link KEK (AES-KW, non-extractable).
 * @param salt - The salt embedded in the viewer's keyring file.
 */
export function buildMagicLinkKeyring(opts: {
  viewerUserId: string
  displayName: string
  deks: Map<string, CryptoKey>
  kek: CryptoKey
  salt: Uint8Array
}): UnlockedKeyring {
  return {
    userId: opts.viewerUserId,
    displayName: opts.displayName,
    role: 'viewer' as Role,
    permissions: {},
    deks: opts.deks,
    kek: opts.kek,
    salt: opts.salt,
  }
}
