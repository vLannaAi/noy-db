/**
 * #199 P2 — `unilateralWithdrawal`: a non-owner extracts their accessible scope
 * AND disposes of the source copy. Destructive; gated by the default-off
 * fail-closed built-in `client-unilateral-withdraw` policy (checked in the
 * UserApi wrapper).
 *
 * Two source dispositions (see the #199 design spec §9/§9b):
 *  - 'delete'  — delete-closure: the records leave the source vault entirely.
 *  - 'freeze'  — the firm retains a cryptographically-frozen, read-only, write-once
 *                snapshot (hash-pinned in the tamper-evident ledger) while the live
 *                records are removed.
 *
 * Ordering guarantees no data loss: the client's re-keyed export bundle (and the
 * freeze snapshot) are produced BEFORE anything is deleted.
 *
 * The `freezeAndDeleteClosure` core is shared with the two-party approval path
 * (#199 P3, `bundle/request-withdrawal.ts`).
 */
import type { Vault } from '../../vault.js'
import { sha256Hex } from '../../kernel/enclave/crypto.js'
import { ReadOnlyError } from '../../errors.js'
import { NOYDB_FORMAT_VERSION } from '../../kernel/types.js'
import { resolveAccessibleCollections, buildAccessibleBundle } from './export-accessible.js'

export const FROZEN_SNAPSHOTS_COLLECTION = '_frozen_snapshots'
const ENC = new TextEncoder()

/** 24-hex-char random id (used for withdrawal ids + request ids). */
export function randomId(): string {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(12))
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export interface FrozenSnapshotRef {
  readonly withdrawalId: string
  readonly sha256: string
  readonly recordCount: number
  readonly frozenAt: string
}

export interface WithdrawAccessibleOptions {
  /** Legal/contractual basis recorded in the audit (e.g. 'gdpr-art-17'). */
  readonly legalBasis: string
  /** Re-key the exported bundle to a new owner passphrase. */
  readonly reKey?: { readonly passphrase: string }
  /** Source disposition. Default 'delete'. */
  readonly disposition?: 'delete' | 'freeze'
  readonly scope?: { readonly collections?: readonly string[] }
  /** Stable id for idempotent resume (default random). */
  readonly withdrawalId?: string
}

export interface WithdrawResult {
  readonly bundle: Uint8Array
  readonly snapshot?: FrozenSnapshotRef
}

/**
 * Freeze a write-once, hash-pinned snapshot of the current ciphertext for
 * `collections` WITHOUT touching the live records. Returns the snapshot ref.
 *
 * This is the non-destructive core shared by two callers:
 *  - `freezeAndDeleteClosure` (#199 withdrawal, disposition `'freeze'`) — which
 *    pins the snapshot and THEN delete-closures the live records.
 *  - FR-6 `liberateVault` (custody) — which pins a PRE-liberation evidence
 *    snapshot but PRESERVES the live data for the new owner (operational
 *    continuity; liberation transfers, it does not erase).
 *
 * The snapshot put is write-once (CAS expectedVersion 0) and the ledger pin is
 * appended on success, so a crashed run re-run with the same `withdrawalId` is
 * safe. The snapshot is taken under the vault's own firm-owned DEKs — no re-key.
 */
export async function freezeSnapshotOnly(
  vault: Vault,
  collections: readonly string[],
  opts: { actorUserId: string; withdrawalId?: string },
): Promise<FrozenSnapshotRef> {
  const { name: vaultName, adapter } = vault._introspectState()

  // Enumerate the closure (record ids per collection).
  const closure: Array<{ collection: string; id: string }> = []
  for (const c of collections) {
    for (const id of await adapter.list(vaultName, c)) closure.push({ collection: c, id })
  }

  const withdrawalId = opts.withdrawalId ?? `wd-${randomId()}`
  const snap: Record<string, Record<string, unknown>> = {}
  for (const { collection, id } of closure) {
    const env = await adapter.get(vaultName, collection, id)
    if (env) (snap[collection] ??= {})[id] = env
  }
  const frozenAt = new Date().toISOString()
  const body = JSON.stringify({ withdrawalId, frozenAt, by: opts.actorUserId, collections: snap })
  const sha = await sha256Hex(ENC.encode(body))
  // Write-once: expectedVersion 0 rejects an overwrite (idempotent resume).
  await adapter.put(
    vaultName,
    FROZEN_SNAPSHOTS_COLLECTION,
    withdrawalId,
    { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: frozenAt, _iv: '', _data: body, _by: opts.actorUserId },
    0,
  )
  // Hash-pin into the tamper-evident ledger — makes the snapshot provably unaltered.
  await vault._getLedgerOrNull()?.append({
    op: 'lifecycle', collection: '', id: '', version: 0, actor: opts.actorUserId, payloadHash: '',
    reason: `withdrawal-frozen-snapshot:${withdrawalId}:${sha}`,
  })
  return { withdrawalId, sha256: sha, recordCount: closure.length, frozenAt }
}

