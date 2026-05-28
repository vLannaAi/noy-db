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
import { resolveManagedSecret } from '../team/managed-passphrase.js'
import type { SealingKeyProvider } from '../team/managed-passphrase.js'
import type { ShamirRecoveryProvider } from '../team/shamir-recovery-provider.js'
import type { RecoveryEnrollmentInput } from '../team/rotate-recover.js'
import { LedgerStore } from '../history/ledger/store.js'
import { LEDGER_COLLECTION } from '../history/ledger/constants.js'
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

  // Single-occupancy per vaultName: an `_meta/adoption` marker already present
  // means this slot holds a partition (adopted-and-unowned, or already owned).
  // saveAll below would overwrite its data and replace the marker, stranding the
  // prior adoption's transfer seal. Refuse regardless of sealId — re-adopting the
  // SAME bundle is a redundant call, and adopting a DIFFERENT bundle here would
  // clobber the existing partition. Either way, pick a fresh vaultName.
  const existing = await destinationStore.get(vaultName, '_meta', 'adoption')
  if (existing) {
    const prior = JSON.parse(existing._data) as { sealId?: string }
    if (prior.sealId === seal.sealId) {
      throw new AdoptionStateError(
        `partition (sealId ${seal.sealId}) is already adopted into vault "${vaultName}".`,
      )
    }
    throw new AdoptionStateError(
      `vault "${vaultName}" already holds an adopted partition (sealId ${prior.sealId}); `
      + `adopting a different partition (sealId ${seal.sealId}) here would overwrite it. `
      + `Adopt into a fresh vaultName instead.`,
    )
  }

  // The marker-only check above misses a worse case: a vaultName already in use
  // by an ORDINARY vault (createNoydb + openVault) carries no `_meta/adoption`,
  // yet `saveAll` below is destructive on SQL adapters (`DELETE FROM ... WHERE
  // vault = ?` followed by upsert) and would wipe the legitimate keyring +
  // data. Refuse adoption into ANY occupied slot — a fresh vaultName is the
  // documented precondition.
  const existingKeyring = await destinationStore.list(vaultName, '_keyring')
  if (existingKeyring.length > 0) {
    throw new AdoptionStateError(
      `vault "${vaultName}" already holds a keyring (an unrelated owner exists at this slot); `
      + `adoptPartition requires a fresh vaultName to avoid destructive saveAll on SQL adapters.`,
    )
  }

  const backup = JSON.parse(dump) as { collections: VaultSnapshot; _internal?: VaultSnapshot }
  await destinationStore.saveAll(vaultName, backup.collections)

  // Import carried internal collections (e.g. _schemas from #204 carrySchemas).
  // saveAll only writes data collections; _internal is written per-record.
  if (backup._internal) {
    for (const [collection, records] of Object.entries(backup._internal)) {
      for (const [id, envelope] of Object.entries(records)) {
        await destinationStore.put(vaultName, collection, id, envelope)
      }
    }
  }

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

/** Standard-mode owner: recipient supplies the passphrase. */
export interface CreateOwnerStandardOptions {
  readonly userId: string
  readonly passphrase: string
  readonly transferKey: Uint8Array
}

/**
 * Managed-mode owner (#208 follow-up): the passphrase is minted + sealed under
 * a `SealingKeyProvider` (e.g. an `at-*` OS keychain) so the partition
 * auto-unlocks on the recipient's device. Managed mode mandates a strong
 * (Shamir) recovery profile at creation (#195), which needs the
 * `shamirRecovery` provider injected.
 */
export interface CreateOwnerManagedOptions {
  readonly userId: string
  readonly passphraseMode: 'managed'
  readonly sealingKey: SealingKeyProvider
  readonly recovery: ReadonlyArray<RecoveryEnrollmentInput>
  readonly shamirRecovery: ShamirRecoveryProvider
  readonly transferKey: Uint8Array
}

export type CreateOwnerOptions = CreateOwnerStandardOptions | CreateOwnerManagedOptions

function isManaged(o: CreateOwnerOptions): o is CreateOwnerManagedOptions {
  return 'passphraseMode' in o && o.passphraseMode === 'managed'
}

/**
 * Mint the first owner keyring on an adopted-but-unowned partition (#208),
 * then destroy the transfer seal (#209).
 *
 * Standard mode: the recipient supplies a passphrase. Managed mode: the
 * passphrase is minted + sealed under a `SealingKeyProvider` and a strong
 * (Shamir) recovery profile is enrolled (#195) — orchestrated via the existing
 * `openVaultAndEnrollRecovery` ceremony.
 *
 * Either way, reuses `createOwnerKeyring` to derive the KEK + write the base
 * keyring, then wraps the partition's DEKs (recovered from the seal) under that
 * KEK and re-persists the merged keyring file.
 *
 * Idempotent under retry: the seal is destroyed LAST (Stage D), after the
 * keyring (Stage A), the ledger transition (Stage B), and — in managed mode —
 * strong-recovery enrollment (Stage C). A failure in the fallible enrollment
 * step leaves the seal intact, and re-running with the same `userId` +
 * `transferKey` resumes from the first incomplete stage. (Multi-profile recovery
 * arrays may re-enroll an already-enrolled profile on retry; managed mode's
 * mandated single Shamir profile does not.)
 */
