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
 * The body is encrypted (AES-GCM under the `_meta` collection DEK) when
 * the vault is encrypted — the `keys[]` are derived-row ids produced by a
 * user-supplied key extractor and can be content-bearing (SKU, tag, email),
 * so a ciphertext-only store must not read them, the derivation graph, or
 * `emittedAt`. Back-compat: sidecars written before this fix are plaintext
 * (`_iv === ''`); `loadFanoutSidecar` dual-reads them.
 *
 * @module
 */
import type { NoydbStore, EncryptedEnvelope } from '../../kernel/types.js'
import { NOYDB_FORMAT_VERSION } from '../../kernel/types.js'
import { encrypt, openEnvelopeJson, type EnclaveKey } from '../../kernel/enclave/index.js'

type GetDEK = (collectionName: string) => Promise<EnclaveKey>

/** The `_meta` collection name whose DEK encrypts the sidecar body. */
const FANOUT_DEK_COLLECTION = '_meta'

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

/**
 * Read the sidecar; returns `undefined` only when it's legitimately absent
 * (no envelope at that id) — the correct signal for callers to skip
 * orphan-row reconciliation because there's nothing to reconcile against.
 *
 * A PRESENT envelope that fails to decrypt or parse is a data-integrity
 * problem, not an absence, and is deliberately NOT caught here: swallowing
 * it to `undefined` would look identical to "no sidecar" and make callers
 * (the array-derivation dispatch in `vault.ts`/`collection.ts`) silently
 * skip deleting stale derived rows on a shrink. Let `openEnvelopeJson`'s
 * `DecryptionError`/`TamperedError` and `JSON.parse` failures propagate,
 * matching the no-catch convention of sibling decrypt call-sites (e.g.
 * `with-audit/consent/consent.ts`'s `decryptEntry`).
 *
 * Dual-reads for back-compat: an envelope with `_iv === ''` is a legacy
 * plaintext sidecar (parse `_data` directly); otherwise the body was
 * encrypted under the `_meta` DEK and is decrypted first.
 */
export async function loadFanoutSidecar(
  store: NoydbStore,
  vault: string,
  source: string,
  sourceId: string,
  outputKey: string,
  getDEK: GetDEK,
  encrypted: boolean,
): Promise<FanoutSidecar | undefined> {
  const envelope = await store.get(vault, '_meta', recordId(source, sourceId, outputKey))
  if (!envelope) return undefined
  // Legacy plaintext (`_iv === ''`) reads directly; encrypted bodies decrypt.
  const json = (!encrypted || envelope._iv === '')
    ? envelope._data
    : await openEnvelopeJson(envelope, await getDEK(FANOUT_DEK_COLLECTION))
  const parsed = JSON.parse(json) as FanoutSidecar
  if (parsed._noydb_fanout !== 1) return undefined
  if (!Array.isArray(parsed.keys)) return undefined
  return parsed
}

/**
 * Persist (insert/replace) the sidecar with a fresh key set. The body is
 * encrypted under the `_meta` DEK when the vault is encrypted (the `keys[]`
 * can be content-bearing); plaintext only in debug/unencrypted vaults.
 */
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
  getDEK: GetDEK,
  encrypted: boolean,
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
  const json = JSON.stringify(doc)
  let envelope: EncryptedEnvelope
  if (!encrypted) {
    envelope = {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: (prior?._v ?? 0) + 1,
      _ts: new Date().toISOString(),
      _iv: '',
      _data: json,
    }
  } else {
    const { iv, data } = await encrypt(json, await getDEK(FANOUT_DEK_COLLECTION))
    envelope = {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: (prior?._v ?? 0) + 1,
      _ts: new Date().toISOString(),
      _iv: iv,
      _data: data,
    }
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
