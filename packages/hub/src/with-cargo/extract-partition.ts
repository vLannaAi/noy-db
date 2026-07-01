/**
 * Partition extraction. Walks the FK closure, re-encrypts
 * the selected records under fresh per-collection DEKs, seals those DEKs
 * under a one-time transfer key, and serializes an unowned
 * `extracted-partition` bundle.
 *
 * @module
 */
import type { Vault } from '../vault.js'
import type { EncryptedEnvelope, BlobObject, SlotRecord, VersionRecord } from '../types.js'
import { NOYDB_BACKUP_VERSION } from '../types.js'
import {
  decrypt,
  encrypt,
  generateDEK,
  bufferToBase64,
  encryptBytesWithAAD,
  decryptBytesWithAAD,
} from '../crypto.js'
import { unwrapCek, wrapCek } from '../record-keys/index.js'
import {
  BLOB_COLLECTION,
  BLOB_INDEX_COLLECTION,
  BLOB_CHUNKS_COLLECTION,
  BLOB_SLOTS_PREFIX,
  BLOB_VERSIONS_PREFIX,
} from '../with-shape/blobs/blob-set.js'
import { PartitionExtractionError } from '../errors.js'
import { walkClosure, type WalkClosureOptions } from './walk-closure.js'
import { generateULID } from '../with-pod/ulid.js'
import { SCHEMAS_COLLECTION } from '../with-shape/persisted-schemas/storage.js'
import { NOYDB_FORMAT_VERSION } from '../types.js'
import { LEDGER_COLLECTION } from '../with-commit/history/ledger/constants.js'
import { canonicalJson, hashEntry } from '../with-commit/history/ledger/entry.js'
import type { LedgerEntry } from '../with-commit/history/ledger/entry.js'
import { envelopePayloadHash } from '../with-commit/history/ledger/hash.js'
import {
  assembleBundleContainer,
  buildExtractedPartitionWrapper,
  type TransferSealPayload,
} from '../with-pod/bundle.js'

/** Re-keyed collections snapshot + the fresh DEKs used. */
export interface ReKeyResult {
  readonly collections: Record<string, Record<string, EncryptedEnvelope>>
  readonly deks: Map<string, CryptoKey>
}

/**
 * Re-encrypt every record in `closure` under a fresh per-collection DEK.
 * Reads raw source envelopes, decrypts under the source DEK, re-encrypts
 * under the new DEK. Plaintext-pipeline: requires an unlocked vault.
 */
export async function reKeyClosure(
  vault: Vault,
  closure: Map<string, Set<string>>,
  fieldProjection?: Record<string, readonly string[]>,
): Promise<ReKeyResult> {
  const { name: vaultName, adapter, getDEK } = vault._introspectState()
  const collections: Record<string, Record<string, EncryptedEnvelope>> = {}
  const deks = new Map<string, CryptoKey>()

  for (const [collectionName, ids] of closure) {
    const srcDek = await getDEK(collectionName)
    const destDek = await generateDEK()
    deks.set(collectionName, destDek)
    const out: Record<string, EncryptedEnvelope> = {}
    // FR-7 structural field projection: when this collection has a projection,
    // narrow the plaintext body to `id` (always) + the listed fields BEFORE
    // re-encryption, so excluded fields never travel in the bundle. Applied
    // identically in both re-key branches; only the body changes — the `_cek`
    // re-wrap order is untouched. Absent/empty projection → byte-identical to
    // the un-projected path (`proj` is undefined and `project` is a no-op).
    const projList = fieldProjection?.[collectionName]
    const proj = projList ? new Set(projList) : undefined
    const project = (plaintext: string): string => {
      if (!proj) return plaintext
      const rec = JSON.parse(plaintext) as Record<string, unknown>
      const kept: Record<string, unknown> = {}
      if ('id' in rec) kept['id'] = rec['id'] // id ALWAYS preserved
      for (const f of proj) if (f in rec) kept[f] = rec[f]
      return JSON.stringify(kept)
    }

    for (const id of ids) {
      const env = await adapter.get(vaultName, collectionName, id)
      if (!env) continue
      if (env._cek !== undefined) {
        // Per-record CEK: a naive `{ ...env }` spread would carry a
        // SOURCE-DEK-wrapped CEK into a bundle re-keyed under a different
        // destination DEK — silently undecryptable for the recipient.
        // Re-wrap: unwrap the CEK under the source DEK, re-encrypt the body
        // under the SAME CEK (decision 2 — CEK reused on re-key, preserving
        // the history-chain identity), then wrap the CEK under the fresh
        // destination DEK. The recipient gains access transitively once they
        // re-wrap the collection DEK under their KEK on adopt.
        const cek = await unwrapCek(env._cek, srcDek)
        const plaintext = await decrypt(env._iv, env._data, cek)
        const { iv, data } = await encrypt(project(plaintext), cek)
        const wrapped = await wrapCek(cek, destDek)
        out[id] = { ...env, _iv: iv, _data: data, _cek: wrapped }
        continue
      }
      const plaintext = await decrypt(env._iv, env._data, srcDek)
      const { iv, data } = await encrypt(project(plaintext), destDek)
      out[id] = { ...env, _iv: iv, _data: data }
    }
    collections[collectionName] = out
  }

  return { collections, deks }
}

