/**
 * Partition adoption (#207). Recipient side: verify an extracted bundle,
 * validate the transfer key, import the re-keyed collections into a
 * destination store, and record an `_meta/adoption` marker. The bundle
 * stays UNOWNED after adoption — `createOwnerOnAdoptedPartition` (#208)
 * mints the owner; `#209` destroys the seal.
 *
 * @module
 */
import { base64ToBuffer, wrapKey } from '../crypto.js'
import { TransferSealError, AdoptionStateError, ValidationError } from '../errors.js'
import type { NoydbStore, VaultSnapshot, KeyringFile } from '../types.js'
import { createOwnerKeyring } from '../team/keyring.js'
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
    // Extractable: the recipient must be able to re-wrap these under their
    // own KEK (AES-KW) at owner-creation (#208). Matches generateDEK.
    const dek = await crypto.subtle.importKey('raw', base64ToBuffer(b64) as BufferSource, 'AES-GCM', true, ['encrypt', 'decrypt'])
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

export interface CreateOwnerResult {
  readonly vaultName: string
  readonly userId: string
}

/**
 * Mint the first owner keyring on an adopted-but-unowned partition (#208),
 * then destroy the transfer seal (#209). Standard-mode passphrase only —
 * recovery enrollment + managed mode are post-hoc / follow-ups.
 *
 * Reuses `createOwnerKeyring` to derive the KEK + write the base keyring,
 * then wraps the partition's DEKs (recovered from the seal) under that KEK
 * and re-persists the merged keyring file.
 */
export async function createOwnerOnAdoptedPartition(
  store: NoydbStore,
  vaultName: string,
  opts: { readonly userId: string; readonly passphrase: string; readonly transferKey: Uint8Array },
): Promise<CreateOwnerResult> {
  const { userId, passphrase, transferKey } = opts

  // 1. Verify adopted-unowned state.
  const adoptionEnv = await store.get(vaultName, '_meta', 'adoption')
  if (!adoptionEnv) {
    throw new AdoptionStateError(
      `vault "${vaultName}" is not an adopted partition (no _meta/adoption). `
      + `createOwnerOnAdoptedPartition only applies to vaults created via adoptPartition.`,
    )
  }
  const adoption = JSON.parse(adoptionEnv._data) as {
    sealId: string; adoptedAt: string; needsOwner?: boolean
    consumedAt?: string; transferSeal?: TransferSealPayload
  }
  if (adoption.consumedAt !== undefined || adoption.transferSeal === undefined) {
    throw new AdoptionStateError(
      `vault "${vaultName}" already has an owner (transfer seal consumed at ${adoption.consumedAt}).`,
    )
  }
  if ((await store.list(vaultName, '_keyring')).length > 0) {
    throw new AdoptionStateError(`vault "${vaultName}" already has a keyring; cannot create a second owner.`)
  }

  // 2. Recover the partition DEKs from the seal (throws on wrong key) BEFORE
  //    writing any keyring, so a bad transfer key leaves no trace.
  const partitionDeks = await unsealDeks(adoption.transferSeal, transferKey)

  // 3. Mint the owner keyring (KEK + _users DEK + canary, written to disk).
  const unlocked = await createOwnerKeyring(store, vaultName, userId, passphrase)

  // 4. Merge the partition DEKs (wrapped under the new KEK) into the keyring.
  const env = await store.get(vaultName, '_keyring', userId)
  if (!env) throw new AdoptionStateError(`keyring write for "${userId}" did not persist`)
  const keyringFile = JSON.parse(env._data) as KeyringFile
  const kek = unlocked.kek
  if (!kek) throw new AdoptionStateError(`owner keyring for "${userId}" has no KEK to wrap partition DEKs under`)
  const mergedDeks: Record<string, string> = { ...keyringFile.deks }
  for (const [collection, dek] of partitionDeks) {
    mergedDeks[collection] = await wrapKey(dek, kek)
  }
  const mergedFile: KeyringFile = { ...keyringFile, deks: mergedDeks }
  await store.put(vaultName, '_keyring', userId, { ...env, _data: JSON.stringify(mergedFile) })

  // 5. (#209) Destroy the transfer seal; retain sealId + consumedAt for audit.
  const consumed = { sealId: adoption.sealId, adoptedAt: adoption.adoptedAt, consumedAt: new Date().toISOString() }
  await store.put(vaultName, '_meta', 'adoption', { ...adoptionEnv, _data: JSON.stringify(consumed) })

  return { vaultName, userId }
}
