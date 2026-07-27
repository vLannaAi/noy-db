/**
 * `liberateVault` — the audited claim of ownership over a
 * sealed-owner (Deed) vault. The inverse of withdrawal.
 *
 * A **Deed** vault's owner credential is sealed under a non-firm provider, so
 * the firm-side **custodian** (which holds every collection DEK and operates
 * the vault fully) can never reach `KEK_owner`. Liberation is the ONLY route
 * by which a custodian assumes ownership, and it is deliberately a manual,
 * audited ceremony:
 *
 *   1. gate `'liberate-vault'` (fail-closed)
 *   2. caller MUST be the `custodian` (the de-facto authority holding the DEKs)
 *   3. freeze a PRE-liberation EVIDENCE snapshot (hash-pinned in the ledger) —
 *      but PRESERVE the live data for the new owner (see the freeze decision
 *      below)
 *   4. mint a NEW owner keyring re-wrapping the incumbent DEKs under the new
 *      owner's KEK
 *   5. lifecycle ledger `liberation-claimed:<newOwnerId>:<legalBasis>`
 *   6. stamp the `_meta/deed` marker with `liberatedAt`
 *
 * ## Security: the inalienability floor
 *
 * Liberation **mints a new owner from the custodian's DEKs** — it does NOT
 * unseal the original sealed owner. The old sealed-owner credential is left
 * untouched and ORPHANED (its `_keyring/<id>` file remains, its KEK is still
 * sealed under the non-firm provider), never impersonated. The new owner is a
 * DISTINCT principal under a fresh KEK derived from `newOwnerSecret`. This
 * preserves the inalienability floor: the act of claiming ownership is itself
 * auditable and produces a different principal, rather than silently assuming
 * the latent owner's identity.
 *
 * ## Freeze decision: snapshot-only, not freeze-and-delete
 *
 * `freezeAndDeleteClosure` (withdraw-accessible.ts) writes a hash-pinned
 * snapshot and THEN delete-closures the live records — correct for a
 * destructive withdrawal, WRONG for liberation. Liberation transfers
 * operational continuity; it must leave the live data intact for the new
 * owner. We therefore call the snapshot-only core `freezeSnapshotOnly`
 * (factored out of that module; the freeze-AND-delete withdrawal path is
 * unchanged) to pin the evidence snapshot while preserving the records.
 *
 * @module
 */

import type { Vault } from '../../kernel/vault.js'
import type { FactorProofBundle, KeyringFile } from '../../kernel/types.js'
import { PermissionDeniedError } from '../../kernel/errors.js'
import { wrapKey } from '../../kernel/enclave/index.js'
import { createOwnerKeyring } from '../team/keyring.js'
import type { FrozenSnapshotRef } from '../../with-audit/portability/withdraw-accessible.js'
import { freezeSnapshotOnly } from '../../with-audit/portability/withdraw-accessible.js'
import { loadDeedMarker, saveDeedMarker } from '../team/deed.js'

export interface LiberateOptions {
  /** The id of the new owner principal the custodian mints by claiming ownership. */
  readonly newOwnerId: string
  /** The secret that derives the new owner's KEK (the DEKs are re-wrapped under it). */
  readonly newOwnerSecret: string
  /** Legal/contractual basis recorded in the audit (e.g. 'contractual-handover'). */
  readonly legalBasis: string
  readonly factors?: FactorProofBundle
}

export interface LiberateResult {
  /** The hash-pinned pre-liberation evidence snapshot. */
  readonly snapshot: FrozenSnapshotRef
}

/**
 * Audited claim of ownership over a sealed-owner vault by its custodian. See
 * the module doc for the full ceremony + security rationale.
 */
export async function liberateVault(
  vault: Vault,
  opts: LiberateOptions,
): Promise<LiberateResult> {
  // 1. gate — fail-closed `liberate-vault`.
  await vault.noydb.checkGate(vault.name, 'liberate-vault', opts.factors)

  // 2. caller must be the custodian (the de-facto authority holding the DEKs).
  const { name: vaultName, adapter, keyring } = vault._introspectState()
  if (keyring.role !== 'custodian') {
    throw new PermissionDeniedError(
      'liberation is claimed only by the custodian (the de-facto authority holding the DEKs)',
    )
  }

  // Refuse to clobber an existing principal: the new owner must be a FRESH id.
  // (Checked before any side effect so a colliding id never leaves a half-run
  //  ceremony — no orphan snapshot, no partial keyring overwrite.)
  const existing = await adapter.get(vaultName, '_keyring', opts.newOwnerId)
  if (existing) {
    throw new PermissionDeniedError(
      `liberateVault: newOwnerId "${opts.newOwnerId}" already exists as a principal; choose a fresh id (liberation mints a distinct owner, it never overwrites an existing keyring)`,
    )
  }

  // 3. Pre-liberation EVIDENCE snapshot of every operational collection —
  //    snapshot-only (live data preserved for the new owner; liberation
  //    transfers operational continuity, it does not erase).
  const collections = await listOperationalCollections(vault)
  const snapshot = await freezeSnapshotOnly(vault, collections, { actorUserId: keyring.userId })

  // 4. Mint a NEW owner keyring, re-wrapping the incumbent DEKs under the new
  //    owner's fresh KEK. The old sealed owner is NOT unsealed — a DISTINCT
  //    principal is minted and the original owner credential is left orphaned
  //    (inalienability floor). Mirrors adopt-partition.ts's DEK re-wrap.
  const newOwner = await createOwnerKeyring(adapter, vaultName, { userId: opts.newOwnerId, secret: opts.newOwnerSecret })
  if (!newOwner.kek) {
    throw new PermissionDeniedError(
      `new owner keyring for "${opts.newOwnerId}" has no KEK to re-wrap the incumbent DEKs under`,
    )
  }
  const env = await adapter.get(vaultName, '_keyring', opts.newOwnerId)
  if (!env) {
    throw new PermissionDeniedError(`new owner keyring for "${opts.newOwnerId}" did not persist`)
  }
  const keyringFile = JSON.parse(env._data) as KeyringFile
  const mergedDeks: Record<string, string> = { ...keyringFile.deks }
  for (const [collection, dek] of keyring.deks) {
    mergedDeks[collection] = await wrapKey(dek, newOwner.kek)
  }
  const mergedFile: KeyringFile = { ...keyringFile, deks: mergedDeks }
  await adapter.put(vaultName, '_keyring', opts.newOwnerId, { ...env, _data: JSON.stringify(mergedFile) })

  // 5. Lifecycle ledger audit (no-op if the history strategy is absent).
  await vault._getLedgerOrNull()?.append({
    op: 'lifecycle', collection: '', id: '', version: 0, actor: opts.newOwnerId, payloadHash: '',
    reason: `liberation-claimed:${opts.newOwnerId}:${opts.legalBasis}`,
  })

  // 6. Stamp the Deed marker with `liberatedAt` (if a marker exists).
  const marker = await loadDeedMarker(adapter, vaultName)
  if (marker) {
    await saveDeedMarker(adapter, vaultName, { ...marker, liberatedAt: new Date().toISOString() })
  }

  return { snapshot }
}

/**
 * Enumerate the vault's operational (user-facing) collections — those carried
 * by the caller's keyring DEK map, minus the reserved internal collections
 * (`_*`). These are the collections frozen into the evidence snapshot.
 */
async function listOperationalCollections(vault: Vault): Promise<readonly string[]> {
  const { keyring } = vault._introspectState()
  return [...keyring.deks.keys()].filter((c) => !c.startsWith('_'))
}
