/**
 * Persistence helpers for per-principal user envelopes stored at
 * `_users/<keyringId>` (logically: `_meta/user/<keyringId>`).
 *
 * Unlike `_meta/policy` and `_meta/handle` which are plaintext, user
 * envelopes carry user data and are encrypted with a dedicated
 * {@link USER_ENVELOPE_COLLECTION} DEK (provisioned at vault open and
 * propagated to every keyring via the system-collection DEK path in
 * `team/keyring.ts`).
 *
 * This module is the **storage primitive** layer. The public API
 * (`vault.user.*`) sits on top of this; permission gates, own-only
 * write enforcement, and presence-channel propagation live there.
 *
 * @see docs/superpowers/specs/2026-05-05-user-envelope-design.md
 *
 * @module
 */
import type { NoydbStore, EncryptedEnvelope, UserEnvelope } from '../../../kernel/types.js'
import { NOYDB_FORMAT_VERSION } from '../../../kernel/types.js'
import { encrypt, decrypt } from '../../../kernel/enclave/index.js'
import { ConflictError, UserEnvelopeOversizedError } from '../../../kernel/errors.js'
import {
  USER_ENVELOPE_COLLECTION,
  USER_ENVELOPE_MAX_BYTES,
} from '../../../kernel/constants.js'

/**
 * Read and decrypt the user envelope for `keyringId`. Returns `null`
 * when no envelope has been persisted (either the principal has never
 * called `updateMe`, or the keyring predates this feature).
 *
 * Decryption errors propagate — a tampered or wrong-keyed envelope
 * surfaces as the underlying crypto error rather than masquerading as
 * "not found".
 */
export async function loadUserEnvelope<T = unknown>(
  store: NoydbStore,
  vault: string,
  keyringId: string,
  dek: CryptoKey,
): Promise<UserEnvelope<T> | null> {
  const envelope = await store.get(vault, USER_ENVELOPE_COLLECTION, keyringId)
  if (!envelope) return null
  const plaintext = await decrypt(envelope._iv, envelope._data, dek)
  const data = JSON.parse(plaintext) as T
  return {
    keyringId,
    data,
    _v: envelope._v,
    _ts: envelope._ts,
  }
}

/**
 * Encrypt and persist the user envelope for `keyringId`. The new
 * version is `(prior._v ?? 0) + 1`. Pass `expectedVersion` to enable
 * optimistic-concurrency checks: a mismatch with the stored version
 * throws {@link ConflictError} with the actual stored version.
 *
 * `expectedVersion: 0` means "expect no prior envelope"; the write
 * succeeds only if no envelope exists yet.
 *
 * Soft-caps the JSON-serialized payload at {@link USER_ENVELOPE_MAX_BYTES};
 * larger payloads throw {@link UserEnvelopeOversizedError}.
 */
export async function saveUserEnvelope<T>(
  store: NoydbStore,
  vault: string,
  keyringId: string,
  payload: T,
  dek: CryptoKey,
  expectedVersion?: number,
): Promise<UserEnvelope<T>> {
  const json = JSON.stringify(payload)
  // TextEncoder counts bytes correctly for multi-byte UTF-8 (Thai text,
  // emoji, etc.) — JSON.stringify().length would undercount.
  const bytes = new TextEncoder().encode(json).byteLength
  if (bytes > USER_ENVELOPE_MAX_BYTES) {
    throw new UserEnvelopeOversizedError(bytes)
  }

  const prior = await store.get(vault, USER_ENVELOPE_COLLECTION, keyringId)
  if (expectedVersion !== undefined) {
    const priorVersion = prior?._v ?? 0
    if (priorVersion !== expectedVersion) {
      throw new ConflictError(
        priorVersion,
        `User envelope for "${keyringId}" expected version ${expectedVersion}, ` +
          `actual ${priorVersion}`,
      )
    }
  }

  const nextVersion = (prior?._v ?? 0) + 1
  const ts = new Date().toISOString()
  const { iv, data } = await encrypt(json, dek)

  const envelope: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: nextVersion,
    _ts: ts,
    _iv: iv,
    _data: data,
  }
  await store.put(vault, USER_ENVELOPE_COLLECTION, keyringId, envelope)

  return {
    keyringId,
    data: payload,
    _v: nextVersion,
    _ts: ts,
  }
}

/**
 * Delete the user envelope for `keyringId`. Idempotent — no error if
 * the envelope is already absent. Called from the keyring revoke path
 * (cascade-delete) and is a no-op for keyrings that never wrote.
 */
export async function deleteUserEnvelope(
  store: NoydbStore,
  vault: string,
  keyringId: string,
): Promise<void> {
  await store.delete(vault, USER_ENVELOPE_COLLECTION, keyringId)
}

/**
 * List the keyring ids that have a user envelope persisted in `vault`.
 * Order is store-defined — callers that need a stable order should sort.
 */
export async function listUserEnvelopeIds(
  store: NoydbStore,
  vault: string,
): Promise<string[]> {
  return store.list(vault, USER_ENVELOPE_COLLECTION)
}
