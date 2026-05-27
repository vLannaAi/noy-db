/**
 * Partition adoption (#207). Recipient side: verify an extracted bundle,
 * validate the transfer key, import the re-keyed collections into a
 * destination store, and record an `_meta/adoption` marker. The bundle
 * stays UNOWNED after adoption — `createOwnerOnAdoptedPartition` (#208)
 * mints the owner; `#209` destroys the seal.
 *
 * @module
 */
import { base64ToBuffer } from '../crypto.js'
import { TransferSealError, AdoptionStateError, ValidationError } from '../errors.js'
import type { NoydbStore, VaultSnapshot } from '../types.js'
import type { TransferSealPayload } from './bundle.js'
import { readNoydbBundleHeader, readNoydbBundle, parseExtractedPartitionBody } from './bundle.js'

/**
 * Reverse of `sealDeks` (#206). Imports the transfer key, decrypts the
 * sealed `{ collection: base64(rawDEK) }` map (layout iv(12)‖ct‖tag), and
 * re-imports each DEK as an AES-GCM key. Throws `TransferSealError` on a
 * wrong key (AES-GCM auth-tag failure) or malformed payload.
 */
export async function unsealDeks(
  seal: TransferSealPayload,
  transferKey: Uint8Array,
): Promise<Map<string, CryptoKey>> {
  if (transferKey.byteLength !== 32) {
    throw new TransferSealError(
      `transfer key must be 32 bytes, got ${transferKey.byteLength}.`,
    )
  }
  const key = await crypto.subtle.importKey('raw', transferKey as BufferSource, 'AES-GCM', false, ['decrypt'])
  const raw = base64ToBuffer(seal.payload)
  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, 12) as BufferSource },
      key,
      raw.slice(12) as BufferSource,
    )
  } catch {
    throw new TransferSealError(
      'transfer seal could not be opened — wrong transfer key (AES-GCM authentication failed).',
    )
  }
  let dekMap: Record<string, string>
  try {
    dekMap = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, string>
  } catch {
    throw new TransferSealError('transfer seal payload is not valid JSON after decryption.')
  }
  const deks = new Map<string, CryptoKey>()
  for (const [collection, b64] of Object.entries(dekMap)) {
    const dek = await crypto.subtle.importKey('raw', base64ToBuffer(b64), 'AES-GCM', false, ['encrypt', 'decrypt'])
    deks.set(collection, dek)
  }
  return deks
}

export interface AdoptPartitionOptions {
  readonly transferKey: Uint8Array
  readonly destinationStore: NoydbStore
  readonly vaultName: string
}

export interface AdoptPartitionResult {
  readonly vaultName: string
  readonly needsOwner: true
  readonly sealId: string
}

export async function adoptPartition(
  bundleBytes: Uint8Array,
  opts: AdoptPartitionOptions,
): Promise<AdoptPartitionResult> {
  const { transferKey, destinationStore, vaultName } = opts

  const header = readNoydbBundleHeader(bundleBytes)
  if (header.bundleKind !== 'extracted-partition' || header.transferSeal === undefined) {
    throw new ValidationError(
      'adoptPartition requires an extracted-partition bundle with a transfer seal. '
      + 'For ordinary backups use readNoydbBundle + vault.load.',
    )
  }

  const { dumpJson } = await readNoydbBundle(bundleBytes)
  const { dump, seal } = parseExtractedPartitionBody(dumpJson)

  // Validate the transfer key by unsealing in memory; throws
  // TransferSealError on mismatch. DEKs are discarded here — they stay
  // sealed at rest (in _meta/adoption) until #208 wraps them under the
  // recipient's KEK.
  await unsealDeks(seal, transferKey)

  // One-time-per-destination: refuse to re-adopt the same partition into
  // a store that already consumed this seal.
  const existing = await destinationStore.get(vaultName, '_meta', 'adoption')
  if (existing) {
    const prior = JSON.parse(existing._data) as { sealId?: string }
    if (prior.sealId === seal.sealId) {
      throw new AdoptionStateError(
        `partition (sealId ${seal.sealId}) is already adopted into vault "${vaultName}".`,
      )
    }
  }

  const backup = JSON.parse(dump) as { collections: VaultSnapshot }
  await destinationStore.saveAll(vaultName, backup.collections)

  const adoptedAt = new Date().toISOString()
  const adoption = { sealId: seal.sealId, adoptedAt, needsOwner: true as const, transferSeal: seal }
  await destinationStore.put(vaultName, '_meta', 'adoption', {
    _noydb: 1, _v: 1, _ts: adoptedAt, _iv: '', _data: JSON.stringify(adoption),
  })

  return { vaultName, needsOwner: true, sealId: seal.sealId }
}
