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

import {
  generateULID,
  deriveMagicLinkContentKey,
  readMagicLinkGrantRecord,
  listMagicLinkGrants,
  unwrapMagicLinkGrant,
  revokeMagicLinkGrant,
  magicLinkGrantRecordId,
  isMagicLinkGrantExpired,
  MAGIC_LINK_GRANTS_COLLECTION,
} from '@noy-db/hub'
import type {
  Role,
  UnlockedKeyring,
  Vault,
  NoydbStore,
  MagicLinkGrantPayload,
  IssueMagicLinkGrantOptions,
} from '@noy-db/hub'

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

// ─── Delegation bridge ─────────────────────────────────────

/**
 * Single grant within a batch magic-link issue. The grantor specifies
 * the tier + scope; the package handles the wrapping. `record` is
 * optional and narrows the grant to a single record id in the
 * collection (leave undefined for a whole-collection grant).
 */
export interface MagicLinkGrantSpec {
  readonly toUser: string
  readonly tier: number
  readonly collection?: string
  readonly record?: string
  readonly until: Date | string
  readonly note?: string
}

export interface IssueMagicLinkDelegationOptions {
  /**
   * Server-held secret that gates access to the grant. Same value must
   * be supplied at claim time — the server is the only party that
   * knows it, so a leaked URL alone cannot unlock anything.
   */
  readonly serverSecret: string | Uint8Array<ArrayBuffer>
  /**
   * One or more grants to persist under the same magic-link token.
   * Single-element arrays cover the common "one collection to one
   * user" case; multi-element arrays support scoped cross-collection
   * delegations (e.g. client portal: invoices + payments + etax).
   */
  readonly grants: readonly MagicLinkGrantSpec[]
  /**
   * Magic-link TTL. Controls `link.expiresAt` (the URL freshness).
   * Each grant's own `until` bounds the *delegation* lifetime — the
   * claimant only receives DEKs for grants whose `until` is still
   * future at claim time. Default 24 h.
   */
  readonly ttlMs?: number
  /**
   * Optional override for the ULID embedded in the URL. Rarely useful
   * outside deterministic tests.
   */
  readonly token?: string
}

export interface IssueMagicLinkDelegationResult {
  /** URL-embeddable token metadata. Serialize `link.token` into the link. */
  readonly link: MagicLinkToken
  /** One record per grant — mirrors the input array order. */
  readonly grants: ReadonlyArray<{
    readonly recordId: string
    readonly payload: MagicLinkGrantPayload
  }>
}

/**
 * Issue a magic-link-bound delegation.
 *
 * Server-side workflow:
 *
 * ```ts
 * import { issueMagicLinkDelegation } from '@noy-db/on-magic-link'
 *
 * const { link, grants } = await issueMagicLinkDelegation(vault, {
 *   serverSecret: process.env.MAGIC_LINK_SECRET!,
 *   grants: [
 *     { toUser: 'auditor-bob', tier: 1, collection: 'invoices',
 *       until: new Date(Date.now() + 48*3600e3) },
 *   ],
 *   ttlMs: 48 * 3600 * 1000,
 * })
 *
 * // Embed link.token in an email URL. The grantee clicks → loads your
 * // client → calls claimMagicLinkDelegation() with the same serverSecret.
 * ```
 */
export async function issueMagicLinkDelegation(
  vault: Vault,
  options: IssueMagicLinkDelegationOptions,
): Promise<IssueMagicLinkDelegationResult> {
  if (options.grants.length === 0) {
    throw new Error('@noy-db/on-magic-link: grants[] must be non-empty')
  }
  const token = options.token ?? generateULID()
  const ttlMs = options.ttlMs ?? MAGIC_LINK_DEFAULT_TTL_MS
  const link: MagicLinkToken = {
    token,
    vault: vault.name,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    role: 'viewer',
  }
  const contentKey = await deriveMagicLinkContentKey(options.serverSecret, token, vault.name)
  const grantKek = await deriveMagicLinkKEK(options.serverSecret, token, vault.name)

  const grants: Array<{ recordId: string; payload: MagicLinkGrantPayload }> = []
  for (let i = 0; i < options.grants.length; i += 1) {
    const spec = options.grants[i]!
    const recordId = magicLinkGrantRecordId(token, i)
    const issueOpts: IssueMagicLinkGrantOptions = {
      toUser: spec.toUser,
      tier: spec.tier,
      ...(spec.collection !== undefined && { collection: spec.collection }),
      ...(spec.record !== undefined && { record: spec.record }),
      until: spec.until,
      ...(spec.note !== undefined && { note: spec.note }),
    }
    const record = await vault.writeMagicLinkGrant(contentKey, grantKek, recordId, issueOpts)
    grants.push({ recordId: record.recordId, payload: record.payload })
  }
  return { link, grants }
}

