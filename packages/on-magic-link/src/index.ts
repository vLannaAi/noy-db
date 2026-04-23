/**
 * **@noy-db/on-magic-link** — one-time-link viewer unlock for noy-db.
 *
 * A magic link is a single-use URL that opens a vault in a read-only,
 * viewer-scoped session WITHOUT entering a passphrase. The link
 * expires after use or after a configurable TTL; the resulting
 * session is strictly limited to the `viewer` role.
 *
 * Part of the `@noy-db/on-*` authentication family. Sibling packages:
 * `@noy-db/on-oidc` (federated login), `@noy-db/on-webauthn` (passkey
 * / biometric). All follow the same shape: enrol once, produce a
 * short-lived token, unwrap a viewer keyring at unlock.
 *
 * ## Security model
 *
 * The viewer KEK is derived via:
 *
 * ```
 * HKDF-SHA256(
 *   ikm   = serverSecret,
 *   salt  = sha256(token),
 *   info  = "noydb-magic-link-v1:" + vaultId,
 * )
 * ```
 *
 * - `serverSecret` is a server-held secret that the SERVER knows but
 *   is NOT embedded in the link. If the link is intercepted, the
 *   attacker cannot derive the KEK without the server secret.
 * - `token` is a ULID embedded in the URL. It is single-use at the
 *   application layer (the server marks it consumed after first use).
 * - `vaultId` binds the derived key to a specific vault — a token for
 *   vault A cannot be used to unlock vault B.
 *
 * The resulting keyring is ALWAYS viewer-scoped (`role: 'viewer'`).
 * The DEKs available to the viewer are only the collections in the
 * viewer-specific subset, determined by the admin who created the link.
 *
 * ## What this package is NOT
 *
 * This module provides the CRYPTO layer only — it does not:
 *   - Issue HTTP tokens or send emails (that's the application layer)
 *   - Mark tokens as consumed (that's the server's responsibility)
 *   - Store viewer keyrings in the adapter (callers do this via `grant()`)
 *
 * ## Usage
 *
 * ```ts
 * import {
 *   createMagicLinkToken,
 *   deriveMagicLinkKEK,
 *   isMagicLinkValid,
 *   buildMagicLinkKeyring,
 * } from '@noy-db/on-magic-link'
 *
 * // SERVER — mint a token + grant the viewer keyring
 * const token = createMagicLinkToken('company-a', { ttlMs: 24 * 60 * 60 * 1000 })
 * const kek = await deriveMagicLinkKEK(serverSecret, token.token, 'company-a')
 * // ... use kek + db.grant(...) to create a viewer keyring entry ...
 *
 * // Email the link, e.g. https://app.example.com/view?t=<token.token>
 *
 * // CLIENT — derive the same KEK and unlock
 * if (!isMagicLinkValid(token)) throw new Error('expired')
 * const sameKek = await deriveMagicLinkKEK(serverSecret, token.token, token.vault)
 * const keyring = buildMagicLinkKeyring({ ... })
 * ```
 *
 * @packageDocumentation
 */

import { generateULID } from '@noy-db/hub'
import type { Role, UnlockedKeyring } from '@noy-db/hub'

// HKDF info string — version-namespaced so future schemes are distinguishable.
const MAGIC_LINK_INFO_PREFIX = 'noydb-magic-link-v1:'

/** Default magic-link TTL: 24 hours. */
export const MAGIC_LINK_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * The serializable metadata describing a magic link.
 * Embed `token` in the link URL as a query parameter or path segment.
 */
export interface MagicLinkToken {
  /** Unique one-time token (ULID). Embed this in the URL. */
  readonly token: string
  /** The vault this link unlocks (viewer-only). */
  readonly vault: string
  /** ISO timestamp after which the link is invalid. */
  readonly expiresAt: string
  /** Role of the resulting session. Always `'viewer'` for magic links. */
  readonly role: 'viewer'
}

/** Options for `createMagicLinkToken()`. */
export interface CreateMagicLinkOptions {
  /** Link lifetime in milliseconds. Default: 24 hours. */
  ttlMs?: number
}

// ─── KEK derivation ─────────────────────────────────────────────────────

/**
 * Derive a viewer KEK from the server secret and the magic-link token.
 *
 * Both the server (at grant time) and the client (at unlock time) call
 * this with the same inputs to get the same key. The key is used to:
 *   - Server: derive the KEK, call `db.grant()` to create a viewer keyring.
 *   - Client: derive the KEK, call `db.openVault()` / `loadKeyring()` with
 *     this KEK directly (bypassing PBKDF2) to unlock the viewer session.
 *
 * @param serverSecret - Server-held secret (never sent to the client).
 * @param token - The ULID from the magic-link URL.
 * @param vault - The vault ID this link is for.
 */
export async function deriveMagicLinkKEK(
  serverSecret: string | Uint8Array<ArrayBuffer>,
  token: string,
  vault: string,
): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle

  // IKM: the server secret
  const ikmBytes =
    serverSecret instanceof Uint8Array
      ? serverSecret
      : new TextEncoder().encode(serverSecret)

  // Salt: SHA-256(token). Hashing the token prevents the salt from being
  // trivially guessable if the token format is known (ULID has predictable
  // structure — hashing removes that structure from the HKDF salt).
  const tokenBytes = new TextEncoder().encode(token)
  const saltBuffer = await subtle.digest('SHA-256', tokenBytes)

  // Info: "noydb-magic-link-v1:" + vaultId — binds the key to a specific
  // vault so a token for vault A cannot unlock vault B.
  const info = new TextEncoder().encode(MAGIC_LINK_INFO_PREFIX + vault)

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

// ─── Link creation (server-side) ────────────────────────────────────────

/**
 * Generate a magic-link token (server-side).
 *
 * Returns a `MagicLinkToken` whose `token` field should be embedded in
 * the URL sent to the viewer. The server must store the token metadata
 * (or reconstruct it from the URL) so it can:
 *   1. Validate that the token has not expired or been used.
 *   2. Call `deriveMagicLinkKEK()` to create the viewer keyring.
 *
 * @param vault - The vault to grant viewer access to.
 * @param options - Optional TTL configuration.
 */
export function createMagicLinkToken(
  vault: string,
  options: CreateMagicLinkOptions = {},
): MagicLinkToken {
  const ttlMs = options.ttlMs ?? MAGIC_LINK_DEFAULT_TTL_MS
  return {
    token: generateULID(),
    vault,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    role: 'viewer',
  }
}

/**
 * Validate that a magic-link token is not expired.
 * Returns `true` if valid, `false` if expired.
 *
 * Single-use enforcement (marking a token as consumed after first use)
 * is the server's responsibility — this function only checks `expiresAt`.
 */
export function isMagicLinkValid(linkToken: MagicLinkToken): boolean {
  return Date.now() <= new Date(linkToken.expiresAt).getTime()
}

/**
 * Build a stub `UnlockedKeyring` from the magic-link-derived KEK and
 * the viewer's DEK set.
 *
 * This is a thin wrapper for callers that have already:
 *   1. Called `deriveMagicLinkKEK()` to get the viewer KEK.
 *   2. Loaded the viewer's keyring from the adapter (which holds the DEKs
 *      wrapped with the magic-link KEK).
 *   3. Unwrapped the DEKs.
 *
 * The resulting keyring is always viewer-scoped. Callers who want to turn
 * it into a session token should call `createSession()` from
 * `@noy-db/hub/session`.
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
