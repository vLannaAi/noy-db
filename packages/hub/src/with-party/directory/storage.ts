/**
 * Persistence helpers for the vault-level user-directory toggle
 * (`_meta/directory`). Mirrors the bypass-AES pattern used by
 * `_meta/policy` — the directory document is plain JSON, the
 * envelope's `_iv` field is left empty.
 *
 * @see https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/user-envelope.md → Directory visibility
 * @see https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/plaintext-bypass.md — every `_iv: ''` write site
 *
 * @module
 */
import { buildRecordEnvelope } from '../../kernel/enclave/index.js'
import type { NoydbStore } from '../../kernel/types.js'
import type { DirectoryConfig } from './types.js'

/** Reserved collection name for vault-level metadata documents. */
export const META_COLLECTION = '_meta'
/** Reserved id for the vault-level directory document. */
export const DIRECTORY_RECORD_ID = 'directory'

/**
 * Read the directory toggle from `_meta/directory`. Returns `undefined`
 * when no document has been persisted — callers treat that as the
 * default-on case (`{ enabled: true }`).
 *
 * Tolerates corrupted documents the same way `_meta/policy` does: a
 * JSON parse failure surfaces as `undefined`, not a thrown error, so a
 * bad write never permanently breaks team enumeration.
 */
export async function readDirectoryConfig(
  store: NoydbStore,
  vault: string,
): Promise<DirectoryConfig | undefined> {
  const envelope = await store.get(vault, META_COLLECTION, DIRECTORY_RECORD_ID)
  if (!envelope) return undefined
  try {
    const parsed = JSON.parse(envelope._data) as unknown
    if (!isDirectoryConfig(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Persist the directory toggle at `_meta/directory`. Idempotent — call
 * on every `db.setDirectoryEnabled()` invocation. Owner-only at the
 * caller site; this primitive does not check roles.
 */
export async function persistDirectoryConfig(
  store: NoydbStore,
  vault: string,
  config: DirectoryConfig,
): Promise<void> {
  const envelope = buildRecordEnvelope(
    { collection: META_COLLECTION, id: DIRECTORY_RECORD_ID, version: 1 },
    { iv: '', data: JSON.stringify({ enabled: config.enabled }) },
  )
  await store.put(vault, META_COLLECTION, DIRECTORY_RECORD_ID, envelope)
}

function isDirectoryConfig(x: unknown): x is DirectoryConfig {
  if (x === null || typeof x !== 'object') return false
  if (!('enabled' in x)) return false
  return typeof (x as { enabled: unknown }).enabled === 'boolean'
}
