/**
 * #199 P3 — two-party withdrawal ceremony.
 *
 * The conservative counterpart to `unilateralWithdrawal` (P2): a non-owner —
 * including a read-only `client`/`viewer` who cannot self-serve a deletion —
 * files a durable REQUEST; an owner/admin reviews it and either APPROVES
 * (extract-and-dispose under firm authority) or REJECTS it. Every step is
 * audited in the tamper-evident ledger.
 *
 *   requester:  vault.user.requestWithdrawal({ scope, disposition?, legalBasis? })
 *   owner:      vault.user.listWithdrawalRequests()
 *               vault.user.approveWithdrawal(requestId, { reKey })  → { bundle, snapshot? }
 *               vault.user.rejectWithdrawal(requestId, { reason })
 *
 * Requests live in the reserved `_user_withdrawal_requests` namespace. The
 * record body is plaintext metadata (collection names + disposition + legal
 * basis — none secret in this trust model; the owner sees the data anyway) and
 * carries NO passphrase: the re-key passphrase is supplied by the approver at
 * approval time and conveyed to the requester out-of-band, so no secret is
 * stored at rest.
 */
import type { Vault } from '../vault.js'
import type { EncryptedEnvelope } from '../types.js'
import { NOYDB_FORMAT_VERSION } from '../types.js'
import { NoydbError } from '../errors.js'
import { resolveAccessibleCollections, buildAccessibleBundle } from './export-accessible.js'
import { freezeAndDeleteClosure, randomId, type FrozenSnapshotRef, type WithdrawResult } from './withdraw-accessible.js'

export const WITHDRAWAL_REQUESTS_COLLECTION = '_user_withdrawal_requests'

/** Raised when a request is missing, already decided, or expired. */
export class WithdrawalRequestError extends NoydbError {
  constructor(message: string) {
    super('WITHDRAWAL_REQUEST', message)
    this.name = 'WithdrawalRequestError'
  }
}

export type WithdrawalRequestStatus = 'pending' | 'approved' | 'rejected'

export interface WithdrawalRequest {
  readonly requestId: string
  readonly requester: string
  readonly collections: readonly string[]
  readonly disposition: 'delete' | 'freeze'
  readonly legalBasis?: string
  readonly status: WithdrawalRequestStatus
  readonly requestedAt: string
  readonly expiresAt?: string
  readonly decidedAt?: string
  readonly decidedBy?: string
  readonly rejectReason?: string
  readonly snapshotSha256?: string
}

export interface RequestWithdrawalOptions {
  readonly scope?: { readonly collections?: readonly string[] }
  readonly disposition?: 'delete' | 'freeze'
  readonly legalBasis?: string
  /** Time-to-live in ms; after this the request can no longer be approved. */
  readonly expiresInMs?: number
}

export interface RequestWithdrawalResult {
  readonly requestId: string
  readonly status: WithdrawalRequestStatus
  readonly expiresAt?: string
}

function writeRequest(vault: Vault, req: WithdrawalRequest, expectedVersion: number): Promise<void> {
  const { name: vaultName, adapter } = vault._introspectState()
  const body = JSON.stringify(req)
  const env: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION, _v: expectedVersion + 1, _ts: req.decidedAt ?? req.requestedAt,
    _iv: '', _data: body, _by: req.decidedBy ?? req.requester,
  }
  return adapter.put(vaultName, WITHDRAWAL_REQUESTS_COLLECTION, req.requestId, env, expectedVersion)
}

async function readRequest(vault: Vault, requestId: string): Promise<{ req: WithdrawalRequest; version: number }> {
  const { name: vaultName, adapter } = vault._introspectState()
  const env = await adapter.get(vaultName, WITHDRAWAL_REQUESTS_COLLECTION, requestId)
  if (!env) throw new WithdrawalRequestError(`withdrawal request "${requestId}" not found`)
  return { req: JSON.parse(env._data) as WithdrawalRequest, version: env._v }
}

/**
 * Requester side. Files a durable request for the caller's accessible scope.
 * Gated by `user-request-withdrawal` (checked in the UserApi wrapper).
 */
export async function requestWithdrawal(
  vault: Vault,
  opts: RequestWithdrawalOptions = {},
): Promise<RequestWithdrawalResult> {
  const { keyring } = vault._introspectState()
  // Resolve the requester's accessible collections (read access defines "theirs";
  // the owner — who can delete anything — executes the disposition on approval).
  const collections = resolveAccessibleCollections(keyring, opts.scope, false)
  if (!collections || collections.length === 0) {
    throw new WithdrawalRequestError(
      'requestWithdrawal needs a concrete scope.collections (the caller has all-collection access — name the collections to withdraw)',
    )
  }
  const requestId = `wr-${randomId()}`
  const requestedAt = new Date().toISOString()
  const req: WithdrawalRequest = {
    requestId, requester: keyring.userId, collections, disposition: opts.disposition ?? 'delete',
    status: 'pending', requestedAt,
    ...(opts.legalBasis ? { legalBasis: opts.legalBasis } : {}),
    ...(opts.expiresInMs ? { expiresAt: new Date(Date.parse(requestedAt) + opts.expiresInMs).toISOString() } : {}),
  }
  await writeRequest(vault, req, 0) // create-only
  await vault._getLedgerOrNull()?.append({
    op: 'lifecycle', collection: '', id: '', version: 0, actor: keyring.userId, payloadHash: '',
    reason: `user-withdrawal-request:${requestId}:${keyring.userId}`,
  })
  return { requestId, status: 'pending', ...(req.expiresAt ? { expiresAt: req.expiresAt } : {}) }
}