/**
 * Re-key the persisted JSON Schemas (`_schemas/<collection>`) for the
 * closure collections under the destination DEKs. Returns a
 * `{ collection: envelope }` map for the carried collections that actually
 * have a schema; collections without one are omitted.
 */
export async function reKeySchemas(
  vault: Vault,
  closure: Map<string, Set<string>>,
  destDeks: Map<string, CryptoKey>,
  fieldProjection?: Record<string, readonly string[]>,
): Promise<Record<string, EncryptedEnvelope>> {
  const { name: vaultName, adapter, getDEK } = vault._introspectState()
  const out: Record<string, EncryptedEnvelope> = {}

  for (const collectionName of closure.keys()) {
    // FR-7: skip a projected collection's schema — the narrowed shape no
    // longer matches the stored JSON Schema, so carrying it would assert a
    // contract the projected records violate (missing required fields).
    if (fieldProjection?.[collectionName]) continue
    const env = await adapter.get(vaultName, SCHEMAS_COLLECTION, collectionName)
    if (!env) continue // collection has no persisted schema — skip
    const destDek = destDeks.get(collectionName)
    if (!destDek) continue
    const srcDek = await getDEK(collectionName)
    const plaintext = await decrypt(env._iv, env._data, srcDek)
    const { iv, data } = await encrypt(plaintext, destDek)
    out[collectionName] = { ...env, _iv: iv, _data: data }
  }
  return out
}

const paddedIndex = (n: number): string => String(n).padStart(10, '0')

export interface ReKeyLedgerResult {
  /** { paddedIndex: re-encrypted entry envelope } for backup._internal._ledger. */
  readonly entries: Record<string, EncryptedEnvelope>
  /** Recomputed ledgerHead for the carried chain (index -1 when empty). */
  readonly head: { hash: string; index: number; ts: string }
}

/**
 * Build the carried `_ledger` chain for an extracted partition.
 * Filters source entries to the closure, RE-CHAINS them (fresh index + prevHash),
 * and re-encrypts under `ledgerDek`. The `payloadHash` is recomputed against the
 * re-keyed envelope ONLY for the latest `put` per (collection,id) — the entry
 * `verifyBackupIntegrity` cross-checks; earlier puts + deletes keep their source
 * `payloadHash` verbatim (recomputing an intermediate put would assert a false
 * hash for an older version). Amendments + out-of-closure entries are dropped;
 * `_ledger_deltas`/`_history` are deferred to slice 2.
 */
