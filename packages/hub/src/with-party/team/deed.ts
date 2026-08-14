/**
 * FR-6 — Deed: sealed / hidden-owner provisioning.
 *
 * A **Deed** is a vault owned by a *latent* principal who never
 * authenticates. The owner credential (the random secret that
 * derives `KEK_owner`) is minted machine-side and sealed under a
 * **non-firm** {@link SealingKeyProvider} — that sealing boundary is
 * the cryptographic *inalienability anchor*: whoever holds the
 * provider (the client / their KMS) is the only party that can ever
 * re-derive `KEK_owner`. A firm-side custodian operates the vault
 * fully but can never reach the owner key — there is deliberately NO
 * firm-controlled fallback.
 *
 * Provisioning reuses the managed-mode seam:
 *   - {@link resolveManagedSecret} mints + seals + persists the random
 *     secret at `_meta/sealed-secret` (and unseals it on every
 *     subsequent open through the same provider).
 *   - {@link createOwnerKeyring} derives `KEK_owner` from that
 *     secret and writes the `_keyring/<ownerUserId>` file.
 *
 * On top of that, a Deed writes a `_meta/deed` **marker**. The marker
 * is PLAINTEXT metadata — it records WHO the latent owner is and WHICH
 * sealing boundary protects them, so it must be readable without
 * unlocking the vault (a custodian or auditor inspecting the vault must
 * be able to see "this is a Deed vault, owner = X, sealed under Y"
 * without any key). The marker itself is therefore never sealed; only
 * the owner *credential* is.
 *
 * @module
 */

import { buildRecordEnvelope } from '../../kernel/enclave/index.js'
import type { NoydbStore } from '../../kernel/types.js'
import type { UnlockedKeyring } from './keyring.js'
import { createOwnerKeyring } from './keyring.js'
import type { SealingKeyProvider } from './managed-secret.js'
import { resolveManagedSecret } from './managed-secret.js'

/** Reserved id for the Deed marker under `_meta`. */
export const DEED_RECORD_ID = 'deed' as const

/**
 * Plaintext metadata recording a vault's latent-owner Deed. Persisted
 * at `_meta/deed`. Readable without unlocking the vault by design — it
 * carries no secret material, only the identity of the latent owner
 * and the sealing boundary that anchors inalienability.
 */
export interface DeedMarker {
  /** The latent owner principal — the user id of the `_keyring/<id>` owner file. */
  readonly ownerUserId: string
  /**
   * The `SealingKeyProvider.id` the owner credential is sealed under.
   * The inalienability anchor: only the holder of this (non-firm)
   * provider can re-derive `KEK_owner`. Audit metadata — never secret.
   */
  readonly sealedUnder: string
  /** Always `true` for a Deed — the owner never authenticates interactively. */
  readonly latent: true
  /** ISO-8601 timestamp the Deed was issued. */
  readonly issuedAt: string
  /**
   * ISO-8601 timestamp the vault was liberated (a new owner claimed it
   * via the audited Liberate ceremony), if any. Absent until liberation.
   */
  readonly liberatedAt?: string
}

/**
 * Wire-format payload stored inside the `_meta/deed` envelope. Carries
 * a magic marker for forensics + the {@link DeedMarker} fields. JSON,
 * AES-GCM bypassed (the marker is plaintext metadata by design).
 */
interface DeedEnvelopePayload extends DeedMarker {
  readonly _noydb_deed: 1
}

/**
 * Provision a Deed: a latent owner whose credential is sealed under
 * `sealing` (a NON-firm provider). Mints + seals the owner secret
 * via {@link resolveManagedSecret}, derives the owner keyring via
 * {@link createOwnerKeyring}, then writes the plaintext `_meta/deed`
 * marker. Returns the unlocked owner keyring.
 *
 * The returned keyring is the only in-memory window onto `KEK_owner`
 * for this call; the persistent re-entry point is the sealing provider
 * (re-run {@link resolveManagedSecret} with the same provider to
 * re-resolve the secret, then {@link createOwnerKeyring}/load to
 * unlock — no interactive secret is ever required).
 *
 * There is deliberately no firm-controlled fallback: the marker's
 * `sealedUnder` is the single cryptographic anchor of ownership.
 */
export async function createDeedOwner(
  store: NoydbStore,
  vault: string,
  ownerUserId: string,
  sealing: SealingKeyProvider,
): Promise<UnlockedKeyring> {
  // 1. Mint + seal + persist the random owner secret under the
  //    non-firm provider (writes _meta/sealed-secret).
  const secret = await resolveManagedSecret(store, vault, sealing)

  // 2. Derive KEK_owner from the (never-human-seen) secret and
  //    write the owner keyring file.
  const keyring = await createOwnerKeyring(store, vault, { userId: ownerUserId, secret: secret })

  // 3. Write the plaintext Deed marker. NOT sealed — it is audit
  //    metadata that must be readable without unlocking.
  await saveDeedMarker(store, vault, {
    ownerUserId,
    sealedUnder: sealing.id,
    latent: true,
    issuedAt: new Date().toISOString(),
  })

  return keyring
}

/**
 * Read the {@link DeedMarker} from `_meta/deed`, or `null` if the vault
 * has no Deed marker (i.e. it is not a Deed vault). Plaintext read — no
 * unlocking required.
 */
export async function loadDeedMarker(
  store: NoydbStore,
  vault: string,
): Promise<DeedMarker | null> {
  const envelope = await store.get(vault, '_meta', DEED_RECORD_ID)
  if (!envelope) return null
  let payload: unknown
  try {
    payload = JSON.parse(envelope._data)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null) return null
  const r = payload as Record<string, unknown>
  if (r._noydb_deed !== 1) return null
  if (
    typeof r.ownerUserId !== 'string'
    || typeof r.sealedUnder !== 'string'
    || r.latent !== true
    || typeof r.issuedAt !== 'string'
  ) {
    return null
  }
  const marker: DeedMarker = {
    ownerUserId: r.ownerUserId,
    sealedUnder: r.sealedUnder,
    latent: true,
    issuedAt: r.issuedAt,
    ...(typeof r.liberatedAt === 'string' ? { liberatedAt: r.liberatedAt } : {}),
  }
  return marker
}

/** Whether `vault` carries a Deed marker (a sealed/latent owner). */
export async function isDeedVault(
  store: NoydbStore,
  vault: string,
): Promise<boolean> {
  return (await loadDeedMarker(store, vault)) !== null
}

/**
 * Persist a {@link DeedMarker} at `_meta/deed`. Mirrors
 * `saveSealedSecret`'s envelope shape: a standard
 * {@link EncryptedEnvelope} with AES-GCM bypassed (`_iv: ''`), the
 * payload stored as plaintext JSON in `_data`. The marker is metadata,
 * not a secret — sealing it would defeat its purpose (auditors /
 * custodians must read it without a key).
 *
 * @internal — used by `createDeedOwner` and (later) the Liberate
 * ceremony to stamp `liberatedAt`.
 */
export async function saveDeedMarker(
  store: NoydbStore,
  vault: string,
  marker: DeedMarker,
): Promise<void> {
  const persisted: DeedEnvelopePayload = { _noydb_deed: 1, ...marker }
  const prior = await store.get(vault, '_meta', DEED_RECORD_ID)
  const env = buildRecordEnvelope(
    { collection: '_meta', id: DEED_RECORD_ID },
    // AES-GCM bypassed — the marker is plaintext audit metadata.
    { version: (prior?._v ?? 0) + 1, iv: '', data: JSON.stringify(persisted) },
  )
  await store.put(vault, '_meta', DEED_RECORD_ID, env)
}
