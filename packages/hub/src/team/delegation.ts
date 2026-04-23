/**
 * Time-boxed cross-tier delegation tokens (v0.18 #209).
 *
 * A higher-tier user can issue a delegation that grants another user
 * temporary access to records at a specified tier. The delegation is
 * persisted as an encrypted envelope in the reserved `_delegations`
 * collection. The target user's runtime scans this collection on every
 * open and, while `until` is still in the future, merges the
 * unwrapped tier DEKs into their in-memory DEK map.
 *
 * ## Token shape
 *
 * ```
 * {
 *   id,             // ULID, also the _delegations record id
 *   toUser,         // grantee user id
 *   fromUser,       // grantor user id (owner/admin/higher-tier principal)
 *   tier,           // tier being delegated
 *   collection,     // collection name OR null for "every collection"
 *   record,         // optional specific record id
 *   until,          // ISO timestamp — token expires at this instant
 *   wrappedDek,     // base64 AES-KW-wrapped tier DEK, wrapped under target KEK
 *   createdAt,      // ISO timestamp
 * }
 * ```
 *
 * The ciphertext is stored as a normal noy-db envelope — the
 * `_delegations` collection has its own DEK shared across all vault
 * users, so an operator can enumerate active delegations for audit
 * without being able to *use* them (the `wrappedDek` inside is still
 * keyed to the target user's KEK).
 *
 * ## Revocation
 *
 * Delete the `_delegations/<id>` envelope. The target user's runtime
 * reloads the delegation list at each open and at periodic intervals
 * (tracked by the caller — this module is pure logic).
 *
 * @module
 */

import type { NoydbStore, EncryptedEnvelope } from '../types.js'
import type { UnlockedKeyring } from './keyring.js'
import { encrypt, decrypt, wrapKey, unwrapKey } from '../crypto.js'
import { dekKey } from './tiers.js'
import { DelegationTargetMissingError } from '../errors.js'
import { generateULID } from '../bundle/ulid.js'

export const DELEGATIONS_COLLECTION = '_delegations'

/**
 * Durable payload of a delegation token. Encrypted under the vault's
 * `_delegations` DEK; the `wrappedDek` inside is additionally wrapped
 * under the target user's KEK.
 */
export interface DelegationToken {
  readonly id: string
  readonly toUser: string
  readonly fromUser: string
  readonly tier: number
  /** Collection name or `null` for all collections. */
  readonly collection: string | null
  /** Optional specific record id scope. */
  readonly record?: string
  readonly until: string
  readonly wrappedDek: string
  readonly createdAt: string
}

export interface IssueDelegationOptions {
  readonly toUser: string
  readonly tier: number
  readonly collection?: string
  readonly record?: string
  readonly until: Date | string
}

/**
 * Build and persist a delegation token. The caller must hold a tier-N
 * DEK and must have already located the target user's keyring file
 * (so the `wrappedDek` can be re-wrapped against their KEK).
 */
export async function issueDelegation(
  store: NoydbStore,
  vault: string,
  grantor: UnlockedKeyring,
  targetKek: CryptoKey | null,
  delegationsDek: CryptoKey,
  opts: IssueDelegationOptions,
): Promise<DelegationToken> {
  if (!targetKek) {
    throw new DelegationTargetMissingError(opts.toUser)
  }
  const tier = opts.tier
  const collectionName = opts.collection ?? null
  const dekLookupCollection = collectionName ?? ''
  // Tier DEK to delegate — fetched from the grantor's own keyring.
  const sourceDek = collectionName
    ? grantor.deks.get(dekKey(collectionName, tier))
    : undefined
  if (!sourceDek) {
    throw new DelegationTargetMissingError(
      `grantor cannot find tier ${tier} DEK for ${dekLookupCollection || '(any)'}`,
    )
  }
  const wrappedDek = await wrapKey(sourceDek, targetKek)

  const until = typeof opts.until === 'string' ? opts.until : opts.until.toISOString()
  const token: DelegationToken = {
    id: generateULID(),
    toUser: opts.toUser,
    fromUser: grantor.userId,
    tier,
    collection: collectionName,
    ...(opts.record && { record: opts.record }),
    until,
    wrappedDek,
    createdAt: new Date().toISOString(),
  }

  const plaintext = JSON.stringify(token)
  const { iv, data } = await encrypt(plaintext, delegationsDek)
  const envelope: EncryptedEnvelope = {
    _noydb: 1,
    _v: 1,
    _ts: token.createdAt,
    _iv: iv,
    _data: data,
    _by: grantor.userId,
  }
  await store.put(vault, DELEGATIONS_COLLECTION, token.id, envelope)
  return token
}

/**
 * Enumerate every live (non-expired) delegation addressed to `toUser`
 * and merge the unwrapped tier DEKs into their keyring. Returns the
 * list of merged delegations so the caller can register per-access
 * audit context.
 */
export async function loadActiveDelegations(
  store: NoydbStore,
  vault: string,
  user: UnlockedKeyring,
  delegationsDek: CryptoKey,
  now: Date = new Date(),
): Promise<DelegationToken[]> {
  const ids = await store.list(vault, DELEGATIONS_COLLECTION)
  const merged: DelegationToken[] = []
  const nowIso = now.toISOString()
  for (const id of ids) {
    const env = await store.get(vault, DELEGATIONS_COLLECTION, id)
    if (!env) continue
    let token: DelegationToken
    try {
      const plaintext = await decrypt(env._iv, env._data, delegationsDek)
      token = JSON.parse(plaintext) as DelegationToken
    } catch {
      continue
    }
    if (token.toUser !== user.userId) continue
    if (token.until <= nowIso) continue

    let dek: CryptoKey
    try {
      dek = await unwrapKey(token.wrappedDek, user.kek)
    } catch {
      continue
    }
    const k = token.collection
      ? dekKey(token.collection, token.tier)
      : `__any#${token.tier}`
    user.deks.set(k, dek)
    merged.push(token)
  }
  return merged
}

/**
 * Revoke a delegation by id — the caller resolves the envelope and
 * issues a `delete`. Provided as a stable helper so the naming is
 * symmetric to `issueDelegation`.
 */
export async function revokeDelegation(
  store: NoydbStore,
  vault: string,
  id: string,
): Promise<void> {
  await store.delete(vault, DELEGATIONS_COLLECTION, id)
}