export async function reKeyLedger(
  vault: Vault,
  closure: Map<string, Set<string>>,
  reKeyedCollections: Record<string, Record<string, EncryptedEnvelope>>,
  ledgerDek: CryptoKey,
): Promise<ReKeyLedgerResult> {
  const { name: vaultName, adapter, getDEK } = vault._introspectState()
  const srcLedgerDek = await getDEK(LEDGER_COLLECTION)

  // 1. Load + decrypt source entries in index order.
  const ids = (await adapter.list(vaultName, LEDGER_COLLECTION)).sort()
  const srcEntries: LedgerEntry[] = []
  for (const id of ids) {
    const env = await adapter.get(vaultName, LEDGER_COLLECTION, id)
    if (!env) continue
    srcEntries.push(JSON.parse(await decrypt(env._iv, env._data, srcLedgerDek)) as LedgerEntry)
  }

  // 2. Keep closure put/delete entries (drop amendments + out-of-closure).
  const kept = srcEntries.filter(
    (e) => (e.op === 'put' || e.op === 'delete') && (closure.get(e.collection)?.has(e.id) ?? false),
  )

  // 3a. Reverse pass: index of the LATEST put per (collection,id).
  const latestPutIndex = new Map<string, number>()
  for (let i = kept.length - 1; i >= 0; i--) {
    const e = kept[i]!
    if (e.op !== 'put') continue
    const key = `${e.collection}/${e.id}`
    if (!latestPutIndex.has(key)) latestPutIndex.set(key, i)
  }

  // 3b. Forward re-chain + re-encrypt.
  const entries: Record<string, EncryptedEnvelope> = {}
  let prevHash = ''
  let last: LedgerEntry | undefined
  for (let i = 0; i < kept.length; i++) {
    const src = kept[i]!
    const key = `${src.collection}/${src.id}`
    const isLatestPut = src.op === 'put' && latestPutIndex.get(key) === i
    const reKeyedEnv = reKeyedCollections[src.collection]?.[src.id]
    const payloadHash = isLatestPut && reKeyedEnv
      ? await envelopePayloadHash(reKeyedEnv)
      : src.payloadHash
    const entry: LedgerEntry = {
      index: i,
      prevHash,
      op: src.op,
      collection: src.collection,
      id: src.id,
      version: src.version,
      ts: src.ts,
      actor: src.actor,
      payloadHash,
      ...(src.reason !== undefined ? { reason: src.reason } : {}),
    }
    const { iv, data } = await encrypt(canonicalJson(entry), ledgerDek)
    entries[paddedIndex(i)] = {
      _noydb: NOYDB_FORMAT_VERSION, _v: i + 1, _ts: entry.ts, _iv: iv, _data: data, _by: entry.actor,
    }
    prevHash = await hashEntry(entry)
    last = entry
  }

  return {
    entries,
    head: last ? { hash: prevHash, index: last.index, ts: last.ts } : { hash: '', index: -1, ts: '' },
  }
}

/** Build the AAD binding for chunk integrity: "{eTag}:{chunkIndex}:{chunkCount}".
 * Mirrors `chunkAAD` in blob-set.ts — the eTag is preserved verbatim across
 * the transfer (see `reKeyBlobs`), so the same AAD that bound a chunk in the
 * source keeps binding it in the bundle. */
function chunkAAD(eTag: string, chunkIndex: number, chunkCount: number): Uint8Array {
  return new TextEncoder().encode(`${eTag}:${chunkIndex}:${chunkCount}`)
}

/** Carried blob internals + the fresh transfer `_blob` DEK (present only when
 * the closure references at least one chunk-based blob). */
export interface ReKeyBlobsResult {
  /** `_blob_slots_<C>` / `_blob_versions_<C>` / `_blob_index` / `_blob_chunks`
   * envelopes for the bundle's `_internal` map. */
  readonly internal: Record<string, Record<string, EncryptedEnvelope>>
  /** Fresh transfer `_blob` DEK — seal it so owner-creation wraps it under the
   * recipient KEK. Undefined when no blob travels (source keyring untouched). */
  readonly blobDek?: CryptoKey
}

