import type { NoydbStore, EncryptedEnvelope } from '../../kernel/types.js'
import { NOYDB_FORMAT_VERSION } from '../../kernel/types.js'
import { encrypt } from '../../kernel/enclave/index.js'
import { AttestationError } from '../../kernel/errors.js'
import { generateULID } from '../../with-pod/ulid.js'
import { loadOrCreateSigner, ATTESTATIONS_COLLECTION } from './signer.js'
import {
  computeFieldHashes, signPayloadCore, encodeQr, bytesToB64url,
  type AttestationFieldSchema, type QrPayload,
} from '@noy-db/attestation'

/** Everything issueAttestationCore needs from the Vault, injected for testability. */
export interface IssueContext {
  readonly store: NoydbStore
  readonly vault: string
  readonly role: string
  /** The _attestations collection DEK (AES-KW-wrapped under KEK by the keyring). */
  getDEK(): Promise<CryptoKey>
  /** Decrypted source record + its envelope version, or null if absent. */
  readRecord(collection: string, id: string): Promise<{ record: Record<string, unknown>; version: number } | null>
}

export interface IssueArgs {
  readonly collection: string
  readonly id: string
  readonly fieldSchema: AttestationFieldSchema
}
export interface IssueResult {
  readonly docId: string
  readonly qr: string
  readonly payload: QrPayload
  readonly keyId: string
  readonly publicKeyB64: string
}

export async function issueAttestationCore(ctx: IssueContext, args: IssueArgs): Promise<IssueResult> {
  if (ctx.role !== 'owner') {
    throw new AttestationError(`issueAttestation requires the 'owner' role; caller is '${ctx.role}'. Issuing a signed attestation is the firm's identity operation.`)
  }
  const src = await ctx.readRecord(args.collection, args.id)
  if (!src) throw new AttestationError(`issueAttestation: source record '${args.collection}/${args.id}' not found.`)

  const dek = await ctx.getDEK()
  // ONE signer implementation, from signer.ts. Lazily minted + persisted.
  const signer = await loadOrCreateSigner(ctx.store, ctx.vault, () => Promise.resolve(dek))

  const saltB64 = bytesToB64url(crypto.getRandomValues(new Uint8Array(16)))
  let fieldHashes: string[]
  try {
    fieldHashes = await computeFieldHashes(saltB64, args.fieldSchema, src.record)
  } catch (e) {
    throw new AttestationError(`issueAttestation: ${(e as Error).message}`)
  }
  const docId = generateULID()

  const sig = await signPayloadCore({ v: 1, docId, salt: saltB64, keyId: signer.keyId, fieldHashes }, signer.privateKeyPkcs8B64)
  const payload: QrPayload = { v: 1, docId, salt: saltB64, alg: 'ed25519', keyId: signer.keyId, fieldHashes, sig }

  const index = {
    docId, issuedAt: new Date().toISOString(), keyId: signer.keyId,
    fieldPaths: args.fieldSchema.fields.map((f) => f.path),
    sourceRefs: [{ collection: args.collection, id: args.id, version: src.version }],
  }
  const { iv, data } = await encrypt(JSON.stringify(index), dek)
  const env: EncryptedEnvelope = { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: index.issuedAt, _iv: iv, _data: data }
  await ctx.store.put(ctx.vault, ATTESTATIONS_COLLECTION, docId, env)

  return { docId, qr: encodeQr(payload), payload, keyId: signer.keyId, publicKeyB64: signer.publicKeyB64 }
}