export interface ClaimMagicLinkDelegationOptions {
  readonly store: NoydbStore
  readonly vault: string
  readonly serverSecret: string | Uint8Array<ArrayBuffer>
  readonly token: string
  /**
   * Reference clock used to evaluate grant expiry. Production callers
   * leave this `undefined`; tests pass a fixed date.
   */
  readonly now?: Date
}

export interface ClaimedMagicLinkGrant {
  readonly payload: MagicLinkGrantPayload
  /** Tier DEK, ready to insert into a keyring map. */
  readonly dek: CryptoKey
  /** True when the grant's `until` has already passed. */
  readonly expired: boolean
}

export interface ClaimMagicLinkDelegationResult {
  /**
   * False when the server secret is wrong, the vault is wrong, or
   * every grant is malformed. A `true` with an empty `grants` array
   * means the record was deleted (revoked) between issue and claim.
   */
  readonly valid: boolean
  readonly grants: readonly ClaimedMagicLinkGrant[]
}

/**
 * Client-side flow. Derives the same content key + KEK as the grantor,
 * loads every grant persisted under the token (primary + batch
 * entries), and returns the unwrapped tier DEKs.
 *
 * The caller decides what to do with them — typically inserting them
 * into a freshly-built `UnlockedKeyring` (see `buildMagicLinkKeyring`)
 * and opening a viewer session.
 */
export async function claimMagicLinkDelegation(
  options: ClaimMagicLinkDelegationOptions,
): Promise<ClaimMagicLinkDelegationResult> {
  const { store, vault, token, serverSecret } = options
  const contentKey = await deriveMagicLinkContentKey(serverSecret, token, vault)
  const grantKek = await deriveMagicLinkKEK(serverSecret, token, vault)

  const payloads = await listMagicLinkGrants(store, vault, contentKey, token)
  if (payloads.length === 0) {
    // Could be wrong secret / wrong vault / revoked — all indistinguishable.
    return { valid: false, grants: [] }
  }
  const now = options.now ?? new Date()
  const claimed: ClaimedMagicLinkGrant[] = []
  for (const payload of payloads) {
    let dek: CryptoKey
    try {
      dek = await unwrapMagicLinkGrant(payload, grantKek)
    } catch {
      // Malformed wrappedDek — skip this record but keep the others.
      continue
    }
    claimed.push({
      payload,
      dek,
      expired: isMagicLinkGrantExpired(payload, now),
    })
  }
  return { valid: true, grants: claimed }
}

/**
 * Read (without unwrapping) the grants under a token — useful for an
 * audit UI that shows the grantor what's still live on a link.
 */
export async function inspectMagicLinkDelegation(options: {
  readonly store: NoydbStore
  readonly vault: string
  readonly serverSecret: string | Uint8Array<ArrayBuffer>
  readonly token: string
}): Promise<readonly MagicLinkGrantPayload[]> {
  const contentKey = await deriveMagicLinkContentKey(
    options.serverSecret,
    options.token,
    options.vault,
  )
  return listMagicLinkGrants(options.store, options.vault, contentKey, options.token)
}

/**
 * Delete every grant under a token. Idempotent — safe to call on an
 * already-revoked or never-existed token. Returns the number of
 * records removed.
 */
export async function revokeMagicLinkDelegation(options: {
  readonly store: NoydbStore
  readonly vault: string
  readonly token: string
}): Promise<number> {
  return revokeMagicLinkGrant(options.store, options.vault, options.token)
}

/**
 * Read a single grant by its full record id. Convenience for callers
 * that persisted `recordId` during issue and want to resolve just one.
 */
export async function readMagicLinkGrant(options: {
  readonly store: NoydbStore
  readonly vault: string
  readonly serverSecret: string | Uint8Array<ArrayBuffer>
  readonly token: string
  readonly recordId: string
}): Promise<MagicLinkGrantPayload | null> {
  const contentKey = await deriveMagicLinkContentKey(
    options.serverSecret,
    options.token,
    options.vault,
  )
  return readMagicLinkGrantRecord(options.store, options.vault, contentKey, options.recordId)
}

// Re-exports so callers don't need a separate @noy-db/hub import for
// these helpers.
export { MAGIC_LINK_GRANTS_COLLECTION, deriveMagicLinkContentKey }
export type { MagicLinkGrantPayload }