/**
 * Carry the FK-closed slice's blobs — HARDENED key handling (no master-key leak).
 *
 * The source vault's shared `_blob` DEK decrypts (or unwraps the content CEK of)
 * EVERY blob in the source. Sealing it into the transfer would hand the recipient
 * a key to blobs far outside their slice. Instead we mint a **fresh transfer
 * `_blob` DEK** and arrange every carried blob into per-blob-CEK mode under it:
 *
 *  - **erasable blob** (`_cek` present): unwrap the per-blob content CEK under the
 *    SOURCE `_blob` DEK, re-wrap it under the FRESH transfer DEK. Chunks travel
 *    **verbatim** (still ciphertext under that same content CEK — passthrough).
 *  - **legacy blob** (no `_cek`, chunks under the shared `_blob` DEK): promote it
 *    IN-BUNDLE — mint a fresh content CEK, decrypt each chunk under the source
 *    `_blob` DEK and re-encrypt under the content CEK (same AAD, so the eTag-bound
 *    integrity holds), then wrap the content CEK under the transfer DEK. The
 *    SOURCE is never mutated (non-destructive), and the bundle never holds
 *    plaintext blob bytes (zero-knowledge preserved).
 *
 * **eTag identity is preserved** (not re-HMAC'd). eTags are HMAC-keyed off the
 * `_blob` DEK, but they are stored as OPAQUE keys (`_blob_index/<eTag>`,
 * `_blob_chunks/<eTag>_<i>`) and never recomputed on read — only on a `put()`
 * for dedup. Keeping them verbatim keeps every slot/version/index/chunk key and
 * the chunk AAD coherent with zero chunk-key churn. The only consequence: a
 * future `put()` of identical bytes in the adopted vault computes a different
 * eTag (HMAC under the fresh DEK) and will NOT dedup against the carried blob —
 * an accepted, documented trade for hardened key isolation.
 *
 * Slots/versions are re-keyed under their parent collection's destination DEK
 * (honoring `fieldProjection` — projected-out blob fields' slots never travel);
 * `BlobObject.refCount` is recomputed from carried references only.
 *
 * `external` slots reference an unencrypted shared-bucket object that is not in
 * the bundle — their slot metadata travels (so the catalog entry survives) but
 * the bytes do not (a documented v1 limitation; their eTag is `''`).
 */
