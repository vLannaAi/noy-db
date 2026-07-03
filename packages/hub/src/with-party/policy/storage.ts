/**
 * Persistence helpers for the vault-level policy document
 * (`_meta/policy`). Mirrors the bypass-AES pattern used by
 * `_meta/handle` — the policy document is plain JSON, the envelope's
 * `_iv` field is left empty.
 *
 * @see docs/services/session-tiers.md → Storage location
 *
 * @module
 */
import type { NoydbStore, EncryptedEnvelope, VaultPolicy } from '../../kernel/types.js'
import { NOYDB_FORMAT_VERSION } from '../../kernel/types.js'

/** Reserved collection name for vault-level metadata documents. */
export const META_COLLECTION = '_meta'
/** Reserved id for the vault-level policy document. */
export const POLICY_RECORD_ID = 'policy'

/**
 * Read the vault-level policy from `_meta/policy`. Returns `undefined`
 * when no policy has been persisted (fresh vault, or a vault written
 * before the policy module landed). The caller falls back to the
 * default preset.
 *
 * Tolerates corrupted documents the same way `_meta/handle` does: a
 * JSON parse failure surfaces as `undefined`, not a thrown error, so
 * a bad write never permanently locks a vault.
 */
export async function loadVaultPolicy(
  store: NoydbStore,
  vault: string,
): Promise<VaultPolicy | undefined> {
  const envelope = await store.get(vault, META_COLLECTION, POLICY_RECORD_ID)
  if (!envelope) return undefined
  try {
    const parsed = JSON.parse(envelope._data) as unknown
    if (!isVaultPolicy(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Persist the vault-level policy at `_meta/policy`. Idempotent — call
 * once at vault creation and again on `db.updatePolicy()` invocations.
 */
export async function saveVaultPolicy(
  store: NoydbStore,
  vault: string,
  policy: VaultPolicy,
): Promise<void> {
  const envelope: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: 1,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: JSON.stringify(policy),
  }
  await store.put(vault, META_COLLECTION, POLICY_RECORD_ID, envelope)
}

function isVaultPolicy(x: unknown): x is VaultPolicy {
  if (x === null || typeof x !== 'object') return false
  if (!('gates' in x)) return false
  const gates = (x as { gates: unknown }).gates
  return gates !== null && typeof gates === 'object'
}
