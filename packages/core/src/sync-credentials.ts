/**
 * _sync_credentials reserved collection — v0.7 #110
 *
 * Stores per-adapter OAuth tokens (and any other long-lived sync secrets) as
 * encrypted records inside the compartment itself. Tokens are wrapped with the
 * compartment's own DEK, live on disk as ciphertext like any other record, and
 * are accessed only through the dedicated API in this module — never via
 * `compartment.collection('_sync_credentials')`.
 *
 * Design decisions
 * ────────────────
 *
 * **Why a reserved collection, not a separate store?**
 * The compartment's existing encryption stack (AES-256-GCM + collection DEK)
 * is exactly the right primitive for protecting OAuth tokens at rest. Using a
 * separate store would require a new encryption surface, new adapter calls,
 * and a new backup/restore path — all of which already exist for collections.
 *
 * **Why not exposed as a regular collection?**
 * The same reason `_keyring` and `_ledger` aren't: they have invariants that
 * must be enforced (naming scheme, no cross-user leakage, no schema
 * validation, no history/ledger writes for privacy). Routing through a
 * dedicated API enforces those invariants.
 *
 * **Token lifecycle:**
 * - `putCredential(compartment, adapterId, token)` — store or overwrite
 * - `getCredential(compartment, adapterId)` — load and decrypt
 * - `deleteCredential(compartment, adapterId)` — remove
 * - `listCredentials(compartment)` — enumerate adapter IDs (not tokens)
 *
 * The `adapterId` is the record ID within the `_sync_credentials` collection.
 * It should be a stable, human-readable identifier for the adapter instance
 * (e.g. `'google-drive'`, `'dropbox'`, `'s3-prod'`).
 *
 * **ACL:** only `owner` and `admin` roles can read/write sync credentials.
 * Operators, viewers, and clients cannot call this API. The check is made
 * against the caller's keyring role at call time.
 */

import type { NoydbAdapter, EncryptedEnvelope } from './types.js'
import { NOYDB_FORMAT_VERSION } from './types.js'
import type { UnlockedKeyring } from './keyring.js'
import { encrypt, decrypt } from './crypto.js'
import { ensureCollectionDEK } from './keyring.js'
import { PermissionDeniedError } from './errors.js'

/** The reserved collection name. Never collides with user collections. */
export const SYNC_CREDENTIALS_COLLECTION = '_sync_credentials'

// ─── Token types ──────────────────────────────────────────────────────

/**
 * An OAuth/auth token stored in `_sync_credentials`.
 *
 * Fields mirror the OAuth2 token response shape. `customData` is an escape
 * hatch for adapter-specific secrets (API keys, connection strings, etc.)
 * that don't fit the OAuth2 shape.
 */
export interface SyncCredential {
  /** Stable identifier for the adapter instance (e.g. 'google-drive'). */
  readonly adapterId: string
  /** OAuth token type, usually 'Bearer'. */
  readonly tokenType: string
  /** The access token. Expires at `expiresAt` if set. */
  readonly accessToken: string
  /** Long-lived refresh token for renewing the access token. */
  readonly refreshToken?: string
  /** ISO timestamp when `accessToken` expires. Absent means "no expiry". */
  readonly expiresAt?: string
  /** Space-separated OAuth scopes. */
  readonly scopes?: string
  /** Adapter-specific opaque data (API keys, endpoints, etc.). */
  readonly customData?: Record<string, string>
}

// ─── Access check ─────────────────────────────────────────────────────

function requireAdminAccess(keyring: UnlockedKeyring): void {
  if (keyring.role !== 'owner' && keyring.role !== 'admin') {
    throw new PermissionDeniedError(
      `Sync credentials require owner or admin role. Current role: "${keyring.role}"`,
    )
  }
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Store or overwrite a sync credential for the given adapter.
 *
 * The credential is encrypted with the `_sync_credentials` collection DEK
 * (auto-generated on first use). The record ID is the `adapterId`.
 *
 * Requires owner or admin role.
 */
export async function putCredential(
  adapter: NoydbAdapter,
  compartment: string,
  keyring: UnlockedKeyring,
  credential: SyncCredential,
): Promise<void> {
  requireAdminAccess(keyring)

  const getDek = await ensureCollectionDEK(adapter, compartment, keyring)
  const dek = await getDek(SYNC_CREDENTIALS_COLLECTION)

  const { iv, data } = await encrypt(JSON.stringify(credential), dek)

  const existing = await adapter.get(compartment, SYNC_CREDENTIALS_COLLECTION, credential.adapterId)
  const version = existing ? existing._v + 1 : 1

  const envelope: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: version,
    _ts: new Date().toISOString(),
    _iv: iv,
    _data: data,
    _by: keyring.userId,
  }

  await adapter.put(
    compartment,
    SYNC_CREDENTIALS_COLLECTION,
    credential.adapterId,
    envelope,
    existing ? existing._v : undefined,
  )
}

/**
 * Load and decrypt a sync credential for the given adapter ID.
 *
 * Returns `null` if no credential exists for this adapter.
 * Requires owner or admin role.
 */
export async function getCredential(
  adapter: NoydbAdapter,
  compartment: string,
  keyring: UnlockedKeyring,
  adapterId: string,
): Promise<SyncCredential | null> {
  requireAdminAccess(keyring)

  const getDek = await ensureCollectionDEK(adapter, compartment, keyring)
  const dek = await getDek(SYNC_CREDENTIALS_COLLECTION)

  const envelope = await adapter.get(compartment, SYNC_CREDENTIALS_COLLECTION, adapterId)
  if (!envelope) return null

  const plaintext = await decrypt(envelope._iv, envelope._data, dek)
  return JSON.parse(plaintext) as SyncCredential
}

/**
 * Delete a sync credential by adapter ID.
 *
 * No-op if the credential doesn't exist. Requires owner or admin role.
 */
export async function deleteCredential(
  adapter: NoydbAdapter,
  compartment: string,
  keyring: UnlockedKeyring,
  adapterId: string,
): Promise<void> {
  requireAdminAccess(keyring)
  await adapter.delete(compartment, SYNC_CREDENTIALS_COLLECTION, adapterId)
}

/**
 * List all adapter IDs that have stored credentials.
 *
 * Returns only the IDs, never the credential payloads. Useful for
 * displaying "connected adapters" in UI without decrypting tokens.
 * Requires owner or admin role.
 */
export async function listCredentials(
  adapter: NoydbAdapter,
  compartment: string,
  keyring: UnlockedKeyring,
): Promise<string[]> {
  requireAdminAccess(keyring)
  return adapter.list(compartment, SYNC_CREDENTIALS_COLLECTION)
}

/**
 * Check whether a credential exists and whether its access token has expired.
 *
 * Returns `{ exists: false }` if no credential is stored, or
 * `{ exists: true, expired: boolean }` based on the `expiresAt` field.
 * Requires owner or admin role.
 */
export async function credentialStatus(
  adapter: NoydbAdapter,
  compartment: string,
  keyring: UnlockedKeyring,
  adapterId: string,
): Promise<{ exists: false } | { exists: true; expired: boolean }> {
  const credential = await getCredential(adapter, compartment, keyring, adapterId)
  if (!credential) return { exists: false }

  const expired = credential.expiresAt
    ? Date.now() > new Date(credential.expiresAt).getTime()
    : false

  return { exists: true, expired }
}