export async function reKeyBlobs(
  vault: Vault,
  closure: Map<string, Set<string>>,
  destDeks: Map<string, CryptoKey>,
  fieldProjection?: Record<string, readonly string[]>,
): Promise<ReKeyBlobsResult> {
  const { name: vaultName, adapter, getDEK } = vault._introspectState()
  const internal: Record<string, Record<string, EncryptedEnvelope>> = {}

  // travel set: eTag → number of carried references (slots + versions) within
  // the closure. Recomputed refCount, NOT the source's (which may count
  // out-of-slice referrers, leaving the adopted blob un-GC-able).
  const carriedRefs = new Map<string, number>()
  const addRef = (eTag: string): void => {
    if (!eTag) return // external slot — no chunk-based blob to carry
    carriedRefs.set(eTag, (carriedRefs.get(eTag) ?? 0) + 1)
  }

  const place = (collection: string, id: string, env: EncryptedEnvelope): void => {
    let bucket = internal[collection]
    if (!bucket) { bucket = {}; internal[collection] = bucket }
    bucket[id] = env
  }

  // ── Slots + versions (parent-collection-DEK keyed) ─────────────────
  for (const [collectionName, ids] of closure) {
    const destDek = destDeks.get(collectionName)
    if (!destDek) continue
    const srcDek = await getDEK(collectionName)
    const projList = fieldProjection?.[collectionName]
    const proj = projList ? new Set(projList) : undefined

    // Slots: one envelope per record, a `{ slotName: SlotRecord }` map.
    const slotsCollection = `${BLOB_SLOTS_PREFIX}${collectionName}`
    for (const id of ids) {
      const env = await adapter.get(vaultName, slotsCollection, id)
      if (!env) continue
      const slots = JSON.parse(await decrypt(env._iv, env._data, srcDek)) as Record<string, SlotRecord>
      // FR-7: drop projected-out blob fields' slots (slot names are blob field
      // names) — their eTags then never enter the travel set.
      const kept: Record<string, SlotRecord> = {}
      for (const [slotName, slot] of Object.entries(slots)) {
        if (proj && !proj.has(slotName)) continue
        kept[slotName] = slot
        addRef(slot.eTag)
      }
      if (Object.keys(kept).length === 0) continue
      const { iv, data } = await encrypt(JSON.stringify(kept), destDek)
      place(slotsCollection, id, { ...env, _iv: iv, _data: data })
    }

    // Versions: key = `${recordId}::${slotName}::${label}`; each an independent
    // refCount hold on its eTag.
    const versionsCollection = `${BLOB_VERSIONS_PREFIX}${collectionName}`
    const versionKeys = await adapter.list(vaultName, versionsCollection)
    for (const key of versionKeys) {
      const [recordId, slotName] = key.split('::')
      if (recordId === undefined || !ids.has(recordId)) continue
      if (proj && slotName !== undefined && !proj.has(slotName)) continue
      const env = await adapter.get(vaultName, versionsCollection, key)
      if (!env) continue
      const record = JSON.parse(await decrypt(env._iv, env._data, srcDek)) as VersionRecord
      addRef(record.eTag)
      const { iv, data } = await encrypt(JSON.stringify(record), destDek)
      place(versionsCollection, key, { ...env, _iv: iv, _data: data })
    }
  }

  // No chunk-based blob in the closure → carry nothing, mint nothing. Guarded
  // so `getDEK('_blob')` does not auto-mint + persist a phantom DEK on the
  // source keyring (mirrors the carryLedger non-destructive guard).
  if (carriedRefs.size === 0) return { internal }

  // ── Index + chunks (re-keyed under a FRESH transfer `_blob` DEK) ────
  const srcBlobDek = await getDEK(BLOB_COLLECTION)
  const transferBlobDek = await generateDEK()

  for (const [eTag, refCount] of carriedRefs) {
    const idxEnv = await adapter.get(vaultName, BLOB_INDEX_COLLECTION, eTag)
    if (!idxEnv) continue // dangling slot reference — nothing to carry
    const blob = JSON.parse(await decrypt(idxEnv._iv, idxEnv._data, srcBlobDek)) as BlobObject

    // Resolve the per-blob content CEK; passthrough vs. in-bundle promotion.
    let contentCek: CryptoKey
    let chunksPassthrough: boolean
    if (blob._cek !== undefined) {
      contentCek = await unwrapCek(blob._cek, srcBlobDek)
      chunksPassthrough = true
    } else {
      // Legacy: promote to per-blob-CEK for the bundle (source untouched).
      contentCek = await generateDEK()
      chunksPassthrough = false
    }

    // Chunks: verbatim for an already-erasable blob; decrypt-then-re-encrypt
    // under the fresh content CEK for a legacy blob (same eTag-bound AAD).
    for (let i = 0; i < blob.chunkCount; i++) {
      const chunkId = `${eTag}_${i}`
      const chunkEnv = await adapter.get(vaultName, BLOB_CHUNKS_COLLECTION, chunkId)
      if (!chunkEnv) {
        throw new PartitionExtractionError(
          `reKeyBlobs: blob chunk ${i}/${blob.chunkCount} missing for eTag "${eTag}"; `
          + `cannot carry an incomplete blob into the partition.`,
        )
      }
      if (chunksPassthrough) {
        place(BLOB_CHUNKS_COLLECTION, chunkId, chunkEnv)
      } else {
        const aad = chunkAAD(eTag, i, blob.chunkCount)
        const plain = await decryptBytesWithAAD(chunkEnv._iv, chunkEnv._data, srcBlobDek, aad)
        const { iv, data } = await encryptBytesWithAAD(plain, contentCek, aad)
        place(BLOB_CHUNKS_COLLECTION, chunkId, { ...chunkEnv, _iv: iv, _data: data })
      }
    }

    // Index: per-blob-CEK mode under the transfer DEK, refCount corrected.
    // Drop any transient `_cekPending` (never set on a settled blob — possible
    // only if the source is mid-migration; we set a fresh settled `_cek`).
    const { _cekPending, ...rest } = blob
    void _cekPending
    const carried: BlobObject = { ...rest, refCount, _cek: await wrapCek(contentCek, transferBlobDek) }
    const { iv, data } = await encrypt(JSON.stringify(carried), transferBlobDek)
    place(BLOB_INDEX_COLLECTION, eTag, { ...idxEnv, _iv: iv, _data: data })
  }

  return { internal, blobDek: transferBlobDek }
}