export async function createOwnerOnAdoptedPartition(
  store: NoydbStore,
  vaultName: string,
  opts: CreateOwnerOptions,
): Promise<CreateOwnerResult> {
  const { userId, transferKey } = opts

  // Managed mode requires a strong (Shamir) recovery profile, validated BEFORE
  // any disk write (#195) — same gate as createNoydb.
  if (isManaged(opts) && !opts.recovery.some((r) => r.profile === 'shamir')) {
    throw new AdoptionStateError(
      'managed-mode adoption requires at least one strong (shamir) recovery profile in '
      + '`recovery` — paper alone is not strong when there is no user passphrase to fall back on.',
    )
  }

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

  // 2. Recover the partition DEKs from the seal (throws on wrong key) BEFORE
  //    writing any keyring, so a bad transfer key leaves no trace. Always
  //    validated, including when resuming a partial prior call.
  const partitionDeks = await unsealDeks(adoption.transferSeal, transferKey)

  // The ceremony below is split into stages so a failure in the fallible
  // managed-enrollment step (network/provider outage) leaves the call RETRYABLE
  // — the seal is destroyed only once everything durable is in place. Each stage
  // detects its own prior completion rather than relying on a single resume bit.

  // A keyring present for a DIFFERENT user (with the seal still unconsumed) is a
  // genuine second-owner attempt — refuse it. A same-user keyring is a resumed
  // partial call and is handled by the stage checks below.
  const existingKeyring = await store.get(vaultName, '_keyring', userId)
  const otherOwners = (await store.list(vaultName, '_keyring')).filter((u) => u !== userId)
  if (otherOwners.length > 0) {
    throw new AdoptionStateError(
      `vault "${vaultName}" already has a keyring for a different owner; cannot create owner "${userId}".`,
    )
  }

  // Stage A — mint the owner keyring + merge the partition DEKs. Considered done
  // only when the keyring already holds every partition DEK. createOwnerKeyring
  // overwrites (fresh KEK + fresh _users DEK), so re-running is safe ONLY while
  // no recovery has been enrolled yet — guaranteed here because enrollment
  // (Stage C) runs strictly after Stage A completes.
  const partitionCollections = [...partitionDeks.keys()]
  const priorDeks = existingKeyring ? (JSON.parse(existingKeyring._data) as KeyringFile).deks : {}
  const ownerMinted = existingKeyring !== null && partitionCollections.every((c) => c in priorDeks)
  if (!ownerMinted) {
    // Resolve the owner passphrase. Managed mode mints a random passphrase, seals
    // it under the provider, and persists _meta/sealed-passphrase (so the
    // partition auto-unlocks on the recipient's device); standard mode uses the
    // caller's passphrase. Idempotent under retry — resolveManagedSecret's reopen
    // arm reuses an already-sealed passphrase.
    const passphrase = isManaged(opts)
      ? await resolveManagedSecret(store, vaultName, opts.sealingKey)
      : opts.passphrase

    // Mint the owner keyring (KEK + _users DEK + canary, written to disk).
    const unlocked = await createOwnerKeyring(store, vaultName, userId, passphrase)

    // Merge the partition DEKs (wrapped under the new KEK) into the keyring.
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
  }

  // Stage B — (#226 destination) record the ownership transition on the carried
  // audit chain (carryLedger sealed the _ledger DEK). No-op without that DEK.
  // Idempotent: appended only if the closing `transfer-seal-consumed` entry is
  // absent, so a retry does not duplicate the pair.
  const ledgerDek = partitionDeks.get(LEDGER_COLLECTION)
  if (ledgerDek) {
    const ledger = new LedgerStore({
      adapter: store,
      vault: vaultName,
      encrypted: true,
      getDEK: async () => ledgerDek,
      actor: userId,
    })
    const creationReason = `creation-of-new-owner:${userId}`
    const consumedReason = `transfer-seal-consumed:${adoption.sealId}`
    // Gate each append on its own presence — a crash or store error strictly
    // between the two adjacent puts would otherwise re-append the first one
    // on retry. The pair is the audit record, not a single transaction.
    const recordedReasons = new Set((await ledger.loadAllEntries()).map((e) => e.reason))
    if (!recordedReasons.has(creationReason)) {
      await ledger.append({ op: 'lifecycle', collection: '', id: '', version: 0, actor: '', payloadHash: '', reason: creationReason })
    }
    if (!recordedReasons.has(consumedReason)) {
      await ledger.append({ op: 'lifecycle', collection: '', id: '', version: 0, actor: '', payloadHash: '', reason: consumedReason })
    }
  }

  // Stage C — Managed mode (#208 follow-up): enroll the mandatory strong recovery
  //    (#195) by orchestrating the existing public ceremony. The partition is
  //    now a managed-mode vault on disk (sealed passphrase + keyring), so we
  //    open it as a normal client and let openVaultAndEnrollRecovery do the
  //    gate-bypass + enroll + re-assert. Dynamic import keeps the Noydb class
  //    out of the @noy-db/hub/bundle static graph. Runs BEFORE seal destruction
  //    so a failure here leaves the seal intact and the call retryable.
  if (isManaged(opts)) {
    const { createNoydb } = await import('../noydb.js')
    const db = await createNoydb({
      store,
      user: userId,
      passphraseMode: 'managed',
      sealingKey: opts.sealingKey,
      shamirRecovery: opts.shamirRecovery,
    })
    await db.openVaultAndEnrollRecovery(vaultName, { recovery: opts.recovery })
  }

  // Stage D — (#209) Destroy the transfer seal LAST — the commit point. Everything
  //    above is either idempotent or resumable, so the seal is only consumed
  //    once the owner keyring (and, in managed mode, strong recovery) is
  //    durably in place. Retain sealId + consumedAt for audit.
  const consumed = { sealId: adoption.sealId, adoptedAt: adoption.adoptedAt, consumedAt: new Date().toISOString() }
  await store.put(vaultName, '_meta', 'adoption', { ...adoptionEnv, _data: JSON.stringify(consumed) })

  return { vaultName, userId }
}
