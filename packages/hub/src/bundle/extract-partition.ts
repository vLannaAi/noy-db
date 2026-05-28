/**
 * Partition extraction (#203 + #206). Walks the FK closure, re-encrypts
 * the selected records under fresh per-collection DEKs, seals those DEKs
 * under a one-time transfer key, and serializes an unowned
 * `extracted-partition` bundle.
 *
 * @module
 */
import type { Vault } from '../vault.js'
import type { EncryptedEnvelope } from '../types.js'
import { NOYDB_BACKUP_VERSION } from '../types.js'
import { decrypt, encrypt, generateDEK, bufferToBase64 } from '../crypto.js'
import { PartitionExtractionError } from '../errors.js'
import { walkClosure, type WalkClosureOptions } from './walk-closure.js'
import { generateULID } from './ulid.js'
import { SCHEMAS_COLLECTION } from '../persisted-schemas/storage.js'
import { NOYDB_FORMAT_VERSION } from '../types.js'
import { LEDGER_COLLECTION } from '../history/ledger/constants.js'
import { canonicalJson, hashEntry } from '../history/ledger/entry.js'
import type { LedgerEntry } from '../history/ledger/entry.js'
import { envelopePayloadHash } from '../history/ledger/hash.js'
import {
  assembleBundleContainer,
  buildExtractedPartitionWrapper,
  type TransferSealPayload,
} from './bundle.js'

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
): Promise<ReKeyResult> {
  const { name: vaultName, adapter, getDEK } = vault._introspectState()
  const collections: Record<string, Record<string, EncryptedEnvelope>> = {}
  const deks = new Map<string, CryptoKey>()

  for (const [collectionName, ids] of closure) {
    const srcDek = await getDEK(collectionName)
    const destDek = await generateDEK()
    deks.set(collectionName, destDek)
    const out: Record<string, EncryptedEnvelope> = {}

    for (const id of ids) {
      const env = await adapter.get(vaultName, collectionName, id)
      if (!env) continue
      const plaintext = await decrypt(env._iv, env._data, srcDek)
      const { iv, data } = await encrypt(plaintext, destDek)
      out[id] = { ...env, _iv: iv, _data: data }
    }
    collections[collectionName] = out
  }

  return { collections, deks }
}

/**
 * Re-key the persisted JSON Schemas (`_schemas/<collection>`) for the
 * closure collections under the destination DEKs (#204). Returns a
 * `{ collection: envelope }` map for the carried collections that actually
 * have a schema; collections without one are omitted.
 */
export async function reKeySchemas(
  vault: Vault,
  closure: Map<string, Set<string>>,
  destDeks: Map<string, CryptoKey>,
): Promise<Record<string, EncryptedEnvelope>> {
  const { name: vaultName, adapter, getDEK } = vault._introspectState()
  const out: Record<string, EncryptedEnvelope> = {}

  for (const collectionName of closure.keys()) {
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
 * Build the carried `_ledger` chain for an extracted partition (#205, slice 1).
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
 * Extract a re-keyed, transfer-sealed partition (#203 + #206). Owner-only
 * (#198 invariant 5): producing a standalone re-keyed vault is an
 * ownership operation. Non-destructive on the source.
 */
export async function extractPartition(
  vault: Vault,
  opts: WalkClosureOptions & {
    readonly compression?: 'auto' | 'brotli' | 'gzip' | 'none'
    readonly carrySchemas?: boolean
    readonly carryLedger?: boolean
  },
): Promise<ExtractPartitionResult> {
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
  const { collections, deks } = await reKeyClosure(vault, closure)

  // carryLedger (#205): mint a fresh _ledger DEK, build the carried chain, and
  // SEAL the ledger DEK alongside the data DEKs so #208 wraps it into the
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

  // Build _internal (schemas #204 + ledger #205). reKeySchemas reads data-
  // collection DEKs only, so it is unaffected by the _ledger DEK added above.
  const internalSchemas = opts.carrySchemas ? await reKeySchemas(vault, closure, deks) : {}
  const internal: Record<string, Record<string, EncryptedEnvelope>> = {}
  if (Object.keys(internalSchemas).length > 0) internal[SCHEMAS_COLLECTION] = internalSchemas
  if (ledgerEntries) internal[LEDGER_COLLECTION] = ledgerEntries
  const hasInternal = Object.keys(internal).length > 0

  const { seal, transferKey } = await sealDeks(deks)

  // Source-side audit (#226 / spec §4.2 / invariant 4): record that a partition
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
