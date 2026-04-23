/**
 * Magic-link-bound cross-user delegation grants (v0.21 #257).
 *
 * This module is the **core storage + encryption layer** that lets a
 * grantor issue a tier-DEK to a user whose KEK they do not know. The
 * trust bridge is provided by the `@noy-db/on-magic-link` package:
 *
 *   1. Grantor picks a grantee identity (user id + email handle).
 *   2. Grantor mints a magic-link token (ULID) via `createMagicLinkToken`.
 *   3. Grantor derives a **content key** + a **KEK** from
 *      `(serverSecret, token, vault)` using HKDF-SHA256 with separate
 *      `info` tags — both callers (grantor and grantee) can derive the
 *      same keys given the same inputs.
 *   4. Grantor persists a record in `_magic_link_grants/<token>`:
 *        - envelope `_data` is AES-GCM encrypted under the content key
 *        - the inner `wrappedDek` is AES-KW wrapped under the KEK
 *   5. Grantee receives the URL, derives the same content key + KEK,
 *      loads the grant, decrypts the envelope, unwraps the tier DEK.
 *
 * ## Why a separate collection from `_delegations`
 *
 * `_delegations` envelopes are encrypted under a DEK shared across
 * every vault user (audit-visibility). External auditors / client
 * portal users have NO pre-existing keyring, so they cannot read that
 * DEK. Magic-link grants live in their own collection whose envelope
 * encryption is derived purely from the magic-link URL + server secret
 * — nothing else is required to decrypt.
 *
 * ## Batch grants
 *
 * One magic-link token may point to MULTIPLE grants (e.g. the client
 * portal case: invoices + payments + etax all share one link). Each
 * grant is persisted under a distinct record id:
 *
 *   `<token>` for the single-grant / primary entry
 *   `<token>:<index>` for subsequent entries
 *
 * `listMagicLinkGrants(store, vault, token)` enumerates every record
 * whose id begins with `<token>` so the claimant can materialize all
 * DEKs in one pass.
 *
 * ## Revocation
 *
 * `store.delete(vault, _magic_link_grants, <token>)` immediately
 * invalidates the link — even if the URL was captured and the server
 * secret leaked, no payload remains to decrypt.
 *
 * @module
 */

import type { NoydbStore, EncryptedEnvelope } from '../types.js'
import type { UnlockedKeyring } from './keyring.js'
import { encrypt, decrypt, wrapKey, unwrapKey } from '../crypto.js'
import { dekKey } from './tiers.js'
import { DelegationTargetMissingError } from '../errors.js'

/** Reserved collection holding magic-link grant envelopes. */
export const MAGIC_LINK_GRANTS_COLLECTION = '_magic_link_grants'

/** HKDF `info` for the AES-GCM content key. Version-namespaced. */
export const MAGIC_LINK_CONTENT_INFO_PREFIX = 'noydb-magic-link-content-v1:'

/** HKDF `info` for the AES-KW KEK. Matches `@noy-db/on-magic-link`. */
export const MAGIC_LINK_KEK_INFO_PREFIX = 'noydb-magic-link-v1:'

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * Decrypted payload of a magic-link grant record. Mirrors
 * `DelegationToken` in `team/delegation.ts` but tracked separately
 * because the two flows persist under different collections + envelope
 * encryption schemes.
 */
export interface MagicLinkGrantPayload {
  readonly id: string
  readonly toUser: string
  readonly fromUser: string
  readonly tier: number
  /** Collection name or `null` for the vault-wide tier DEK. */
  readonly collection: string | null
  /** Optional specific record id scope. */
  readonly record?: string
  /** ISO timestamp — grant expires at this instant. */
  readonly until: string
  /** AES-KW-wrapped tier DEK, unwrap with the magic-link KEK. */
  readonly wrappedDek: string
  /** ISO timestamp the grant was issued. */
  readonly createdAt: string
  /** Optional caller-provided label (surfaced in audit UIs). */
  readonly note?: string
}

export interface IssueMagicLinkGrantOptions {
  readonly toUser: string
  readonly tier: number
  readonly collection?: string
  readonly record?: string
  readonly until: Date | string
  readonly note?: string
}

export interface MagicLinkGrantRecord {
  /** Store record id — `<token>` or `<token>:<index>` for batch entries. */
  readonly recordId: string
  readonly payload: MagicLinkGrantPayload
}

// ─── Key derivation ─────────────────────────────────────────────────────

/**
 * Derive the AES-GCM content key from the same HKDF inputs used for
 * the magic-link KEK. Different `info` suffix → domain-separated key.
 *
 * Exported so the `@noy-db/on-magic-link` package can share the exact
 * derivation path without cross-dependency between the two modules.
 */
export async function deriveMagicLinkContentKey(
  serverSecret: string | Uint8Array<ArrayBuffer>,
  token: string,
  vault: string,
): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle
  const ikmBytes =
    serverSecret instanceof Uint8Array
      ? serverSecret
      : new TextEncoder().encode(serverSecret)
  const tokenBytes = new TextEncoder().encode(token)
  const saltBuffer = await subtle.digest('SHA-256', tokenBytes)
  const info = new TextEncoder().encode(MAGIC_LINK_CONTENT_INFO_PREFIX + vault)
  const ikm = await subtle.importKey('raw', ikmBytes, 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: saltBuffer, info },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// ─── Issue ──────────────────────────────────────────────────────────────