/** A minted transfer key (raw 32 bytes) + the seal carrying the DEK set. */
export interface SealResult {
  readonly seal: TransferSealPayload
  readonly transferKey: Uint8Array
}

/**
 * Mint a random 32-byte transfer key, export each DEK to raw bytes, and
 * AES-256-GCM-seal the `{ collection: base64(rawDEK) }` map under the
 * transfer key. The transfer key is returned to the caller out-of-band;
 * only the sealed bytes travel in the bundle. Layout: iv(12) ‖ ct ‖ tag.
 */
export async function sealDeks(deks: Map<string, CryptoKey>): Promise<SealResult> {
  const dekMap: Record<string, string> = {}
  for (const [collection, dek] of deks) {
    const raw = await crypto.subtle.exportKey('raw', dek)
    dekMap[collection] = bufferToBase64(raw)
  }

  const transferKey = crypto.getRandomValues(new Uint8Array(32))
  const key = await crypto.subtle.importKey('raw', transferKey, 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(dekMap))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)

  const combined = new Uint8Array(iv.byteLength + ct.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ct), iv.byteLength)

  const sealId = bufferToBase64(crypto.getRandomValues(new Uint8Array(12)))
  return {
    seal: { v: 1, alg: 'aes-256-gcm-pre-shared', sealId, payload: bufferToBase64(combined) },
    transferKey,
  }
}

export interface ExtractPartitionResult {
  readonly bundleBytes: Uint8Array
  /** Raw 32-byte transfer key — deliver out-of-band; required to adopt. */
  readonly transferKey: Uint8Array
  readonly sealId: string
}

/**
 * Extract a re-keyed, transfer-sealed partition. Owner-only
 * (invariant 5): producing a standalone re-keyed vault is an
 * ownership operation. Non-destructive on the source.
 */
