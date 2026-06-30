/**
 * Schema-fence document. Vault-level generation counter + drain
 * state, stored at `_meta/schema-fence` using the plaintext-envelope
 * pattern of `_meta/policy` (no PII — a counter + a state enum).
 */
import type { NoydbStore, EncryptedEnvelope } from '../../types.js'
import { NOYDB_FORMAT_VERSION } from '../../types.js'

export type FenceState = 'normal' | 'draining' | 'migrating' | 'complete'

export interface FenceDoc {
  readonly currentSchemaVersion: number
  readonly fenceState: FenceState
}

export const FENCE_RECORD_ID = 'schema-fence'
const META_COLLECTION = '_meta'

export const DEFAULT_FENCE: FenceDoc = { currentSchemaVersion: 0, fenceState: 'normal' }

export async function loadFence(store: NoydbStore, vault: string): Promise<FenceDoc> {
  const envelope = await store.get(vault, META_COLLECTION, FENCE_RECORD_ID)
  if (!envelope) return DEFAULT_FENCE
  try {
    const parsed = JSON.parse(envelope._data) as unknown
    if (!isFenceDoc(parsed)) return DEFAULT_FENCE
    return parsed
  } catch {
    return DEFAULT_FENCE
  }
}

export async function saveFence(store: NoydbStore, vault: string, fence: FenceDoc): Promise<void> {
  const envelope: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: 1,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: JSON.stringify(fence),
  }
  await store.put(vault, META_COLLECTION, FENCE_RECORD_ID, envelope)
}

function isFenceDoc(x: unknown): x is FenceDoc {
  if (x === null || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return typeof o['currentSchemaVersion'] === 'number'
    && (o['fenceState'] === 'normal' || o['fenceState'] === 'draining'
      || o['fenceState'] === 'migrating' || o['fenceState'] === 'complete')
}