/**
 * Dispose of the source records for `collections`: optionally freeze a
 * write-once hash-pinned snapshot of the original ciphertext, then
 * delete-closure the live records. Returns the snapshot ref on freeze.
 *
 * Caller MUST have produced the portable bundle FIRST — this is destructive.
 * The delete is best-effort + idempotent (re-deleting an absent record is a
 * no-op) and the snapshot put is write-once (CAS expectedVersion 0), so a
 * crashed run re-run with the same `withdrawalId` is safe.
 */
export async function freezeAndDeleteClosure(
  vault: Vault,
  collections: readonly string[],
  opts: { disposition: 'delete' | 'freeze'; actorUserId: string; withdrawalId?: string },
): Promise<FrozenSnapshotRef | undefined> {
  // freeze: pin a write-once, hash-pinned snapshot BEFORE any delete. The
  // snapshot-only core is shared with FR-6 liberation (which never deletes).
  const snapshot = opts.disposition === 'freeze'
    ? await freezeSnapshotOnly(vault, collections, {
        actorUserId: opts.actorUserId,
        ...(opts.withdrawalId ? { withdrawalId: opts.withdrawalId } : {}),
      })
    : undefined

  // delete-closure — only after the snapshot is durable.
  const { name: vaultName, adapter } = vault._introspectState()
  for (const c of collections) {
    for (const id of await adapter.list(vaultName, c)) {
      await vault.collection(c).delete(id)
    }
  }

  return snapshot
}

export async function withdrawAccessibleData(
  vault: Vault,
  opts: WithdrawAccessibleOptions,
): Promise<WithdrawResult> {
  const { keyring } = vault._introspectState()
  const disposition = opts.disposition ?? 'delete'

  // Owner-class roles hold blanket authority — they use extractPartition.
  if (keyring.role === 'owner' || keyring.role === 'admin') {
    throw new ReadOnlyError(
      'unilateralWithdrawal is the scoped self-service path; an owner/admin should use extractPartition',
    )
  }
  // FR-6: a custodian must NOT destructively SEVER the vault. It holds the DEKs
  // and operates fully, but ownership is claimed only through the audited
  // Liberate ceremony — never by a one-sided delete/freeze withdrawal. Fires
  // BEFORE the operator rw-scope path below (where a custodian would otherwise
  // be rejected with the wrong "requires rw access" message).
  if (keyring.role === 'custodian') {
    throw new ReadOnlyError(
      'a custodian cannot destructively withdraw/sever; use vault.custody.liberate for an audited ownership claim',
    )
  }
  // client/viewer are read-only by construction (see hasWritePermission): a
  // destructive withdrawal they cannot self-serve — they use the two-party
  // requestWithdrawal flow where firm authority executes the delete-closure.
  if (keyring.role === 'client' || keyring.role === 'viewer') {
    throw new ReadOnlyError(
      'read-only role cannot self-serve a destructive withdrawal — use requestWithdrawal (two-party)',
    )
  }
  // Operator path: destructive ops need rw on the whole scope.
  const collections = resolveAccessibleCollections(keyring, opts.scope, true)
  if (!collections || collections.length === 0) {
    throw new ReadOnlyError(
      'unilateralWithdrawal requires rw access on the withdrawn collections — use requestWithdrawal for read-only scope',
    )
  }

  // 1. Produce the client's re-keyed portable copy FIRST (nothing destroyed yet).
  const bundle = await buildAccessibleBundle(vault, collections, opts.reKey)

  // 2. + 3. freeze (optional) then delete-closure.
  const snapshot = await freezeAndDeleteClosure(vault, collections, {
    disposition, actorUserId: keyring.userId, ...(opts.withdrawalId ? { withdrawalId: opts.withdrawalId } : {}),
  })

  // 4. audit
  await vault._getLedgerOrNull()?.append({
    op: 'lifecycle', collection: '', id: '', version: 0, actor: keyring.userId, payloadHash: '',
    reason: `user-unilateral-withdrawal:${keyring.userId}:${disposition}:${opts.legalBasis}`,
  })

  return snapshot ? { bundle, snapshot } : { bundle }
}