/** Owner side. List filed requests (optionally by status). */
export async function listWithdrawalRequests(
  vault: Vault,
  opts: { status?: WithdrawalRequestStatus } = {},
): Promise<WithdrawalRequest[]> {
  const { name: vaultName, adapter } = vault._introspectState()
  const ids = await adapter.list(vaultName, WITHDRAWAL_REQUESTS_COLLECTION)
  const out: WithdrawalRequest[] = []
  for (const id of ids) {
    const env = await adapter.get(vaultName, WITHDRAWAL_REQUESTS_COLLECTION, id)
    if (!env) continue
    const req = JSON.parse(env._data) as WithdrawalRequest
    if (!opts.status || req.status === opts.status) out.push(req)
  }
  return out
}

function assertApprover(vault: Vault): string {
  const { keyring } = vault._introspectState()
  // FR-6: custodian is INTENTIONALLY excluded (SAFER default — review flag).
  // Approving a two-party withdrawal is a destructive extract-and-dispose
  // exercised under FIRM authority — a governance act adjacent to grant/revoke,
  // which a non-owning custodian cannot do. It stays owner/admin-only.
  if (keyring.role !== 'owner' && keyring.role !== 'admin') {
    throw new WithdrawalRequestError('approveWithdrawal / rejectWithdrawal require an owner or admin')
  }
  return keyring.userId
}

function assertPending(req: WithdrawalRequest): void {
  if (req.status !== 'pending') {
    throw new WithdrawalRequestError(`withdrawal request "${req.requestId}" is already ${req.status}`)
  }
  if (req.expiresAt && Date.now() > Date.parse(req.expiresAt)) {
    throw new WithdrawalRequestError(`withdrawal request "${req.requestId}" expired at ${req.expiresAt}`)
  }
}

export interface ApproveWithdrawalOptions {
  /** Re-key the handed-back bundle to a passphrase the requester will use. */
  readonly reKey?: { readonly passphrase: string }
}

/**
 * Owner side. Extract the requester's recorded scope under firm authority,
 * dispose of the source per the request's disposition, mark the request
 * approved, and return the re-keyed bundle to hand back. Gated by
 * `approve-user-withdrawal` (checked in the UserApi wrapper) + owner/admin role.
 */
export async function approveWithdrawal(
  vault: Vault,
  requestId: string,
  opts: ApproveWithdrawalOptions = {},
): Promise<WithdrawResult> {
  const approver = assertApprover(vault)
  const { req, version } = await readRequest(vault, requestId)
  assertPending(req)

  // 1. Produce the requester's re-keyed portable copy FIRST (owner authority
  //    holds every DEK, so the recorded collections are all readable).
  const bundle = await buildAccessibleBundle(vault, [...req.collections], opts.reKey)

  // 2. + 3. dispose of the source (freeze snapshot, optional → delete-closure).
  const snapshot: FrozenSnapshotRef | undefined = await freezeAndDeleteClosure(vault, req.collections, {
    disposition: req.disposition, actorUserId: approver, withdrawalId: `wd-${requestId}`,
  })

  // 4. mark approved + audit (OCC against the version we read).
  const decidedAt = new Date().toISOString()
  await writeRequest(vault, {
    ...req, status: 'approved', decidedAt, decidedBy: approver,
    ...(snapshot ? { snapshotSha256: snapshot.sha256 } : {}),
  }, version)
  await vault._getLedgerOrNull()?.append({
    op: 'lifecycle', collection: '', id: '', version: 0, actor: approver, payloadHash: '',
    reason: `user-withdrawal-approved:${requestId}:${req.requester}:${req.disposition}`,
  })

  return snapshot ? { bundle, snapshot } : { bundle }
}

export interface RejectWithdrawalOptions {
  readonly reason?: string
}

/** Owner side. Decline a pending request (no data is touched). */
export async function rejectWithdrawal(
  vault: Vault,
  requestId: string,
  opts: RejectWithdrawalOptions = {},
): Promise<WithdrawalRequest> {
  const approver = assertApprover(vault)
  const { req, version } = await readRequest(vault, requestId)
  assertPending(req)
  const decidedAt = new Date().toISOString()
  const updated: WithdrawalRequest = {
    ...req, status: 'rejected', decidedAt, decidedBy: approver,
    ...(opts.reason ? { rejectReason: opts.reason } : {}),
  }
  await writeRequest(vault, updated, version)
  await vault._getLedgerOrNull()?.append({
    op: 'lifecycle', collection: '', id: '', version: 0, actor: approver, payloadHash: '',
    reason: `user-withdrawal-rejected:${requestId}:${req.requester}`,
  })
  return updated
}
