/**
 * Schema-fence document. Vault-level generation counter + drain
 * state, stored at `_meta/schema-fence` using the plaintext-envelope
 * pattern of `_meta/policy` (no PII — a counter + a state enum).
 */
import type { NoydbStore } from '../../kernel/types.js'
import { buildRecordEnvelope } from '../../kernel/enclave/index.js'

export type FenceState = 'normal' | 'draining' | 'migrating' | 'complete'

export interface FenceDoc {
  readonly currentSchemaVersion: number
  readonly fenceState: FenceState
  /**
   * Content hash (`PersistedSchemaEnvelope.hash`) of the schema most
   * recently persisted while the vault sat at `currentSchemaVersion` —
   * binds "generation N" to a concrete schema-content hash (#946), so
   * "which schema is generation N" is answerable from `schemaFenceState()`
   * alone. Optional: absent on a fresh vault (generation 0, nothing
   * persisted yet) and on a fence document written before #946.
   */
  readonly schemaHash?: string
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
  const envelope = buildRecordEnvelope(
    { collection: META_COLLECTION, id: FENCE_RECORD_ID, version: 1 },
    { iv: '', data: JSON.stringify(fence) },
  )
  await store.put(vault, META_COLLECTION, FENCE_RECORD_ID, envelope)
}

function isFenceDoc(x: unknown): x is FenceDoc {
  if (x === null || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  if (typeof o['currentSchemaVersion'] !== 'number') return false
  if (o['fenceState'] !== 'normal' && o['fenceState'] !== 'draining'
    && o['fenceState'] !== 'migrating' && o['fenceState'] !== 'complete') return false
  // schemaHash is optional (#946) — a legacy fence doc without it is still valid.
  return o['schemaHash'] === undefined || typeof o['schemaHash'] === 'string'
}
