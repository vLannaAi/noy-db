/**
 * Per-source-row fanout sidecar for `shape: 'array'` derivations.
 *
 * Each `(sourceCollection, sourceId, outputKey)` triple gets its own
 * envelope at:
 *
 *     _meta/derivations-fanout/<sourceCollection>/<sourceId>/<outputKey>
 *
 * The envelope records the last-emitted derived row ids so the
 * dispatcher can compute the diff on every source-row update in O(1):
 * read prior keys, compute `toDelete = prev \ new`, write new, persist
 * back.
 *
 * Stored as plain JSON with AES-GCM bypassed (same pattern as
 * `_meta/policy`, `_meta/recovery-paper`, `_meta/sealed-passphrase`,
 * etc.): the sidecar is system metadata, not user data, and the
 * derived outputs themselves carry their own encryption envelopes.
 *
 * @module
 */
import type { NoydbStore, EncryptedEnvelope } from '../types.js'
import { NOYDB_FORMAT_VERSION } from '../types.js'

/** Magic-prefixed JSON payload at `_meta/<recordId>`. */
export interface FanoutSidecar {
  readonly _noydb_fanout: 1
  /** Source collection name. */
  readonly source: string
  /** Source record id. */
  readonly sourceId: string
  /** Strategy output key (the key in `strategy.outputs`). */
  readonly outputKey: string
  /** Output collection name (audit / forensics). */
  readonly outputCollection: string
  /** Derived-row ids last emitted for this (source, output) pair. */
  readonly keys: ReadonlyArray<string>
  /** ISO timestamp of last dispatch. */
  readonly emittedAt: string
}

/**
 * Build the canonical `_meta` record id for a fanout sidecar.
 *
 * The full path inside the store is `_meta/<this-string>`. We pack the
 * full triple into the id so a single `_meta` collection holds all
 * sidecars (collection-per-source would proliferate names; the
 * existing `_meta` flat namespace is cheaper).
 */
function recordId(source: string, sourceId: string, outputKey: string): string {
  // Use `/` as a separator. None of the components is supposed to
  // contain it (collection names + output keys are bare identifiers;
  // source ids are typically ULIDs / UUIDs / app-chosen strings
  // without slashes). If a future source carries `/` in its id, we'd
  // need an escape; deferred until that's a real case.
  return `derivations-fanout/${source}/${sourceId}/${outputKey}`
}

/** Read the sidecar; returns empty if absent. */
export async function loadFanoutSidecar(
  store: NoydbStore,
  vault: string,
  source: string,
  sourceId: string,
  outputKey: string,
): Promise<FanoutSidecar | undefined> {
  const envelope = await store.get(vault, '_meta', recordId(source, sourceId, outputKey))
  if (!envelope) return undefined
  try {
    const parsed = JSON.parse(envelope._data) as FanoutSidecar
    if (parsed._noydb_fanout !== 1) return undefined
    if (!Array.isArray(parsed.keys)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** Persist (insert/replace) the sidecar with a fresh key set. */
export async function saveFanoutSidecar(
  store: NoydbStore,
  vault: string,
  payload: {
    readonly source: string
    readonly sourceId: string
    readonly outputKey: string
    readonly outputCollection: string
    readonly keys: ReadonlyArray<string>
  },
): Promise<void> {
  const doc: FanoutSidecar = {
    _noydb_fanout: 1,
    source: payload.source,
    sourceId: payload.sourceId,
    outputKey: payload.outputKey,
    outputCollection: payload.outputCollection,
    keys: payload.keys,
    emittedAt: new Date().toISOString(),
  }
  const id = recordId(payload.source, payload.sourceId, payload.outputKey)
  const prior = await store.get(vault, '_meta', id)
  const envelope: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: (prior?._v ?? 0) + 1,
    _ts: new Date().toISOString(),
    // AES-GCM bypassed — sidecar is system metadata, no user data inside.
    _iv: '',
    _data: JSON.stringify(doc),
  }
  await store.put(vault, '_meta', id, envelope)
}

/** Delete the sidecar (used on source-row delete cascade). */
export async function deleteFanoutSidecar(
  store: NoydbStore,
  vault: string,
  source: string,
  sourceId: string,
  outputKey: string,
): Promise<void> {
  await store.delete(vault, '_meta', recordId(source, sourceId, outputKey))
}
