import type { NoydbStore, EncryptedEnvelope } from '../../kernel/types.js'
import { NOYDB_FORMAT_VERSION } from '../../kernel/types.js'
import { encrypt, decrypt } from '../../kernel/enclave/index.js'
import { AttestationError, ConflictError } from '../../kernel/errors.js'
import { loadOrCreateSigner, ATTESTATIONS_COLLECTION, REVOKED_RECORD_ID } from './signer.js'
import { signRevocationList, type RevocationList } from '@noy-db/attestation'

/** Everything the revoke core needs from the Vault, injected for testability. */
export interface RevokeContext {
  readonly store: NoydbStore
  readonly vault: string
  readonly role: string
  /** The _attestations collection DEK. */
  getDEK(): Promise<CryptoKey>
}

interface RevokedSet {
  docIds: string[]
  updatedAt: string
}

function requireOwner(ctx: RevokeContext, op: string): void {
  if (ctx.role !== 'owner') {
    throw new AttestationError(`${op} requires the 'owner' role; caller is '${ctx.role}'. Revocation is the firm's identity operation.`)
  }
}

async function readSet(store: NoydbStore, vault: string, dek: CryptoKey): Promise<{ docIds: Set<string>; version: number | undefined }> {
  const env = await store.get(vault, ATTESTATIONS_COLLECTION, REVOKED_RECORD_ID)
  if (!env) return { docIds: new Set<string>(), version: undefined }
  const set = JSON.parse(await decrypt(env._iv, env._data, dek)) as RevokedSet
  return { docIds: new Set(set.docIds), version: env._v }
}

/** Read-modify-write the _revoked set with optimistic concurrency + one retry. */
async function mutateSet(ctx: RevokeContext, mutate: (ids: Set<string>) => void): Promise<void> {
  const dek = await ctx.getDEK()
  for (let attempt = 0; attempt < 2; attempt++) {
    const { docIds, version } = await readSet(ctx.store, ctx.vault, dek)
    mutate(docIds)
    const payload: RevokedSet = { docIds: [...docIds].sort(), updatedAt: new Date().toISOString() }
    const { iv, data } = await encrypt(JSON.stringify(payload), dek)
    const expectedVersion = version ?? 0
    const env: EncryptedEnvelope = {
      _noydb: NOYDB_FORMAT_VERSION, _v: expectedVersion + 1, _ts: payload.updatedAt, _iv: iv, _data: data,
    }
    try {
      await ctx.store.put(ctx.vault, ATTESTATIONS_COLLECTION, REVOKED_RECORD_ID, env, expectedVersion)
      return
    } catch (e) {
      if (e instanceof ConflictError && attempt === 0) continue
      throw e
    }
  }
}

export async function revokeDocCore(ctx: RevokeContext, docId: string): Promise<void> {
  requireOwner(ctx, 'revokeAttestation')
  const issued = await ctx.store.get(ctx.vault, ATTESTATIONS_COLLECTION, docId)
  if (!issued) throw new AttestationError(`revokeAttestation: attestation '${docId}' not found (was it issued by this vault?).`)
  await mutateSet(ctx, (ids) => ids.add(docId))
}

export async function unrevokeDocCore(ctx: RevokeContext, docId: string): Promise<void> {
  requireOwner(ctx, 'unrevokeAttestation')
  await mutateSet(ctx, (ids) => ids.delete(docId))
}

export async function getRevokedDocIdsCore(ctx: RevokeContext): Promise<string[]> {
  const dek = await ctx.getDEK()
  const { docIds } = await readSet(ctx.store, ctx.vault, dek)
  return [...docIds].sort()
}

export async function publishRevocationListCore(ctx: RevokeContext): Promise<RevocationList> {
  requireOwner(ctx, 'publishRevocationList')
  const docIds = await getRevokedDocIdsCore(ctx)
  const signer = await loadOrCreateSigner(ctx.store, ctx.vault, () => ctx.getDEK())
  return signRevocationList(docIds, new Date().toISOString(), signer.keyId, signer.privateKeyPkcs8B64)
}