/**
 * Persist a magic-link grant record. Caller derives + provides both
 * the content key and the KEK; this function performs the wrap/encrypt
 * and writes the envelope.
 *
 * `recordId` lets the caller use either the bare token (primary grant)
 * or a suffixed id (batch entry). The writer is responsible for
 * collision-avoidance across batch entries.
 */
export async function writeMagicLinkGrant(
  store: NoydbStore,
  vault: string,
  grantor: UnlockedKeyring,
  contentKey: CryptoKey,
  grantKek: CryptoKey,
  recordId: string,
  opts: IssueMagicLinkGrantOptions,
): Promise<MagicLinkGrantRecord> {
  const collectionName = opts.collection ?? null
  const sourceKey = collectionName
    ? dekKey(collectionName, opts.tier)
    : `__any#${opts.tier}`
  const sourceDek = grantor.deks.get(sourceKey)
  if (!sourceDek) {
    throw new DelegationTargetMissingError(
      `grantor cannot find tier ${opts.tier} DEK for ${collectionName ?? '(any)'}`,
    )
  }
  const wrappedDek = await wrapKey(sourceDek, grantKek)

  const until = typeof opts.until === 'string' ? opts.until : opts.until.toISOString()
  const createdAt = new Date().toISOString()
  const payload: MagicLinkGrantPayload = {
    id: recordId,
    toUser: opts.toUser,
    fromUser: grantor.userId,
    tier: opts.tier,
    collection: collectionName,
    ...(opts.record && { record: opts.record }),
    until,
    wrappedDek,
    createdAt,
    ...(opts.note && { note: opts.note }),
  }

  const { iv, data } = await encrypt(JSON.stringify(payload), contentKey)
  const envelope: EncryptedEnvelope = {
    _noydb: 1,
    _v: 1,
    _ts: createdAt,
    _iv: iv,
    _data: data,
    _by: grantor.userId,
  }
  await store.put(vault, MAGIC_LINK_GRANTS_COLLECTION, recordId, envelope)
  return { recordId, payload }
}

// ─── Claim ──────────────────────────────────────────────────────────────

/**
 * Fetch + decrypt a single magic-link grant record by id. Returns null
 * when the record is absent OR when decryption fails (wrong server
 * secret, wrong vault, tampered envelope) — callers treat a null as
 * "this URL is not valid for this server".
 *
 * The returned payload's `wrappedDek` is still AES-KW-wrapped; the
 * caller unwraps it with the magic-link KEK to obtain the tier DEK.
 */
export async function readMagicLinkGrantRecord(
  store: NoydbStore,
  vault: string,
  contentKey: CryptoKey,
  recordId: string,
): Promise<MagicLinkGrantPayload | null> {
  const env = await store.get(vault, MAGIC_LINK_GRANTS_COLLECTION, recordId)
  if (!env) return null
  try {
    const json = await decrypt(env._iv, env._data, contentKey)
    return JSON.parse(json) as MagicLinkGrantPayload
  } catch {
    return null
  }
}

/**
 * Enumerate every grant record sharing the magic-link `token` prefix
 * (i.e. the primary `<token>` entry plus any `<token>:*` batch entries).
 * Expired grants are still returned — the caller filters on `until`.
 */
export async function listMagicLinkGrants(
  store: NoydbStore,
  vault: string,
  contentKey: CryptoKey,
  token: string,
): Promise<MagicLinkGrantPayload[]> {
  const ids = await store.list(vault, MAGIC_LINK_GRANTS_COLLECTION)
  const matching = ids.filter(id => id === token || id.startsWith(`${token}:`))
  const out: MagicLinkGrantPayload[] = []
  for (const id of matching) {
    const payload = await readMagicLinkGrantRecord(store, vault, contentKey, id)
    if (payload) out.push(payload)
  }
  return out
}

/**
 * Unwrap the tier DEK from a grant payload using the magic-link KEK.
 * Thin wrapper around `unwrapKey` — provided so the claimant can avoid
 * importing `crypto.js` directly.
 */
export async function unwrapMagicLinkGrant(
  payload: MagicLinkGrantPayload,
  grantKek: CryptoKey,
): Promise<CryptoKey> {
  return unwrapKey(payload.wrappedDek, grantKek)
}

/**
 * Delete a magic-link grant (primary + every batch entry sharing the
 * token). Safe to call when nothing exists.
 */
export async function revokeMagicLinkGrant(
  store: NoydbStore,
  vault: string,
  token: string,
): Promise<number> {
  const ids = await store.list(vault, MAGIC_LINK_GRANTS_COLLECTION)
  const matching = ids.filter(id => id === token || id.startsWith(`${token}:`))
  for (const id of matching) {
    await store.delete(vault, MAGIC_LINK_GRANTS_COLLECTION, id)
  }
  return matching.length
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Compose the batch-entry record id. `index === 0` → bare token.
 * Subsequent entries use `<token>:<index>` so `store.list()` can
 * enumerate them all by common prefix.
 */
export function magicLinkGrantRecordId(token: string, index: number): string {
  return index === 0 ? token : `${token}:${index}`
}

/**
 * True when the payload's `until` is in the past relative to `now`.
 * Kept here (rather than inlined) so the semantics stay aligned with
 * the canonical `DelegationToken` expiry check.
 */
export function isMagicLinkGrantExpired(
  payload: MagicLinkGrantPayload,
  now: Date = new Date(),
): boolean {
  return payload.until <= now.toISOString()
}