export async function extractPartition(
  vault: Vault,
  opts: WalkClosureOptions & {
    readonly compression?: 'auto' | 'brotli' | 'gzip' | 'none'
    readonly carrySchemas?: boolean
    readonly carryLedger?: boolean
    /**
     * FR-7 structural field projection: per-collection allow-list of fields
     * to keep. Non-listed fields are dropped from each record BEFORE
     * re-encryption (so they never travel in the bundle); `id` is always
     * preserved. A projected collection's persisted schema is NOT carried.
     * Absent/empty → un-projected behavior (byte-identical to today).
     */
    readonly fieldProjection?: Record<string, readonly string[]>
  },
): Promise<ExtractPartitionResult> {
  // FR-6: extract-and-sever is the inalienability-floor half — owner-only. A
  // custodian operates fully but must NEVER produce a standalone re-keyed
  // partition (that would let it sever a copy out from under the sealed owner).
  // Explicit assertion so the security boundary is auditable at this site.
  if (vault.role === 'custodian') {
    throw new PartitionExtractionError(
      'extractPartition is owner-only; a custodian cannot extract-and-sever '
      + '(FR-6: producing a re-keyed standalone partition is an ownership operation; use the Deed owner).',
    )
  }
  if (vault.role !== 'owner') {
    throw new PartitionExtractionError(
      `extractPartition requires the 'owner' role on the source vault; caller is '${vault.role}'. `
      + `Producing a re-keyed standalone partition is an ownership operation.`,
    )
  }

  // Persisted-schema writes (collection({ persistJsonSchema: true })) are fire-
  // and-forget queued onto vault._pendingSchemaWrites — a caller that does
  // `collection() → put() → extractPartition({ carrySchemas: true })` in quick
  // succession can hit a window where _schemas/<col> is not yet on disk and
  // reKeySchemas silently drops the row. Drain BEFORE reKeySchemas reads.
  if (opts.carrySchemas) await vault._drainPendingSchemaWrites()

  const { closure } = await walkClosure(vault, opts)
  const { collections, deks } = await reKeyClosure(vault, closure, opts.fieldProjection)

  // carryLedger: mint a fresh _ledger DEK, build the carried chain, and
  // SEAL the ledger DEK alongside the data DEKs so owner-creation wraps it into the
  // recipient keyring (lets them decrypt + verify the chain). Must run BEFORE
  // sealDeks.
  let ledgerHead: { hash: string; index: number; ts: string } | undefined
  let ledgerEntries: Record<string, EncryptedEnvelope> | undefined
  if (opts.carryLedger && vault._getLedgerOrNull() !== null) {
    // Skip when the source vault has no history strategy: reKeyLedger's first
    // `getDEK(LEDGER_COLLECTION)` would auto-mint and persist a phantom
    // _ledger DEK on the source keyring (contradicting "non-destructive on
    // the source"), and there's nothing to carry anyway. Mirrors the same
    // null-guard the source audit-append uses below.
    const ledgerDek = await generateDEK()
    const built = await reKeyLedger(vault, closure, collections, ledgerDek)
    if (built.head.index >= 0) {
      ledgerEntries = built.entries
      ledgerHead = built.head
      deks.set(LEDGER_COLLECTION, ledgerDek)
    }
  }

  // Carry the slice's blobs — re-keyed under a FRESH transfer `_blob` DEK
  // (HARDENED: never carries the source's shared blob DEK). Runs BEFORE
  // sealDeks so the fresh DEK is sealed alongside the data DEKs; non-destructive
  // on the source (mints + reads `_blob` only when the closure has blobs).
  const blobs = await reKeyBlobs(vault, closure, deks, opts.fieldProjection)
  if (blobs.blobDek) deks.set(BLOB_COLLECTION, blobs.blobDek)

  // Build _internal (schemas + ledger + blobs). reKeySchemas reads data-
  // collection DEKs only, so it is unaffected by the _ledger DEK added above.
  const internalSchemas = opts.carrySchemas ? await reKeySchemas(vault, closure, deks, opts.fieldProjection) : {}
  const internal: Record<string, Record<string, EncryptedEnvelope>> = {}
  if (Object.keys(internalSchemas).length > 0) internal[SCHEMAS_COLLECTION] = internalSchemas
  if (ledgerEntries) internal[LEDGER_COLLECTION] = ledgerEntries
  for (const [collection, records] of Object.entries(blobs.internal)) internal[collection] = records
  const hasInternal = Object.keys(internal).length > 0

  const { seal, transferKey } = await sealDeks(deks)

  // Source-side audit (spec §4.2 / invariant 4): record that a partition
  // was handed over. Non-destructive — an audit append, no record touched.
  // No-op when the source vault has no history strategy. append() fills
  // index/prevHash/ts and (since actor is '') the ledger's configured actor.
  await vault._getLedgerOrNull()?.append({
    op: 'lifecycle',
    collection: '',
    id: '',
    version: 0,
    actor: '',
    payloadHash: '',
    reason: `partition-handed-over:${seal.sealId}`,
  })

  // Build the dump JSON: unowned (empty keyrings), empty ledger (default),
  // re-keyed collections only.
  const { name: vaultName } = vault._introspectState()
  const backup = {
    _noydb_backup: NOYDB_BACKUP_VERSION,
    _compartment: vaultName,
    _exported_at: new Date().toISOString(),
    _exported_by: '', // unowned — no source user travels
    keyrings: {},
    collections,
    ...(hasInternal ? { _internal: internal } : {}),
    ...(ledgerHead ? { ledgerHead: { hash: ledgerHead.hash, index: ledgerHead.index, ts: ledgerHead.ts } } : {}),
  }
  const bodyJsonStr = JSON.stringify(buildExtractedPartitionWrapper(JSON.stringify(backup), seal))

  // An extracted partition is a NEW vault, not a re-export of the source —
  // mint a fresh handle rather than reusing the source's stable ULID
  // (which would collide if a recipient imports both source + partition).
  const handle = generateULID()
  const bundleBytes = await assembleBundleContainer({
    handle,
    bodyJsonStr,
    compression: opts.compression,
    headerExtras: {
      bundleKind: 'extracted-partition',
      transferSeal: { v: seal.v, alg: seal.alg, sealId: seal.sealId }, // indicator only
    },
  })

  return { bundleBytes, transferKey, sealId: seal.sealId }
}
