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
  opts: WalkClosureOptions & { readonly compression?: 'auto' | 'brotli' | 'gzip' | 'none' },
): Promise<ExtractPartitionResult> {
  if (vault.role !== 'owner') {
    throw new PartitionExtractionError(
      `extractPartition requires the 'owner' role on the source vault; caller is '${vault.role}'. `
      + `Producing a re-keyed standalone partition is an ownership operation.`,
    )
  }

  const { closure } = await walkClosure(vault, opts)
  const { collections, deks } = await reKeyClosure(vault, closure)
  const { seal, transferKey } = await sealDeks(deks)

  // TODO(#226): write a `partition-handed-over:<sealId>` entry to the SOURCE
  // vault's ledger (spec §4.2 / invariant 4 — the firm's audit signal that an
  // extraction happened). Deferred: needs the LedgerStore append + hash-chain
  // path and a no-history fallback; doing it wrong corrupts verifyBackupIntegrity.
  // Extraction stays non-destructive of records regardless.

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
